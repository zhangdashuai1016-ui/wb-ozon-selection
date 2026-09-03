import { createHash } from "node:crypto";

import { assertValidC1ProductPlan } from "./c1-product-plan.mjs";
import { validateKeywordScoredSnapshot } from "./keyword-evidence-scoring.mjs";

export const C1_K3_KEYWORD_ADAPTER_VERSION = "c1-k3-keyword-adapter-v1";

const FACT_SECTIONS = Object.freeze([
  "exactSkuVerification",
  "productAttributes",
  "platformCategory",
  "schemaSnapshot",
  "batteryAssessment",
  "categoryRestrictions",
  "platformCompliance"
]);

const GROUP_POLICY = Object.freeze({
  title_keywords: Object.freeze({ allowedOutputFields: Object.freeze(["title"]), purpose: "title_core" }),
  attribute_and_tag_keywords: Object.freeze({ allowedOutputFields: Object.freeze(["searchKeywords"]), purpose: "attribute_and_theme_tags" }),
  description_long_tail: Object.freeze({ allowedOutputFields: Object.freeze(["description", "bulletPoints"]), purpose: "description_long_tail" })
});

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function iso(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}
function gap(code, field, message) { return { code, field, message }; }

function fingerprintC1VerifiedFacts(plan) {
  return digest(Object.fromEntries(FACT_SECTIONS.map((section) => [section, structuredClone(plan[section])])));
}

function fingerprintC1SalesSnapshot(snapshot) {
  if (!isObject(snapshot)) throw new Error("C1_K3_ADAPTER_SALES_INVALID: 缺少冻结销售快照");
  return digest(snapshot);
}

function collectConfirmedFacts(value, path, catalog) {
  if (isObject(value) && "verificationStatus" in value && "sourceRefs" in value) {
    if (value.verificationStatus === "confirmed" && value.value !== "unknown" && Array.isArray(value.sourceRefs)) {
      catalog.push({ factPath: path, sourceRefs: [...new Set(value.sourceRefs.filter(nonEmpty))] });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectConfirmedFacts(child, `${path}.${index}`, catalog));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) collectConfirmedFacts(child, `${path}.${key}`, catalog);
  }
}

function confirmedFactCatalog(plan) {
  const catalog = [];
  for (const section of FACT_SECTIONS) collectConfirmedFacts(plan[section], section, catalog);
  return catalog;
}

function notReady({ adaptedAt, plan, snapshot, gaps, factsFingerprint = null, salesFingerprint = null }) {
  return freeze({
    schemaVersion: C1_K3_KEYWORD_ADAPTER_VERSION,
    status: "not_ready",
    adaptedAt,
    identity: {
      c1PlanId: plan?.c1PlanId ?? null,
      skuPackageId: plan?.identity?.skuPackageId ?? null,
      supplierSkuId: plan?.identity?.supplierSkuId ?? null
    },
    sourceSnapshot: snapshot ? {
      snapshotId: snapshot.snapshotId ?? null,
      snapshotFingerprint: snapshot.snapshotFingerprint ?? null,
      status: snapshot.status ?? null
    } : null,
    sourceFingerprints: { c1Facts: factsFingerprint, c1SalesSnapshot: salesFingerprint },
    keywordEvidence: null,
    gaps,
    executionEvidence: { externalAccesses: [], seerfarCalls: 0, aiCalls: 0, codexDispatches: 0, platformWrites: 0 },
    downstream: { c2Started: false, productionStarted: false, eReadbackStarted: false }
  });
}

export function adaptK3KeywordEvidenceForC1({ skuPackage, k3Snapshot, currentBinding, adaptedAt }) {
  const plan = skuPackage?.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  if (skuPackage.businessPhase !== "C1" || plan.status !== "facts_checked") {
    throw new Error("C1_K3_ADAPTER_GATE_REJECTED: 只有facts_checked C1可接收K3快照");
  }
  if (!iso(adaptedAt)) throw new Error("C1_K3_ADAPTER_TIME_INVALID: 适配时间无效");
  const factsFingerprint = fingerprintC1VerifiedFacts(plan);
  const salesFingerprint = fingerprintC1SalesSnapshot(plan.inputSnapshots.salesSnapshot);
  const requiredBindingFields = [
    "candidateId", "parentOpportunityId", "skuPackageId", "salesSnapshotVersion", "salesSnapshotFingerprint",
    "supplySkuFactsVersion", "supplySkuFactsFingerprint", "preparationFingerprint", "metricEvidenceFingerprint",
    "scoringPayloadFingerprint", "supplierSkuId"
  ];
  if (!isObject(currentBinding) || !Number.isInteger(currentBinding.dataRevision) ||
      requiredBindingFields.some((field) => !nonEmpty(currentBinding[field]))) {
    return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
      gap("k3_current_binding_incomplete", "currentBinding", "缺少当前revision、销售、供应事实或K3评分指纹绑定")
    ] });
  }
  const validation = validateKeywordScoredSnapshot(k3Snapshot, {
    currentBinding,
    expectedPreparationFingerprint: currentBinding.preparationFingerprint,
    expectedMetricEvidenceFingerprint: currentBinding.metricEvidenceFingerprint,
    asOf: adaptedAt
  });
  if (k3Snapshot?.status !== "ready") {
    const status = nonEmpty(k3Snapshot?.status) ? k3Snapshot.status : "invalid";
    return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
      gap(`k3_status_${status}`, "k3Snapshot.status", `K3状态为${status}，只有ready可进入C1 AI`),
      ...(!validation.valid ? [gap("k3_snapshot_validation_failed", "k3Snapshot", validation.errors.join("；"))] : [])
    ] });
  }
  if (!validation.valid) return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
    gap("k3_snapshot_validation_failed", "k3Snapshot", validation.errors.join("；"))
  ] });
  if (!iso(k3Snapshot.validity?.expiresAt) || Date.parse(k3Snapshot.validity.expiresAt) <= Date.parse(adaptedAt)) {
    return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
      gap("k3_snapshot_expired", "k3Snapshot.validity.expiresAt", "K3关键词快照已过期")
    ] });
  }

  const identityGaps = [];
  if ((nonEmpty(skuPackage.candidateId) && skuPackage.candidateId !== currentBinding.candidateId) ||
      skuPackage.dataRevision !== currentBinding.dataRevision || plan.identity.skuPackageId !== currentBinding.skuPackageId ||
      plan.identity.parentOpportunityId !== currentBinding.parentOpportunityId || plan.identity.supplierSkuId !== currentBinding.supplierSkuId ||
      skuPackage.supplierSkuId !== currentBinding.supplierSkuId || plan.inputRefs.salesSnapshotId !== k3Snapshot?.bindings?.salesSnapshot?.snapshotId) {
    identityGaps.push(gap("k3_c1_identity_drift", "currentBinding", "K3与当前C1的SKU、revision、销售快照或供应SKU不一致"));
  }
  const frozenSales = plan.inputSnapshots.salesSnapshot;
  const frozenSupply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  if ((nonEmpty(frozenSales.version) && frozenSales.version !== currentBinding.salesSnapshotVersion) ||
      (nonEmpty(frozenSales.fingerprint) && frozenSales.fingerprint !== currentBinding.salesSnapshotFingerprint) ||
      (nonEmpty(frozenSupply?.version) && frozenSupply.version !== currentBinding.supplySkuFactsVersion) ||
      (nonEmpty(frozenSupply?.fingerprint) && frozenSupply.fingerprint !== currentBinding.supplySkuFactsFingerprint)) {
    identityGaps.push(gap("k3_frozen_input_drift", "currentBinding", "C1冻结销售或供应事实版本已漂移"));
  }
  if (identityGaps.length > 0) return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: identityGaps });
  if (!Array.isArray(k3Snapshot?.sourceAttempts) || k3Snapshot.sourceAttempts.some((attempt) => attempt.targetPlatform !== plan.identity.targetPlatform)) {
    return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
      gap("k3_platform_scope_drift", "k3Snapshot.sourceAttempts", "K3来源平台与当前C1目标平台不一致")
    ] });
  }
  if (k3Snapshot.scoringContext.scoringPayloadFingerprint !== currentBinding.scoringPayloadFingerprint) {
    return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: [
      gap("k3_scoring_payload_drift", "currentBinding.scoringPayloadFingerprint", "K3评分载荷指纹与当前绑定不一致")
    ] });
  }

  const facts = confirmedFactCatalog(plan);
  const keywords = [];
  const bindingGaps = [];
  for (const [group, policy] of Object.entries(GROUP_POLICY)) {
    for (const [index, item] of k3Snapshot.groups[group].entries()) {
      const k3FactRefs = new Set(item.factRefs);
      const matchingFacts = facts.filter((fact) => fact.sourceRefs.some((ref) => k3FactRefs.has(ref)));
      if (matchingFacts.length === 0) {
        bindingGaps.push(gap("k3_keyword_fact_intersection_missing", `k3Snapshot.groups.${group}[${index}]`, `${item.keyword}没有与C1确认事实证据相交`));
        continue;
      }
      keywords.push({
        query: item.keyword,
        group,
        purpose: policy.purpose,
        allowedOutputFields: [...policy.allowedOutputFields],
        keywordEvidenceRef: `${k3Snapshot.snapshotId}#groups/${group}/${index}`,
        sourcePlatform: plan.identity.targetPlatform,
        relevanceStatus: "retained",
        factBindingPaths: [...new Set(matchingFacts.map((fact) => fact.factPath))].sort(),
        k3FactRefs: structuredClone(item.factRefs),
        sourceRefs: structuredClone(item.sourceRefs),
        score: item.score,
        confidence: item.confidence,
        components: structuredClone(item.components),
        matchType: item.matchType,
        evidenceCoverage: item.evidenceCoverage,
        usageRestriction: item.usageRestriction,
        placementGateEvidence: structuredClone(item.placementGateEvidence),
        scoringVersion: item.scoringVersion
      });
    }
  }
  if (bindingGaps.length > 0) return notReady({ adaptedAt, plan, snapshot: k3Snapshot, factsFingerprint, salesFingerprint, gaps: bindingGaps });

  const sourceBindings = {
    adapterVersion: C1_K3_KEYWORD_ADAPTER_VERSION,
    sourceSnapshotId: k3Snapshot.snapshotId,
    sourceSnapshotFingerprint: k3Snapshot.snapshotFingerprint,
    sourcePreparationFingerprint: k3Snapshot.scoringContext.preparationFingerprint,
    sourceMetricEvidenceFingerprint: k3Snapshot.scoringContext.metricEvidenceFingerprint,
    sourceScoringPayloadFingerprint: k3Snapshot.scoringContext.scoringPayloadFingerprint,
    c1PlanId: plan.c1PlanId,
    c1FactsFingerprint: factsFingerprint,
    c1SalesSnapshotFingerprint: salesFingerprint,
    salesSnapshotId: k3Snapshot.bindings.salesSnapshot.snapshotId,
    salesSnapshotVersion: k3Snapshot.bindings.salesSnapshot.version,
    salesSnapshotFingerprint: k3Snapshot.bindings.salesSnapshot.fingerprint,
    supplierSkuId: plan.identity.supplierSkuId,
    supplySkuFactsVersion: k3Snapshot.bindings.supplySkuFacts.version,
    supplySkuFactsFingerprint: k3Snapshot.bindings.supplySkuFacts.fingerprint,
    dataRevision: currentBinding.dataRevision,
    observedAt: k3Snapshot.validity.collectedAt,
    expiresAt: k3Snapshot.validity.expiresAt
  };
  const evidenceId = `c1-k3-keywords:${plan.identity.skuPackageId}:${digest({ sourceBindings, keywords }).slice(0, 24)}`;
  const keywordEvidence = {
    evidenceId,
    status: "ready",
    targetPlatform: plan.identity.targetPlatform,
    targetSkuPackageId: plan.identity.skuPackageId,
    sourcePlatform: "k3_keyword_evidence_snapshot",
    collectionMode: "validated_k3_snapshot",
    observedAt: k3Snapshot.validity.collectedAt,
    expiresAt: k3Snapshot.validity.expiresAt,
    evidenceRef: k3Snapshot.snapshotId,
    sourceBindings: structuredClone(sourceBindings),
    groups: Object.fromEntries(Object.keys(GROUP_POLICY).map((group) => [group, keywords.filter((item) => item.group === group).map((item) => item.keywordEvidenceRef)])),
    keywords
  };
  return freeze({
    schemaVersion: C1_K3_KEYWORD_ADAPTER_VERSION,
    status: "ready",
    adaptedAt,
    identity: { c1PlanId: plan.c1PlanId, skuPackageId: plan.identity.skuPackageId, supplierSkuId: plan.identity.supplierSkuId },
    sourceSnapshot: { snapshotId: k3Snapshot.snapshotId, snapshotFingerprint: k3Snapshot.snapshotFingerprint, status: k3Snapshot.status },
    sourceFingerprints: { c1Facts: factsFingerprint, c1SalesSnapshot: salesFingerprint },
    keywordEvidence,
    gaps: [],
    executionEvidence: { externalAccesses: [], seerfarCalls: 0, aiCalls: 0, codexDispatches: 0, platformWrites: 0 },
    downstream: { c2Started: false, productionStarted: false, eReadbackStarted: false }
  });
}
