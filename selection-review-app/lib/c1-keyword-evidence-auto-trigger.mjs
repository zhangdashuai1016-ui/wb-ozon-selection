import { createHash } from "node:crypto";

export const C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION = "c1-keyword-evidence-ready-event-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function assertNoSensitiveFields(value, path = "event") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i.test(key)) {
      throw new Error(`C1_KEYWORD_AUTO_TRIGGER_SECRET_FORBIDDEN:${path}.${key}`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`);
  }
}

export function acceptC1KeywordEvidenceReadyEvent({ candidate, event, acceptedAt }) {
  if (!isObject(candidate) || !isObject(event) ||
      event.schemaVersion !== C1_KEYWORD_EVIDENCE_READY_EVENT_VERSION ||
      event.eventType !== "k1_k2_frozen_evidence_ready" || event.actorType !== "software" ||
      !nonEmpty(event.eventId) || !nonEmpty(event.candidateId) || !nonEmpty(event.skuPackageId) ||
      !Number.isInteger(event.dataRevision) || event.dataRevision < 0 ||
      event.keywordEvidenceStatus !== "ready" || !isObject(event.runtimeInput) ||
      !nonEmpty(event.runtimeInputFingerprint) || !nonEmpty(event.createdAt) ||
      Number.isNaN(Date.parse(event.createdAt)) || !nonEmpty(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_EVENT_INVALID: K1/K2就绪事件结构不完整");
  }
  assertNoSensitiveFields(event);
  if (event.candidateId !== candidate.id || event.dataRevision !== candidate.dataRevision) {
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_REVISION_DRIFT: 候选或revision已变化");
  }
  const skuPackage = candidate.lifecycleV11?.skuPackage;
  if (!isObject(skuPackage) || skuPackage.businessPhase !== "C1" || skuPackage.skuPackageId !== event.skuPackageId) {
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_SKU_DRIFT: 当前C1 SKU包与事件不一致");
  }
  if (event.runtimeInput.dataRevision !== event.dataRevision || digest(event.runtimeInput) !== event.runtimeInputFingerprint) {
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_INPUT_DRIFT: 冻结运行输入或指纹不一致");
  }
  const existing = candidate.lifecycleV11?.c1KeywordEvidenceAutoTriggerV1;
  if (isObject(existing)) {
    if (existing.eventId === event.eventId && existing.runtimeInputFingerprint === event.runtimeInputFingerprint) {
      return { status: "idempotent_replay", runtimeInput: null, triggerReceipt: structuredClone(existing) };
    }
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_ALREADY_FROZEN: 当前SKU已接受另一份关键词证据事件");
  }
  if (candidate.lifecycleV11?.c1SoftwareEvidenceV1) {
    throw new Error("C1_KEYWORD_AUTO_TRIGGER_ALREADY_FROZEN: 当前SKU的C1证据已经冻结");
  }
  const triggerReceipt = {
    schemaVersion: "c1-keyword-evidence-auto-trigger-receipt-v1",
    eventId: event.eventId,
    eventType: event.eventType,
    actorType: "software",
    candidateId: event.candidateId,
    sourceDataRevision: event.dataRevision,
    skuPackageId: event.skuPackageId,
    runtimeInputFingerprint: event.runtimeInputFingerprint,
    acceptedAt,
    codexDispatches: 0,
    platformAccesses: 0,
    automaticRetries: 0
  };
  triggerReceipt.receiptFingerprint = digest(triggerReceipt);
  return {
    status: "accepted",
    runtimeInput: structuredClone(event.runtimeInput),
    triggerReceipt
  };
}
