import assert from "node:assert/strict";
import test from "node:test";

import {
  createKeywordEvidenceSoftwareJobIntent,
  legacyKeywordJobBlocksPaidExecution,
  reconcileKeywordEvidenceSoftwareJobAfterRestart,
  settleKeywordEvidenceSoftwareJob
} from "../lib/keyword-evidence-software-job-state.mjs";

const NOW = "2026-08-24T12:00:00.000Z";
function candidate(revision = 8) { return { id: "CX-MUSIC-JOB", dataRevision: revision, lifecycleV11: { skuPackage: { businessPhase: "C1", skuPackageId: "sku:music:8" } } }; }

test("旧候选内作业意图已退役，任何新创建均显式拒绝", () => {
  assert.throws(() => createKeywordEvidenceSoftwareJobIntent({ candidate: candidate(), expectedRevision: 8, jobId: "job:music:8", inputFingerprint: "a".repeat(64), createdAt: NOW }), /INTENT_RETIRED/);
  assert.throws(() => createKeywordEvidenceSoftwareJobIntent(), /INTENT_RETIRED/);
});

test("相同revision和并发作业均拒绝，不能双跑", () => {
  const current = candidate();
  current.lifecycleV11.keywordEvidenceSoftwareJobV1 = { sourceRevision: 8, status: "failed" };
  assert.throws(() => createKeywordEvidenceSoftwareJobIntent({ candidate: current, expectedRevision: 8, jobId: "job:2", inputFingerprint: "b".repeat(64), createdAt: NOW }), /INTENT_RETIRED/);
  current.lifecycleV11.keywordEvidenceSoftwareJobV1.status = "in_flight";
  assert.throws(() => createKeywordEvidenceSoftwareJobIntent({ candidate: current, expectedRevision: 8, jobId: "job:3", inputFingerprint: "c".repeat(64), createdAt: NOW }), /INTENT_RETIRED/);
});

test("成功、失败和服务重启结果都不允许自动重试", () => {
  const intent = { schemaVersion: "keyword-evidence-software-job-state-v1", jobId: "job:music:8", sourceRevision: 8, executionRevision: 9, status: "in_flight", attemptCount: 1, automaticRetries: 0, browserFallbacks: 0, retryAllowed: false };
  const completed = settleKeywordEvidenceSoftwareJob({ persistedJob: intent, settledAt: NOW, outcome: { status: "completed", eventId: "event:8", executionReceipt: { receiptId: "receipt:8" } } });
  assert.deepEqual([completed.status, completed.eventId, completed.retryAllowed], ["completed", "event:8", false]);
  const restarted = reconcileKeywordEvidenceSoftwareJobAfterRestart({ persistedJob: intent, restartedAt: NOW });
  assert.deepEqual([restarted.status, restarted.failureClass, restarted.retryAllowed], ["unknown_outcome", "service_restarted_during_provider_attempt", false]);
  assert.equal(reconcileKeywordEvidenceSoftwareJobAfterRestart({ persistedJob: completed, restartedAt: NOW }), null);
});

test("旧unknown不因候选revision改变而解除付费阻断，已明确终态不受影响", () => {
  for (const status of ["in_flight", "unknown_outcome", "completed", "failed"]) {
    const value = candidate(100);
    value.lifecycleV11.keywordEvidenceSoftwareJobV1 = { status, sourceRevision: 8, retryAllowed: false };
    assert.equal(legacyKeywordJobBlocksPaidExecution(value), ["in_flight", "unknown_outcome"].includes(status));
  }
  assert.equal(legacyKeywordJobBlocksPaidExecution(candidate()), false);
});
