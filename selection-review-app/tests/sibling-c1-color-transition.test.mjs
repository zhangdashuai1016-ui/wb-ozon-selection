import test from "node:test";
import assert from "node:assert/strict";
import { createFormalC1DraftFixture, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { executeBusinessMutation } from "../lib/business-mutation-transaction.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { createC1SiblingColorRevisionUseCase, prepareC1SiblingColorRevision } from "../lib/c1-sibling-color-revision-use-case.mjs";
import { createC1OzonAttributeMappingUseCase } from "../lib/c1-ozon-attribute-mapping-use-case.mjs";
import { assertSiblingSkuColorProjection } from "../lib/sibling-sku-card-guard.mjs";

const AT = "2026-08-12T13:00:00.000Z";

function siblingInput() {
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  const candidate = structuredClone(fixture.candidate);
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.created.skuPackage);
  candidate.sourceCapture = { skuChoices: [{ sourceSkuId: candidate.lifecycleV11.skuPackage.supplierSkuId,
    attributes: { 颜色: "黑cp" } }] };
  candidate.siblingSourceV1 = { supplierSkuId: candidate.lifecycleV11.skuPackage.supplierSkuId,
    parentCandidateId: "candidate:synthetic-parent", parentCardBinding: {
      descriptionCategoryId: 17028665, typeId: 92935, model: "synthetic-model", brand: "synthetic-brand",
      parentImageSha256s: ["a".repeat(64)] } };
  return { candidate, rights: fixture.checked.c1ProductPlan.inputSnapshots.skuRightsReview };
}

test("missing sibling colors cannot durably freeze C1 facts while mapping remains editable", async () => {
  const { candidate, rights } = siblingInput();
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-c1-color", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const original = await repository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "c1_verify_facts_from_owner_declaration",
    candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, idempotencyKey: "synthetic:sibling-freeze",
    inputFingerprint: "synthetic:sibling-freeze", auditEventId: "synthetic:sibling-freeze-audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } }), /SIBLING_COLOR_BINDING_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), original);
  assert.equal((await repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
});

test("ordinary SKU fact freeze remains available without sibling color mappings", async () => {
  const { candidate, rights } = siblingInput();
  delete candidate.siblingSourceV1;
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "ordinary-c1", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const frozen = await executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "c1_verify_ordinary_facts",
    candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision, idempotencyKey: "synthetic:ordinary-freeze",
    inputFingerprint: "synthetic:ordinary-freeze", auditEventId: "synthetic:ordinary-freeze-audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } });
  assert.equal(frozen.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, candidate.dataRevision + 1);
});

test("frozen sibling color gap creates a new editable C1 revision with an immutable predecessor", async () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-revision", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const useCase = createC1SiblingColorRevisionUseCase({ repository, runtimeMode: "local_development", serverClock: () => AT });
  const input = { candidateId: candidate.id, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: candidate.dataRevision };
  const first = await useCase.prepare({ actor, input });
  assert.equal(first.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.notEqual(first.candidate.lifecycleV11.skuPackage.c1ProductPlan.c1PlanId,
    candidate.lifecycleV11.skuPackage.c1ProductPlan.c1PlanId);
  assert.equal(first.candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1, undefined);
  const document = await repository.readSnapshot();
  assert.deepEqual(document.c1SiblingColorRevisionHistoryRecords[0].previousSkuPackage,
    candidate.lifecycleV11.skuPackage);
  assert.equal((await useCase.prepare({ actor, input })).status, "idempotent_replay");
  assert.equal((await repository.readSnapshot()).c1SiblingColorRevisionHistoryRecords.length, 1);
});

test("owner maps both schema typed colors before a sibling C1 freeze", async () => {
  const { candidate, rights } = siblingInput();
  candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes = [
    { fieldKey: "10096", label: "Цвет товара", labelZh: "商品颜色", required: false, complexId: 0, dictionaryId: 1494 },
    { fieldKey: "10097", label: "Название цвета", labelZh: "颜色名称", required: false, complexId: 0, dictionaryId: 0 }
  ];
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-map", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const useCase = createC1OzonAttributeMappingUseCase({ repository, runtimeMode: "local_development",
    serverClock: () => AT, readDictionaryValue: async ({ attributeId, value }) => {
      assert.equal(attributeId, "10096");
      assert.equal(value, "synthetic-broad-color");
      return { evidenceData: { exactMatch: { value, dictionaryValueId: 910096 } }, sourceRef: "synthetic:dictionary:10096" };
    } });
  const preview = await useCase.propose({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: candidate.dataRevision } });
  const source = preview.confirmedFacts.filter(fact => fact.value === "黑cp" &&
    fact.factPath.startsWith("productAttributes.supplierAttributes."));
  assert.equal(source.length, 1);
  const mapped = await useCase.map({ actor, input: { candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: candidate.dataRevision,
    mappings: [
      { attributeId: "10096", value: "synthetic-broad-color", sourceFactPath: source[0].factPath },
      { attributeId: "10097", value: "synthetic-exact-color", sourceFactPath: source[0].factPath }
    ], idempotencyKey: "synthetic:map-both", auditEventId: "synthetic:map-both:audit" } });
  assert.deepEqual(mapped.result.mappedAttributeIds, ["10096", "10097"]);
  const frozen = await executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "synthetic_freeze_both_colors", candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: mapped.candidate.dataRevision,
    idempotencyKey: "synthetic:freeze-both", inputFingerprint: "synthetic:freeze-both",
    auditEventId: "synthetic:freeze-both:audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage = verifyC1ProductFacts({ skuPackage: staged.lifecycleV11.skuPackage,
        skuRightsReview: rights, verifiedAt: AT }).skuPackage;
      return { candidate: staged, result: { status: "facts_checked" } };
    } });
  assert.equal(frozen.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "facts_checked");
  assert.doesNotThrow(() => assertSiblingSkuColorProjection(frozen.candidate));
});

test("C2 transition still rejects a frozen sibling without the two color bindings", async () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate] });
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "sibling-c2", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: AT });
  const original = await repository.readSnapshot();
  await assert.rejects(() => executeBusinessMutation({ repository, runtimeMode: "local_development", actor,
    requiredRoles: ["owner"], action: "synthetic_c2_transition", candidateId: candidate.id,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId, expectedRevision: candidate.dataRevision,
    idempotencyKey: "synthetic:c2-gap", inputFingerprint: "synthetic:c2-gap",
    auditEventId: "synthetic:c2-gap:audit", serverClock: () => AT,
    mutate: ({ candidate: staged }) => {
      staged.lifecycleV11.skuPackage.businessPhase = "C2";
      return { candidate: staged, result: { status: "C2" } };
    } }), /SIBLING_COLOR_BINDING_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), original);
});

test("color revision refuses in-flight, unknown, sent and authorized predecessor states", () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1DraftFixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.checked.skuPackage);
  const prepare = relatedSoftwareJobs => prepareC1SiblingColorRevision({ candidate,
    expectedRevision: candidate.dataRevision, relatedSoftwareJobs, preparedAt: AT });
  for (const job of [
    { status: "queued", externalRequestState: "not_sent" },
    { status: "claimed", externalRequestState: "not_sent" },
    { status: "unknown_outcome", externalRequestState: "unknown_outcome" },
    { status: "failed", externalRequestState: "sent" }
  ]) assert.throws(() => prepare([job]), /C1_SIBLING_COLOR_REVISION_JOB_UNSETTLED/);
  candidate.lifecycleV11.skuPackage.productionAuthorization = { synthetic: true };
  assert.throws(() => prepare([]), /C1_SIBLING_COLOR_REVISION_PRODUCTION_STARTED/);
});

test("C2 color repair returns to fresh C1 without carrying prior C2 assets or job references", () => {
  const { candidate } = siblingInput();
  const fixture = createFormalC1C2Fixture({ variantKey: "颜色:黑cp", skuAttributes: { 颜色: "黑cp" } });
  candidate.lifecycleV11.skuPackage = structuredClone(fixture.c2.skuPackage);
  candidate.lifecycleV11.c1AiDraftJobRefV1 = { jobId: "synthetic:old-job" };
  candidate.lifecycleV11.c2UploadDraft = { revision: 1, uploads: [{ assetId: "synthetic:old-image" }] };
  const result = prepareC1SiblingColorRevision({ candidate, expectedRevision: candidate.dataRevision,
    relatedSoftwareJobs: [{ status: "completed", externalRequestState: "succeeded" }], preparedAt: AT });
  const current = result.candidate.lifecycleV11;
  assert.equal(current.skuPackage.businessPhase, "C1");
  assert.equal(current.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(current.skuPackage.c2FinalAssets, null);
  assert.equal(current.c1AiDraftJobRefV1, undefined);
  assert.equal(current.c2UploadDraft, undefined);
  assert.deepEqual(result.historyRecord.previousSkuPackage, candidate.lifecycleV11.skuPackage);
  assert.deepEqual(result.historyRecord.previousC1References.c2UploadDraft, candidate.lifecycleV11.c2UploadDraft);
});
