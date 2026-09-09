import { assertCurrentC1AiDraftRequestSources, prepareCurrentC1AiDraftRequest } from "./c1-ai-draft-request-source.mjs";
import { C1SkuRightsReviewError, C1_SKU_RIGHTS_REVIEW_FAILURE_CODES } from "./c1-sku-rights-review.mjs";
import { assertC1PaidKeywordContinuationResult } from "./software-job-repository.mjs";
import { recoverC1KeywordHandoffTechnicalFailure } from "./software-execution-state.mjs";

const SOURCE_GATE_CODES = new Set([
  "C1_DRAFT_REQUEST_INVALID", "C1_DRAFT_EVIDENCE_REQUIRED", "C1_DRAFT_EVIDENCE_NOT_CURRENT", "C1_DRAFT_REQUEST_SOURCE_CONFLICT",
  "C1_AI_REQUEST_INVALID", "C1_AI_REQUEST_GATE_REJECTED", "C1_AI_FACT_DRIFT_DETECTED", "C1_AI_SOURCE_BINDING_REJECTED",
  "C1_AI_COMPETITOR_EVIDENCE_INVALID", "C1_INPUT_PREPARATION_EVIDENCE_DRIFT", "C1_EVIDENCE_STAGE_DUPLICATE_DRIFT",
  "C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT", "C1_KEYWORD_HANDOFF_RECOVERY_REJECTED"
]);

function sourceBlockReasonFromError(error) {
  if (error instanceof C1SkuRightsReviewError && C1_SKU_RIGHTS_REVIEW_FAILURE_CODES.includes(error.code) &&
      error.code !== "C1_SKU_RIGHTS_REVIEW_TIME_INVALID") return error.code;
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
    const code = error.message.split(":", 1)[0];
    if (SOURCE_GATE_CODES.has(code)) return code;
  }
  throw error;
}

function currentSourceBlock(candidate, request, observedAt) {
  try {
    assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt });
    return null;
  } catch (error) {
    // Only declared evidence failures are display states. Invalid clocks and
    // unexpected/programming errors must remain visible to the caller.
    return sourceBlockReasonFromError(error);
  }
}

function configurationBlock(serviceBindings, provider, credentialAlias = null) {
  const binding = serviceBindings.find(value => value.provider === provider && value.modelVersion === `gpt-5.6-${provider}`);
  if (!binding) return { configurationBlockReason: "C1_DRAFT_RUNTIME_NOT_CONFIGURED",
    message: "尚未配置该文案服务，当前任务无法继续。" };
  if (credentialAlias !== null && binding.credentialAlias !== credentialAlias) {
    return { configurationBlockReason: "C1_DRAFT_SERVICE_BINDING_CONFLICT",
      message: "当前文案服务配置与已许可任务不一致，请核对原任务的服务配置。" };
  }
  return null;
}

/** A read-only projection of the saved request/job. It never grants admission. */
export function buildC1DraftRuntimeView({ candidate, runtime, serviceBindings, observedAt }) {
  const lifecycle = candidate.lifecycleV11;
  const sku = lifecycle?.skuPackage;
  if (!sku || !["C1", "C2"].includes(sku.businessPhase)) return null;
  const request = lifecycle.c1AiDraftRequestV1;
  const ref = lifecycle.c1AiDraftJobRefV1;
  const base = { schemaVersion: "c1-draft-runtime-view-v1", automaticRetryAllowed: false,
    canAuthorize: false, canContinueSaved: false, canRetryKeywordHandoff: false,
    keywordJobId: null, handoffFailureId: null, jobRevision: null, configurationBlockReason: null, sourceBlockReason: null,
    requestRef: request?.requestId ?? null, requestFingerprint: request?.requestFingerprint ?? null,
    provider: request?.provider ?? null, modelVersion: request ? `gpt-5.6-${request.provider}` : null,
    maxCalls: 1, accounting: null, providerOutcome: null };
  if (ref) {
    const job = runtime?.softwareJobs?.find(value => value.jobId === ref.jobId);
    if (!job || job.jobType !== "c1_ai_draft" || job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
        job.revision !== ref.resultRevision || job.scopeBinding.requestFingerprint !== ref.inputFingerprint) {
      return { ...base, status: "source_conflict", message: "已保存作业与当前商品引用不一致，请核对记录。" };
    }
    const payload = job.resultEnvelope?.payload;
    const view = { ...base, status: job.status, jobId: job.jobId, jobRevision: job.revision, externalRequestState: job.externalRequestState,
      applicationDisposition: job.resultEnvelope?.applicationDisposition ?? null,
      accounting: structuredClone(payload?.receipt?.accounting ?? payload?.accounting ?? null),
      providerOutcome: structuredClone(payload?.providerOutcome ?? null) };
    const queued = job.status === "queued" && job.attempt === 0 && job.externalRequestState === "not_sent";
    const receiptOnly = job.status === "completed" && job.externalRequestState === "succeeded" &&
      job.resultEnvelope?.applicationDisposition === "result_recorded_no_candidate_mutation";
    if (!queued && !receiptOnly) return view;
    const blocked = configurationBlock(serviceBindings, job.scopeBinding.provider, queued ? job.scopeBinding.credentialAlias : null);
    if (blocked) return { ...view, ...blocked };
    if (candidate.dataRevision !== job.revision) return { ...view, sourceBlockReason: "C1_DRAFT_CANDIDATE_REVISION_CONFLICT",
      message: "商品资料已变更，原任务不能按旧修订继续，请核对保存记录。" };
    // Applying an already saved receipt is not a new external action. Its own
    // transaction checks the frozen source without requiring current evidence.
    if (receiptOnly) return { ...view, canContinueSaved: true };
    const sourceBlockReason = currentSourceBlock(candidate, request, observedAt);
    if (sourceBlockReason) return { ...view, sourceBlockReason, message: "当前商品事实或关键词、权益证据尚未通过核验，原任务暂不能执行。" };
    if (request.requestFingerprint !== job.scopeBinding.requestFingerprint || request.provider !== job.scopeBinding.provider) {
      return { ...view, sourceBlockReason: "C1_DRAFT_REQUEST_SOURCE_CONFLICT", message: "已保存请求与原任务不一致，请核对记录。" };
    }
    return { ...view, canContinueSaved: true };
  }
  const failure = candidate.executionRuntime?.technicalFailure;
  if (!request && failure?.failureLayer === "c1_keyword_handoff" && failure.errorCode === "C1_DRAFT_RUNTIME_UNAVAILABLE") {
    const stopped = { ...base, status: "keyword_handoff_blocked", keywordJobId: failure.softwareJobId,
      handoffFailureId: failure.failureId };
    let prepared;
    try {
      const job = runtime?.softwareJobs?.find(value => value.jobId === failure.softwareJobId);
      assertC1PaidKeywordContinuationResult({ candidate, job });
      if (failure.sourceRevision !== job.revision || !failure.evidenceRefs.includes(job.resultRef)) {
        throw new Error("C1_KEYWORD_HANDOFF_RECOVERY_REJECTED");
      }
      recoverC1KeywordHandoffTechnicalFailure(candidate.executionRuntime, {
        failureId: failure.failureId, softwareJobId: job.jobId, errorCode: failure.errorCode, at: observedAt
      });
      prepared = prepareCurrentC1AiDraftRequest(candidate, observedAt);
    } catch (error) {
      return { ...stopped, sourceBlockReason: sourceBlockReasonFromError(error),
        message: "已保存的关键词证据或交接记录未通过核对，当前不能继续准备文案。" };
    }
    const blocked = configurationBlock(serviceBindings, prepared.provider);
    if (blocked) return { ...stopped, ...blocked };
    return { ...stopped, canRetryKeywordHandoff: true,
      message: "文案配置已就绪，可以继续准备请求。此动作只使用已保存证据，不会查询关键词或产生付费调用。" };
  }
  if (!request) return { ...base, status: serviceBindings.length ? "evidence_required" : "configuration_required",
    message: serviceBindings.length ? "正在等待当前商品的完整事实和关键词证据。" : "尚未配置文案服务，当前没有发起付费调用。" };
  const sourceBlockReason = currentSourceBlock(candidate, request, observedAt);
  if (sourceBlockReason) return { ...base, status: "source_conflict", sourceBlockReason,
    message: "保存请求的商品事实或关键词、权益证据已失效或不一致，请先核对当前证据。" };
  const blocked = configurationBlock(serviceBindings, request.provider);
  if (blocked) return { ...base, status: "configuration_required", ...blocked };
  return { ...base, status: "awaiting_paid_confirmation", canAuthorize: true,
    message: "文案请求已保存，等待本件商品的一次付费许可。" };
}
