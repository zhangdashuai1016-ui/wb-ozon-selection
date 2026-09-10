import { createHash } from "node:crypto";
import {
  C1_CANONICAL_CONTRACT_VERSION,
  C1_FACT_VERIFICATION_VERSION,
  assertValidC1ProductPlan,
  normalizeC1SourceIdentity
} from "./c1-product-plan.mjs";
import { assertCanonicalC1AuthorizationId, assertCanonicalFrozenRef, assertNoRawPersistenceKeys, assertNoProductionSecrets } from "./production-contract-primitives.mjs";
import { sameStoreRef } from "./store-binding.mjs";

export const C1_AI_DRAFT_REQUEST_VERSION = "c1-ai-draft-request-v1";
export const C1_AI_DRAFT_RECEIPT_VERSION = "c1-ai-draft-receipt-v1";
export const C1_AI_PROVIDER_POLICY_VERSION = "c1-ai-provider-policy-v1";
export const C1_AI_AUTHORIZED_EXECUTION_VERSION = "c1-ai-authorized-execution-v1";
export const C1_AI_SETTLED_EXECUTION_VERSION = "c1-ai-settled-execution-v1";
export const C1_AI_ACCOUNTING_VERSION = "c1-ai-accounting-v1";

export function validateC1ProviderOutcome(value) {
  const errors = [];
  if (!exactKeys(value, ["schemaVersion", "failureLayer", "externalRequestState", "requestTransmission"]) ||
      value.schemaVersion !== "c1-provider-outcome-v1" || typeof value.failureLayer !== "string" || !/^[a-z_]{1,40}$/.test(value.failureLayer) ||
      !["not_sent", "failed", "succeeded", "unknown_outcome"].includes(value.externalRequestState) ||
      !["not_attempted", "attempted", "response_received", "unknown"].includes(value.requestTransmission)) {
    errors.push("C1_PROVIDER_OUTCOME_INVALID");
  } else if ((value.externalRequestState === "not_sent" && value.requestTransmission !== "not_attempted") ||
      (["failed", "succeeded"].includes(value.externalRequestState) && value.requestTransmission !== "response_received")) {
    errors.push("C1_PROVIDER_OUTCOME_TRANSMISSION_CONFLICT");
  }
  return { valid: errors.length === 0, errors };
}

export function assertC1ProviderOutcome(value) {
  const result = validateC1ProviderOutcome(value);
  if (!result.valid) throw new Error(result.errors[0]);
  return deepFreeze(structuredClone(value));
}

const C1_AI_EXPECTED_OUTPUT = Object.freeze({
  locale: "ru-RU",
  status: "draft_only",
  fields: ["title", "description", "bulletPoints", "searchKeywords"],
  citationPolicy: "every_output_item_requires_fact_and_keyword_refs",
  assertionPolicy: "every_factual_assertion_must_equal_a_verified_fact"
});
const C1_AI_EXECUTION_POLICY = Object.freeze({
  attemptLimit: 1,
  automaticRetry: false,
  fallbackProvider: null,
  solFallbackAfterTerraFailure: false,
  codexDispatch: false,
  platformAccessAllowed: false,
  productionWriteAllowed: false
});

const FACT_SECTIONS = Object.freeze([
  "exactSkuVerification",
  "productAttributes",
  "platformCategory",
  "schemaSnapshot",
  "batteryAssessment",
  "categoryRestrictions",
  "platformCompliance"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmpty(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function requestFingerprint(request) {
  if (!isObject(request)) return null;
  const core = structuredClone(request);
  delete core.requestId;
  delete core.requestFingerprint;
  return fingerprint(core);
}

function unique(values) {
  return [...new Set(values.filter(nonEmpty))];
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function exactKeys(value, keys) {
  return isObject(value) && sameJson(Object.keys(value).sort(), [...keys].sort());
}

export function validateC1AiAccounting(accounting) {
  if (!exactKeys(accounting, ["schemaVersion", "gatewayJobId", "providerRequestId", "usage", "charge"]) ||
      accounting.schemaVersion !== C1_AI_ACCOUNTING_VERSION ||
      !exactKeys(accounting.charge, ["status", "reason"]) || accounting.charge.status !== "unknown" ||
      accounting.charge.reason !== "provider_charge_not_reported") {
    return { valid: false, errors: ["accounting: 必须使用明确费用未知的closed合同"] };
  }
  try {
    assertNoRawPersistenceKeys(accounting, "c1Accounting");
    assertNoProductionSecrets(accounting, "c1Accounting");
    for (const field of ["gatewayJobId", "providerRequestId"]) {
      if (accounting[field] !== null) assertCanonicalFrozenRef(accounting[field], `c1Accounting.${field}`);
    }
  } catch { return { valid: false, errors: ["accounting: 对账引用或结构无效"] }; }
  const usage = accounting.usage;
  if (usage !== "unknown" && (!isObject(usage) || Object.keys(usage).length === 0 ||
      Object.keys(usage).some(key => !["prompt_tokens", "completion_tokens", "total_tokens"].includes(key)) ||
      Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0))) {
    return { valid: false, errors: ["accounting.usage: 只接受网关实际提供的三项非负整数耗用"] };
  }
  return { valid: true, errors: [] };
}

/** The current gateway reports token counts, never a verified monetary charge. */
export function createC1AiAccounting({ gatewayJobId = null, providerRequestId = null, usage = "unknown" } = {}) {
  const accounting = { schemaVersion: C1_AI_ACCOUNTING_VERSION, gatewayJobId, providerRequestId, usage,
    charge: { status: "unknown", reason: "provider_charge_not_reported" } };
  if (!validateC1AiAccounting(accounting).valid) throw new Error("C1_AI_ACCOUNTING_INVALID: 网关耗用或对账引用不符合已声明合同");
  return deepFreeze(structuredClone(accounting));
}

function assertRequestSource(skuPackage, request = null) {
  const identity = normalizeC1SourceIdentity(skuPackage?.g1Identity);
  const plan = skuPackage.c1ProductPlan;
  if (plan.contractVersion !== C1_CANONICAL_CONTRACT_VERSION ||
      identity.skuPackageId !== skuPackage.skuPackageId || identity.supplierSkuId !== skuPackage.supplierSkuId ||
      identity.platform !== skuPackage.targetPlatform || identity.storeRef.stableStoreId !== skuPackage.targetStore ||
      plan.frozenInputRefs?.candidateId !== identity.candidateId ||
      !sameStoreRef(plan.inputSnapshots.platformSchemaRules.storeRef, identity.storeRef) ||
      !Number.isInteger(skuPackage.dataRevision) || skuPackage.dataRevision < plan.revisionRefs.resultRevision ||
      (request && (!sameJson(request.sourceIdentity, identity) || request.identity.platform !== identity.platform ||
        request.identity.store !== identity.storeRef.stableStoreId))) {
    throw new Error("C1_AI_SOURCE_BINDING_REJECTED: C1必须绑定当前完整G1、Schema和真实SKU修订");
  }
  return identity;
}

function assertAuthorizationReference(authorization, { identity, sourceSkuRevision }) {
  const scope = authorization?.scope;
  if (!exactKeys(authorization, ["authorizationId", "authorizationType", "scope"]) ||
      authorization.authorizationType !== "paid_ai_draft" ||
      !exactKeys(scope, ["candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "jobType"]) ||
      scope.candidateId !== identity.candidateId || scope.skuPackageId !== identity.skuPackageId ||
      scope.platform !== identity.platform || scope.storeRef !== identity.storeRef.stableStoreId ||
      scope.sourceRevision !== sourceSkuRevision || scope.jobType !== "c1_ai_draft") {
    throw new Error("C1_AI_AUTHORIZATION_REQUIRED: 必须提供同一SKU修订的精确单次草稿授权引用");
  }
  assertCanonicalC1AuthorizationId(authorization.authorizationId, "c1.authorizationId");
  assertNoProductionSecrets(scope, "c1.authorizationScope");
}

/** The service projects this DTO only after durable admission and request-start recording. */
export function assertAuthorizedC1Execution({ request, authorizedExecution }) {
  const execution = authorizedExecution;
  assertNoRawPersistenceKeys({ request, authorizedExecution }, "c1.authorizedExecution");
  if (!validateC1AiDraftRequest(request).valid) {
    throw new Error("C1_AI_AUTHORIZED_EXECUTION_REQUIRED: 必须绑定正式C1请求");
  }
  if (!exactKeys(execution, ["schemaVersion", "jobId", "jobType", "candidateRevision", "sourceSkuRevision",
    "identity", "requestFingerprint", "authorizationRef", "status", "externalRequestState"]) ||
      execution.schemaVersion !== C1_AI_AUTHORIZED_EXECUTION_VERSION || execution.jobType !== "c1_ai_draft" ||
      execution.status !== "waiting_platform" || execution.externalRequestState !== "in_flight" ||
      !Number.isInteger(execution.candidateRevision) || execution.candidateRevision < 0 ||
      !Number.isInteger(execution.sourceSkuRevision) || execution.sourceSkuRevision < 0 ||
      execution.sourceSkuRevision !== request.sourceSkuRevision ||
      execution.requestFingerprint !== request.requestFingerprint || requestFingerprint(request) !== request.requestFingerprint ||
      !sameJson(normalizeC1SourceIdentity(execution.identity), request.sourceIdentity)) {
    throw new Error("C1_AI_AUTHORIZED_EXECUTION_REQUIRED: 必须先保存精确作业授权和请求开始状态");
  }
  assertCanonicalFrozenRef(execution.jobId, "c1.softwareJobId");
  assertAuthorizationReference(execution.authorizationRef, execution);
  assertNoRawPersistenceKeys(execution, "c1.authorizedExecution");
  return deepFreeze(structuredClone(execution));
}

/** Called by the settlement use case with its saved terminal record, never by the gateway. */
export function projectC1ProviderJobReference({ request, receipt, settledExecution }) {
  const settled = settledExecution;
  if (!exactKeys(settled, ["schemaVersion", "authorizedExecution", "softwareJobId", "gatewayJobId", "status", "externalRequestState", "receiptRef"]) ||
      settled.schemaVersion !== C1_AI_SETTLED_EXECUTION_VERSION || settled.status !== "completed" ||
      settled.externalRequestState !== "succeeded" || settled.softwareJobId !== receipt?.softwareJobId ||
      settled.gatewayJobId !== receipt?.gatewayJobId || settled.receiptRef !== receipt?.receiptId) {
    throw new Error("C1_AI_SETTLED_EXECUTION_REQUIRED: 只有已保存的精确成功回执可以形成正式provider引用");
  }
  const execution = assertAuthorizedC1Execution({ request, authorizedExecution: settled.authorizedExecution });
  const validation = validateC1AiDraftReceipt({ request, receipt });
  if (!validation.valid || receipt.softwareJobId !== execution.jobId) {
    throw new Error("C1_AI_PROVIDER_RECEIPT_REJECTED: 正式回执必须属于同一已保存的软件作业");
  }
  return deepFreeze({
    jobId: receipt.gatewayJobId, jobType: "c1_ai_draft", providerId: receipt.provider, providerVersion: receipt.modelVersion,
    candidateId: execution.identity.candidateId, skuPackageId: execution.identity.skuPackageId,
    platform: execution.identity.platform, storeRef: execution.identity.storeRef.stableStoreId,
    authorizationRef: structuredClone(execution.authorizationRef), inputFingerprint: request.requestFingerprint,
    sourceRevision: request.sourceSkuRevision, receiptRef: receipt.receiptId, terminalStatus: "completed",
    requestSubmitted: true, responseVerified: true
  });
}

function collectConfirmedFacts(value, path, result) {
  if (isObject(value) && "verificationStatus" in value && "sourceRefs" in value) {
    if (value.verificationStatus === "confirmed" && value.value !== "unknown" &&
        Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0) {
      result.push({
        factPath: path,
        value: structuredClone(value.value),
        evidenceRefs: unique(value.sourceRefs)
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectConfirmedFacts(child, `${path}.${index}`, result));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) collectConfirmedFacts(child, `${path}.${key}`, result);
  }
}

function factSnapshot(plan) {
  return Object.fromEntries(FACT_SECTIONS.map((field) => [field, structuredClone(plan[field])]));
}

function frozenInputSnapshot(plan) {
  return Object.fromEntries(["inputRefs", "inputSnapshots", "revisionRefs", "frozenInputRefs", "schemaSnapshotRef",
    "mediaRequirements", "unknownManifest"].map(field => [field, structuredClone(plan[field])]));
}

function assertUnchangedC1RequestInputs(plan, request) {
  if (request.identity.c1PlanId !== plan.c1PlanId || request.identity.skuPackageId !== plan.identity.skuPackageId ||
      request.identity.supplierSkuId !== plan.identity.supplierSkuId || request.identity.variantKey !== plan.identity.variantKey ||
      request.sourceFactsFingerprint !== fingerprint(factSnapshot(plan)) ||
      request.sourceInputFingerprint !== fingerprint(frozenInputSnapshot(plan)) ||
      !sameJson(request.verifiedFacts, confirmedFactCatalog(plan))) {
    throw new Error("C1_AI_FACT_DRIFT_DETECTED: C1事实或SKU在AI调用后发生变化");
  }
}

/** Admission checks the saved request against the current source before starting its one external attempt. */
export function assertCurrentC1AiDraftRequest({ skuPackage, request }) {
  if (!validateC1AiDraftRequest(request).valid) throw new Error("C1_AI_REQUEST_INVALID: 当前请求不符合正式冻结合同");
  const plan = skuPackage?.c1ProductPlan;
  assertNoRawPersistenceKeys(plan, "c1ProductPlan");
  assertValidC1ProductPlan(plan);
  assertRequestSource(skuPackage, request);
  if (skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked" ||
      plan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION || skuPackage.dataRevision !== request.sourceSkuRevision) {
    throw new Error("C1_AI_REQUEST_GATE_REJECTED: 请求只能属于当前已核验且尚未合并的SKU修订");
  }
  assertUnchangedC1RequestInputs(plan, request);
  validateCompetitorSnapshot(request.competitorTextEvidence, plan);
  return deepFreeze(structuredClone(request));
}

function confirmedFactCatalog(plan) {
  const facts = [];
  for (const section of FACT_SECTIONS) collectConfirmedFacts(plan[section], section, facts);
  return facts;
}

function validateTaskClassification(classification) {
  if (!isObject(classification) || !["standard", "complex"].includes(classification.complexity) ||
      !nonEmpty(classification.reason) || !["software", "owner"].includes(classification.markedBy) ||
      !isoDateTime(classification.markedAt)) {
    throw new Error("C1_AI_TASK_CLASSIFICATION_INVALID: 必须在请求前标记任务复杂度、理由、标记者和时间");
  }
  if (classification.complexity === "complex" && classification.preapprovedForSol !== true) {
    throw new Error("C1_AI_SOL_PREAPPROVAL_REQUIRED: Sol只接受预先标记并批准的复杂任务");
  }
  if (classification.complexity === "standard" && classification.preapprovedForSol === true) {
    throw new Error("C1_AI_ROUTE_SCOPE_REJECTED: 普通任务不得预授权Sol");
  }
}

function validateCompetitorSnapshot(snapshot, plan) {
  if (!isObject(snapshot) || !nonEmpty(snapshot.snapshotId) || !nonEmpty(snapshot.evidenceRef) ||
      snapshot.sourceSalesSnapshotId !== plan.inputRefs.salesSnapshotId || !isoDateTime(snapshot.observedAt) ||
      !Array.isArray(snapshot.texts) || snapshot.texts.length === 0 ||
      snapshot.texts.some((item) => !isObject(item) || !nonEmpty(item.textId) || !nonEmpty(item.text) || !nonEmpty(item.sourceRef))) {
    throw new Error("C1_AI_COMPETITOR_EVIDENCE_INVALID: 竞品文本必须来自C1冻结销售快照并保留证据引用");
  }
}

function validateSeoRules(rules) {
  if (!isObject(rules) || !nonEmpty(rules.rulesVersion) || rules.locale !== "ru-RU" ||
      !Number.isInteger(rules.titleMaxLength) || rules.titleMaxLength < 1 ||
      !Number.isInteger(rules.descriptionMaxLength) || rules.descriptionMaxLength < 1 ||
      !Number.isInteger(rules.bulletPointLimit) || rules.bulletPointLimit < 1 ||
      !Array.isArray(rules.prohibitedClaims)) {
    throw new Error("C1_AI_SEO_RULES_INVALID: 必须提供版本化俄语SEO规则和禁止宣称清单");
  }
}

function prepareKeywords(evidence, plan, factMap) {
  if (!isObject(evidence) || evidence.status !== "ready" || evidence.targetPlatform !== plan.identity.targetPlatform ||
      evidence.targetSkuPackageId !== plan.identity.skuPackageId || !nonEmpty(evidence.evidenceId) ||
      !isoDateTime(evidence.observedAt) || !Array.isArray(evidence.keywords)) {
    throw new Error("C1_AI_KEYWORD_EVIDENCE_INVALID: 关键词证据与当前SKU不匹配");
  }
  const retained = evidence.keywords.filter((keyword) =>
    isObject(keyword) && keyword.relevanceStatus === "retained" && nonEmpty(keyword.query) &&
    nonEmpty(keyword.keywordEvidenceRef) && Array.isArray(keyword.factBindingPaths) &&
    keyword.factBindingPaths.length > 0 && keyword.factBindingPaths.every((path) => factMap.has(path))
  ).map((keyword) => ({
    query: keyword.query,
    group: keyword.group,
    keywordEvidenceRef: keyword.keywordEvidenceRef,
    factRefs: unique(keyword.factBindingPaths),
    sourceSku: keyword.sourceSku || null,
    sourcePlatform: keyword.sourcePlatform || evidence.sourcePlatform,
    ...(Array.isArray(keyword.allowedOutputFields) ? { allowedOutputFields: unique(keyword.allowedOutputFields) } : {}),
    ...(keyword.purpose ? { purpose: keyword.purpose } : {}),
    ...(keyword.score !== undefined ? { score: keyword.score } : {}),
    ...(keyword.confidence !== undefined ? { confidence: keyword.confidence } : {}),
    ...(keyword.components !== undefined ? { components: structuredClone(keyword.components) } : {}),
    ...(keyword.matchType ? { matchType: keyword.matchType } : {}),
    ...(keyword.usageRestriction !== undefined ? { usageRestriction: keyword.usageRestriction } : {}),
    ...(keyword.placementGateEvidence !== undefined ? { placementGateEvidence: structuredClone(keyword.placementGateEvidence) } : {}),
    ...(keyword.sourceRefs !== undefined ? { sourceRefs: structuredClone(keyword.sourceRefs) } : {}),
    ...(keyword.k3FactRefs !== undefined ? { k3FactRefs: structuredClone(keyword.k3FactRefs) } : {})
  }));
  if (retained.length === 0) throw new Error("C1_AI_KEYWORD_EVIDENCE_INVALID: 没有同时受关键词证据和已核验事实支持的词");
  return retained;
}

export function buildC1AiDraftRequest({
  skuPackage,
  competitorTextSnapshot,
  keywordEvidence,
  seoRules,
  taskClassification,
  requestedAt
}) {
  const plan = skuPackage?.c1ProductPlan;
  assertNoRawPersistenceKeys(plan, "c1ProductPlan");
  assertValidC1ProductPlan(plan);
  if (skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked" ||
      plan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION) {
    throw new Error("C1_AI_REQUEST_GATE_REJECTED: 只有完成事实核验的C1可以生成AI请求");
  }
  const sourceIdentity = assertRequestSource(skuPackage);
  if (!isoDateTime(requestedAt)) throw new Error("C1_AI_REQUEST_TIME_INVALID: 请求时间无效");
  validateTaskClassification(taskClassification);
  validateCompetitorSnapshot(competitorTextSnapshot, plan);
  validateSeoRules(seoRules);

  const facts = confirmedFactCatalog(plan);
  const factMap = new Map(facts.map((fact) => [fact.factPath, fact]));
  if (facts.length === 0) throw new Error("C1_AI_REQUEST_FACTS_MISSING: 没有可供模型使用的已核验事实");
  const keywords = prepareKeywords(keywordEvidence, plan, factMap);
  const provider = taskClassification.complexity === "complex" ? "sol" : "terra";
  const factsFingerprint = fingerprint(factSnapshot(plan));
  const requestCore = {
    schemaVersion: C1_AI_DRAFT_REQUEST_VERSION,
    providerPolicyVersion: C1_AI_PROVIDER_POLICY_VERSION,
    requestedAt,
    provider,
    taskClassification: structuredClone(taskClassification),
    identity: {
      c1PlanId: plan.c1PlanId,
      skuPackageId: plan.identity.skuPackageId,
      supplierSkuId: plan.identity.supplierSkuId,
      variantKey: plan.identity.variantKey,
      platform: plan.identity.targetPlatform,
      store: plan.identity.targetStore
    },
    sourceIdentity,
    sourceSkuRevision: skuPackage.dataRevision,
    sourceFactsFingerprint: factsFingerprint,
    sourceInputFingerprint: fingerprint(frozenInputSnapshot(plan)),
    verifiedFacts: facts,
    competitorTextEvidence: structuredClone(competitorTextSnapshot),
    keywordEvidence: {
      evidenceId: keywordEvidence.evidenceId,
      observedAt: keywordEvidence.observedAt,
      collectionMode: keywordEvidence.collectionMode,
      ...(keywordEvidence.evidenceRef ? { evidenceRef: keywordEvidence.evidenceRef } : {}),
      ...(keywordEvidence.expiresAt ? { expiresAt: keywordEvidence.expiresAt } : {}),
      ...(keywordEvidence.sourceBindings ? { sourceBindings: structuredClone(keywordEvidence.sourceBindings) } : {}),
      ...(keywordEvidence.groups ? { groups: structuredClone(keywordEvidence.groups) } : {}),
      keywords
    },
    seoRules: structuredClone(seoRules),
    expectedOutput: structuredClone(C1_AI_EXPECTED_OUTPUT),
    executionPolicy: structuredClone(C1_AI_EXECUTION_POLICY)
  };
  const requestFingerprint = fingerprint(requestCore);
  return deepFreeze({
    ...requestCore,
    requestId: `c1-ai-request:${plan.c1PlanId}:${requestFingerprint.slice(0, 16)}`,
    requestFingerprint
  });
}

function validateCitedItem(item, path, outputField, factMap, keywordRefMap, errors) {
  if (!exactKeys(item, ["text", "factRefs", "keywordRefs", "assertions"]) || !nonEmpty(item.text)) {
    errors.push(`${path}: 文本不能为空`);
    return;
  }
  if (!Array.isArray(item.factRefs) || item.factRefs.length === 0 || item.factRefs.some((ref) => !factMap.has(ref))) {
    errors.push(`${path}.factRefs: 必须全部引用请求中的已核验事实`);
  }
  if (!Array.isArray(item.keywordRefs) || item.keywordRefs.length === 0 || item.keywordRefs.some((ref) => !keywordRefMap.has(ref))) {
    errors.push(`${path}.keywordRefs: 必须全部引用请求中的关键词证据`);
  } else if (item.keywordRefs.some((ref) => {
    const allowed = keywordRefMap.get(ref)?.allowedOutputFields;
    return Array.isArray(allowed) && !allowed.includes(outputField);
  })) {
    errors.push(`${path}.keywordRefs: 关键词组用途越界`);
  }
  if (!Array.isArray(item.assertions) || item.assertions.length === 0) {
    errors.push(`${path}.assertions: 必须显式声明文本中的商品事实`);
    return;
  }
  item.assertions.forEach((assertion, index) => {
    const fact = factMap.get(assertion?.factPath);
    if (!exactKeys(assertion, ["factPath", "value"]) || !fact || !sameJson(assertion.value, fact.value)) {
      errors.push(`${path}.assertions[${index}]: 模型新增或篡改了未核验事实`);
    }
  });
}

export function validateC1AiDraftRequest(request) {
  if (!isObject(request) || request.schemaVersion !== C1_AI_DRAFT_REQUEST_VERSION) {
    return { valid: false, errors: ["request: C1 AI请求无效"] };
  }
  try {
    assertNoRawPersistenceKeys(request, "c1AiRequest");
    assertNoProductionSecrets(request, "c1AiRequest");
  } catch { return { valid: false, errors: ["request: 请求含秘密、原始响应或超限结构"] }; }
  if (!exactKeys(request, ["schemaVersion", "requestId", "requestFingerprint", "providerPolicyVersion", "requestedAt", "provider", "taskClassification",
    "identity", "sourceIdentity", "sourceSkuRevision", "sourceInputFingerprint", "sourceFactsFingerprint", "verifiedFacts",
    "competitorTextEvidence", "keywordEvidence", "seoRules", "expectedOutput", "executionPolicy"]) ||
      !exactKeys(request.identity, ["c1PlanId", "skuPackageId", "supplierSkuId", "variantKey", "platform", "store"]) ||
      !Array.isArray(request.verifiedFacts) || request.verifiedFacts.length === 0 ||
      request.verifiedFacts.some(fact => !exactKeys(fact, ["factPath", "value", "evidenceRefs"]) || !nonEmpty(fact.factPath) ||
        !Array.isArray(fact.evidenceRefs) || fact.evidenceRefs.length === 0 || fact.evidenceRefs.some(ref => !nonEmpty(ref))) ||
      !isObject(request.competitorTextEvidence) ||
      !Array.isArray(request.keywordEvidence?.keywords) || request.keywordEvidence.keywords.length === 0 || !isObject(request.seoRules) ||
      request.keywordEvidence.keywords.some(keyword => !isObject(keyword) || !nonEmpty(keyword.keywordEvidenceRef)) ||
      !Number.isInteger(request.sourceSkuRevision) || request.sourceSkuRevision < 0 ||
      !/^[a-f0-9]{64}$/.test(String(request.sourceInputFingerprint ?? ""))) {
    return { valid: false, errors: ["request: 必须是完整的冻结C1请求"] };
  }
  if (request.providerPolicyVersion !== C1_AI_PROVIDER_POLICY_VERSION || !["terra", "sol"].includes(request.provider) ||
      !sameJson(request.executionPolicy, C1_AI_EXECUTION_POLICY) || !sameJson(request.expectedOutput, C1_AI_EXPECTED_OUTPUT) ||
      !/^[a-f0-9]{64}$/.test(String(request.sourceFactsFingerprint ?? ""))) {
    return { valid: false, errors: ["request: 路由或执行边界不符合唯一C1合同"] };
  }
  try {
    normalizeC1SourceIdentity(request.sourceIdentity);
    validateTaskClassification(request.taskClassification);
    validateSeoRules(request.seoRules);
  } catch { return { valid: false, errors: ["request: 冻结身份、任务分类或SEO规则无效"] }; }
  if (!isoDateTime(request.requestedAt) || Date.parse(request.taskClassification.markedAt) > Date.parse(request.requestedAt) ||
      request.provider !== (request.taskClassification.complexity === "complex" ? "sol" : "terra") ||
      Object.values(request.identity).some(value => !nonEmpty(value)) ||
      request.identity.skuPackageId !== request.sourceIdentity.skuPackageId ||
      request.identity.supplierSkuId !== request.sourceIdentity.supplierSkuId ||
      request.identity.platform !== request.sourceIdentity.platform ||
      request.identity.store !== request.sourceIdentity.storeRef.stableStoreId) {
    return { valid: false, errors: ["request: 请求时间、模型路由或SKU身份与冻结来源不一致"] };
  }
  if (requestFingerprint(request) !== request.requestFingerprint ||
      request.requestId !== `c1-ai-request:${request.identity?.c1PlanId}:${request.requestFingerprint.slice(0, 16)}`) {
    return { valid: false, errors: ["request: 请求指纹或身份已被修改"] };
  }
  return { valid: true, errors: [] };
}

export function validateC1AiDraftReceipt({ request, receipt }) {
  const requestValidation = validateC1AiDraftRequest(request);
  if (!requestValidation.valid) return requestValidation;
  const errors = [];
  if (!isObject(receipt)) return { valid: false, errors: ["receipt: 必须是对象"] };
  if (!exactKeys(receipt, ["schemaVersion", "receiptId", "providerRequestId", "softwareJobId", "gatewayJobId",
    "requestId", "requestFingerprint", "provider", "modelVersion", "serviceVersion", "status", "attempt",
    "startedAt", "completedAt", "inputEvidenceRefs", "outputFingerprint", "externalPlatformAccesses", "codexDispatches", "productionWrites", "output", "accounting"])) {
    return { valid: false, errors: ["receipt: 回执字段必须符合唯一closed合同"] };
  }
  try {
    assertNoRawPersistenceKeys({ request, receipt }, "c1AiReceipt");
    assertNoProductionSecrets({ request, receipt }, "c1AiReceipt");
  } catch { return { valid: false, errors: ["receipt: 请求或回执含秘密、原始响应或超限结构"] }; }
  if (receipt.schemaVersion !== C1_AI_DRAFT_RECEIPT_VERSION) errors.push("schemaVersion: 回执版本无效");
  if (!nonEmpty(receipt.receiptId) || !nonEmpty(receipt.providerRequestId)) errors.push("receiptId: 必须记录本地回执ID和第三方调用ID");
  for (const field of ["receiptId", "providerRequestId", "softwareJobId", "gatewayJobId"]) {
    try { assertCanonicalFrozenRef(receipt[field], `receipt.${field}`); }
    catch { errors.push(`${field}: 必须是明确的安全作业或回执引用`); }
  }
  if (receipt.requestId !== request.requestId || receipt.requestFingerprint !== request.requestFingerprint) errors.push("request: 回执不属于当前请求");
  if (receipt.provider !== request.provider) errors.push("provider: 模型路由与预定义路由不一致");
  if (!validateC1AiAccounting(receipt.accounting).valid || receipt.accounting.gatewayJobId !== receipt.gatewayJobId ||
      receipt.accounting.providerRequestId !== receipt.providerRequestId) errors.push("accounting: 必须保留同一回执的真实耗用或明确未知费用");
  if (!nonEmpty(receipt.modelVersion) || !nonEmpty(receipt.serviceVersion)) errors.push("modelVersion: 必须记录模型与服务版本");
  if (receipt.status !== "completed" || receipt.attempt !== 1) errors.push("status: 只接受首次调用成功的completed回执");
  if (!isoDateTime(request.requestedAt) || !isoDateTime(receipt.startedAt) || !isoDateTime(receipt.completedAt) ||
      Date.parse(request.requestedAt) > Date.parse(receipt.startedAt) || Date.parse(receipt.startedAt) > Date.parse(receipt.completedAt)) {
    errors.push("time: 必须记录真实有效且按请求、开始、完成排序的UTC时间");
  }
  if (receipt.externalPlatformAccesses !== 0 || receipt.codexDispatches !== 0 || receipt.productionWrites !== 0) errors.push("boundary: C1 AI不得访问平台、派发Codex或生产写入");
  if (!exactKeys(receipt.output, ["status", "locale", "claimCoverage", "unsupportedClaims", "title", "description", "bulletPoints", "searchKeywords"]) ||
      receipt.output.status !== "draft_only" || receipt.output.locale !== "ru-RU" || receipt.output.claimCoverage !== "complete") {
    errors.push("output: 必须是俄语draft_only且声明完整事实覆盖");
    return { valid: false, errors };
  }
  const expectedEvidenceRefs = unique([
    request.competitorTextEvidence.evidenceRef,
    request.keywordEvidence.evidenceId,
    ...request.verifiedFacts.flatMap((fact) => fact.evidenceRefs)
  ]).sort();
  if (!Array.isArray(receipt.inputEvidenceRefs) || !sameJson(unique(receipt.inputEvidenceRefs).sort(), expectedEvidenceRefs)) {
    errors.push("inputEvidenceRefs: 第三方回执未完整锁定本次输入证据");
  }
  if (!nonEmpty(receipt.outputFingerprint) || receipt.outputFingerprint !== fingerprint(receipt.output)) {
    errors.push("outputFingerprint: 第三方输出指纹缺失或不一致");
  }
  if (!Array.isArray(receipt.output.unsupportedClaims) || receipt.output.unsupportedClaims.length !== 0) errors.push("output.unsupportedClaims: 存在未支持宣称");
  const factMap = new Map(request.verifiedFacts.map((fact) => [fact.factPath, fact]));
  const keywordRefMap = new Map(request.keywordEvidence.keywords.map((keyword) => [keyword.keywordEvidenceRef, keyword]));
  validateCitedItem(receipt.output.title, "output.title", "title", factMap, keywordRefMap, errors);
  validateCitedItem(receipt.output.description, "output.description", "description", factMap, keywordRefMap, errors);
  for (const [field, limit] of [["bulletPoints", request.seoRules.bulletPointLimit], ["searchKeywords", Number.MAX_SAFE_INTEGER]]) {
    const items = receipt.output[field];
    if (!Array.isArray(items) || items.length === 0 || items.length > limit) {
      errors.push(`output.${field}: 数量无效`);
    } else {
      items.forEach((item, index) => validateCitedItem(item, `output.${field}[${index}]`, field, factMap, keywordRefMap, errors));
    }
  }
  if (nonEmpty(receipt.output.title?.text) && receipt.output.title.text.length > request.seoRules.titleMaxLength) errors.push("output.title: 超过SEO标题长度");
  if (nonEmpty(receipt.output.description?.text) && receipt.output.description.text.length > request.seoRules.descriptionMaxLength) errors.push("output.description: 超过SEO描述长度");
  return { valid: errors.length === 0, errors };
}

function draftField(item) {
  return {
    status: "draft_only",
    text: item.text,
    factRefs: unique(item.factRefs),
    keywordEvidenceRefs: unique(item.keywordRefs),
    assertions: structuredClone(item.assertions),
    productionApproved: false
  };
}

function searchKeywordDraft(items) {
  return { status: "draft_only", keywords: items.map(item => ({
    query: item.text, factRefs: unique(item.factRefs), evidenceRefs: unique(item.keywordRefs),
    assertions: structuredClone(item.assertions)
  })), productionApproved: false };
}

export function mergeC1AiDraftReceipt({ skuPackage, request, receipt, settledExecution, mergedAt }) {
  if (!isoDateTime(mergedAt)) throw new Error("C1_AI_MERGE_TIME_INVALID: 合并时间无效");
  const current = skuPackage?.c1ProductPlan;
  assertNoRawPersistenceKeys(current, "c1ProductPlan");
  assertValidC1ProductPlan(current);
  assertRequestSource(skuPackage, request);
  const providerJobRef = projectC1ProviderJobReference({ request, receipt, settledExecution });
  if (Date.parse(mergedAt) < Date.parse(receipt.completedAt)) {
    throw new Error("C1_AI_MERGE_TIME_INVALID: 合并时间不得早于真实回执完成时间");
  }
  assertUnchangedC1RequestInputs(current, request);
  const validation = validateC1AiDraftReceipt({ request, receipt });
  if (!validation.valid) throw new Error(`C1_AI_RECEIPT_REJECTED: ${validation.errors.join("；")}`);
  if (current.status === "seo_draft_ready" && current.seoEvidenceLayer?.aiReceiptId === receipt.receiptId) {
    if (skuPackage.dataRevision !== request.sourceSkuRevision + 1 ||
        !sameJson(current.seoEvidenceLayer.providerJobRef, providerJobRef) ||
        current.seoEvidenceLayer.outputFingerprint !== receipt.outputFingerprint ||
        current.seoEvidenceLayer.aiRequestFingerprint !== request.requestFingerprint ||
        !sameJson(current.seoTitleDraft, draftField(receipt.output.title)) ||
        !sameJson(current.descriptionDraft, draftField(receipt.output.description)) ||
        !sameJson(current.bulletPointsDraft, receipt.output.bulletPoints.map(draftField)) ||
        !sameJson(current.searchKeywordsDraft, searchKeywordDraft(receipt.output.searchKeywords))) {
      throw new Error("C1_AI_REPLAY_DRIFT_DETECTED: 相同回执ID不得覆盖不同正式结果");
    }
    return deepFreeze({ flowVersion: "c1-ai-draft-merge-v1", skuPackage: structuredClone(skuPackage), c1ProductPlan: structuredClone(current), idempotent: true });
  }
  if (skuPackage.businessPhase !== "C1" || current.status !== "facts_checked" || skuPackage.dataRevision !== request.sourceSkuRevision) {
    throw new Error("C1_AI_MERGE_GATE_REJECTED: 当前C1状态或SKU修订不能合并AI草稿");
  }

  const profitBefore = structuredClone(skuPackage.profitModels);
  const c1 = structuredClone(current);
  c1.status = "seo_draft_ready";
  c1.keywordEvidenceRefs = unique([receipt.output.title, receipt.output.description,
    ...receipt.output.bulletPoints, ...receipt.output.searchKeywords].flatMap(item => item.keywordRefs));
  c1.draftOnlySeo = {
    status: "draft_only", formalProviderResultAccepted: true, reason: null,
    aiRequestId: request.requestId, aiRequestFingerprint: request.requestFingerprint,
    inputFingerprint: providerJobRef.inputFingerprint, sourceRevision: providerJobRef.sourceRevision,
    receiptRef: receipt.receiptId, providerJobRef: structuredClone(providerJobRef)
  };
  c1.seoTitleDraft = draftField(receipt.output.title);
  c1.descriptionDraft = draftField(receipt.output.description);
  c1.bulletPointsDraft = receipt.output.bulletPoints.map(draftField);
  c1.searchKeywordsDraft = searchKeywordDraft(receipt.output.searchKeywords);
  c1.seoEvidenceLayer = {
    draftVersion: C1_AI_DRAFT_RECEIPT_VERSION,
    createdAt: mergedAt,
    executionStatus: "draft_only",
    locale: "ru-RU",
    targetPlatform: current.identity.targetPlatform,
    aiRequestId: request.requestId,
    aiRequestFingerprint: request.requestFingerprint,
    aiReceiptId: receipt.receiptId,
    outputFingerprint: receipt.outputFingerprint,
    providerJobRef: structuredClone(providerJobRef),
    inputFingerprint: providerJobRef.inputFingerprint,
    sourceRevision: providerJobRef.sourceRevision,
    provider: receipt.provider,
    modelVersion: receipt.modelVersion,
    serviceVersion: receipt.serviceVersion,
    attempt: 1,
    executionPolicy: structuredClone(request.executionPolicy),
    inputEvidenceRefs: unique([
      request.competitorTextEvidence.evidenceRef,
      request.keywordEvidence.evidenceId,
      ...request.verifiedFacts.flatMap((fact) => fact.evidenceRefs)
    ]),
    productionWrites: 0,
    finalApprovalGranted: false
  };
  assertValidC1ProductPlan(c1);

  const next = structuredClone(skuPackage);
  next.c1ProductPlan = c1;
  next.dataRevision += 1;
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = mergedAt;
  next.audit.history.push({
    event: "c1_ai_draft_receipt_merged",
    at: mergedAt,
    requestId: request.requestId,
    receiptId: receipt.receiptId,
    provider: receipt.provider,
    modelVersion: receipt.modelVersion,
    codexDispatches: 0,
    platformWrites: 0,
    c2Started: false,
    productionStarted: false
  });
  if (!sameJson(next.profitModels, profitBefore) || next.activeProfitModelVersion !== skuPackage.activeProfitModelVersion) {
    throw new Error("C1_AI_PROTECTED_DATA_CHANGED: B利润结果被修改");
  }
  if (next.supplierSkuId !== skuPackage.supplierSkuId || next.variantKey !== skuPackage.variantKey) {
    throw new Error("C1_AI_PROTECTED_DATA_CHANGED: 供应SKU被替换");
  }
  if (next.c2FinalAssets !== null || next.productionAuthorization !== null || next.productionRecord !== null) {
    throw new Error("C1_AI_BOUNDARY_VIOLATION: C1不得进入C2、D或E");
  }
  return deepFreeze({ flowVersion: "c1-ai-draft-merge-v1", skuPackage: next, c1ProductPlan: next.c1ProductPlan, idempotent: false });
}

export const C1_AI_DRAFT_EXECUTION_POLICY_VERSION = "c1-ai-draft-execution-policy-v1";
export const C1_AI_DRAFT_PAYMENT_AUTHORIZATION_VERSION = "c1-ai-draft-payment-authorization-v1";

export class C1AiDraftPaymentPolicyError extends Error {
  constructor(code) { super(code); this.name = "C1AiDraftPaymentPolicyError"; this.code = code; }
}

/** Historical restricted-record validation only; new single-use permissions do not require a budget policy. */
export function validateC1AiDraftExecutionPolicy(policy, { observedAt } = {}) {
  const errors = [];
  const fields = ["schemaVersion", "policyRef", "configurationVersion", "provider", "modelVersion", "credentialAlias",
    "serviceBindingRef", "serviceContractVersion", "allowedWorkerIds", "quote"];
  if (!exactKeys(policy, fields) || policy.schemaVersion !== C1_AI_DRAFT_EXECUTION_POLICY_VERSION) {
    return { valid: false, errors: ["C1_DRAFT_EXECUTION_POLICY_INVALID"] };
  }
  for (const field of ["policyRef", "configurationVersion", "modelVersion", "credentialAlias", "serviceBindingRef", "serviceContractVersion"]) {
    try { assertCanonicalFrozenRef(policy[field], field); } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("C2_REFERENCE_REJECTED_NONCANONICAL:")) throw error;
      errors.push("C1_DRAFT_EXECUTION_POLICY_REFERENCE_INVALID");
    }
  }
  if (!["terra", "sol"].includes(policy.provider) || policy.modelVersion !== `gpt-5.6-${policy.provider}`) errors.push("C1_DRAFT_EXECUTION_POLICY_PROVIDER_INVALID");
  if (!Array.isArray(policy.allowedWorkerIds) || policy.allowedWorkerIds.length < 1 || policy.allowedWorkerIds.length > 32 ||
      new Set(policy.allowedWorkerIds).size !== policy.allowedWorkerIds.length) errors.push("C1_DRAFT_EXECUTION_POLICY_WORKERS_INVALID");
  else for (const workerId of policy.allowedWorkerIds) {
    try { assertCanonicalFrozenRef(workerId, "workerId"); } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("C2_REFERENCE_REJECTED_NONCANONICAL:")) throw error;
      errors.push("C1_DRAFT_EXECUTION_POLICY_WORKERS_INVALID");
    }
  }
  const quote = policy.quote;
  if (!exactKeys(quote, ["schemaVersion", "quoteRef", "quotedAt", "expiresAt", "maximumAmountMinor", "currency", "currencyScale", "maxCalls", "allowZeroCharge"]) ||
      quote.schemaVersion !== "c1-ai-draft-quote-v1") errors.push("C1_DRAFT_QUOTE_INVALID");
  else {
    try { assertCanonicalFrozenRef(quote.quoteRef, "quoteRef"); } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("C2_REFERENCE_REJECTED_NONCANONICAL:")) throw error;
      errors.push("C1_DRAFT_QUOTE_REFERENCE_INVALID");
    }
    if (!isoDateTime(quote.quotedAt) || !isoDateTime(quote.expiresAt) || Date.parse(quote.quotedAt) >= Date.parse(quote.expiresAt)) errors.push("C1_DRAFT_QUOTE_TIME_INVALID");
    if (!Number.isSafeInteger(quote.maximumAmountMinor) || quote.maximumAmountMinor < 0 || typeof quote.allowZeroCharge !== "boolean" ||
        (quote.maximumAmountMinor === 0 && !quote.allowZeroCharge) || !/^[A-Z]{3}$/.test(quote.currency) ||
        !Number.isInteger(quote.currencyScale) || quote.currencyScale < 0 || quote.currencyScale > 6 || quote.maxCalls !== 1) errors.push("C1_DRAFT_QUOTE_BUDGET_INVALID");
    if (observedAt !== undefined && (!isoDateTime(observedAt) || Date.parse(observedAt) < Date.parse(quote.quotedAt) ||
        Date.parse(observedAt) >= Date.parse(quote.expiresAt))) errors.push("C1_DRAFT_QUOTE_NOT_CURRENT");
  }
  try { assertNoRawPersistenceKeys(policy, "c1DraftExecutionPolicy"); assertNoProductionSecrets(policy, "c1DraftExecutionPolicy"); }
  catch (error) {
    if (!(error instanceof Error) || !/^(C2_SENSITIVE_INPUT_REJECTED|PRODUCTION_AUTHORIZATION_SECRET_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)(?::|$)/.test(error.message)) throw error;
    errors.push("C1_DRAFT_EXECUTION_POLICY_UNSAFE");
  }
  return { valid: errors.length === 0, errors };
}

export function assertC1AiDraftExecutionPolicy(policy, context = {}) {
  const result = validateC1AiDraftExecutionPolicy(policy, context);
  if (!result.valid) throw new C1AiDraftPaymentPolicyError(result.errors[0]);
  return deepFreeze(structuredClone(policy));
}

export function assertC1AiDraftPaymentAuthorization(value, { scopeBinding, observedAt } = {}) {
  if (!exactKeys(value, ["schemaVersion", "proposalRef", "proposalFingerprint", "requestFingerprint", "executionPolicy"]) ||
      value.schemaVersion !== C1_AI_DRAFT_PAYMENT_AUTHORIZATION_VERSION || !/^[a-f0-9]{64}$/.test(value.proposalFingerprint) ||
      !/^[a-f0-9]{64}$/.test(value.requestFingerprint)) throw new C1AiDraftPaymentPolicyError("C1_DRAFT_PAYMENT_AUTHORIZATION_REQUIRED");
  assertCanonicalFrozenRef(value.proposalRef, "proposalRef");
  const policy = assertC1AiDraftExecutionPolicy(value.executionPolicy, { observedAt });
  if (scopeBinding && (value.requestFingerprint !== scopeBinding.requestFingerprint || policy.provider !== scopeBinding.provider ||
      policy.credentialAlias !== scopeBinding.credentialAlias)) throw new C1AiDraftPaymentPolicyError("C1_DRAFT_PAYMENT_AUTHORIZATION_SCOPE_CONFLICT");
  return deepFreeze(structuredClone(value));
}
