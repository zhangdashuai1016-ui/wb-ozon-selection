import assert from "node:assert/strict";
import test from "node:test";

import { buildC1FactKeywordAtomicPatch } from "../lib/c1-fact-keyword-persistence.mjs";

function candidate() {
  return {
    id: "CX-PERSIST-001",
    dataRevision: 12,
    businessResult: "passed",
    processing: { state: "idle", manualHold: false },
    listingPreparation: { status: "c1_inputs_ready" },
    lifecycleV11: {
      status: "b_passed_auto_c1",
      skuPackage: { skuPackageId: "sku:1", dataRevision: 4, businessPhase: "C1" }
    }
  };
}

function prepared() {
  return {
    result: {
      status: "ready_for_atomic_persist",
      skuPackage: { skuPackageId: "sku:1", dataRevision: 5, businessPhase: "C1" },
      keywordPreparation: { preparationId: "k2:1" },
      k3KeywordEvidenceSnapshot: { snapshotId: "k3:1" },
      k3CurrentBinding: { skuPackageId: "sku:1" },
      evidenceStage: { evidence: { evidenceFingerprint: "evidence:1" } }
    },
    receipt: { receiptFingerprint: "receipt:1" }
  };
}

test("完整结果生成一个原子补丁并保留B业务结论", () => {
  const before = candidate();
  const patch = buildC1FactKeywordAtomicPatch({
    candidate: before,
    expectedRevision: 12,
    sourceSkuPackage: before.lifecycleV11.skuPackage,
    prepared: prepared(),
    triggerReceipt: { eventId: "keyword-ready:1", receiptFingerprint: "trigger:1" },
    stagedAt: "2026-08-24T00:00:00.000Z"
  });
  assert.equal(patch.nextRevision, 13);
  assert.equal(patch.lifecycleV11.status, "c1_evidence_ready");
  assert.equal(patch.lifecycleV11.skuPackage.dataRevision, 5);
  assert.equal(patch.lifecycleV11.keywordEvidencePreparationV1.preparationId, "k2:1");
  assert.equal(patch.lifecycleV11.k3KeywordEvidenceSnapshotV1.snapshotId, "k3:1");
  assert.equal(patch.lifecycleV11.c1SoftwareEvidenceV1.evidenceFingerprint, "evidence:1");
  assert.equal(patch.lifecycleV11.c1KeywordEvidenceAutoTriggerV1.eventId, "keyword-ready:1");
  assert.equal(before.businessResult, "passed");
  assert.equal(before.lifecycleV11.status, "b_passed_auto_c1");
});

test("半套结果、candidate revision或SKU漂移全部拒绝且不修改原对象", () => {
  for (const change of [
    ({ value }) => { value.result.k3KeywordEvidenceSnapshot = null; },
    ({ args }) => { args.expectedRevision = 13; },
    ({ args }) => { args.sourceSkuPackage = { skuPackageId: "other", dataRevision: 4 }; }
  ]) {
    const before = candidate();
    const snapshot = structuredClone(before);
    const value = prepared();
    const args = {
      candidate: before,
      expectedRevision: 12,
      sourceSkuPackage: before.lifecycleV11.skuPackage,
      prepared: value,
      stagedAt: "2026-08-24T00:00:00.000Z"
    };
    change({ value, args });
    assert.throws(() => buildC1FactKeywordAtomicPatch(args), /PERSISTENCE_/);
    assert.deepEqual(before, snapshot);
  }
});
