import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { acceptC1KeywordEvidenceReadyEvent } from "../lib/c1-keyword-evidence-auto-trigger.mjs";
import { produceKeywordEvidenceReadyEvent } from "../lib/keyword-evidence-ready-event-producer.mjs";

const NOW = "2026-08-24T05:00:00.000Z";
function stable(v) { return Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v; }
function digest(v) { return createHash("sha256").update(JSON.stringify(stable(v))).digest("hex"); }
function runtimeInput() { return { schemaVersion: "c1-fact-keyword-runtime-input-v1", dataRevision: 9, keywordSourceEvidence: { frozenEvidence: {}, policy: {}, healthPolicy: {} }, frozenSeoRules: { version: "seo-v1" }, frozenComplexityDecision: null, reusableKeywordSnapshot: null, keywordExpiresAt: "2026-08-25T05:00:00.000Z", providerEvidence: { seerfarApiReceipt: { receiptId: "api:9" }, browserReceipt: null, standardSkuHealthReceipts: [], keywordMetricEvidence: { evidenceId: "metrics:9" } } }; }
function readiness(input = runtimeInput(), overrides = {}) { return { status: "ready", candidateId: "CX-NON-TRAIN-EVENT", dataRevision: 9, skuPackageId: "sku:event:9", evidenceFingerprint: "evidence-fp-9", runtimeInputFingerprint: digest(input), ...overrides }; }
function args(input = runtimeInput(), ready = readiness(input)) { return { candidateId: "CX-NON-TRAIN-EVENT", dataRevision: 9, skuPackageId: "sku:event:9", runtimeInput: input, readiness: ready, expectedEvidenceFingerprint: "evidence-fp-9", createdAt: NOW }; }

test("ready冻结输入生成与现有总控Schema完全兼容的单SKU事件", async () => {
  const result = produceKeywordEvidenceReadyEvent(args());
  assert.equal(result.status, "ready");
  assert.equal(result.event.schemaVersion, "c1-keyword-evidence-ready-event-v1");
  assert.equal(result.event.eventType, "k1_k2_frozen_evidence_ready");
  assert.equal(result.event.actorType, "software");
  assert.deepEqual({ externalCalls: result.productionAttempt.externalCalls, codexDispatches: result.productionAttempt.codexDispatches, businessMutations: result.productionAttempt.businessMutations, automaticRetries: result.productionAttempt.automaticRetries }, { externalCalls: 0, codexDispatches: 0, businessMutations: 0, automaticRetries: 0 });
  const schema = JSON.parse(await readFile(new URL("../schema/c1-keyword-evidence-ready-event-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(result.event).sort(), schema.required.sort());
  const candidate = { id: "CX-NON-TRAIN-EVENT", dataRevision: 9, lifecycleV11: { skuPackage: { businessPhase: "C1", skuPackageId: "sku:event:9" } } };
  assert.equal(acceptC1KeywordEvidenceReadyEvent({ candidate, event: result.event, acceptedAt: NOW }).status, "accepted");
});

test("相同输入与既有生产回执幂等且只保留一次尝试", () => {
  const first = produceKeywordEvidenceReadyEvent(args());
  const replay = produceKeywordEvidenceReadyEvent({ ...args(), existingProduction: first.productionAttempt });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.productionAttempt.attemptCount, 1);
  assert.equal(replay.event.eventId, first.event.eventId);
});

test("跨SKU、revision、证据或运行输入指纹漂移停止", () => {
  const mutations = [
    (ready) => { ready.candidateId = "OTHER"; },
    (ready) => { ready.dataRevision = 10; },
    (ready) => { ready.skuPackageId = "sku:other"; },
    (ready) => { ready.evidenceFingerprint = "evidence-drift"; },
    (ready) => { ready.runtimeInputFingerprint = "0".repeat(64); }
  ];
  for (const mutate of mutations) { const input = runtimeInput(); const ready = readiness(input); mutate(ready); assert.throws(() => produceKeywordEvidenceReadyEvent(args(input, ready)), /BINDING_DRIFT/); }
  const first = produceKeywordEvidenceReadyEvent(args());
  const changed = runtimeInput(); changed.frozenSeoRules.version = "seo-v2";
  assert.throws(() => produceKeywordEvidenceReadyEvent({ ...args(changed, readiness(changed)), existingProduction: first.productionAttempt }), /ALREADY_PRODUCED/);
});

test("非ready和技术失败准确返回且绝不生成事件", () => {
  const input = runtimeInput();
  const notReady = produceKeywordEvidenceReadyEvent(args(input, { status: "not_ready", reason: "missing_metrics" }));
  assert.deepEqual([notReady.status, notReady.event, notReady.productionAttempt], ["not_ready", null, null]);
  const failed = produceKeywordEvidenceReadyEvent(args(input, { status: "technical_unavailable", technicalFailureClass: "provider_server_error", reason: "seerfar_500" }));
  assert.deepEqual([failed.status, failed.failureClass, failed.event], ["technical_failure", "provider_server_error", null]);
});

test("冻结输入不完整或含秘密字段时事件生产前拒绝", () => {
  const incomplete = runtimeInput(); delete incomplete.providerEvidence.keywordMetricEvidence;
  assert.equal(produceKeywordEvidenceReadyEvent(args(incomplete, readiness(incomplete))).status, "not_ready");
  for (const field of ["access_token", "Cookie", "password", "apiKey"]) {
    const unsafe = runtimeInput(); unsafe.providerEvidence[field] = "forbidden";
    assert.throws(() => produceKeywordEvidenceReadyEvent(args(unsafe, readiness(unsafe))), /SECRET_FORBIDDEN/);
  }
});
