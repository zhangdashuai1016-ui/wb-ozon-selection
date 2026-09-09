import { isDeepStrictEqual } from "node:util";
import { evaluateFinalMarketPricing, assessAStageMarket } from "./market-sample-policy.mjs";
import { validateLifecyclePackage } from "./product-lifecycle-schema.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { buildLifecycleBExplicitOtherCosts, resolveLifecycleBProfitRule } from "./lifecycle-b-evidence-runtime.mjs";
import { createLifecycleBInputBundle, validateLifecycleBInputBundle } from "./lifecycle-b-input-bundle.mjs";
import { runSkuProfitModel } from "./profit-model.mjs";
import { createSoftwareExecutionRuntime, waitForOwner } from "./software-execution-state.mjs";
import { createC1ProductPlan } from "./c1-product-plan.mjs";
import { validateOwnerSupplyConfirmation } from "./supplier-selection-flow.mjs";

export class FinalPricingRevisionError extends Error {
  constructor(code) { super(code); this.name = "FinalPricingRevisionError"; this.code = code; }
}
function reject(code) { throw new FinalPricingRevisionError(code); }
const C1_REFERENCES = ["c1AiDraftJobRefV1", "c1AiDraftRequestV1", "c1AiDraftSoftwareJobRef", "c1KeywordPlanningEvidenceV1", "c1KeywordPlanningProductionV1", "c1KeywordPlanningLocalMaterialProductionV1", "c1KeywordPlanningLocalMaterialV1", "k3CurrentBindingV1", "k3KeywordEvidenceSnapshotV1",
  "c1KeywordPlanningSourceRecordV1", "c1KeywordSoftwareJobPlanV1", "c1PaidKeywordEvidenceInputArtifactRefV1", "c1PaidKeywordEvidenceJobRefV1", "c1PaidKeywordEvidenceQueuedAt", "c1PaidKeywordEvidenceRuntimeInputV1", "c1PaidKeywordEvidenceSeerfarRequestV1", "c1PaidKeywordEvidenceSettlementV1", "keywordEvidenceSoftwareJobV1", "c2UploadDraft", "c1Handoffs"];
const DOWNSTREAM = ["productionAuthorization", "productionRecord", "dHandoff", "dSoftwareExecution", "dAssetTransport", "externalListingRecord", "eVerificationRecord"];

function currentCostsMatchProfit(model, bundle, supplier) {
  const fees = bundle.platformFeeEvidence;
  const expectedIds = [fees.evidenceId, bundle.logisticsEvidence.evidenceId, bundle.exchangeRateEvidence.evidenceId];
  return model.calculation?.version === "profit-calculation-v3-cost-policy-snapshot" &&
    isDeepStrictEqual(model.inputSnapshotRefs.slice(2), expectedIds) && model.commissionRate === fees.commissionRate &&
    model.actualPurchaseCost.amount === supplier.actualPurchaseCost &&
    model.internationalFreight.amount === bundle.logisticsEvidence.amountRmb && model.internationalFreight.route === bundle.logisticsEvidence.route &&
    model.priceConversion.rubPerCny === bundle.exchangeRateEvidence.rubPerCny &&
    isDeepStrictEqual(model.otherCosts.costPolicySnapshot, fees.costPolicySnapshot) &&
    isDeepStrictEqual(model.otherCosts.costPolicyContext, fees.costPolicyContext) &&
    Object.entries(model.otherCosts.components).every(([key, value]) => fees.otherCosts[key] === value);
}

/** Revalidate final pricing locally. The caller owns atomic persistence and job guards. */
export function prepareFinalPricingRevision({ candidate, assessment, assessmentInput, evidencePacks, currentCommissionCatalogs = [], rules, observedAt }) {
  if (!candidate || !Number.isSafeInteger(candidate.dataRevision) || candidate.dataRevision < 1 ||
      typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) reject("FINAL_PRICING_REVISION_INPUT_INVALID");
  const lifecycle = candidate.lifecycleV11, sku = lifecycle?.skuPackage;
  const history = lifecycle?.finalPricingRevisionHistory;
  if (history !== undefined && !Array.isArray(history)) reject("FINAL_PRICING_HISTORY_INVALID");
  const lastRevision = history?.at(-1);
  const rejectedReview = sku?.businessPhase === "B" && lifecycle.finalPricingReviewStatus === "profit_rejected" &&
    lastRevision?.previousSkuPackage?.skuPackageId === sku.skuPackageId &&
    lastRevision.previousSkuPackage.parentOpportunityId === sku.parentOpportunityId &&
    lastRevision.resultOpportunityRevision === lifecycle.opportunityPackage?.dataRevision;
  if (!sku || !validateLifecyclePackage(sku).valid || (sku.businessPhase !== "C2" && !rejectedReview) ||
      DOWNSTREAM.some(key => sku[key] !== null && sku[key] !== undefined) ||
      ["running", "waiting_external", "unknown_outcome"].includes(sku.technicalStatus) ||
      ["queued", "running", "waiting_external", "unknown_outcome"].includes(candidate.executionRuntime?.status) ||
      candidate.executionRuntime?.technicalFailure?.kind === "unknown_outcome" ||
      candidate.executionRuntime?.exceptionCase?.status === "open") reject("FINAL_PRICING_REVISION_NOT_AVAILABLE");
  const evaluated = evaluateFinalMarketPricing(assessmentInput);
  if (!isDeepStrictEqual(assessment, evaluated)) reject("FINAL_PRICING_ASSESSMENT_CONFLICT");
  if (assessment.status !== "ready") reject("FINAL_PRICING_ASSESSMENT_PENDING");
  const target = assessment.target;
  if (target.candidateId !== candidate.id || target.sourceRevision !== candidate.dataRevision || target.skuPackageId !== sku.skuPackageId ||
      target.platform !== sku.targetPlatform || target.store !== sku.targetStore || !sameStoreRef(target.storeRef, sku.g1Identity.storeRef) ||
      Date.parse(assessment.assessedAt) > Date.parse(observedAt)) reject("FINAL_PRICING_ASSESSMENT_CONFLICT");
  const active = sku.profitModels.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
  const priorBundle = lifecycle.bSystemEvidenceBundle;
  if (!active || active.result !== (rejectedReview ? "rejected" : "passed") || active.commissionMode !== "exact" ||
      Date.parse(observedAt) < Date.parse(active.calculatedAt) || !validateLifecycleBInputBundle(priorBundle).valid) reject("FINAL_PRICING_SOURCE_CONFLICT");
  const confirmation = sku.selectedSupplySnapshot.ownerSupplyConfirmation;
  if (!validateOwnerSupplyConfirmation(confirmation).valid || confirmation.parentOpportunityId !== sku.parentOpportunityId ||
      confirmation.supplierOptionId !== sku.supplierOptionId || confirmation.supplierSkuId !== sku.supplierSkuId ||
      confirmation.variantKey !== sku.variantKey || confirmation.sourceOpportunityRevision !== sku.selectedSupplySnapshot.sourceOpportunityRevision) reject("B_INPUT_GAP");
  const supplier = sku.selectedSupplySnapshot.supplierSku;
  const packaging = priorBundle.packagingSnapshot;
  if (supplier.weight?.unit !== "kg" || supplier.weight.value !== packaging.weightKg || supplier.dimensions?.unit !== "cm" ||
      !isDeepStrictEqual({ length: supplier.dimensions.length, width: supplier.dimensions.width, height: supplier.dimensions.height }, packaging.dimensionsCm)) reject("FINAL_PRICING_SOURCE_CONFLICT");
  const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf: observedAt });
  const bundle = createLifecycleBInputBundle({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, createdAt: observedAt,
    normalizedSubmission: { supplierConfirmation: { weightKg: packaging.weightKg, dimensionsCm: packaging.dimensionsCm } } });
  if (bundle.platformFeeEvidence.commissionEvidenceMode !== "exact") reject("FINAL_PRICING_EXACT_COMMISSION_REQUIRED");
  const next = structuredClone(candidate);
  if (!rejectedReview && assessment.selectedPriceRub === active.recommendedSalePriceRub && currentCostsMatchProfit(active, bundle, supplier) &&
      ["platformFeeEvidence", "logisticsEvidence", "exchangeRateEvidence", "platformSchemaEvidence"].every(key => isDeepStrictEqual(bundle[key], priorBundle[key]))) {
    return { candidate: next, status: "price_unchanged", profitModelVersion: active.profitModelVersion, externalAccesses: [], taskDispatches: 0 };
  }
  const sourceRevision = sku.selectedSupplySnapshot.sourceOpportunityRevision;
  const sources = [lifecycle.opportunityPackage, ...(history || []).map(entry => entry.previousOpportunityPackage)]
    .filter(value => value?.dataRevision === sourceRevision && value?.parentOpportunityId === sku.parentOpportunityId);
  if (sources.length !== 1) reject("FINAL_PRICING_SUPPLY_SOURCE_CONFLICT");
  const supplySourceOpportunity = sources[0];
  const opportunity = structuredClone(lifecycle.opportunityPackage);
  if (!validateLifecyclePackage(opportunity).valid) reject("FINAL_PRICING_SOURCE_CONFLICT");
  opportunity.dataRevision += 1;
  const selectedIds = [...assessment.coreSampleIds, ...assessment.supplementarySampleIds];
  for (const snapshot of assessmentInput.salesSnapshots) {
    const existing = opportunity.salesSnapshots.find(item => item.snapshotId === snapshot.snapshotId);
    if (existing && !isDeepStrictEqual(existing, snapshot)) reject("FINAL_PRICING_SNAPSHOT_CONFLICT");
    if (!existing) opportunity.salesSnapshots.push(structuredClone(snapshot));
  }
  const sampleReviews = Object.fromEntries(opportunity.salesSnapshots.map(snapshot => [snapshot.snapshotId, {
    comparability: selectedIds.includes(snapshot.snapshotId) ? "comparable" : "unknown",
    priceEvidenceStatus: selectedIds.includes(snapshot.snapshotId) ? "verified" : "missing",
    validityStatus: selectedIds.includes(snapshot.snapshotId) ? "current" : "unknown",
    evidenceTraceable: selectedIds.includes(snapshot.snapshotId)
  }]));
  opportunity.marketAssessment = structuredClone(assessAStageMarket({ opportunityPackage: { ...opportunity, salesSnapshots: opportunity.salesSnapshots.filter(snapshot => selectedIds.includes(snapshot.snapshotId)) }, sampleReviews,
    assessedAt: observedAt, assessmentId: `final-market:${assessment.assessmentId}` }));
  opportunity.marketAssessment.recommendedSalePrice = { amount: assessment.selectedPriceRub, currency: "RUB",
    method: "owner_selected_final_price_v1", evidenceRefs: assessment.samples.filter(item => selectedIds.includes(item.snapshotId)).map(item => item.evidenceRef) };
  const work = structuredClone(sku);
  for (const key of ["c1ProductPlan", "c2FinalAssets", "productionConfirmationCard"]) work[key] = null;
  delete work.c1RightsReviewRecord;
  delete work.finalPricingReview;
  work.businessPhase = "B";
  work.inheritedSalesSnapshotRefs = [...new Set([...work.inheritedSalesSnapshotRefs, ...selectedIds])];
  const calculated = runSkuProfitModel({ opportunityPackage: opportunity, supplySourceOpportunity, skuPackage: work,
    salesSelection: { salesSnapshotId: selectedIds[0] }, platformFeeEvidence: bundle.platformFeeEvidence,
    logisticsEvidence: bundle.logisticsEvidence, exchangeRateEvidence: bundle.exchangeRateEvidence, calculatedAt: observedAt });
  const passed = calculated.profitModel.result === "passed";
  const revised = passed ? createC1ProductPlan({ opportunityPackage: opportunity, skuPackage: calculated.skuPackage,
    platformSchemaEvidence: bundle.platformSchemaEvidence, createdAt: observedAt }).skuPackage : calculated.skuPackage;
  next.lifecycleV11.finalPricingRevisionHistory = [...(history || []), {
    revisionId: `final-pricing:${assessment.assessmentId}`, sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: sku.dataRevision,
    recordedAt: observedAt, assessment: structuredClone(assessment), previousSkuPackage: structuredClone(sku),
    previousBSystemEvidenceBundle: structuredClone(priorBundle), previousOpportunityPackage: structuredClone(lifecycle.opportunityPackage),
    sourceOpportunityRevision: lifecycle.opportunityPackage.dataRevision, resultOpportunityRevision: opportunity.dataRevision,
    previousExecutionRuntime: structuredClone(candidate.executionRuntime ?? null), previousC1References: Object.fromEntries(C1_REFERENCES.filter(key => Object.hasOwn(lifecycle, key)).map(key => [key, structuredClone(lifecycle[key])]))
  }];
  next.lifecycleV11.skuPackage = revised;
  next.lifecycleV11.bSystemEvidenceBundle = bundle;
  next.lifecycleV11.opportunityPackage = opportunity;
  for (const key of C1_REFERENCES) delete next.lifecycleV11[key];
  next.lifecycleV11.status = passed ? "c1_inputs_ready" : "b_rejected";
  next.lifecycleV11.finalPricingReviewStatus = passed ? "price_revalidated" : "profit_rejected";
  next.workflowStatus = passed ? "listing_preparation" : "needs_user_data";
  next.neededFields = passed ? [] : ["最终售价按当前完整成本计算未通过，需重新评审售价。"];
  next.listingPreparation = passed ? { status: "c1_inputs_ready", reason: "最终定价已形成新利润版本；旧事实、文案及素材保留为历史，尚未重新确认。", decisionItems: [], writeOccurred: false, platformWrites: 0 } : null;
  next.listingHandoff = passed ? { state: "needs_decision", owner: "listing_task", runId: null, currentStep: "核对新利润版本对应的C1资料", blockReason: null,
    userAction: "复核保留的商品资料与素材；未自动请求关键词、模型或生产授权", inheritedInputRevision: revised.dataRevision, realTaskDispatched: false } : null;
  const runtime = createSoftwareExecutionRuntime({ candidateId: candidate.id, dataRevision: candidate.dataRevision + 1,
    businessPhase: passed ? "C1" : "B", stepId: passed ? "C1_INPUTS_READY" : "B_FINAL_PRICING_REJECTED", at: observedAt });
  next.executionRuntime = passed ? runtime : waitForOwner(runtime, { stepId: "B_FINAL_PRICING_REJECTED", inputRevision: candidate.dataRevision + 1,
    at: observedAt, detail: "最终售价按当前完整成本重算未通过，需要主人重新评审" });
  return { candidate: next, status: passed ? "price_revalidated" : "profit_rejected", profitModelVersion: calculated.profitModel.profitModelVersion,
    externalAccesses: [], taskDispatches: 0 };
}
