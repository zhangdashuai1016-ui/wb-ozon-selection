import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION,
  acceptC1KeywordEvidenceReadyEvent
} from "../lib/c1-keyword-evidence-auto-trigger.mjs";

const NOW = "2026-08-24T03:00:00.000Z";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function candidate() {
  return {
    id: "CX-NON-TRAIN-002",
    dataRevision: 17,
    lifecycleV11: {
      status: "b_passed_auto_c1",
      skuPackage: { candidateId: "CX-NON-TRAIN-002", skuPackageId: "sku-package:NON-TRAIN:SKU-2", dataRevision: 8, businessPhase: "C1" }
    }
  };
}

function runtimeInput() {
  return {
    schemaVersion: "c1-fact-keyword-runtime-input-v1",
    dataRevision: 17,
    keywordSourceEvidence: { fulfillment: "rfbs", locale: "ru-RU", frozenEvidence: {}, policy: {}, healthPolicy: {} },
    frozenSeoRules: { rulesVersion: "seo-ru-v1" },
    frozenComplexityDecision: null,
    reusableKeywordSnapshot: null,
    keywordExpiresAt: "2026-08-25T03:00:00.000Z",
    providerEvidence: {
      seerfarApiReceipt: { receiptId: "seerfar:2" },
      browserReceipt: null,
      standardSkuHealthReceipts: [],
      keywordMetricEvidence: { evidenceId: "metrics:2" }
    }
  };
}

function event() {
  const input = runtimeInput();
  return {
    schemaVersion: C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION,
    eventId: "keyword-ready:CX-NON-TRAIN-002:17",
    eventType: "k1_k2_frozen_evidence_ready",
    actorType: "software",
    candidateId: "CX-NON-TRAIN-002",
    dataRevision: 17,
    skuPackageId: "sku-package:NON-TRAIN:SKU-2",
    keywordEvidenceStatus: "ready",
    runtimeInputFingerprint: digest(input),
    runtimeInput: input,
    createdAt: NOW
  };
}

test("K1/K2软件就绪事件锁定单SKU与revision并生成零派发触发回执", () => {
  const result = acceptC1KeywordEvidenceReadyEvent({ candidate: candidate(), event: event(), acceptedAt: NOW });
  assert.equal(result.status, "accepted");
  assert.equal(result.runtimeInput.dataRevision, 17);
  assert.equal(result.triggerReceipt.actorType, "software");
  assert.equal(result.triggerReceipt.codexDispatches, 0);
  assert.equal(result.triggerReceipt.platformAccesses, 0);
  assert.equal(result.triggerReceipt.automaticRetries, 0);
  assert.match(result.triggerReceipt.receiptFingerprint, /^[a-f0-9]{64}$/);
});

test("重复同一事件幂等，另一事件、revision、SKU和输入漂移全部拒绝", () => {
  const first = acceptC1KeywordEvidenceReadyEvent({ candidate: candidate(), event: event(), acceptedAt: NOW });
  const replayCandidate = candidate();
  replayCandidate.lifecycleV11.c1KeywordEvidenceAutoTriggerV1 = first.triggerReceipt;
  assert.equal(acceptC1KeywordEvidenceReadyEvent({ candidate: replayCandidate, event: event(), acceptedAt: NOW }).status, "idempotent_replay");

  for (const mutate of [
    (value) => { value.dataRevision = 18; value.runtimeInput.dataRevision = 18; value.runtimeInputFingerprint = digest(value.runtimeInput); },
    (value) => { value.skuPackageId = "sku-package:OTHER"; },
    (value) => { value.runtimeInput.frozenSeoRules.rulesVersion = "tampered"; },
    (value) => { value.eventId = "keyword-ready:other"; }
  ]) {
    const currentCandidate = mutate.name === "" ? candidate() : candidate();
    const value = event();
    mutate(value);
    const target = value.eventId === "keyword-ready:other" ? replayCandidate : currentCandidate;
    assert.throws(() => acceptC1KeywordEvidenceReadyEvent({ candidate: target, event: value, acceptedAt: NOW }), /AUTO_TRIGGER_/);
  }
});

test("事件含Token、Cookie、密码或密钥字段时在C1前拒绝", () => {
  for (const field of ["access_token", "Cookie", "password", "apiKey"]) {
    const value = event();
    value.runtimeInput.providerEvidence.keywordMetricEvidence[field] = "forbidden";
    value.runtimeInputFingerprint = digest(value.runtimeInput);
    assert.throws(() => acceptC1KeywordEvidenceReadyEvent({ candidate: candidate(), event: value, acceptedAt: NOW }), /SECRET_FORBIDDEN/);
  }
});

test("事件Schema只接受软件就绪事件并引用冻结运行输入", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-keyword-evidence-ready-event-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.actorType.const, "software");
  assert.equal(schema.properties.eventType.const, "k1_k2_frozen_evidence_ready");
  assert.equal(schema.properties.runtimeInput.$ref, "c1-fact-keyword-runtime-input-v1.schema.json");
});
