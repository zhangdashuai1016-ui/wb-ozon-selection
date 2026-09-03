import { createHash } from "node:crypto";

import { verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { prepareKeywordEvidence } from "./keyword-evidence-orchestrator.mjs";
import { scoreAndGroupKeywordEvidence, validateKeywordScoredSnapshot } from "./keyword-evidence-scoring.mjs";
import { prepareC1SoftwareInputs } from "./c1-software-input-preparation.mjs";
import { createC1SoftwareEvidenceStage } from "./c1-software-evidence-stage.mjs";

export const C1_FACT_KEYWORD_PIPELINE_VERSION = "c1-fact-keyword-pipeline-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
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

function gap(code, field, message) {
  return { code, field, message };
}

function resolveFactsCheckedPackage(skuPackage, preparedAt) {
  const status = skuPackage?.c1ProductPlan?.status;
  if (skuPackage?.businessPhase !== "C1") {
    throw new Error("C1_FACT_KEYWORD_GATE_REJECTED: 当前SKU不在C1阶段");
  }
  if (status === "facts_checked") return { skuPackage, factVerification: "reused" };
  if (status !== "inputs_ready") {
    throw new Error("C1_FACT_KEYWORD_GATE_REJECTED: C1必须处于inputs_ready或facts_checked");
  }
  const verified = verifyC1ProductFacts({ skuPackage, verifiedAt: preparedAt });
  return { skuPackage: verified.skuPackage, factVerification: "created" };
}

function resolveBindingPart(snapshot, { kind, fallbackVersion }) {
  if (!isObject(snapshot)) throw new Error(`C1_FACT_KEYWORD_BINDING_INVALID: 缺少${kind}冻结快照`);
  const version = nonEmpty(snapshot.version)
    ? snapshot.version
    : nonEmpty(snapshot.schemaVersion) ? snapshot.schemaVersion : fallbackVersion;
  if (!nonEmpty(version)) throw new Error(`C1_FACT_KEYWORD_BINDING_INVALID: ${kind}缺少版本标识`);
  return {
    version,
    fingerprint: nonEmpty(snapshot.fingerprint) ? snapshot.fingerprint : digest(snapshot),
    versionSource: nonEmpty(snapshot.version) ? "upstream_version" : nonEmpty(snapshot.schemaVersion) ? "upstream_schema_version" : "pipeline_contract_version",
    fingerprintSource: nonEmpty(snapshot.fingerprint) ? "upstream_fingerprint" : "computed_from_frozen_snapshot"
  };
}

function buildBinding(skuPackage) {
  const plan = skuPackage.c1ProductPlan;
  const sales = plan.inputSnapshots?.salesSnapshot;
  const supply = plan.inputSnapshots?.confirmedSupplierSkuSnapshot;
  const salesBinding = resolveBindingPart(sales, { kind: "销售", fallbackVersion: null });
  const supplyBinding = resolveBindingPart(supply, { kind: "供应SKU", fallbackVersion: "c1-confirmed-supplier-sku-snapshot-v1" });
  if (!nonEmpty(sales?.snapshotId) || !nonEmpty(plan.identity?.parentOpportunityId) ||
      !nonEmpty(plan.identity?.skuPackageId) || !nonEmpty(plan.identity?.supplierSkuId)) {
    throw new Error("C1_FACT_KEYWORD_BINDING_INVALID: C1身份或销售快照ID不完整");
  }
  const identity = {
    candidateId: skuPackage.candidateId,
    parentOpportunityId: plan.identity.parentOpportunityId,
    skuPackageId: plan.identity.skuPackageId,
    dataRevision: skuPackage.dataRevision
  };
  if (!nonEmpty(identity.candidateId) || !Number.isInteger(identity.dataRevision) || identity.dataRevision < 0) {
    throw new Error("C1_FACT_KEYWORD_BINDING_INVALID: 候选ID或SKU revision无效");
  }
  return {
    identity,
    bindings: {
      salesSnapshot: { snapshotId: sales.snapshotId, version: salesBinding.version, fingerprint: salesBinding.fingerprint },
      supplySkuFacts: { version: supplyBinding.version, fingerprint: supplyBinding.fingerprint }
    },
    bindingEvidence: { salesSnapshot: salesBinding, supplySkuFacts: supplyBinding }
  };
}

function validateSourceEvidence(value) {
  if (!isObject(value) || !nonEmpty(value.fulfillment) || !nonEmpty(value.locale) ||
      !isObject(value.frozenEvidence) || !isObject(value.policy) || !isObject(value.healthPolicy)) {
    throw new Error("C1_FACT_KEYWORD_SOURCE_EVIDENCE_INVALID: 关键词来源、履约或策略证据不完整");
  }
  return value;
}

function businessGateFromPlan(plan, preparedAt) {
  const confirmation = plan.inputSnapshots?.confirmedSupplierSkuSnapshot?.ownerSupplyConfirmation;
  const profit = plan.inputSnapshots?.profitModel;
  if (confirmation?.status !== "confirmed" || profit?.result !== "passed") {
    throw new Error("C1_FACT_KEYWORD_BUSINESS_GATE_REJECTED: 供应方案未确认或B利润未通过");
  }
  return {
    approved: true,
    approvedAt: confirmation.confirmedAt ?? plan.createdAt ?? preparedAt,
    note: "继承主人已确认供应方案与冻结B利润通过结果",
    evidenceRef: confirmation.confirmationId ?? plan.inputRefs.selectedSupplySnapshotId
  };
}

function k3Binding({ identity, bindings, supplierSkuId, preparation, snapshot }) {
  return {
    ...identity,
    supplierSkuId,
    salesSnapshotVersion: bindings.salesSnapshot.version,
    salesSnapshotFingerprint: bindings.salesSnapshot.fingerprint,
    supplySkuFactsVersion: bindings.supplySkuFacts.version,
    supplySkuFactsFingerprint: bindings.supplySkuFacts.fingerprint,
    preparationFingerprint: snapshot.scoringContext?.preparationFingerprint ?? preparation.preparationFingerprint,
    metricEvidenceFingerprint: snapshot.scoringContext?.metricEvidenceFingerprint ?? null,
    scoringPayloadFingerprint: snapshot.scoringContext?.scoringPayloadFingerprint ?? null
  };
}

function notReady({
  candidateId,
  candidateRevision,
  skuPackage,
  factVerification,
  bindingEvidence,
  preparation,
  k3Snapshot = null,
  gaps,
  metricProviderCalls = 0
}) {
  return freeze({
    schemaVersion: C1_FACT_KEYWORD_PIPELINE_VERSION,
    status: "not_ready",
    candidateId,
    sourceCandidateRevision: candidateRevision,
    skuPackage,
    factVerification,
    bindingEvidence,
    keywordPreparation: preparation,
    k3KeywordEvidenceSnapshot: k3Snapshot,
    k3CurrentBinding: null,
    preparedInputs: null,
    evidenceStage: null,
    gaps,
    execution: {
      metricProviderCalls,
      aiGatewayCalls: 0,
      codexDispatches: 0,
      platformAccessesByPipeline: 0,
      platformWrites: 0,
      automaticRetries: 0
    },
    downstream: { c2Started: false, productionStarted: false, eReadbackStarted: false }
  });
}

export async function prepareC1FactKeywordPipeline({
  candidateId,
  candidateRevision,
  skuPackage,
  keywordSourceEvidence,
  frozenSeoRules,
  frozenComplexityDecision = null,
  reusableKeywordSnapshot = null,
  preparedAt,
  keywordExpiresAt,
  existingEvidence = null
}, providers = {}) {
  if (!nonEmpty(candidateId) || !Number.isInteger(candidateRevision) || candidateRevision < 0 ||
      !iso(preparedAt) || !iso(keywordExpiresAt) || Date.parse(keywordExpiresAt) <= Date.parse(preparedAt)) {
    throw new Error("C1_FACT_KEYWORD_INPUT_INVALID: 候选、revision或时间无效");
  }
  const resolved = resolveFactsCheckedPackage(skuPackage, preparedAt);
  const currentSkuPackage = resolved.skuPackage;
  if (currentSkuPackage.candidateId !== candidateId) throw new Error("C1_FACT_KEYWORD_CANDIDATE_DRIFT: 候选身份不一致");
  const source = validateSourceEvidence(keywordSourceEvidence);
  const plan = currentSkuPackage.c1ProductPlan;
  const binding = buildBinding(currentSkuPackage);
  const preparation = await prepareKeywordEvidence({
    identity: binding.identity,
    bindings: binding.bindings,
    platform: plan.identity.targetPlatform,
    exactSku: plan.identity.supplierSkuId,
    fulfillment: source.fulfillment,
    locale: source.locale,
    businessGate: businessGateFromPlan(plan, preparedAt),
    now: preparedAt,
    policy: structuredClone(source.policy),
    healthPolicy: structuredClone(source.healthPolicy),
    frozenEvidence: structuredClone(source.frozenEvidence),
    reusableSnapshot: reusableKeywordSnapshot
  }, {
    seerfarApi: providers.seerfarApi,
    browser: providers.browser,
    standardSkuHealth: providers.standardSkuHealth
  });

  let snapshot;
  let metricCalls = 0;
  if (preparation.result === "reused_snapshot") {
    snapshot = preparation.reusedSnapshot;
  } else if (preparation.result === "source_candidates_ready") {
    if (typeof providers.keywordMetrics !== "function") {
      return notReady({
        candidateId, candidateRevision, skuPackage: currentSkuPackage, factVerification: resolved.factVerification,
        bindingEvidence: binding.bindingEvidence, preparation,
        gaps: [gap("keyword_metrics_provider_missing", "providers.keywordMetrics", "关键词候选已准备，但缺少一次性K3指标提供器")]
      });
    }
    const metricEvidence = await providers.keywordMetrics({ preparation: structuredClone(preparation), attemptLimit: 1 });
    metricCalls = 1;
    snapshot = scoreAndGroupKeywordEvidence({
      preparation,
      metricEvidence,
      collectedAt: preparedAt,
      expiresAt: keywordExpiresAt,
      currentBinding: {
        ...binding.identity,
        salesSnapshotVersion: binding.bindings.salesSnapshot.version,
        salesSnapshotFingerprint: binding.bindings.salesSnapshot.fingerprint,
        supplySkuFactsVersion: binding.bindings.supplySkuFacts.version,
        supplySkuFactsFingerprint: binding.bindings.supplySkuFacts.fingerprint
      }
    });
  } else {
    return notReady({
      candidateId, candidateRevision, skuPackage: currentSkuPackage, factVerification: resolved.factVerification,
      bindingEvidence: binding.bindingEvidence, preparation,
      gaps: [gap(`keyword_preparation_${preparation.result}`, "keywordPreparation.result", `关键词证据状态为${preparation.result}，不能进入C1草稿`)]
    });
  }

  const currentBinding = k3Binding({
    identity: binding.identity,
    bindings: binding.bindings,
    supplierSkuId: plan.identity.supplierSkuId,
    preparation,
    snapshot
  });
  const snapshotValidation = validateKeywordScoredSnapshot(snapshot, {
    currentBinding,
    expectedPreparationFingerprint: currentBinding.preparationFingerprint,
    expectedMetricEvidenceFingerprint: currentBinding.metricEvidenceFingerprint,
    asOf: preparedAt
  });
  if (snapshot.status !== "ready" || !snapshotValidation.valid) {
    return notReady({
      candidateId, candidateRevision, skuPackage: currentSkuPackage, factVerification: resolved.factVerification,
      bindingEvidence: binding.bindingEvidence, preparation, k3Snapshot: snapshot,
      gaps: [gap(`k3_status_${snapshot.status ?? "invalid"}`, "k3KeywordEvidenceSnapshot", snapshotValidation.valid ? "K3分组尚未完整ready" : snapshotValidation.errors.join("；"))],
      metricProviderCalls: metricCalls
    });
  }

  const preparedInputs = prepareC1SoftwareInputs({
    skuPackage: currentSkuPackage,
    frozenSeoRules,
    k3KeywordEvidenceSnapshot: snapshot,
    k3CurrentBinding: currentBinding,
    frozenComplexityDecision,
    preparedAt
  });
  if (preparedInputs.status !== "ready") {
    return notReady({
      candidateId, candidateRevision, skuPackage: currentSkuPackage, factVerification: resolved.factVerification,
      bindingEvidence: binding.bindingEvidence, preparation, k3Snapshot: snapshot,
      gaps: structuredClone(preparedInputs.gaps),
      metricProviderCalls: metricCalls
    });
  }
  const evidenceStage = createC1SoftwareEvidenceStage({
    candidateId,
    candidateRevision,
    skuPackage: currentSkuPackage,
    preparedInputs,
    k3KeywordEvidenceSnapshot: snapshot,
    k3CurrentBinding: currentBinding,
    frozenSeoRules,
    frozenComplexityDecision,
    stagedAt: preparedAt,
    existingEvidence
  });
  return freeze({
    schemaVersion: C1_FACT_KEYWORD_PIPELINE_VERSION,
    status: "ready_for_atomic_persist",
    candidateId,
    sourceCandidateRevision: candidateRevision,
    skuPackage: currentSkuPackage,
    factVerification: resolved.factVerification,
    bindingEvidence: binding.bindingEvidence,
    keywordPreparation: preparation,
    k3KeywordEvidenceSnapshot: snapshot,
    k3CurrentBinding: currentBinding,
    preparedInputs,
    evidenceStage,
    gaps: [],
    execution: {
      metricProviderCalls: metricCalls,
      aiGatewayCalls: 0,
      codexDispatches: 0,
      platformAccessesByPipeline: 0,
      platformWrites: 0,
      automaticRetries: 0
    },
    downstream: { c2Started: false, productionStarted: false, eReadbackStarted: false }
  });
}
