import { createHash } from "node:crypto";
import {
  C1_FACT_VERIFICATION_VERSION,
  assertValidC1ProductPlan
} from "./c1-product-plan.mjs";
import { adaptK3KeywordEvidenceForC1 } from "./c1-k3-keyword-adapter.mjs";

export const C1_SOFTWARE_INPUT_PREPARATION_VERSION = "c1-software-input-preparation-v1";

export const C1_ALLOWED_SOL_GATEWAY_TASK_TYPES = Object.freeze([
  "evidence_conflict_analysis",
  "category_dispute_analysis",
  "brand_ip_compliance_analysis",
  "multi_image_sku_mapping"
]);

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function jsonPointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectAttributeTexts(value, path, keyPath, evidenceRef, result) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectAttributeTexts(
      child,
      `${path}/${index}`,
      `${keyPath}[${index}]`,
      evidenceRef,
      result
    ));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) collectAttributeTexts(
      child,
      `${path}/${jsonPointerSegment(key)}`,
      keyPath ? `${keyPath}.${key}` : key,
      evidenceRef,
      result
    );
    return;
  }
  if (value === null || value === undefined || value === "") return;
  result.push({
    textId: `sales-attribute:${path}`,
    text: `${keyPath}: ${String(value)}`,
    sourceRef: `${evidenceRef}#/attributes${path}`,
    role: "buyer_language_reference_only"
  });
}

function factSnapshot(plan) {
  return Object.fromEntries(FACT_SECTIONS.map((field) => [field, structuredClone(plan[field])]));
}

function collectConfirmedFacts(value, path, result) {
  if (isObject(value) && "verificationStatus" in value && "sourceRefs" in value) {
    if (value.verificationStatus === "confirmed" && value.value !== "unknown" &&
        Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0) {
      result.push({
        factPath: path,
        value: structuredClone(value.value),
        sourceRefs: [...new Set(value.sourceRefs.filter(nonEmpty))],
        valueFingerprint: sha256(value.value)
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

export function projectC1ConfirmedFacts(c1ProductPlan) {
  assertValidC1ProductPlan(c1ProductPlan);
  const result = [];
  for (const section of FACT_SECTIONS) collectConfirmedFacts(c1ProductPlan[section], section, result);
  return deepFreeze(result);
}

export function fingerprintC1VerifiedFacts(c1ProductPlan) {
  assertValidC1ProductPlan(c1ProductPlan);
  return sha256(factSnapshot(c1ProductPlan));
}

export function fingerprintC1SalesSnapshot(salesSnapshot) {
  if (!isObject(salesSnapshot)) throw new Error("C1_INPUT_PREPARATION_SALES_INVALID: 缺少冻结销售快照");
  return sha256(salesSnapshot);
}

export function projectC1CompetitorTextSnapshot(plan) {
  assertValidC1ProductPlan(plan);
  const salesFingerprint = fingerprintC1SalesSnapshot(plan.inputSnapshots.salesSnapshot);
  const sales = plan.inputSnapshots.salesSnapshot;
  if (sales.snapshotId !== plan.inputRefs.salesSnapshotId || !nonEmpty(sales.title) ||
      !isObject(sales.attributes) || !nonEmpty(sales.evidenceRef) || !isoDateTime(sales.collectedAt)) {
    throw new Error("C1_INPUT_PREPARATION_SALES_INVALID: 冻结销售快照必须含匹配的snapshotId、真实标题、属性、时间和evidenceRef");
  }
  const texts = [{
    textId: `sales-title:${sales.snapshotId}`,
    text: sales.title,
    sourceRef: `${sales.evidenceRef}#/title`,
    role: "buyer_language_reference_only"
  }];
  collectAttributeTexts(sales.attributes, "", "", sales.evidenceRef, texts);
  return {
    snapshotId: `competitor-text:${sales.snapshotId}:${salesFingerprint.slice(0, 16)}`,
    sourceSalesSnapshotId: sales.snapshotId,
    sourceSalesSnapshotFingerprint: salesFingerprint,
    observedAt: sales.collectedAt,
    evidenceRef: sales.evidenceRef,
    texts
  };
}

function prepareSeoRules(frozenSeoRules) {
  if (!isObject(frozenSeoRules) || !nonEmpty(frozenSeoRules.rulesVersion) ||
      frozenSeoRules.locale !== "ru-RU" || !nonEmpty(frozenSeoRules.evidenceRef) ||
      !isoDateTime(frozenSeoRules.frozenAt) ||
      !Number.isInteger(frozenSeoRules.titleMaxLength) || frozenSeoRules.titleMaxLength < 1 ||
      !Number.isInteger(frozenSeoRules.descriptionMaxLength) || frozenSeoRules.descriptionMaxLength < 1 ||
      !Number.isInteger(frozenSeoRules.bulletPointLimit) || frozenSeoRules.bulletPointLimit < 1 ||
      !Array.isArray(frozenSeoRules.prohibitedClaims)) {
    throw new Error("C1_INPUT_PREPARATION_SEO_RULES_INVALID: 必须提供已冻结、可追溯的俄语SEO规则");
  }
  return structuredClone(frozenSeoRules);
}

function prepareTaskClassification({ plan, factsFingerprint, frozenComplexityDecision, preparedAt }) {
  if (frozenComplexityDecision === null || frozenComplexityDecision === undefined) {
    return {
      complexity: "standard",
      preapprovedForSol: false,
      reason: "未命中任何预先冻结的复杂任务规则，按标准任务交给Terra",
      markedBy: "software",
      markedAt: preparedAt
    };
  }
  const decision = frozenComplexityDecision;
  if (!isObject(decision) || !nonEmpty(decision.decisionId) || !nonEmpty(decision.ruleVersion) ||
      !isoDateTime(decision.evaluatedAt) || decision.c1PlanId !== plan.c1PlanId ||
      !["standard", "complex"].includes(decision.complexity) || !nonEmpty(decision.reason) ||
      !Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length === 0 ||
      decision.evidenceRefs.some((item) => !nonEmpty(item))) {
    throw new Error("C1_INPUT_PREPARATION_CLASSIFICATION_INVALID: 复杂度只能来自完整的冻结规则判断");
  }
  if (decision.sourceFactsFingerprint !== factsFingerprint) {
    throw new Error("C1_INPUT_PREPARATION_EVIDENCE_DRIFT: 复杂度判断绑定的C1事实已经漂移");
  }
  if (decision.complexity === "complex" && !C1_ALLOWED_SOL_GATEWAY_TASK_TYPES.includes(decision.gatewayTaskType)) {
    throw new Error("C1_INPUT_PREPARATION_COMPLEX_TASK_INVALID: Sol任务必须预先锁定允许的gatewayTaskType");
  }
  if (decision.complexity === "standard" && decision.gatewayTaskType !== undefined) {
    throw new Error("C1_INPUT_PREPARATION_COMPLEX_TASK_INVALID: 标准任务不得携带Sol gatewayTaskType");
  }
  return {
    complexity: decision.complexity,
    preapprovedForSol: decision.complexity === "complex",
    reason: decision.reason,
    markedBy: "software",
    markedAt: preparedAt,
    classificationDecisionId: decision.decisionId,
    classificationRuleVersion: decision.ruleVersion,
    classificationEvidenceRefs: structuredClone(decision.evidenceRefs),
    ...(decision.complexity === "complex" ? { gatewayTaskType: decision.gatewayTaskType } : {})
  };
}

function prepareKeywordEvidence({ plan, savedKeywordEvidence, factsFingerprint, salesFingerprint }) {
  if (savedKeywordEvidence === null || savedKeywordEvidence === undefined) return {
    keywordEvidence: null,
    gaps: [{
      code: "keyword_evidence_missing",
      field: "keywordEvidence",
      message: "上游没有保存可追溯的关键词证据；不得从标题拆词或自动调用Seerfar补齐"
    }]
  };
  const evidence = savedKeywordEvidence;
  if (!isObject(evidence) || evidence.status !== "ready" || !nonEmpty(evidence.evidenceId) ||
      evidence.targetPlatform !== plan.identity.targetPlatform ||
      evidence.targetSkuPackageId !== plan.identity.skuPackageId || !nonEmpty(evidence.sourcePlatform) ||
      !nonEmpty(evidence.collectionMode) || !isoDateTime(evidence.observedAt) || !nonEmpty(evidence.evidenceRef) ||
      !isObject(evidence.sourceBindings) || !Array.isArray(evidence.keywords) || evidence.keywords.length === 0) {
    throw new Error("C1_INPUT_PREPARATION_KEYWORD_INVALID: 关键词证据不完整或不属于当前SKU");
  }
  if (evidence.sourceBindings.c1PlanId !== plan.c1PlanId ||
      evidence.sourceBindings.salesSnapshotId !== plan.inputRefs.salesSnapshotId ||
      evidence.sourceBindings.c1FactsFingerprint !== factsFingerprint ||
      evidence.sourceBindings.salesSnapshotFingerprint !== salesFingerprint) {
    throw new Error("C1_INPUT_PREPARATION_EVIDENCE_DRIFT: 关键词证据绑定的销售快照或C1事实已经漂移");
  }
  const confirmedFactPaths = new Set(projectC1ConfirmedFacts(plan).map((fact) => fact.factPath));
  for (const keyword of evidence.keywords) {
    if (!isObject(keyword) || !nonEmpty(keyword.query) || !nonEmpty(keyword.keywordEvidenceRef) ||
        keyword.relevanceStatus !== "retained" || !Array.isArray(keyword.factBindingPaths) ||
        keyword.factBindingPaths.length === 0 || keyword.factBindingPaths.some((path) => !confirmedFactPaths.has(path))) {
      throw new Error("C1_INPUT_PREPARATION_KEYWORD_INVALID: 关键词必须同时有上游证据和已核验事实绑定");
    }
  }
  return { keywordEvidence: structuredClone(evidence), gaps: [] };
}

export function prepareC1SoftwareInputs({
  skuPackage,
  frozenSeoRules,
  k3KeywordEvidenceSnapshot = null,
  k3CurrentBinding = null,
  savedKeywordEvidence = null,
  legacySavedKeywordEvidenceReadOnly = false,
  frozenComplexityDecision = null,
  preparedAt
}) {
  const plan = skuPackage?.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  if (skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked" ||
      plan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION) {
    throw new Error("C1_INPUT_PREPARATION_GATE_REJECTED: 只有完成事实核验的C1数据包可以准备AI输入");
  }
  if (!isoDateTime(preparedAt)) throw new Error("C1_INPUT_PREPARATION_TIME_INVALID: 准备时间无效");

  const factsFingerprint = fingerprintC1VerifiedFacts(plan);
  const salesFingerprint = fingerprintC1SalesSnapshot(plan.inputSnapshots.salesSnapshot);
  const competitorTextSnapshot = projectC1CompetitorTextSnapshot(plan);
  const seoRules = prepareSeoRules(frozenSeoRules);
  const taskClassification = prepareTaskClassification({
    plan,
    factsFingerprint,
    frozenComplexityDecision,
    preparedAt
  });
  const k3Adaptation = k3KeywordEvidenceSnapshot === null ? null : adaptK3KeywordEvidenceForC1({
    skuPackage,
    k3Snapshot: k3KeywordEvidenceSnapshot,
    currentBinding: k3CurrentBinding,
    adaptedAt: preparedAt
  });
  const keywordResult = k3Adaptation === null && savedKeywordEvidence !== null && legacySavedKeywordEvidenceReadOnly !== true ? {
    keywordEvidence: null,
    gaps: [{
      code: "k3_keyword_snapshot_required",
      field: "k3KeywordEvidenceSnapshot",
      message: "活动C1路径只接受K3快照；旧savedKeywordEvidence仅限显式历史只读兼容"
    }]
  } : k3Adaptation === null ? prepareKeywordEvidence({ plan, savedKeywordEvidence, factsFingerprint, salesFingerprint }) : {
    keywordEvidence: k3Adaptation.keywordEvidence,
    gaps: k3Adaptation.gaps
  };
  const result = {
    schemaVersion: C1_SOFTWARE_INPUT_PREPARATION_VERSION,
    status: keywordResult.gaps.length === 0 ? "ready" : "not_ready",
    preparedAt,
    identity: {
      c1PlanId: plan.c1PlanId,
      skuPackageId: plan.identity.skuPackageId,
      supplierSkuId: plan.identity.supplierSkuId,
      targetPlatform: plan.identity.targetPlatform,
      targetStore: plan.identity.targetStore
    },
    sourceFingerprints: {
      c1Facts: factsFingerprint,
      salesSnapshot: salesFingerprint
    },
    gaps: keywordResult.gaps,
    inputs: {
      competitorTextSnapshot,
      seoRules,
      taskClassification,
      keywordEvidence: keywordResult.keywordEvidence
    },
    executionEvidence: {
      externalAccesses: [],
      seerfarCalls: 0,
      gatewayCalls: 0,
      codexDispatches: 0,
      platformWrites: 0
    },
    downstream: {
      c2Started: false,
      productionStarted: false,
      eReadbackStarted: false
    }
  };
  return deepFreeze(result);
}
