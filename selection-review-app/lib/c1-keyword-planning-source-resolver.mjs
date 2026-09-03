import { createHash } from "node:crypto";

import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { C1_KEYWORD_PLANNING_SOURCE_VERSION } from "./c1-keyword-planning-evidence-producer.mjs";

export const C1_KEYWORD_PLANNING_SOURCE_RECORD_VERSION = "c1-keyword-planning-source-record-v1";
export const C1_KEYWORD_PLANNING_SOURCE_RESOLUTION_VERSION = "c1-keyword-planning-source-resolution-v1";

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

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function gap(code, field, message) {
  return Object.freeze({ code, field, message });
}

function result({ status, candidate, sourceRecord = null, sourceEvidence = null, gaps = [] }) {
  return freeze({
    schemaVersion: C1_KEYWORD_PLANNING_SOURCE_RESOLUTION_VERSION,
    status,
    candidateId: candidate?.id ?? null,
    candidateRevision: Number.isInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    skuPackageId: candidate?.lifecycleV11?.skuPackage?.skuPackageId ?? null,
    sourceRecordFingerprint: sourceRecord ? digest(sourceRecord) : null,
    sourceEvidence: sourceEvidence ? structuredClone(sourceEvidence) : null,
    gaps: structuredClone(gaps),
    sideEffects: {
      externalCallsPerformed: 0,
      aiCallsPerformed: 0,
      browserActionsPerformed: 0,
      codexDispatchesPerformed: 0,
      softwareJobsCreated: 0
    }
  });
}

/**
 * 只解析已由正式软件保存并绑定当前revision的来源记录。
 * 本模块不采集、不猜测、不读取浏览器或第三方服务。
 */
export function resolveC1KeywordPlanningSourceEvidence({ candidate, expectedRevision, resolvedAt }) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      candidate.dataRevision !== expectedRevision || !nonEmpty(resolvedAt) || Number.isNaN(Date.parse(resolvedAt))) {
    throw new Error("C1_KEYWORD_PLANNING_SOURCE_RESOLUTION_INPUT_INVALID");
  }
  const skuPackage = candidate.lifecycleV11?.skuPackage;
  if (!isObject(skuPackage) || skuPackage.businessPhase !== "C1" || !nonEmpty(skuPackage.skuPackageId)) {
    return result({
      status: "not_ready",
      candidate,
      gaps: [gap("c1_sku_package_missing", "lifecycleV11.skuPackage", "当前候选没有唯一且处于C1阶段的SKU生命周期包")]
    });
  }
  const record = candidate.lifecycleV11?.c1KeywordPlanningSourceRecordV1;
  if (!isObject(record)) {
    return result({
      status: "not_ready",
      candidate,
      gaps: [gap("planning_source_record_missing", "lifecycleV11.c1KeywordPlanningSourceRecordV1", "缺少服务端已保存的关键词准备来源记录")]
    });
  }
  assertSafeRuntimeRecord(record, "c1KeywordPlanningSourceRecordV1");
  const allowed = [
    "schemaVersion", "candidateId", "candidateRevision", "skuPackageId", "recordedAt",
    "sourceEvidence", "sourceRefs"
  ];
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0 || record.schemaVersion !== C1_KEYWORD_PLANNING_SOURCE_RECORD_VERSION ||
      record.candidateId !== candidate.id || record.candidateRevision !== expectedRevision ||
      record.skuPackageId !== skuPackage.skuPackageId) {
    return result({
      status: "blocked",
      candidate,
      sourceRecord: record,
      gaps: [gap("planning_source_binding_drift", "lifecycleV11.c1KeywordPlanningSourceRecordV1", "关键词准备来源记录与当前候选、revision或SKU不一致")]
    });
  }
  if (!nonEmpty(record.recordedAt) || Number.isNaN(Date.parse(record.recordedAt)) ||
      !Array.isArray(record.sourceRefs) || record.sourceRefs.length === 0 || record.sourceRefs.some((ref) => !nonEmpty(ref))) {
    return result({
      status: "not_ready",
      candidate,
      sourceRecord: record,
      gaps: [gap("planning_source_trace_missing", "lifecycleV11.c1KeywordPlanningSourceRecordV1", "关键词准备来源缺少保存时间或可追溯证据引用")]
    });
  }
  if (!isObject(record.sourceEvidence) || record.sourceEvidence.schemaVersion !== C1_KEYWORD_PLANNING_SOURCE_VERSION) {
    return result({
      status: "not_ready",
      candidate,
      sourceRecord: record,
      gaps: [gap("planning_source_evidence_missing", "lifecycleV11.c1KeywordPlanningSourceRecordV1.sourceEvidence", "关键词准备正式来源证据尚未保存完整")]
    });
  }
  if (!nonEmpty(record.sourceEvidence.expiresAt) || Number.isNaN(Date.parse(record.sourceEvidence.expiresAt)) ||
      Date.parse(record.sourceEvidence.expiresAt) <= Date.parse(resolvedAt)) {
    return result({
      status: "not_ready",
      candidate,
      sourceRecord: record,
      gaps: [gap("planning_source_evidence_expired", "lifecycleV11.c1KeywordPlanningSourceRecordV1.sourceEvidence.expiresAt", "关键词准备来源证据已过期")]
    });
  }
  return result({ status: "ready", candidate, sourceRecord: record, sourceEvidence: record.sourceEvidence });
}
