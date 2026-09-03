import { createHash } from "node:crypto";
import {
  C1_FACT_VERIFICATION_VERSION,
  assertValidC1ProductPlan
} from "./c1-product-plan.mjs";

export const C1_AI_DRAFT_REQUEST_VERSION = "c1-ai-draft-request-v1";
export const C1_AI_DRAFT_RECEIPT_VERSION = "c1-ai-draft-receipt-v1";
export const C1_AI_PROVIDER_POLICY_VERSION = "c1-ai-provider-policy-v1";

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
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
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
  assertValidC1ProductPlan(plan);
  if (skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked" ||
      plan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION) {
    throw new Error("C1_AI_REQUEST_GATE_REJECTED: 只有完成事实核验的C1可以生成AI请求");
  }
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
    sourceFactsFingerprint: factsFingerprint,
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
    expectedOutput: {
      locale: "ru-RU",
      status: "draft_only",
      fields: ["title", "description", "bulletPoints", "searchKeywords"],
      citationPolicy: "every_output_item_requires_fact_and_keyword_refs",
      assertionPolicy: "every_factual_assertion_must_equal_a_verified_fact"
    },
    executionPolicy: {
      attemptLimit: 1,
      automaticRetry: false,
      fallbackProvider: null,
      solFallbackAfterTerraFailure: false,
      codexDispatch: false,
      platformAccessAllowed: false,
      productionWriteAllowed: false
    }
  };
  const requestFingerprint = fingerprint(requestCore);
  return deepFreeze({
    ...requestCore,
    requestId: `c1-ai-request:${plan.c1PlanId}:${requestFingerprint.slice(0, 16)}`,
    requestFingerprint
  });
}

function validateCitedItem(item, path, outputField, factMap, keywordRefMap, errors) {
  if (!isObject(item) || !nonEmpty(item.text)) {
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
    if (!fact || !sameJson(assertion.value, fact.value)) {
      errors.push(`${path}.assertions[${index}]: 模型新增或篡改了未核验事实`);
    }
  });
}

export function validateC1AiDraftReceipt({ request, receipt }) {
  const errors = [];
  if (!isObject(request) || request.schemaVersion !== C1_AI_DRAFT_REQUEST_VERSION) {
    return { valid: false, errors: ["request: C1 AI请求无效"] };
  }
  if (requestFingerprint(request) !== request.requestFingerprint ||
      request.requestId !== `c1-ai-request:${request.identity?.c1PlanId}:${request.requestFingerprint.slice(0, 16)}`) {
    return { valid: false, errors: ["request: 请求指纹或身份已被修改"] };
  }
  if (!isObject(receipt)) return { valid: false, errors: ["receipt: 必须是对象"] };
  if (receipt.schemaVersion !== C1_AI_DRAFT_RECEIPT_VERSION) errors.push("schemaVersion: 回执版本无效");
  if (!nonEmpty(receipt.receiptId) || !nonEmpty(receipt.providerRequestId)) errors.push("receiptId: 必须记录本地回执ID和第三方调用ID");
  if (receipt.requestId !== request.requestId || receipt.requestFingerprint !== request.requestFingerprint) errors.push("request: 回执不属于当前请求");
  if (receipt.provider !== request.provider) errors.push("provider: 模型路由与预定义路由不一致");
  if (!nonEmpty(receipt.modelVersion) || !nonEmpty(receipt.serviceVersion)) errors.push("modelVersion: 必须记录模型与服务版本");
  if (receipt.status !== "completed" || receipt.attempt !== 1) errors.push("status: 只接受首次调用成功的completed回执");
  if (!isoDateTime(receipt.startedAt) || !isoDateTime(receipt.completedAt)) errors.push("time: 必须记录有效开始和完成时间");
  if (receipt.externalPlatformAccesses !== 0 || receipt.codexDispatches !== 0 || receipt.productionWrites !== 0) errors.push("boundary: C1 AI不得访问平台、派发Codex或生产写入");
  if (!isObject(receipt.output) || receipt.output.status !== "draft_only" || receipt.output.locale !== "ru-RU" || receipt.output.claimCoverage !== "complete") {
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

export function mergeC1AiDraftReceipt({ skuPackage, request, receipt, mergedAt }) {
  if (!isoDateTime(mergedAt)) throw new Error("C1_AI_MERGE_TIME_INVALID: 合并时间无效");
  const current = skuPackage?.c1ProductPlan;
  assertValidC1ProductPlan(current);
  if (current.status === "seo_draft_ready" && current.seoEvidenceLayer?.aiReceiptId === receipt?.receiptId) {
    return deepFreeze({ flowVersion: "c1-ai-draft-merge-v1", skuPackage: structuredClone(skuPackage), c1ProductPlan: structuredClone(current), idempotent: true });
  }
  if (skuPackage.businessPhase !== "C1" || current.status !== "facts_checked") throw new Error("C1_AI_MERGE_GATE_REJECTED: 当前C1状态不能合并AI草稿");
  if (request.identity.c1PlanId !== current.c1PlanId || request.identity.skuPackageId !== current.identity.skuPackageId ||
      request.identity.supplierSkuId !== current.identity.supplierSkuId || request.identity.variantKey !== current.identity.variantKey ||
      request.sourceFactsFingerprint !== fingerprint(factSnapshot(current))) {
    throw new Error("C1_AI_FACT_DRIFT_DETECTED: C1事实或SKU在AI调用后发生变化");
  }
  const validation = validateC1AiDraftReceipt({ request, receipt });
  if (!validation.valid) throw new Error(`C1_AI_RECEIPT_REJECTED: ${validation.errors.join("；")}`);

  const profitBefore = structuredClone(skuPackage.profitModels);
  const c1 = structuredClone(current);
  c1.status = "seo_draft_ready";
  c1.seoTitleDraft = draftField(receipt.output.title);
  c1.descriptionDraft = draftField(receipt.output.description);
  c1.bulletPointsDraft = receipt.output.bulletPoints.map(draftField);
  c1.searchKeywordsDraft = {
    status: "draft_only",
    keywords: receipt.output.searchKeywords.map((item) => ({
      query: item.text,
      factRefs: unique(item.factRefs),
      evidenceRefs: unique(item.keywordRefs),
      assertions: structuredClone(item.assertions)
    })),
    productionApproved: false
  };
  c1.seoEvidenceLayer = {
    draftVersion: C1_AI_DRAFT_RECEIPT_VERSION,
    createdAt: mergedAt,
    executionStatus: "draft_only",
    locale: "ru-RU",
    targetPlatform: current.identity.targetPlatform,
    aiRequestId: request.requestId,
    aiRequestFingerprint: request.requestFingerprint,
    aiReceiptId: receipt.receiptId,
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
