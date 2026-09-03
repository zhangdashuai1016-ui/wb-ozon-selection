import { createHash } from "node:crypto";
import { C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION } from "./c1-keyword-evidence-auto-trigger.mjs";

const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function stable(value) { return Array.isArray(value) ? value.map(stable) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value; }
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(freeze); return value; }
function assertNoSecrets(value, path = "runtimeInput") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`KEYWORD_READY_EVENT_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function validateRuntimeInput(runtimeInput) {
  if (!isObject(runtimeInput) || runtimeInput.schemaVersion !== "c1-fact-keyword-runtime-input-v1" ||
      !Number.isInteger(runtimeInput.dataRevision) || !isObject(runtimeInput.keywordSourceEvidence) ||
      !isObject(runtimeInput.frozenSeoRules) || !Object.hasOwn(runtimeInput, "frozenComplexityDecision") ||
      !Object.hasOwn(runtimeInput, "reusableKeywordSnapshot") || !nonEmpty(runtimeInput.keywordExpiresAt) ||
      Number.isNaN(Date.parse(runtimeInput.keywordExpiresAt)) || !isObject(runtimeInput.providerEvidence)) return false;
  const evidence = runtimeInput.providerEvidence;
  return ["seerfarApiReceipt", "browserReceipt", "standardSkuHealthReceipts", "keywordMetricEvidence"].every((field) => Object.hasOwn(evidence, field)) &&
    Array.isArray(evidence.standardSkuHealthReceipts) && evidence.standardSkuHealthReceipts.length <= 3;
}

export function produceKeywordEvidenceReadyEvent({ candidateId, dataRevision, skuPackageId, runtimeInput, readiness, expectedEvidenceFingerprint, createdAt, existingProduction = null }) {
  if (!nonEmpty(candidateId) || !Number.isInteger(dataRevision) || dataRevision < 0 || !nonEmpty(skuPackageId) || !nonEmpty(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("KEYWORD_READY_EVENT_IDENTITY_INVALID");
  }
  assertNoSecrets(runtimeInput);
  if (!isObject(readiness) || readiness.status !== "ready") {
    return freeze({ status: readiness?.technicalFailureClass ? "technical_failure" : "not_ready", reason: readiness?.reason ?? "keyword_evidence_not_ready", failureClass: readiness?.technicalFailureClass ?? null, event: null, productionAttempt: null });
  }
  if (!validateRuntimeInput(runtimeInput)) return freeze({ status: "not_ready", reason: "frozen_runtime_input_incomplete", failureClass: null, event: null, productionAttempt: null });
  if (runtimeInput.dataRevision !== dataRevision || readiness.candidateId !== candidateId || readiness.dataRevision !== dataRevision || readiness.skuPackageId !== skuPackageId ||
      !nonEmpty(expectedEvidenceFingerprint) || readiness.evidenceFingerprint !== expectedEvidenceFingerprint || readiness.runtimeInputFingerprint !== digest(runtimeInput)) {
    throw new Error("KEYWORD_READY_EVENT_BINDING_DRIFT");
  }
  const runtimeInputFingerprint = digest(runtimeInput);
  const eventId = `keyword-ready:${candidateId}:${dataRevision}:${runtimeInputFingerprint.slice(0, 16)}`;
  if (existingProduction) {
    if (existingProduction.eventId === eventId && existingProduction.runtimeInputFingerprint === runtimeInputFingerprint) {
      return freeze({ status: "idempotent_replay", reason: null, failureClass: null, event: structuredClone(existingProduction.event), productionAttempt: structuredClone(existingProduction) });
    }
    throw new Error("KEYWORD_READY_EVENT_ALREADY_PRODUCED");
  }
  const event = {
    schemaVersion: C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION,
    eventId,
    eventType: "k1_k2_frozen_evidence_ready",
    actorType: "software",
    candidateId,
    dataRevision,
    skuPackageId,
    keywordEvidenceStatus: "ready",
    runtimeInputFingerprint,
    runtimeInput: structuredClone(runtimeInput),
    createdAt
  };
  const productionAttempt = {
    schemaVersion: "keyword-evidence-ready-production-attempt-v1",
    attemptId: `produce:${eventId}`,
    eventId,
    runtimeInputFingerprint,
    evidenceFingerprint: readiness.evidenceFingerprint,
    attemptCount: 1,
    automaticRetries: 0,
    externalCalls: 0,
    codexDispatches: 0,
    businessMutations: 0,
    producedAt: createdAt,
    event: structuredClone(event)
  };
  productionAttempt.attemptFingerprint = digest(productionAttempt);
  return freeze({ status: "ready", reason: null, failureClass: null, event, productionAttempt });
}
