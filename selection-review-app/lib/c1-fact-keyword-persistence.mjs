import { isDeepStrictEqual } from "node:util";
import { prepareC1FactKeywordRuntime } from "./c1-fact-keyword-runtime.mjs";

export const C1_FACT_KEYWORD_PERSISTENCE_VERSION = "c1-fact-keyword-persistence-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSame(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("C1_FACT_KEYWORD_PERSISTENCE_RESULT_DRIFT");
}

/** Recompute the pure domain result from the immutable enqueue input, never worker-supplied policy or metrics. */
export async function assertC1PaidKeywordPreparedResult({ sourceCandidate, sourceRevision, prepared, providerReceipt }) {
  const sourceSku = sourceCandidate?.lifecycleV11?.skuPackage;
  const runtimeInput = sourceCandidate?.lifecycleV11?.c1PaidKeywordEvidenceRuntimeInputV1;
  if (!isObject(sourceSku) || !isObject(runtimeInput) || !isObject(providerReceipt) ||
      sourceCandidate.dataRevision !== sourceRevision ||
      runtimeInput.dataRevision !== sourceRevision ||
      !Number.isFinite(Date.parse(prepared?.receipt?.completedAt))) {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_RESULT_INVALID");
  }
  if (providerReceipt.attempt?.queryText !== sourceSku.c1ProductPlan?.identity?.supplierSkuId ||
      providerReceipt.attempt?.targetPlatform !== sourceSku.c1ProductPlan?.identity?.targetPlatform ||
      providerReceipt.attempt?.locale !== runtimeInput.keywordSourceEvidence?.locale) {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_PROVIDER_SCOPE_DRIFT");
  }
  const input = structuredClone(runtimeInput);
  input.providerEvidence.seerfarApiReceipt = structuredClone(providerReceipt);
  const expected = await prepareC1FactKeywordRuntime({
    candidateId: sourceCandidate.id,
    skuPackage: structuredClone(sourceSku),
    input,
    preparedAt: prepared.receipt.completedAt,
    existingEvidence: null
  });
  if (expected.result.status !== "ready_for_atomic_persist") {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_RESULT_NOT_READY");
  }
  requireSame(prepared, expected);
  return expected;
}

export function buildC1FactKeywordAtomicPatch({ candidate, expectedRevision, sourceSkuPackage, prepared, triggerReceipt = null, stagedAt }) {
  if (!isObject(candidate) || !Number.isInteger(expectedRevision) || candidate.dataRevision !== expectedRevision) {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_REVISION_DRIFT: 候选revision已变化");
  }
  const currentSku = candidate.lifecycleV11?.skuPackage;
  if (!isObject(currentSku) || currentSku.skuPackageId !== sourceSkuPackage?.skuPackageId ||
      currentSku.dataRevision !== sourceSkuPackage?.dataRevision) {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_SKU_DRIFT: SKU包已变化");
  }
  const result = prepared?.result;
  if (result?.status !== "ready_for_atomic_persist" || !isObject(result.skuPackage) ||
      !isObject(result.keywordPreparation) || !isObject(result.k3KeywordEvidenceSnapshot) ||
      !isObject(result.k3CurrentBinding) || !isObject(result.evidenceStage?.evidence) ||
      !isObject(prepared.receipt)) {
    throw new Error("C1_FACT_KEYWORD_PERSISTENCE_NOT_READY: 不允许保存半套C1证据");
  }
  return {
    persistenceVersion: C1_FACT_KEYWORD_PERSISTENCE_VERSION,
    nextRevision: expectedRevision + 1,
    lifecycleV11: {
      ...structuredClone(candidate.lifecycleV11),
      skuPackage: structuredClone(result.skuPackage),
      keywordEvidencePreparationV1: structuredClone(result.keywordPreparation),
      k3KeywordEvidenceSnapshotV1: structuredClone(result.k3KeywordEvidenceSnapshot),
      k3CurrentBindingV1: structuredClone(result.k3CurrentBinding),
      c1SoftwareEvidenceV1: structuredClone(result.evidenceStage.evidence),
      c1FactKeywordRuntimeReceiptV1: structuredClone(prepared.receipt),
      ...(triggerReceipt ? { c1KeywordEvidenceAutoTriggerV1: structuredClone(triggerReceipt) } : {}),
      status: "c1_evidence_ready"
    },
    listingPreparation: {
      ...structuredClone(candidate.listingPreparation || {}),
      status: "c1_evidence_ready",
      reason: "C1事实、关键词来源、K3评分和俄语SEO规则已在同一revision下原子保存；后续草稿尚未启动。",
      decisionItems: [],
      writeOccurred: false,
      platformWrites: 0
    },
    processing: { ...structuredClone(candidate.processing || {}), state: "idle" },
    updatedAt: stagedAt,
    lastModifiedBy: "system"
  };
}
