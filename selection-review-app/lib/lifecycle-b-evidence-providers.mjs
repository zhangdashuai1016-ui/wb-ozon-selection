import { createHash } from "node:crypto";
import { validateLifecycleEvidenceData } from "./lifecycle-b-input-bundle.mjs";

export const LIFECYCLE_B_EVIDENCE_PROVIDER_VERSION = "lifecycle-b-evidence-provider-v1.1";

const SUPPORTED_KINDS = new Set([
  "commission",
  "logistics_tariff",
  "exchange_rate",
  "schema"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function providerError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function expectedScopeKeys(kind) {
  if (kind === "commission") return ["platform", "store", "category", "salesScheme"];
  if (kind === "logistics_tariff") return ["route", "ruleVersion"];
  if (kind === "exchange_rate") return ["pair"];
  if (kind === "schema") return ["platform", "store", "category", "ruleVersion"];
  return [];
}

function validateRequest(request, kind) {
  if (!isObject(request)) throw providerError("B_EVIDENCE_PROVIDER_REQUEST_INVALID", "请求必须是结构化对象");
  if (request.kind !== kind) throw providerError("B_EVIDENCE_PROVIDER_KIND_MISMATCH", "请求证据类型不匹配");
  if (request.readOnly !== true || request.platformWritesAllowed !== false) {
    throw providerError("B_EVIDENCE_PROVIDER_NOT_READ_ONLY", "证据提供器只允许只读调用");
  }
  if (request.maximumAttempts !== 1) {
    throw providerError("B_EVIDENCE_PROVIDER_ATTEMPT_LIMIT", "每类证据每轮只能调用一次");
  }
  if (!nonEmptyString(request.candidateId) || !Number.isInteger(request.candidateRevision)) {
    throw providerError("B_EVIDENCE_PROVIDER_CANDIDATE_INVALID", "候选身份或修订号无效");
  }
  if (!isoDateTime(request.requestedAt)) {
    throw providerError("B_EVIDENCE_PROVIDER_TIME_INVALID", "请求时间无效");
  }
  if (!isObject(request.scope)) throw providerError("B_EVIDENCE_PROVIDER_SCOPE_INVALID", "适用范围缺失");
  const missing = expectedScopeKeys(kind).filter((key) => !nonEmptyString(request.scope[key]));
  if (missing.length) {
    throw providerError("B_EVIDENCE_PROVIDER_SCOPE_INVALID", `适用范围缺少${missing.join("、")}`);
  }
}

function exactScope(actual, expected, kind) {
  return isObject(actual) && expectedScopeKeys(kind).every(
    (key) => normalizedText(actual[key]) === normalizedText(expected[key])
  );
}

function assertSafeTrace(trace) {
  if (!isObject(trace)) throw providerError("B_EVIDENCE_PROVIDER_TRACE_MISSING", "读取结果缺少来源与时效");
  if (!nonEmptyString(trace.sourceType) || !nonEmptyString(trace.sourceRef)) {
    throw providerError("B_EVIDENCE_PROVIDER_TRACE_MISSING", "读取结果缺少可追溯来源");
  }
  if (/token|cookie|password|secret|authorization/i.test(`${trace.sourceType} ${trace.sourceRef}`)) {
    throw providerError("B_EVIDENCE_PROVIDER_SECRET_REJECTED", "来源引用不得包含凭证或秘密字段");
  }
  if (!isoDateTime(trace.checkedAt) || !isoDateTime(trace.expiresAt)) {
    throw providerError("B_EVIDENCE_PROVIDER_VALIDITY_INVALID", "读取结果缺少有效取得时间或失效时间");
  }
  if (Date.parse(trace.expiresAt) <= Date.parse(trace.checkedAt)) {
    throw providerError("B_EVIDENCE_PROVIDER_VALIDITY_INVALID", "失效时间必须晚于取得时间");
  }
}

function packId(kind, scope, trace) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, scope, sourceType: trace.sourceType, sourceRef: trace.sourceRef, checkedAt: trace.checkedAt }))
    .digest("hex")
    .slice(0, 20);
  return `b-evidence:${kind}:${digest}`;
}

function normalizeReaderResult(result, request, kind) {
  if (!isObject(result)) throw providerError("B_EVIDENCE_PROVIDER_EMPTY_RESULT", "只读来源没有返回结构化结果");
  if (result.current !== true) {
    throw providerError("B_EVIDENCE_PROVIDER_NOT_CURRENT", "只读来源没有证明这是当前有效证据");
  }
  if (!exactScope(result.scope, request.scope, kind)) {
    throw providerError("B_EVIDENCE_PROVIDER_SCOPE_MISMATCH", "返回证据不适用于当前平台、店铺、类目、模式、线路或版本");
  }
  assertSafeTrace(result);
  const validation = validateLifecycleEvidenceData(kind, result.evidenceData);
  if (!validation.valid) {
    throw providerError(
      "B_EVIDENCE_PROVIDER_DATA_INVALID",
      validation.errors.map((item) => `${item.path} ${item.message}`).join("；")
    );
  }
  return deepFreeze({
    id: packId(kind, request.scope, result),
    kind,
    status: "active",
    scope: structuredClone(request.scope),
    sourceType: result.sourceType.trim(),
    sourceRef: result.sourceRef.trim(),
    checkedAt: new Date(result.checkedAt).toISOString(),
    expiresAt: new Date(result.expiresAt).toISOString(),
    evidenceData: structuredClone(result.evidenceData),
    providerVersion: LIFECYCLE_B_EVIDENCE_PROVIDER_VERSION
  });
}

export function createLifecycleBEvidenceProvider({ kind, read }) {
  if (!SUPPORTED_KINDS.has(kind)) throw new TypeError(`B_EVIDENCE_PROVIDER_KIND_UNSUPPORTED: ${kind}`);
  if (typeof read !== "function") throw new TypeError(`B_EVIDENCE_PROVIDER_READER_MISSING: ${kind}`);
  return async function provide(request) {
    validateRequest(request, kind);
    let result;
    try {
      result = await read(deepFreeze({
        providerVersion: LIFECYCLE_B_EVIDENCE_PROVIDER_VERSION,
        kind,
        scope: structuredClone(request.scope),
        candidateId: request.candidateId,
        candidateRevision: request.candidateRevision,
        requestedAt: request.requestedAt,
        readOnly: true,
        platformWritesAllowed: false
      }));
    } catch (error) {
      if (error?.code && String(error.code).startsWith("B_EVIDENCE_PROVIDER_")) throw error;
      throw providerError(
        "B_EVIDENCE_PROVIDER_READ_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
    return normalizeReaderResult(result, request, kind);
  };
}

export function createLifecycleBEvidenceProviderRegistry(readers = {}) {
  const registry = {};
  for (const kind of SUPPORTED_KINDS) {
    if (typeof readers[kind] === "function") {
      registry[kind] = createLifecycleBEvidenceProvider({ kind, read: readers[kind] });
    }
  }
  return deepFreeze(registry);
}
