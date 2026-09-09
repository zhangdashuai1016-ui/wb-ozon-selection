import { rebaseC2UploadDraftAfterPricing } from "./c2-pricing-upload-reuse.mjs";
import { createSoftwareExecutionRuntime, waitForOwner } from "./software-execution-state.mjs";
import { reuseC1PricingResult, C1PricingReuseError } from "./c1-pricing-result-reuse.mjs";
import { readCompletedC1AiSoftwareJobResult } from "./software-job-contract.mjs";
import { createC2SoftwareContainer } from "./c2-software-orchestrator.mjs";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { assertNoProductionSecrets, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { evaluateFinalMarketPricing } from "./market-sample-policy.mjs";
import { prepareFinalPricingRevision } from "./final-pricing-revalidation.mjs";
import { FinalPricingReviewError, assertFinalPricingReviewCurrent } from "./final-pricing-review.mjs";
import { createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";

const FIELDS = ["candidateId", "expectedRevision", "skuPackageId", "selectedPriceRub", "reviews", "idempotencyKey", "auditEventId"];
const ACTIVE_JOB_STATES = new Set(["queued", "claimed", "running", "waiting_platform", "unknown_outcome"]);

function reusePriorC1AfterPricing(candidate, relatedSoftwareJobs, observedAt) {
  const life = candidate.lifecycleV11;
  const previousHistory = [...life.finalPricingRevisionHistory].reverse()
    .find(entry => entry.previousSkuPackage?.c1ProductPlan?.status === "seo_draft_ready");
  const previous = previousHistory?.previousSkuPackage;
  const sourcePlanId = previous?.c1ProductPlan?.c1PlanId ?? null;
  const blocked = reasonCode => {
    const reasons = {
      C1_PRICING_REUSE_SOURCE_MISSING: "未找到原已完成C1资料，需补齐原始文案作业与回执后重新核验。",
      C1_PRICING_REUSE_SOURCE_JOB_MISSING: "未找到原文案对应的已保存作业，需恢复原始作业与回执；未重新付费生成。",
      C1_PRICING_REUSE_SOURCE_JOB_NOT_COMPLETED: "原文案作业尚未确定完成，需先核对原作业结果。",
      C1_PRICING_REUSE_KEYWORDS_VALIDITY_MISSING: "原关键词缺少有效期证据，需补齐有效性依据后重新核验。",
      C1_PRICING_REUSE_KEYWORDS_EXPIRED: "原关键词已过期，需取得当前关键词证据后重新准备C1。",
      C1_PRICING_REUSE_KEYWORDS_TIME_INVALID: "原关键词时间证据不一致，需核对采集时间。",
      C1_PRICING_REUSE_SUPPLY_CHANGED: "供应SKU或规格已变化，需按当前SKU重新准备C1，不能沿用旧文案。",
      C1_PRICING_REUSE_SCHEMA_CHANGED: "平台Schema已变化，需按当前Schema重新核对C1。",
      C1_PRICING_REUSE_FACT_CHANGED: "商品事实已变化，需重新核对事实与文案。",
      C1_PRICING_REUSE_MARKET_FACT_CHANGED: "市场样本承载的商品事实已变化，需重新核对当前商品事实。",
      C1_PRICING_REUSE_CONTENT_CHANGED: "原文案内容与正式回执不一致，需核对原始回执。",
      C1_PRICING_REUSE_PROVIDER_CHANGED: "原文案提供器身份与回执不一致，需核对原始作业。",
      C1_PRICING_REUSE_RECORD_INVALID: "原复用记录结构不完整，需恢复原始资料后重新核验。",
      C1_PRICING_REUSE_SOURCE_INVALID: "原C1来源尚未通过完整校验，需核对已完成资料。",
      C1_PRICING_REUSE_STAGE_INVALID: "当前C1阶段不满足复用条件，需先核对阶段记录。",
      C1_PRICING_REUSE_TARGET_CONFLICT: "复用记录与当前方案或利润版本不一致，需重新核验当前版本。",
      C1_PRICING_REUSE_TIME_INVALID: "原回执与复用时间不一致，需核对时间记录。",
      C1_PRICING_REUSE_RIGHTS_EXPIRED: "原逐SKU权利证据已过期，不能复用旧文案。",
      C1_PRICING_REUSE_RIGHTS_NOT_YET_VALID: "原逐SKU权利证据尚未生效，不能复用旧文案。",
      C1_PRICING_REUSE_RIGHTS_UNVERIFIED: "原品牌或权利依据未核实，需补齐权利证据。"
    };
    if (!Object.hasOwn(reasons, reasonCode)) throw new C1PricingReuseError(reasonCode);
    const message = reasons[reasonCode];
    life.c1PricingReuse = { status: "blocked", reasonCode, message,
      observedAt, sourcePlanId };
    candidate.listingPreparation = { ...candidate.listingPreparation, reason: life.c1PricingReuse.message };
  };
  if (!previous) { blocked("C1_PRICING_REUSE_SOURCE_MISSING"); return; }
  let source = {};
  if (!previous.c1ProductPlan.draftOnlySeo?.pricingReuseRecord) {
    const provider = previous.c1ProductPlan.draftOnlySeo?.providerJobRef;
    if (!provider?.receiptRef || !provider.jobId || !provider.inputFingerprint) { blocked("C1_PRICING_REUSE_SOURCE_JOB_MISSING"); return; }
    const jobs = relatedSoftwareJobs.filter(job => job.jobType === "c1_ai_draft" &&
      job.resultEnvelope?.payload?.receipt?.receiptId === provider.receiptRef &&
      job.resultEnvelope.payload.receipt.gatewayJobId === provider.jobId &&
      job.resultEnvelope.payload.request?.requestFingerprint === provider.inputFingerprint);
    if (jobs.length === 0) { blocked("C1_PRICING_REUSE_SOURCE_JOB_MISSING"); return; }
    if (jobs.length !== 1) throw new FinalPricingReviewError("FINAL_PRICING_SOURCE_JOB_AMBIGUOUS", "原C1作业身份重复，未提交定价变更。");
    if (jobs[0].status !== "completed" || jobs[0].externalRequestState !== "succeeded") { blocked("C1_PRICING_REUSE_SOURCE_JOB_NOT_COMPLETED"); return; }
    const saved = readCompletedC1AiSoftwareJobResult(jobs[0]);
    source = { previousRequest: saved.request, previousReceipt: saved.receipt, previousSettledExecution: saved.settledExecution };
  }
  let reused;
  try {
    reused = reuseC1PricingResult({ previousSkuPackage: previous, revisedSkuPackage: life.skuPackage, ...source, observedAt });
  } catch (error) {
    if (!(error instanceof C1PricingReuseError)) throw error;
    blocked(error.code); return;
  }
  const regions = previous.c2FinalAssets === null || previous.c2FinalAssets === undefined
    ? { collected: [], aiDrafts: [], finalUploads: [] }
    : { collected: structuredClone(previous.c2FinalAssets.assets.collected), aiDrafts: structuredClone(previous.c2FinalAssets.assets.aiDrafts), finalUploads: [] };
  const c2 = createC2SoftwareContainer({ skuPackage: reused.skuPackage, expectedDataRevision: reused.skuPackage.dataRevision,
    assetRegions: regions, createdAt: observedAt });
  life.skuPackage = structuredClone(c2.skuPackage);
  life.c1PricingReuse = { status: "reused", reasonCode: null,
    message: "原C1事实与文案已核验复用；新C2等待素材确认，原最终素材仅保留历史。", observedAt, sourcePlanId };
  const draft = rebaseC2UploadDraftAfterPricing(candidate, { historyRevisionId: previousHistory.revisionId, resultCandidateRevision: candidate.dataRevision + 1 });
  if (draft) {
    life.c2UploadDraft = draft;
    life.c1PricingReuse.message = "原C1事实与文案已核验复用；已保存图片清单已恢复，请核对顺序后重新确认。";
  }
  candidate.listingPreparation = { ...candidate.listingPreparation, status: "c2_waiting_final_uploads", reason: life.c1PricingReuse.message };
  life.status = "c2_waiting_final_uploads";
  candidate.listingHandoff = { state: "needs_decision", owner: "none", runId: null, currentStep: "确认新价格下的最终素材",
    blockReason: null, userAction: draft ? "核对并确认已保存素材" : "提供并确认最终素材", inheritedInputRevision: life.skuPackage.dataRevision, realTaskDispatched: false };
  candidate.executionRuntime = waitForOwner(createSoftwareExecutionRuntime({ candidateId: candidate.id,
    dataRevision: candidate.dataRevision + 1, businessPhase: "C2", stepId: "C2_FINAL_ASSETS_REQUIRED", at: observedAt }), {
      stepId: "C2_FINAL_ASSETS_REQUIRED", inputRevision: candidate.dataRevision + 1, at: observedAt,
      detail: "原C1已核验复用，等待主人确认新版本最终素材。" });
}

export function createFinalPricingReviewUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") throw new TypeError("FINAL_PRICING_DEPENDENCY_INVALID");
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async review({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== FIELDS.length ||
          FIELDS.some(key => !Object.hasOwn(input, key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          ["candidateId", "skuPackageId", "idempotencyKey", "auditEventId"].some(key => typeof input[key] !== "string" || !/^[\w:.-]{1,180}$/.test(input[key])) ||
          !Array.isArray(input.reviews) || input.reviews.length < 1 || input.reviews.length > 20 ||
          !Number.isFinite(input.selectedPriceRub) || input.selectedPriceRub <= 0) {
        throw new FinalPricingReviewError("FINAL_PRICING_INPUT_INVALID", "最终定价请求字段无效。");
      }
      assertNoProductionSecrets(input, "finalPricingInput");
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new FinalPricingReviewError("FINAL_PRICING_OWNER_REQUIRED", "最终定价复核须由当前已登录主人提交。");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"], action: "final_market_pricing_review",
        candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock, includeRelatedSoftwareJobs: true,
        mutate: ({ candidate, evidencePacks, currentCommissionCatalogs, rules, relatedSoftwareJobs, observedAt }) => {
          const sku = candidate.lifecycleV11?.skuPackage;
          const canReassessRejectedPrice = sku?.businessPhase === "B" && candidate.lifecycleV11.finalPricingReviewStatus === "profit_rejected";
          if (!sku || sku.skuPackageId !== input.skuPackageId || (sku.businessPhase !== "C2" && !canReassessRejectedPrice) || sku.productionAuthorization || sku.productionRecord || sku.dHandoff ||
              relatedSoftwareJobs.some(job => ACTIVE_JOB_STATES.has(job.status))) {
            throw new FinalPricingReviewError("FINAL_PRICING_STAGE_CONFLICT", "当前阶段或未结束作业不允许最终定价复核。");
          }
          const ids = input.reviews.map(review => review.snapshotId);
          if (new Set(ids).size !== ids.length) throw new FinalPricingReviewError("FINAL_PRICING_INPUT_INVALID", "市场样本不得重复。");
          const snapshots = ids.map(id => {
            const matches = (candidate.salesSnapshotsV11 || []).filter(snapshot => snapshot.snapshotId === id);
            if (matches.length !== 1) throw new FinalPricingReviewError("FINAL_PRICING_SNAPSHOT_CHANGED", "保存的市场样本不存在或身份重复。");
            return structuredClone(matches[0]);
          });
          const activeProfit = sku.profitModels.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
          const sourceSnapshots = candidate.lifecycleV11.opportunityPackage.salesSnapshots.filter(snapshot =>
            snapshot.snapshotId === activeProfit?.inputSnapshotRefs[0]);
          if (sourceSnapshots.length !== 1 || typeof sourceSnapshots[0].marketScope !== "string") {
            throw new FinalPricingReviewError("FINAL_PRICING_SOURCE_MARKET_REQUIRED", "原价格样本缺少可核对的市场范围。");
          }
          const market = sourceSnapshots[0].marketScope;
          const assessmentInput = { assessmentId: `final-pricing:${input.candidateId}:${input.expectedRevision}`, assessedAt: observedAt,
            target: { candidateId: candidate.id, sourceRevision: candidate.dataRevision, skuPackageId: sku.skuPackageId,
              platform: sku.targetPlatform, store: sku.targetStore, storeRef: structuredClone(sku.g1Identity.storeRef), market },
            salesSnapshots: snapshots, reviews: input.reviews, selectedPriceRub: input.selectedPriceRub };
          const assessment = evaluateFinalMarketPricing(assessmentInput);
          if (assessment.status !== "ready") throw new FinalPricingReviewError("FINAL_PRICING_EVIDENCE_REQUIRED", "多样本比较资料尚不完整；未改变价格、利润或生产授权。");
          const prepared = prepareFinalPricingRevision({ candidate, assessment, assessmentInput, evidencePacks, currentCommissionCatalogs, rules, observedAt });
          const next = structuredClone(prepared.candidate);
          if (prepared.status === "price_revalidated") reusePriorC1AfterPricing(next, relatedSoftwareJobs, observedAt);
          if (prepared.status === "profit_rejected") delete next.lifecycleV11.c1PricingReuse;
          const nextSku = next.lifecycleV11.skuPackage;
          if (prepared.status !== "profit_rejected") {
            nextSku.finalPricingReview = { schemaVersion: "final-pricing-review-v1", assessment: structuredClone(assessment),
              salesSnapshots: snapshots, reviews: structuredClone(input.reviews), supplierSkuId: nextSku.supplierSkuId,
              variantKey: nextSku.variantKey, profitModelVersion: nextSku.activeProfitModelVersion };
            assertFinalPricingReviewCurrent(nextSku);
            if (nextSku.businessPhase === "C2" && nextSku.c2FinalAssets?.status === "completed") {
              if (nextSku.productionConfirmationCard) {
                if (next.lifecycleV11.finalPricingCardHistory !== undefined && !Array.isArray(next.lifecycleV11.finalPricingCardHistory)) {
                  throw new FinalPricingReviewError("FINAL_PRICING_HISTORY_INVALID", "最终商品卡历史格式无效。");
                }
                next.lifecycleV11.finalPricingCardHistory = [...(next.lifecycleV11.finalPricingCardHistory || []), structuredClone(nextSku.productionConfirmationCard)];
                nextSku.productionConfirmationCard = null;
              }
              next.lifecycleV11.skuPackage = structuredClone(createFinalProductPlanConfirmationCard({ skuPackage: nextSku, createdAt: observedAt }).skuPackage);
            }
          }
          next.updatedAt = observedAt;
          return { candidate: next, result: { schemaVersion: "final-pricing-review-result-v1", status: prepared.status,
            assessmentId: assessment.assessmentId, profitModelVersion: nextSku.activeProfitModelVersion,
            sourceRevision: input.expectedRevision, resultRevision: input.expectedRevision + 1,
            externalRequests: 0, platformWrites: 0, productionAuthorizationCreated: false } };
        }
      });
    }
  });
}
