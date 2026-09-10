import { currentOtherCosts } from './fixtures/real-a-b-flow-fixture.mjs';
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runRealAConfirmationToBAndC1, assertCurrentBCommissionEvidence } from "../lib/real-a-b-c1-flow.mjs";
import { buildRealAConfirmationCard } from "../lib/real-a-confirmation-card.mjs";

import { confirmedAt, candidate, submission, evidencePacks, addEvidenceContext } from "./fixtures/real-a-b-flow-fixture.mjs";

test("真实A一次确认原子生成Opportunity、SKU、B利润和唯一C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const before = JSON.stringify(source);
  const card = buildRealAConfirmationCard(source);
  const result = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidencePacks(),
    confirmedAt
  });

  assert.equal(result.decision, "confirm");
  assert.equal(result.opportunityPackage.businessResult, "passed");
  assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
  assert.equal(result.skuPackage.supplierSkuId, "SKU-SEWING-MACHINE-01");
  assert.equal(result.profitModel.result, "passed");
  assert.equal(result.profitModel.thresholdVersion, "profit-threshold-v1.2-15pct-or-20cny");
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(result.c1Handoff.trigger, "b_passed_auto_c1");
  assert.equal(result.c1Handoff.uniqueOwner, "listing_task");
  assert.equal(result.c1Handoff.selectionTaskStopped, true);
  assert.equal(result.c1Handoff.skuPackageId, result.skuPackage.skuPackageId);
  assert.equal(result.c1Handoff.inheritedSkuRevision, result.skuPackage.dataRevision);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.taskDispatches, 0);
  assert.deepEqual(result.externalAccesses, []);
  assert.equal(result.platformWrites, 0);
  assert.equal(JSON.stringify(source), before);
});

test("系统B证据不齐时整轮拒绝且不产生半成品生命周期", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const before = JSON.stringify(source);
  assert.throws(() => runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidencePacks().slice(0, 1),
    confirmedAt
  }), /REAL_A_SYSTEM_EVIDENCE_GAP.*国际物流.*汇率.*Schema/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.lifecycleV11?.skuPackage, undefined);
});

test("B未达利润门槛时不创建C1交接", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const evidence = evidencePacks({ logistics: { perParcelRmb: 105 } });
  const result = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: submission(card),
    evidencePacks: evidence,
    confirmedAt
  });
  assert.equal(result.profitModel.result, "rejected");
  assert.equal(result.skuPackage.businessPhase, "B");
  assert.equal(result.skuPackage.c1ProductPlan, null);
  assert.equal(result.c1Handoff, null);
  assert.equal(result.uniqueOwner, "none");
});

test("A供货确认保留，估算佣金无论数值高低均不形成正式B或C1", async () => {
  for (const perParcelRmb of [18, 105]) {
    const source = addEvidenceContext(await candidate());
    const before = JSON.stringify(source);
    const packs = evidencePacks({ logistics: { perParcelRmb } });
    Object.assign(packs[0].evidenceData, {
      commissionEvidenceMode: "estimated", estimateAuthorized: true,
      commissionEstimateAuthorization: {
        schemaVersion: "commission-estimate-authorization-v1", candidateId: source.id,
        candidateRevision: source.dataRevision, authorizationRef: "fixture:owner-commission-estimate",
        commissionRate: packs[0].evidenceData.commissionRate
      }
    });
    const result = runRealAConfirmationToBAndC1({
      candidate: source, otherCosts: currentOtherCosts(source), submission: submission(buildRealAConfirmationCard(source)), evidencePacks: packs, confirmedAt
    });
    assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
    assert.equal(result.profitModel.result, "manual_review");
    assert.equal(result.profitModel.calculationType, "conditional");
    assert.equal(result.skuPackage.businessResult, "manual_review");
    assert.equal(result.skuPackage.businessPhase, "B");
    assert.equal(result.skuPackage.c1ProductPlan, null);
    assert.equal(result.c1Handoff, null);
    assert.equal(result.platformWrites, 0);
    assert.equal(result.taskDispatches, 0);
    assert.deepEqual(result.externalAccesses, []);
    assert.equal(JSON.stringify(source), before);
  }
});

test("同一A确认结果落盘后重放保持SKU、利润版本、修订号和唯一C1交接不变", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const input = submission(card);
  const first = runRealAConfirmationToBAndC1({
    candidate: source, otherCosts: currentOtherCosts(source),
    submission: input,
    evidencePacks: evidencePacks(),
    confirmedAt
  });
  const persisted = structuredClone(source);
  persisted.dataRevision += 1;
  persisted.lifecycleV11 = {
    schemaVersion: "product-lifecycle-v1.1",
    status: "b_passed_auto_c1",
    aConfirmationReceipt: {
      receiptId: first.confirmationReceiptId,
      decision: "confirm",
      sourceCandidateRevision: first.sourceCandidateRevision,
      confirmedAt
    },
    opportunityPackage: structuredClone(first.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.systemEvidenceBundle),
    skuPackage: structuredClone(first.skuPackage),
    c1Handoffs: [structuredClone(first.c1Handoff)]
  };
  const replay = runRealAConfirmationToBAndC1({
    candidate: persisted,
    submission: { ...input, sourceDataRevision: persisted.dataRevision, dataRevision: persisted.dataRevision },
    evidencePacks: evidencePacks(),
    confirmedAt
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.skuPackage.skuPackageId, first.skuPackage.skuPackageId);
  assert.equal(replay.skuPackage.dataRevision, first.skuPackage.dataRevision);
  assert.deepEqual(replay.skuPackage.profitModels, first.skuPackage.profitModels);
  assert.deepEqual(replay.c1Handoff, first.c1Handoff);
  assert.equal(replay.taskDispatches, 0);
  for (const mutate of [
    value => { value.lifecycleV11.skuPackage.g1Identity.storeRef.platformStoreId = "another"; },
    value => { value.lifecycleV11.bSystemEvidenceBundle.context.storeRef.mappingVersion = "another"; },
    value => { delete value.lifecycleV11.bSystemEvidenceBundle.context.storeRef; },
    value => { delete value.lifecycleV11.bSystemEvidenceBundle; },
    value => { delete value.lifecycleV11.aConfirmationReceipt.sourceCandidateRevision; }
  ]) {
    const stale = structuredClone(persisted); mutate(stale);
    const before = structuredClone(stale);
    assert.throws(() => runRealAConfirmationToBAndC1({ candidate: stale,
      submission: { ...input, sourceDataRevision: stale.dataRevision, dataRevision: stale.dataRevision }, evidencePacks: [], confirmedAt }), /EXISTING_LIFECYCLE_INVALID|SYSTEM_EVIDENCE_GAP/);
    assert.deepEqual(stale, before);
  }
});

test("已有生命周期与重复A输入不一致时拒绝而不产生第二利润版本或C1", async () => {
  const source = addEvidenceContext(await candidate());
  const card = buildRealAConfirmationCard(source);
  const first = runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source), submission: submission(card), evidencePacks: evidencePacks(), confirmedAt });
  source.lifecycleV11 = {
    aConfirmationReceipt: { receiptId: first.confirmationReceiptId, sourceCandidateRevision: first.sourceCandidateRevision },
    opportunityPackage: structuredClone(first.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.systemEvidenceBundle),
    skuPackage: structuredClone(first.skuPackage),
    c1Handoffs: [structuredClone(first.c1Handoff)]
  };
  const changed = submission(card);
  changed.supplierConfirmation.variantKey = "另一个SKU";
  assert.throws(() => runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source), submission: changed, evidencePacks: evidencePacks(), confirmedAt }), /ALREADY_CONFIRMED_CONFLICT/);
});


function wbFinalCommissionFixture() {
  const pack = structuredClone(evidencePacks().find(value => value.kind === "commission"));
  pack.scope = { ...pack.scope, platform: "wb", store: "wb", storeRef: { ...pack.scope.storeRef, stableStoreId: "wb" }, category: "wb:subject:5267", salesScheme: "fbs" };
  pack.sourceType = "wb_official_commission_reference"; pack.expiresAt = null;
  pack.commissionCatalogRef = { catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", sellerRegion: "CN",
    subjectId: 5267, sourceField: "kgvpChina", sourceReceiptRef: "synthetic-official-receipt", effectiveFrom: null };
  const bundle = { context: structuredClone(pack.scope), platformFeeEvidence: { evidenceId: pack.id,
    commissionRate: pack.evidenceData.commissionRate, commissionEvidenceMode: "exact", commissionCatalogRef: structuredClone(pack.commissionCatalogRef) } };
  const catalogs = [{ platform: "wb", sellerRegion: "CN", catalogId: "synthetic-wb-catalog", catalogVersion: "synthetic-version-1", status: "active" }];
  return { pack, bundle, catalogs };
}

test("B提交最终检查读取最新WB目录，拒绝准备后失效或换版并保持冻结历史不变", () => {
  const f = wbFinalCommissionFixture();
  const original = JSON.stringify(f);
  const input = { bundle: f.bundle, evidencePacks: [f.pack], currentCommissionCatalogs: f.catalogs, asOf: confirmedAt };
  assert.equal(assertCurrentBCommissionEvidence(input), undefined);
  for (const [catalogs, code] of [[[{ ...f.catalogs[0], status: "invalidated" }], "B_COMMISSION_CATALOG_INVALIDATED"],
    [[{ ...f.catalogs[0], catalogVersion: "replacement" }], "B_COMMISSION_CATALOG_VERSION_MISMATCH"],
    [[], "B_COMMISSION_CATALOG_MISSING"]]) {
    assert.throws(() => assertCurrentBCommissionEvidence({ ...input, currentCommissionCatalogs: catalogs }), error => error.code === code);
  }
  assert.equal(JSON.stringify(f), original);
});

test("B最终检查拒绝缺包、重复ID、同ID换包或跨平台来源", () => {
  const f = wbFinalCommissionFixture();
  const input = { bundle: f.bundle, evidencePacks: [f.pack], currentCommissionCatalogs: f.catalogs, asOf: confirmedAt };
  assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [] }), error => error.code === "B_COMMISSION_EVIDENCE_MISSING");
  assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [f.pack, f.pack] }), error => error.code === "B_COMMISSION_EVIDENCE_AMBIGUOUS");
  for (const change of [pack => { pack.scope.platform = "ozon"; }, pack => { pack.evidenceData.commissionRate = 0.99; },
    pack => { pack.commissionCatalogRef.catalogVersion = "replacement"; }]) {
    const changed = structuredClone(f.pack); change(changed);
    assert.throws(() => assertCurrentBCommissionEvidence({ ...input, evidencePacks: [changed] }), error => error.code === "B_COMMISSION_SOURCE_CONFLICT");
  }
});

 test('shared commission and schema never carry one SKU packaging cost into another SKU profit', async () => {
  const shared = evidencePacks(), before = JSON.stringify(shared), results = [];
  for (const [id, packagingCostRmb] of [['synthetic-packaging-a', 1.5], ['synthetic-packaging-b', 9.5]]) {
    const source = addEvidenceContext(await candidate()); Object.assign(source, { id, packagingCostRmb });
    results.push(runRealAConfirmationToBAndC1({ candidate: source, otherCosts: currentOtherCosts(source),
      submission: submission(buildRealAConfirmationCard(source)), evidencePacks: shared, confirmedAt }));
  }
  assert.deepEqual(results.map(result => result.systemEvidenceBundle.platformFeeEvidence.otherCosts.packagingRmb), [1.5, 9.5]);
  assert.equal(Number((results[0].profitModel.unitProfitRmb - results[1].profitModel.unitProfitRmb).toFixed(2)), 8);
  assert.equal(results[0].systemEvidenceBundle.platformFeeEvidence.evidenceId, results[1].systemEvidenceBundle.platformFeeEvidence.evidenceId);
  assert.equal(results[0].systemEvidenceBundle.platformSchemaEvidence.evidenceId, results[1].systemEvidenceBundle.platformSchemaEvidence.evidenceId);
  assert.equal(JSON.stringify(shared), before);
  assert.ok(results.every(result => result.externalAccesses.length === 0));
});
