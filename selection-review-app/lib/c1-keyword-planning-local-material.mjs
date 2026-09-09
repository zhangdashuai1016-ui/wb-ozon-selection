import { createHash } from "node:crypto";

import { validateKeywordEvidenceSnapshot } from "./keyword-evidence-snapshot.mjs";
import { validateC1ProductPlan } from "./c1-product-plan.mjs";
import {
  fingerprintC1SalesSnapshot,
  fingerprintC1VerifiedFacts,
  projectC1ConfirmedFacts,
  projectC1CompetitorTextSnapshot
} from "./c1-software-input-preparation.mjs";

export const C1_KEYWORD_PLANNING_LOCAL_MATERIAL_VERSION = "c1-keyword-planning-local-material-v1";
export const C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION = "c1-keyword-planning-local-material-production-v1";

const SECRET_KEY = /(?:token|cookie|password|secret|authorization|api[_-]?key|bearer|headers?)/i;
const SECRET_VALUE = /(?:authorization|bearer|cookie|password|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*(?:=|:)/i;
const CREDENTIAL_QUERY = /[?&](?:key|token|secret|signature|password)=/i;

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0 && value !== "unknown"; }
function iso(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}
function gap(code, field, message) { return { code, field, message }; }

function assertNoSecrets(value, path = "candidate", depth = 0) {
  if (depth > 16) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_DEPTH_EXCEEDED:${path}`);
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_TEXT_LIMIT_EXCEEDED:${path}`);
    if (SECRET_VALUE.test(value) || CREDENTIAL_QUERY.test(value)) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_SECRET_FORBIDDEN:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_ARRAY_LIMIT_EXCEEDED:${path}`);
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key.replace(/[^a-z0-9_-]/gi, ""))) throw new Error(`C1_KEYWORD_LOCAL_MATERIAL_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`, depth + 1);
  }
}

function exactLiteralTerms(facts) {
  const seen = new Set();
  const terms = [];
  for (const fact of facts) {
    if (!nonEmpty(fact.value)) continue;
    const normalized = fact.value.normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = normalized.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({
      term: normalized,
      sourceRefs: structuredClone(fact.sourceRefs),
      factRefs: structuredClone(fact.sourceRefs),
      factBindings: [{
        factPath: fact.factPath,
        factValueFingerprint: fact.valueFingerprint,
        sourceRef: fact.sourceRefs[0],
        bindingRelation: "exact_value",
        semanticProofRef: null
      }],
      sourceTrust: "confirmed_c1_fact",
      matchType: "target_fact"
    });
  }
  return terms;
}

function opportunityFor(candidate, plan) {
  const opportunity = candidate.lifecycleV11?.opportunityPackage;
  if (!isObject(opportunity) || opportunity.parentOpportunityId !== plan.identity.parentOpportunityId ||
      !Array.isArray(opportunity.salesSnapshots) || !isObject(opportunity.marketAssessment)) return null;
  return opportunity;
}

function comparableTexts(candidate, plan) {
  const opportunity = opportunityFor(candidate, plan);
  if (!opportunity) return { comparables: [], gaps: [gap("opportunity_market_evidence_missing", "lifecycleV11.opportunityPackage", "缺少当前C1绑定的A阶段市场证据")] };
  const primaryIds = opportunity.marketAssessment.primarySampleIds;
  if (!Array.isArray(primaryIds) || primaryIds.length < 3 || primaryIds.length > 5) {
    return { comparables: [], gaps: [gap("comparable_count_invalid", "lifecycleV11.opportunityPackage.marketAssessment.primarySampleIds", "本地原料要求3至5个已审查主要竞品")] };
  }
  const summaries = new Map((opportunity.marketAssessment.sampleSummaries || []).map((item) => [item.snapshotId, item]));
  const comparables = [];
  for (const snapshotId of primaryIds) {
    const summary = summaries.get(snapshotId);
    const snapshot = opportunity.salesSnapshots.find((item) => item.snapshotId === snapshotId);
    if (!isObject(summary) || summary.role !== "primary" || summary.comparability !== "comparable" ||
        summary.priceEvidenceStatus !== "verified" || summary.validityStatus !== "current" ||
        summary.evidenceTraceable !== true || summary.sellerType === "local_ru" || !isObject(snapshot) ||
        !nonEmpty(snapshot.title) || !nonEmpty(snapshot.evidenceRef) || !iso(snapshot.collectedAt)) {
      return { comparables: [], gaps: [gap("comparable_evidence_invalid", `salesSnapshots.${snapshotId}`, "竞品未通过A阶段可比性、价格、时效或可追溯性门禁")] };
    }
    const projectedPlan = {
      ...structuredClone(plan),
      inputRefs: { ...structuredClone(plan.inputRefs), salesSnapshotId: snapshotId },
      inputSnapshots: { ...structuredClone(plan.inputSnapshots), salesSnapshot: structuredClone(snapshot) }
    };
    const textSnapshot = projectC1CompetitorTextSnapshot(projectedPlan);
    comparables.push({
      competitorRef: snapshot.evidenceRef,
      salesSnapshotId: snapshot.snapshotId,
      platform: snapshot.platform,
      sellerType: snapshot.sellerType,
      comparabilityStatus: "proven",
      role: "buyer_language_reference_only",
      textSnapshot
    });
  }
  if (new Set(comparables.map((item) => item.salesSnapshotId)).size !== comparables.length) {
    return { comparables: [], gaps: [gap("duplicate_comparable", "salesSnapshots", "竞品销售快照不得重复")] };
  }
  return { comparables, gaps: [] };
}

function reusableSnapshot(candidate, plan, sku, producedAt) {
  const snapshot = candidate.lifecycleV11?.k3KeywordEvidenceSnapshotV1 ??
    candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3KeywordEvidenceSnapshot ?? null;
  const binding = candidate.lifecycleV11?.k3CurrentBindingV1 ??
    candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3CurrentBinding ?? null;
  if (snapshot === null) return { status: "not_available", snapshot: null, gap: gap("reusable_keyword_snapshot_missing", "lifecycleV11.k3KeywordEvidenceSnapshotV1", "缺少已保存的可复用关键词快照") };
  if (!isObject(binding)) return { status: "invalid", snapshot: null, gap: gap("reusable_keyword_binding_missing", "lifecycleV11.k3CurrentBindingV1", "可复用关键词快照缺少当前绑定") };
  const expected = {
    candidateId: candidate.id,
    parentOpportunityId: plan.identity.parentOpportunityId,
    skuPackageId: sku.skuPackageId,
    dataRevision: sku.dataRevision,
    salesSnapshotVersion: binding.salesSnapshotVersion,
    salesSnapshotFingerprint: binding.salesSnapshotFingerprint,
    supplySkuFactsVersion: binding.supplySkuFactsVersion,
    supplySkuFactsFingerprint: binding.supplySkuFactsFingerprint
  };
  const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: expected, asOf: producedAt });
  if (!validation.valid || snapshot.status !== "ready") {
    return { status: "invalid", snapshot: null, gap: gap("reusable_keyword_snapshot_invalid", "lifecycleV11.k3KeywordEvidenceSnapshotV1", "关键词快照已过期、漂移或状态不是ready") };
  }
  return { status: "reused", snapshot: structuredClone(snapshot), gap: null };
}

export function produceC1KeywordPlanningLocalMaterial({ candidate, expectedRevision, producedAt }) {
  if (!isObject(candidate) || !nonEmpty(candidate.id) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      candidate.dataRevision !== expectedRevision || !iso(producedAt)) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_INPUT_INVALID");
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const planValidation = isObject(plan) ? validateC1ProductPlan(plan) : { valid: false };
  if (!isObject(sku) || sku.businessPhase !== "C1" || !isObject(plan) || plan.status !== "facts_checked" || !planValidation.valid) {
    const production = {
      schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION,
      candidateId: candidate.id,
      skuPackageId: sku?.skuPackageId ?? null,
      sourceCandidateRevision: expectedRevision,
      resultCandidateRevision: expectedRevision + 1,
      status: "not_ready",
      inputFingerprint: digest({ candidateId: candidate.id, skuPackageId: sku?.skuPackageId ?? null, c1Plan: plan ?? null }),
      materialFingerprint: null,
      gaps: [gap("c1_facts_not_ready", "lifecycleV11.skuPackage.c1ProductPlan", "C1事实核验尚未完成")],
      producedAt,
      execution: { attemptLimit: 1, externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0, automaticRetries: 0 }
    };
    return freeze({ status: "not_ready", material: null, production });
  }

  assertNoSecrets({
    c1ProductPlan: plan,
    opportunityPackage: candidate.lifecycleV11?.opportunityPackage ?? null,
    reusableKeywordSnapshot: candidate.lifecycleV11?.k3KeywordEvidenceSnapshotV1 ?? candidate.lifecycleV11?.c1SoftwareEvidenceV1?.k3KeywordEvidenceSnapshot ?? null
  });

  const facts = projectC1ConfirmedFacts(plan);
  const terms = exactLiteralTerms(facts);
  const comparableResult = comparableTexts(candidate, plan);
  const reusable = reusableSnapshot(candidate, plan, sku, producedAt);
  const sales = plan.inputSnapshots.salesSnapshot;
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  const gaps = [...comparableResult.gaps];
  if (terms.length === 0) gaps.push(gap("exact_literal_fact_terms_missing", "c1ProductPlan", "没有可安全复用的已确认字符串事实词"));
  if (reusable.gap) gaps.push(reusable.gap);
  const inputFingerprint = digest({
    candidateId: candidate.id,
    skuPackageId: sku.skuPackageId,
    skuRevision: sku.dataRevision,
    c1PlanId: plan.c1PlanId,
    factsFingerprint: fingerprintC1VerifiedFacts(plan),
    salesFingerprint: fingerprintC1SalesSnapshot(sales),
    supply,
    comparables: comparableResult.comparables,
    reusableSnapshotFingerprint: reusable.snapshot?.snapshotFingerprint ?? null
  });
  const material = gaps.length === 0 ? {
    schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_VERSION,
    candidateId: candidate.id,
    sourceCandidateRevision: expectedRevision,
    resultCandidateRevision: expectedRevision + 1,
    skuPackageId: sku.skuPackageId,
    supplierSkuId: sku.supplierSkuId,
    sourceSkuRevision: sku.dataRevision,
    resultSkuRevision: sku.dataRevision,
    c1PlanId: plan.c1PlanId,
    producedAt,
    bindings: {
      factsFingerprint: fingerprintC1VerifiedFacts(plan),
      salesSnapshotId: sales.snapshotId,
      salesSnapshotFingerprint: fingerprintC1SalesSnapshot(sales),
      supplySnapshotId: supply.snapshotId ?? plan.inputRefs.selectedSupplySnapshotId,
      supplySnapshotFingerprint: digest(supply),
      targetPlatform: plan.identity.targetPlatform,
      targetStore: plan.identity.targetStore
    },
    confirmedFactCatalog: structuredClone(facts),
    exactLiteralFactTerms: terms,
    competitorTextSnapshots: comparableResult.comparables,
    reusableKeywordSnapshot: reusable.snapshot,
    sourceRefs: [...new Set([
      ...facts.flatMap((item) => item.sourceRefs),
      ...comparableResult.comparables.map((item) => item.competitorRef),
      reusable.snapshot.snapshotId
    ])]
  } : null;
  if (material) material.materialFingerprint = digest(material);
  const production = {
    schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PRODUCTION_VERSION,
    candidateId: candidate.id,
    skuPackageId: sku.skuPackageId,
    sourceCandidateRevision: expectedRevision,
    resultCandidateRevision: expectedRevision + 1,
    status: material ? "ready" : "not_ready",
    inputFingerprint,
    materialFingerprint: material?.materialFingerprint ?? null,
    gaps,
    producedAt,
    execution: { attemptLimit: 1, externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0, automaticRetries: 0 }
  };
  return freeze({ status: production.status, material, production });
}
