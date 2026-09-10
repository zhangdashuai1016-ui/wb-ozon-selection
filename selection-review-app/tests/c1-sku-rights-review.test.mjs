import { fingerprintProductionAuthorization } from "../lib/production-plan.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { C1_SKU_RIGHTS_REVIEW_SCHEMA, C1SkuRightsReviewError, validateC1SkuRightsReview, assertCurrentC1SkuRightsReview, buildC1SkuRightsReviewView } from "../lib/c1-sku-rights-review.mjs";
import { verifyC1ProductFacts, validateC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { assertCurrentC1AiDraftRequest } from "../lib/c1-ai-draft-contract.mjs";
import { normalizeC1CanonicalHandoffContract, createC2AssetLifecycle } from "../lib/c2-asset-lifecycle.mjs";
import { createC2SoftwareContainer, prepareC2FinalUploadManifest } from "../lib/c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "../lib/final-product-plan-confirmation-card.mjs";
import { createProductionAuthorization, assertCurrentProductionAuthorization, assertValidProductionAuthorization } from "../lib/production-authorization.mjs";
import { createFormalC1DraftFixture, createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { packageFixture } from "./fixtures/c2-source-package-fixture.mjs";
import { syntheticSkuRightsReview, SYNTHETIC_LICENSED_BRAND, SYNTHETIC_LICENSED_RIGHTS, SYNTHETIC_UNBRANDED, SYNTHETIC_NO_THIRD_PARTY_RIGHTS } from "./fixtures/c1-sku-rights-review-fixture.mjs";
import { productionAuthorizationInputFixture, finalAssets } from "./helpers/c2-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";

const AT = "2026-08-12T13:00:00.000Z";
const EXPIRES = "2026-08-22T08:00:00.000Z";
function reviewFor(created, options = {}) {
  return syntheticSkuRightsReview({ plan: created.c1ProductPlan, sourceIdentity: created.skuPackage.g1Identity, reviewedAt: AT,
    brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS, ...options });
}
function gate(skuPackage, observedAt = AT) {
  return assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt });
}
function hasCode(code) { return error => error instanceof C1SkuRightsReviewError && error.code === code; }

test("explicit scoped synthetic rights freeze before receipt, retain the original four inputs, and traverse real C1/C2", () => {
  const f = createFormalC1C2Fixture();
  const plan = f.checked.c1ProductPlan;
  assert.equal(plan.factVerificationVersion, "c1-fact-verification-v1.2");
  for (const key of Object.keys(f.created.c1ProductPlan.inputSnapshots)) assert.deepEqual(plan.inputSnapshots[key], f.created.c1ProductPlan.inputSnapshots[key]);
  assert.equal(plan.inputSnapshots.skuRightsReview.sourceSkuRevision, f.created.skuPackage.dataRevision);
  assert.equal(plan.inputSnapshots.skuRightsReview.brand.status, "branded");
  assert.deepEqual(plan.platformCompliance.skuRightsReview.rights.sourceRefs, ["evidence:synthetic:licence-review"]);
  assert.equal(gate(f.c2.skuPackage).rights.status, "verified");
  assert.deepEqual(buildC1SkuRightsReviewView({ plan, sourceIdentity: f.checked.skuPackage.g1Identity, observedAt: AT }), { status: "verified", code: null });
  assert.equal(f.c2.skuPackage.businessPhase, "C2");
  assert.deepEqual(plan.externalAccesses, []);
  assert.equal(f.receipt.externalPlatformAccesses, 0);
  assert.equal(f.receipt.productionWrites, 0);
});

test("missing, unknown and known rights risks stay distinct and cannot enter current C2", () => {
  const { created } = createFormalC1DraftFixture();
  for (const [review, code] of [
    [null, "C1_SKU_RIGHTS_REVIEW_REQUIRED"],
    [reviewFor(created, { brand: { status: "unknown", name: null, evidenceRefs: [] }, rights: { status: "unknown", basis: null, evidenceRefs: [] } }), "C1_SKU_RIGHTS_REVIEW_UNKNOWN"],
    [reviewFor(created, { rights: { status: "blocked", basis: null, evidenceRefs: ["evidence:synthetic:blocked"] } }), "C1_SKU_RIGHTS_REVIEW_BLOCKED"],
    [reviewFor(created, { rights: { status: "requires_authorization", basis: null, evidenceRefs: ["evidence:synthetic:permission-required"] } }), "C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED"]
  ]) {
    const checked = verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview: review, verifiedAt: AT });
    assert.equal(validateC1ProductPlan(checked.c1ProductPlan).valid, true);
    assert.throws(() => gate(checked.skuPackage), hasCode(code));
    assert.throws(() => createC2AssetLifecycle({ skuPackage: checked.skuPackage, createdAt: AT }), hasCode(code));
    if (!review || review.rights.status === "unknown") assert.equal(checked.c1ProductPlan.unknownManifest.some(item => item.blocksC2Handoff && item.fieldPath.includes("skuRightsReview")), true);
    else assert.equal(checked.c1ProductPlan.platformCompliance.skuRightsReview.rights.value.status, review.rights.status);
  }
});

test("review binds candidate, full store, exact supplier SKU, variant, actual revision and frozen supply snapshot", () => {
  const { created } = createFormalC1DraftFixture();
  const mutations = [
    r => r.sourceIdentity.candidateId = "candidate:other",
    r => r.sourceIdentity.skuPackageId = "sku:other",
    r => r.sourceIdentity.supplierSkuId = "sku:other",
    r => r.sourceIdentity.platform = "wb",
    r => r.sourceIdentity.storeRef.stableStoreId = "miska",
    r => r.sourceIdentity.storeRef.platformStoreId = "seller-other",
    r => r.sourceIdentity.storeRef.mappingVersion = "stores-v2",
    r => r.variantKey = "颜色:红色",
    r => r.sourceSkuRevision += 1,
    r => r.sourceSupplySnapshotId = "supply:other"
  ];
  const before = JSON.stringify(created.skuPackage);
  for (const mutate of mutations) {
    const review = reviewFor(created); mutate(review);
    assert.throws(() => verifyC1ProductFacts({ skuPackage: created.skuPackage, skuRightsReview: review, verifiedAt: AT }), hasCode("C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH"));
    assert.equal(JSON.stringify(created.skuPackage), before);
  }
});

test("expiry uses each action clock and an already saved authorization cannot reuse its old authorization time", () => {
  const f = createFormalC1C2Fixture({ rightsReviewOptions: { brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS, expiresAt: EXPIRES } });
  assert.throws(() => gate(f.checked.skuPackage, "2026-08-12T12:59:59.999Z"), hasCode("C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID"));
  assert.throws(() => gate(f.checked.skuPackage, EXPIRES), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  assert.throws(() => gate(f.checked.skuPackage, "2026-02-30T00:00:00.000Z"), hasCode("C1_SKU_RIGHTS_REVIEW_TIME_INVALID"));
  const expiredReview = reviewFor(f.created, { expiresAt: AT });
  assert.equal(validateC1SkuRightsReview(expiredReview).valid, false);
  assert.throws(() => createC2SoftwareContainer({ skuPackage: f.merged.skuPackage, expectedDataRevision: f.merged.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: EXPIRES }), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  assert.throws(() => prepareC2FinalUploadManifest({ skuPackage: f.c2.skuPackage, expectedDataRevision: f.c2.skuPackage.dataRevision,
    finalUploadAssets: finalAssets(), preparedAt: EXPIRES }), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  const input = productionAuthorizationInputFixture({ sourceSkuPackage: f.merged.skuPackage });
  const withoutCard = structuredClone(input.skuPackage); withoutCard.productionConfirmationCard = null;
  assert.throws(() => createFinalProductPlanConfirmationCard({ skuPackage: withoutCard, createdAt: EXPIRES }), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  assert.throws(() => createProductionAuthorization({ ...input, authorizedAt: EXPIRES }), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  const { productionAuthorization } = createProductionAuthorization(input);
  const bytes = JSON.stringify(productionAuthorization), fingerprint = fingerprintProductionAuthorization(productionAuthorization);
  assertValidProductionAuthorization(productionAuthorization);
  assertCurrentProductionAuthorization(productionAuthorization, { observedAt: input.authorizedAt });
  assert.throws(() => assertCurrentProductionAuthorization(productionAuthorization, { observedAt: EXPIRES }), hasCode("C1_SKU_RIGHTS_REVIEW_EXPIRED"));
  assert.equal(JSON.stringify(productionAuthorization), bytes);
  assert.equal(fingerprintProductionAuthorization(productionAuthorization), fingerprint);
});

test("brand names and no-brand labels cannot contradict independently supplied rights evidence", () => {
  assert.throws(() => createFormalC1DraftFixture({ skuAttributes: { brand: "Actual observed brand" } }), hasCode("C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT"));
  assert.throws(() => createFormalC1DraftFixture({ skuAttributes: { 品牌: "Actual observed brand" }, rightsReviewOptions: { brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS } }), hasCode("C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT"));
  assert.throws(() => createFormalC1DraftFixture({ skuAttributes: { brand: "Нет бренда" } }), hasCode("C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT"));
  const f = createFormalC1C2Fixture({ skuAttributes: { brand: "Нет бренда" }, rightsReviewOptions: { brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS } });
  assert.equal(gate(f.c2.skuPackage).rights.basis, "no_third_party_rights_identified");
});

test("malformed frozen schema fields produce typed rights failures and an invalid view without mutating evidence", () => {
  const { checked } = createFormalC1DraftFixture();
  const malformedFields = [null, {}, "brand", true, [null], ["brand"], [[]], [{}], [{ fieldKey: 1 }], Array(1),
    [{ fieldKey: " " }], [{ fieldKey: "brand", label: null, required: true }],
    [{ fieldKey: "brand", label: " ", required: true }], [{ fieldKey: "brand", label: "品牌", required: "true" }],
    [{ fieldKey: "brand", label: "品牌", required: true }, { fieldKey: "brand", label: "品牌", required: true }]];
  const malformedKeys = [null, {}, "brand", true, 1, [null], [{}], [[]], [1], [" "], Array(1)];
  const cases = [
    ...malformedFields.map((value, index) => [`requiredFields case ${index}`, schema => { schema.requiredFields = value; }]),
    ...malformedKeys.flatMap((value, index) => ["brand", "material"].map(fieldKey => [
      `${fieldKey} sourceAttributeKeys case ${index}`,
      schema => { schema.requiredFields = [{ fieldKey, label: fieldKey, required: true, sourceAttributeKeys: value }]; }
    ]))
  ];
  for (const [label, corrupt] of cases) {
    const invalid = structuredClone(checked.skuPackage);
    corrupt(invalid.c1ProductPlan.inputSnapshots.platformSchemaRules);
    const before = structuredClone(invalid);
    assert.throws(() => gate(invalid), hasCode("C1_SKU_RIGHTS_REVIEW_INVALID"), label);
    assert.deepEqual(buildC1SkuRightsReviewView({ plan: invalid.c1ProductPlan,
      sourceIdentity: invalid.g1Identity, observedAt: AT }),
    { status: "invalid", code: "C1_SKU_RIGHTS_REVIEW_INVALID" }, label);
    assert.deepEqual(invalid, before, label);
  }
});

test("omitted and empty source attribute mappings retain their existing valid meaning", () => {
  const { checked } = createFormalC1DraftFixture();
  for (const omit of [true, false]) {
    const skuPackage = structuredClone(checked.skuPackage);
    const field = { fieldKey: "brand", label: "品牌", required: true, sourceAttributeKeys: ["brand"] };
    skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.requiredFields = [field];
    if (omit) delete field.sourceAttributeKeys;
    else field.sourceAttributeKeys = [];
    assert.equal(gate(skuPackage).rights.status, "verified");
    assert.deepEqual(validateC1ProductPlan(skuPackage.c1ProductPlan), { valid: true, errors: [] });
  }
});

test("historical C1 remains readable, incomplete views are typed, and new frozen evidence cannot be patched or replayed", () => {
  const old = packageFixture({ historicalC1: true });
  assert.equal(validateC1ProductPlan(old.c1ProductPlan).valid, true);
  assert.equal(Object.hasOwn(old.c1ProductPlan.inputSnapshots, "skuRightsReview"), false);
  assert.doesNotThrow(() => normalizeC1CanonicalHandoffContract(old));
  assert.throws(() => gate(old, "2026-08-22T06:00:00.000Z"), hasCode("C1_SKU_RIGHTS_REVIEW_REQUIRED"));
  for (const plan of [null, { factVerificationVersion: "c1-fact-verification-v1.2" }]) {
    assert.deepEqual(buildC1SkuRightsReviewView({ plan, sourceIdentity: old.g1Identity, observedAt: AT }), { status: "unknown", code: "C1_SKU_RIGHTS_REVIEW_REQUIRED" });
  }
  const f = createFormalC1DraftFixture();
  assert.throws(() => verifyC1ProductFacts({ skuPackage: f.checked.skuPackage, skuRightsReview: reviewFor(f.created), verifiedAt: AT }), /C1_SKU_RIGHTS_REVIEW_ALREADY_FROZEN|C1_FACT_GATE_REJECTED/);
  const drift = structuredClone(f.checked.skuPackage);
  drift.c1ProductPlan.inputSnapshots.skuRightsReview.reviewId = "review:changed";
  assert.throws(() => assertCurrentC1AiDraftRequest({ skuPackage: drift, request: f.request }), /C1_AI_FACT_DRIFT_DETECTED/);
  const projectionDrift = structuredClone(f.checked.skuPackage);
  projectionDrift.c1ProductPlan.platformCompliance.skuRightsReview.rights.value.basis = "owned";
  assert.equal(validateC1ProductPlan(projectionDrift.c1ProductPlan).valid, false);
  assert.throws(() => gate(projectionDrift), hasCode("C1_SKU_RIGHTS_REVIEW_PROJECTION_DRIFT"));
});

test("published closed rights schema matches required fields and rejects unsafe, unbound and ambiguous evidence", async () => {
  const ajv = await loadPublishedSchemaValidator(), validate = ajv.getSchema("c1-sku-rights-review-v1");
  assert.deepEqual(JSON.parse(await readFile(new URL("../schema/c1-sku-rights-review-v1.schema.json", import.meta.url), "utf8")), C1_SKU_RIGHTS_REVIEW_SCHEMA);
  const f = createFormalC1DraftFixture(), source = f.checked.c1ProductPlan.inputSnapshots.skuRightsReview;
  assert.equal(validate(source), true, JSON.stringify(validate.errors));
  assert.equal(validateC1SkuRightsReview(source).valid, true);
  for (const mutate of [r => r.unexpectedControl = { productionApproved: true }, r => r.brand.extra = true,
    r => r.sourceIdentity.storeRef.extra = true, r => delete r.sourceIdentity.storeRef.mappingVersion,
    r => r.sourceIdentity.storeRef.mappingVersion = "m".repeat(201), r => r.reviewId = "UNKNOWN", r => r.brand.evidenceRefs = [],
    r => r.rights.evidenceRefs = [], r => r.rights.evidenceRefs = ["https://example.test/licence"],
    r => r.brand.status = "unbranded", r => r.rights.basis = "no_third_party_rights_identified",
    r => r.sourceSkuRevision = -1, r => r.reviewedAt = "2026-02-30T00:00:00.000Z"] ) {
    const invalid = structuredClone(source); mutate(invalid);
    assert.equal(validateC1SkuRightsReview(invalid).valid, false);
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
  const unsafe = structuredClone(source); unsafe.brand.name = "token=private-value";
  assert.equal(validateC1SkuRightsReview(unsafe).valid, false);
  const invalid = structuredClone(f.checked.skuPackage); invalid.c1ProductPlan.inputSnapshots.skuRightsReview = unsafe;
  assert.throws(() => gate(invalid), error => error instanceof C1SkuRightsReviewError && !JSON.stringify(error).includes("private-value") && !error.message.includes("private-value"));
});
