import {
  inspectLifecycleBInputReadiness,
  resolveLifecycleEvidenceContext,
  validateLifecycleEvidenceData
} from "./lifecycle-b-input-bundle.mjs";

export const LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION = "lifecycle-b-evidence-preparation-v1.1";

export const LIFECYCLE_B_EVIDENCE_KINDS = Object.freeze([
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

function expectedScope(kind, context) {
  if (kind === "commission") return {
    platform: context.platform,
    store: context.store,
    category: context.category,
    salesScheme: context.salesScheme
  };
  if (kind === "logistics_tariff") return {
    route: context.route,
    ruleVersion: context.logisticsRuleVersion
  };
  if (kind === "exchange_rate") return { pair: context.exchangePair };
  if (kind === "schema") return {
    platform: context.platform,
    store: context.store,
    category: context.category,
    ruleVersion: context.schemaRuleVersion
  };
  throw new Error(`B_EVIDENCE_KIND_UNSUPPORTED: ${kind}`);
}

function exactScope(actual, expected) {
  return isObject(actual) && Object.entries(expected).every(
    ([key, value]) => normalizedText(actual[key]) === normalizedText(value)
  );
}

function validatePreparedPack(pack, kind, context, preparedAt) {
  const problems = [];
  if (!isObject(pack)) return ["提供器没有返回结构化证据包"];
  if (!nonEmptyString(pack.id)) problems.push("缺证据包ID");
  if (pack.kind !== kind) problems.push("证据类型不一致");
  if (pack.status !== "active") problems.push("证据状态必须为active");
  if (!nonEmptyString(pack.sourceType) || !nonEmptyString(pack.sourceRef)) problems.push("缺可追溯来源");
  if (!isoDateTime(pack.checkedAt)) problems.push("取得时间无效");
  if (!isoDateTime(pack.expiresAt)) problems.push("失效时间无效");
  if (isoDateTime(pack.checkedAt) && Date.parse(pack.checkedAt) > Date.parse(preparedAt)) problems.push("取得时间晚于本轮冻结时间");
  if (isoDateTime(pack.checkedAt) && isoDateTime(pack.expiresAt) && Date.parse(pack.expiresAt) <= Date.parse(pack.checkedAt)) {
    problems.push("失效时间必须晚于取得时间");
  }
  if (isoDateTime(pack.expiresAt) && Date.parse(pack.expiresAt) <= Date.parse(preparedAt)) problems.push("证据在本轮冻结时已经过期");
  if (!exactScope(pack.scope, expectedScope(kind, context))) problems.push("证据适用范围不一致");
  const evidenceValidation = validateLifecycleEvidenceData(kind, pack.evidenceData);
  if (!evidenceValidation.valid) {
    problems.push(...evidenceValidation.errors.map((item) => `${item.path} ${item.message}`));
  }
  return problems;
}

export function buildLifecycleBEvidencePreparationPlan({ candidate, evidencePacks = [], plannedAt }) {
  if (!isObject(candidate) || !nonEmptyString(candidate.id) || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("B_EVIDENCE_PREPARATION_INVALID_CANDIDATE: 候选身份或修订号无效");
  }
  if (!isoDateTime(plannedAt)) throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 计划时间无效");
  const context = resolveLifecycleEvidenceContext(candidate);
  const readiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: plannedAt });
  const actions = readiness.fields.map((field) => ({
    kind: field.key,
    action: field.available ? "reuse" : "prepare_once",
    currentStatus: field.status,
    evidencePackId: field.evidencePackId,
    reason: field.message,
    expectedScope: context.ready ? expectedScope(field.key, context.values) : null,
    maximumAutomaticAttempts: field.available ? 0 : 1
  }));
  return deepFreeze({
    planVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    planId: `b-evidence-plan:${candidate.id}:${candidate.dataRevision}:${plannedAt}`,
    candidateId: candidate.id,
    candidateRevision: candidate.dataRevision,
    plannedAt,
    status: context.ready ? (readiness.ready ? "ready_from_reuse" : "preparation_required") : "blocked_context",
    context,
    actions,
    currentEvidenceReady: readiness.ready,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAllowed: false,
    externalAccessStarted: false,
    platformWrites: 0
  });
}

function failureResult({ plan, providerCalls, failureLayer, reason, discardedEvidencePackIds = [] }) {
  return deepFreeze({
    runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    plan,
    status: "failed",
    providerCalls,
    failure: { layer: failureLayer, reason },
    evidencePacksToCommit: [],
    discardedEvidencePackIds,
    finalReadiness: null,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAttempted: false,
    automaticRetryAllowed: false,
    platformWrites: 0
  });
}

export async function runLifecycleBEvidencePreparation({
  candidate,
  evidencePacks = [],
  providers = {},
  plannedAt,
  preparedAt,
  clock = () => new Date()
}) {
  const plan = buildLifecycleBEvidencePreparationPlan({ candidate, evidencePacks, plannedAt });
  if (preparedAt !== undefined && (!isoDateTime(preparedAt) || Date.parse(preparedAt) < Date.parse(plannedAt))) {
    throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 完成时间不得早于计划时间");
  }
  const completionTime = () => {
    const value = preparedAt || clock().toISOString();
    if (!isoDateTime(value) || Date.parse(value) < Date.parse(plannedAt)) {
      throw new Error("B_EVIDENCE_PREPARATION_INVALID_TIME: 完成时间不得早于计划时间");
    }
    return value;
  };
  if (plan.status === "blocked_context") {
    return failureResult({
      plan,
      providerCalls: [],
      failureLayer: "evidence_context",
      reason: `证据适用范围未锁定：${plan.context.missing.join("、")}`
    });
  }
  if (plan.status === "ready_from_reuse") {
    const finalReadiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: completionTime() });
    if (!finalReadiness.ready) {
      return failureResult({
        plan,
        providerCalls: [],
        failureLayer: "reuse_validity_drift",
        reason: `复用证据在本轮结束前失效：${finalReadiness.missing.join("、")}`
      });
    }
    return deepFreeze({
      runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
      plan,
      status: "completed",
      providerCalls: [],
      failure: null,
      evidencePacksToCommit: [],
      discardedEvidencePackIds: [],
      finalReadiness,
      ownerActionRequired: false,
      businessStateEffect: "unchanged",
      automaticRetryAttempted: false,
      automaticRetryAllowed: false,
      platformWrites: 0
    });
  }

  const preparedPacks = [];
  const providerCalls = [];
  for (const action of plan.actions.filter((item) => item.action === "prepare_once")) {
    const provider = providers[action.kind];
    if (typeof provider !== "function") {
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider:${action.kind}`,
        reason: `${action.kind}只读提供器未配置`,
        discardedEvidencePackIds: preparedPacks.map((pack) => pack.id)
      });
    }
    const request = deepFreeze({
      requestVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
      candidateId: candidate.id,
      candidateRevision: candidate.dataRevision,
      kind: action.kind,
      scope: structuredClone(action.expectedScope),
      maximumAttempts: 1,
      readOnly: true,
      platformWritesAllowed: false,
      requestedAt: plannedAt
    });
    providerCalls.push({ kind: action.kind, attempt: 1, status: "started" });
    let pack;
    try {
      pack = await provider(request);
    } catch (error) {
      providerCalls[providerCalls.length - 1] = {
        kind: action.kind,
        attempt: 1,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider:${action.kind}`,
        reason: providerCalls[providerCalls.length - 1].reason,
        discardedEvidencePackIds: preparedPacks.map((item) => item.id)
      });
    }
    const problems = validatePreparedPack(pack, action.kind, plan.context.values, completionTime());
    if (problems.length) {
      providerCalls[providerCalls.length - 1] = {
        kind: action.kind,
        attempt: 1,
        status: "invalid_result",
        reason: problems.join("；")
      };
      return failureResult({
        plan,
        providerCalls,
        failureLayer: `provider_result:${action.kind}`,
        reason: problems.join("；"),
        discardedEvidencePackIds: [...preparedPacks.map((item) => item.id), nonEmptyString(pack?.id) ? pack.id : null].filter(Boolean)
      });
    }
    preparedPacks.push(structuredClone(pack));
    providerCalls[providerCalls.length - 1] = { kind: action.kind, attempt: 1, status: "completed", evidencePackId: pack.id };
  }

  const finalReadiness = inspectLifecycleBInputReadiness({
    candidate,
    evidencePacks: [...evidencePacks, ...preparedPacks],
    asOf: completionTime()
  });
  if (!finalReadiness.ready) {
    return failureResult({
      plan,
      providerCalls,
      failureLayer: "final_readiness",
      reason: `四类证据未全部就绪：${finalReadiness.missing.join("、")}`,
      discardedEvidencePackIds: preparedPacks.map((pack) => pack.id)
    });
  }
  return deepFreeze({
    runVersion: LIFECYCLE_B_EVIDENCE_PREPARATION_VERSION,
    plan,
    status: "completed",
    providerCalls,
    failure: null,
    evidencePacksToCommit: preparedPacks,
    discardedEvidencePackIds: [],
    finalReadiness,
    ownerActionRequired: false,
    businessStateEffect: "unchanged",
    automaticRetryAttempted: false,
    automaticRetryAllowed: false,
    platformWrites: 0
  });
}
