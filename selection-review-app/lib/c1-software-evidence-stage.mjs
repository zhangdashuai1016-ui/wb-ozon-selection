import { createHash } from "node:crypto";

export const C1_SOFTWARE_EVIDENCE_STAGE_VERSION = "c1-software-evidence-stage-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function iso(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
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
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function validateSeoRules(rules) {
  if (!isObject(rules) || !nonEmpty(rules.rulesVersion) || rules.locale !== "ru-RU" ||
      !nonEmpty(rules.evidenceRef) || !iso(rules.frozenAt) ||
      !Number.isInteger(rules.titleMaxLength) || rules.titleMaxLength < 1 ||
      !Number.isInteger(rules.descriptionMaxLength) || rules.descriptionMaxLength < 1 ||
      !Number.isInteger(rules.bulletPointLimit) || rules.bulletPointLimit < 1 ||
      !Array.isArray(rules.prohibitedClaims)) {
    throw new Error("C1_EVIDENCE_STAGE_SEO_RULES_INVALID: 缺少已冻结且可追溯的俄语SEO规则");
  }
}

function validatePreparedInputs(prepared, plan) {
  if (!isObject(prepared) || prepared.schemaVersion !== "c1-software-input-preparation-v1" ||
      prepared.status !== "ready" || !iso(prepared.preparedAt) || !isObject(prepared.inputs) ||
      !isObject(prepared.inputs.keywordEvidence) || !isObject(prepared.inputs.seoRules) ||
      !isObject(prepared.inputs.competitorTextSnapshot) || !isObject(prepared.inputs.taskClassification)) {
    throw new Error("C1_EVIDENCE_STAGE_PREPARATION_NOT_READY: C1软件输入尚未完整通过校验");
  }
  const identity = prepared.identity;
  if (identity?.c1PlanId !== plan.c1PlanId || identity?.skuPackageId !== plan.identity?.skuPackageId ||
      identity?.supplierSkuId !== plan.identity?.supplierSkuId ||
      identity?.targetPlatform !== plan.identity?.targetPlatform || identity?.targetStore !== plan.identity?.targetStore) {
    throw new Error("C1_EVIDENCE_STAGE_IDENTITY_DRIFT: C1软件输入不属于当前SKU或店铺");
  }
  const execution = prepared.executionEvidence;
  if (!isObject(execution) || !Array.isArray(execution.externalAccesses) || execution.externalAccesses.length !== 0 ||
      execution.seerfarCalls !== 0 || execution.gatewayCalls !== 0 || execution.codexDispatches !== 0 ||
      execution.platformWrites !== 0) {
    throw new Error("C1_EVIDENCE_STAGE_SIDE_EFFECT_INVALID: 输入准备阶段必须保持零外部访问和零派发");
  }
}

function validateK3({ snapshot, binding, candidateId, skuRevision, plan, preparedInputs, stagedAt }) {
  if (!isObject(snapshot) || snapshot.schemaVersion !== "keyword-evidence-snapshot-v1" ||
      snapshot.status !== "ready" || !nonEmpty(snapshot.snapshotId) || !nonEmpty(snapshot.snapshotFingerprint) ||
      !iso(snapshot.validity?.expiresAt) || Date.parse(snapshot.validity.expiresAt) <= Date.parse(stagedAt)) {
    throw new Error("C1_EVIDENCE_STAGE_K3_NOT_READY: 只接受当前有效且状态为ready的K3快照");
  }
  if (!isObject(binding) || binding.candidateId !== candidateId || binding.dataRevision !== skuRevision ||
      binding.parentOpportunityId !== plan.identity?.parentOpportunityId ||
      binding.skuPackageId !== plan.identity?.skuPackageId || binding.supplierSkuId !== plan.identity?.supplierSkuId ||
      !nonEmpty(binding.preparationFingerprint) || !nonEmpty(binding.metricEvidenceFingerprint) ||
      !nonEmpty(binding.scoringPayloadFingerprint)) {
    throw new Error("C1_EVIDENCE_STAGE_K3_BINDING_DRIFT: K3绑定不属于当前候选、revision或供应SKU");
  }
  const sourceBindings = preparedInputs.inputs.keywordEvidence.sourceBindings;
  if (sourceBindings?.sourceSnapshotId !== snapshot.snapshotId ||
      sourceBindings?.sourceSnapshotFingerprint !== snapshot.snapshotFingerprint ||
      sourceBindings?.sourcePreparationFingerprint !== binding.preparationFingerprint ||
      sourceBindings?.sourceMetricEvidenceFingerprint !== binding.metricEvidenceFingerprint ||
      sourceBindings?.sourceScoringPayloadFingerprint !== binding.scoringPayloadFingerprint) {
    throw new Error("C1_EVIDENCE_STAGE_K3_OUTPUT_DRIFT: 已准备关键词与K3快照指纹不一致");
  }
}

export function createC1SoftwareEvidenceStage({
  candidateId,
  candidateRevision,
  skuPackage,
  preparedInputs,
  k3KeywordEvidenceSnapshot,
  k3CurrentBinding,
  frozenSeoRules,
  frozenComplexityDecision = null,
  stagedAt,
  existingEvidence = null
}) {
  if (!nonEmpty(candidateId) || !Number.isInteger(candidateRevision) || candidateRevision < 0 || !iso(stagedAt)) {
    throw new Error("C1_EVIDENCE_STAGE_INPUT_INVALID: 候选、revision或时间无效");
  }
  const plan = skuPackage?.c1ProductPlan;
  if (!isObject(plan) || skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked" ||
      skuPackage.dataRevision !== k3CurrentBinding?.dataRevision) {
    throw new Error("C1_EVIDENCE_STAGE_GATE_REJECTED: 只有当前facts_checked C1包可以冻结软件证据");
  }
  validateSeoRules(frozenSeoRules);
  validatePreparedInputs(preparedInputs, plan);
  if (digest(preparedInputs.inputs.seoRules) !== digest(frozenSeoRules)) {
    throw new Error("C1_EVIDENCE_STAGE_SEO_RULES_DRIFT: 输入准备使用的SEO规则已变化");
  }
  validateK3({
    snapshot: k3KeywordEvidenceSnapshot,
    binding: k3CurrentBinding,
    candidateId,
    skuRevision: skuPackage.dataRevision,
    plan,
    preparedInputs,
    stagedAt
  });

  const payload = {
    schemaVersion: C1_SOFTWARE_EVIDENCE_STAGE_VERSION,
    candidateId,
    sourceCandidateRevision: candidateRevision,
    skuPackageId: plan.identity.skuPackageId,
    supplierSkuId: plan.identity.supplierSkuId,
    sourceSkuRevision: skuPackage.dataRevision,
    stagedAt,
    frozenSeoRules: structuredClone(frozenSeoRules),
    k3KeywordEvidenceSnapshot: structuredClone(k3KeywordEvidenceSnapshot),
    k3CurrentBinding: structuredClone(k3CurrentBinding),
    frozenComplexityDecision: frozenComplexityDecision === null ? null : structuredClone(frozenComplexityDecision),
    preparedInputFingerprint: digest(preparedInputs),
    executionPolicy: {
      attemptLimit: 1,
      automaticRetry: false,
      automaticModelFallback: false,
      codexDispatches: 0,
      platformAccesses: 0,
      platformWrites: 0
    },
    downstream: {
      aiStarted: false,
      c2Started: false,
      productionStarted: false,
      eReadbackStarted: false
    }
  };
  payload.evidenceFingerprint = digest(payload);

  if (existingEvidence !== null) {
    if (!isObject(existingEvidence) || existingEvidence.evidenceFingerprint !== payload.evidenceFingerprint) {
      throw new Error("C1_EVIDENCE_STAGE_DUPLICATE_DRIFT: 当前SKU已经存在不同证据包");
    }
    return freeze({ status: "reused", evidence: structuredClone(existingEvidence), sharedWriteRequired: false });
  }
  return freeze({ status: "created", evidence: payload, sharedWriteRequired: true });
}
