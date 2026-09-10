import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildC1AiDraftRequest,
  assertAuthorizedC1Execution,
  assertC1ProviderOutcome,
  createC1AiAccounting,
  validateC1AiAccounting,
  validateC1AiDraftReceipt
} from "./c1-ai-draft-contract.mjs";
import { assertCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { normalizeServiceOrigin } from "./runtime-configuration.mjs";

export const C1_AI_GATEWAY_VERSION = "c1-ai-gateway-v1";
export const C1_GATEWAY_SOURCE_BINDING_VERSION = "c1-inference-source-binding-v1";
export const C1_AI_GATEWAY_TOTAL_TIMEOUT_MS = 60_000;

const MODEL_BY_PROVIDER = Object.freeze({
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol"
});

const SOL_TASK_TYPES = new Set([
  "evidence_conflict_analysis",
  "category_dispute_analysis",
  "brand_ip_compliance_analysis",
  "multi_image_sku_mapping"
]);

const CITED_TEXT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text", "factRefs", "keywordRefs", "assertions"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 6000 },
    factRefs: { type: "array", minItems: 1, maxItems: 60, items: { type: "string", minLength: 1, maxLength: 500 } },
    keywordRefs: { type: "array", minItems: 1, maxItems: 60, items: { type: "string", minLength: 1, maxLength: 500 } },
    assertions: {
      type: "array",
      minItems: 1,
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factPath", "value"],
        properties: {
          factPath: { type: "string", minLength: 1, maxLength: 500 },
          value: {}
        }
      }
    }
  }
});

export const C1_AI_GATEWAY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "locale", "claimCoverage", "title", "description", "bulletPoints", "searchKeywords", "unsupportedClaims"],
  properties: {
    status: { type: "string", enum: ["draft_only"] },
    locale: { type: "string", enum: ["ru-RU"] },
    claimCoverage: { type: "string", enum: ["complete"] },
    title: CITED_TEXT_SCHEMA,
    description: CITED_TEXT_SCHEMA,
    bulletPoints: { type: "array", minItems: 1, maxItems: 10, items: CITED_TEXT_SCHEMA },
    searchKeywords: { type: "array", minItems: 1, maxItems: 50, items: CITED_TEXT_SCHEMA },
    unsupportedClaims: { type: "array", maxItems: 0, items: { type: "string" } }
  }
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeC1GatewayUrl(value, deploymentMode) {
  try {
    return normalizeServiceOrigin(value, {
      deploymentMode,
      label: "c1AiGatewayUrl"
    });
  } catch (error) {
    throw new Error(`C1_AI_GATEWAY_SCOPE_REJECTED: ${error.message}`);
  }
}

function gatewayTaskType(request) {
  if (request.provider === "terra") return "seo_draft";
  const taskType = request.taskClassification?.gatewayTaskType;
  if (!SOL_TASK_TYPES.has(taskType)) {
    throw new Error("C1_AI_COMPLEX_TASK_TYPE_REQUIRED: Sol复杂任务必须在调用前锁定网关任务类型");
  }
  return taskType;
}

function gatewayEvidenceRefs(request) {
  return [
    {
      id: `c1-facts:${request.identity.c1PlanId}`,
      kind: "verified_product_facts",
      contentSha256: sha256(request.verifiedFacts),
      authorizedForAi: true
    },
    {
      id: request.competitorTextEvidence.evidenceRef,
      kind: "public_competitor_text",
      contentSha256: sha256(request.competitorTextEvidence),
      authorizedForAi: true
    },
    {
      id: request.keywordEvidence.evidenceId,
      kind: "seo_keyword_evidence",
      contentSha256: sha256(request.keywordEvidence),
      authorizedForAi: true
    }
  ];
}

function gatewayPrompt(request) {
  return [
    "只根据下列已核验事实、公开竞品文字和关键词证据生成俄语商品文案草稿。",
    "每个输出项必须引用factRefs和keywordRefs，并逐项列出assertions。不得新增材质、品牌、尺寸、功能、认证或其他未核验事实。输出仅为draft_only。",
    JSON.stringify({
      verifiedFacts: request.verifiedFacts,
      competitorTextEvidence: request.competitorTextEvidence,
      keywordEvidence: request.keywordEvidence,
      seoRules: request.seoRules
    })
  ].join("\n\n");
}

export function buildC1GatewayJob({ candidateId, dataRevision, request }) {
  if (!nonEmpty(candidateId) || !Number.isInteger(dataRevision) || dataRevision < 0 ||
      candidateId !== request.sourceIdentity?.candidateId) {
    throw new Error("C1_AI_GATEWAY_INPUT_INVALID: 候选身份或修订号无效");
  }
  return Object.freeze({
    projectId: "three-store-selection",
    candidateId,
    skuPackageId: request.identity.skuPackageId,
    dataRevision: String(dataRevision),
    businessPhase: "C1",
    taskType: gatewayTaskType(request),
    model: MODEL_BY_PROVIDER[request.provider],
    evidenceRefs: gatewayEvidenceRefs(request),
    input: { text: gatewayPrompt(request), images: [] },
    outputSchema: structuredClone(C1_AI_GATEWAY_OUTPUT_SCHEMA)
  });
}

/** Bind the existing gateway request to the exact central job without sending its authorization body. */
function buildSavedC1GatewayJob({ request, authorizedExecution: execution }) {
  return Object.freeze({
    ...buildC1GatewayJob({ candidateId: execution.identity.candidateId, dataRevision: execution.candidateRevision, request }),
    sourceBinding: { schemaVersion: C1_GATEWAY_SOURCE_BINDING_VERSION,
      softwareJobId: execution.jobId, requestFingerprint: request.requestFingerprint,
      sourceSkuRevision: request.sourceSkuRevision, c1PlanId: request.identity.c1PlanId,
      platform: request.sourceIdentity.platform, storeRef: structuredClone(request.sourceIdentity.storeRef),
      supplierSkuId: request.sourceIdentity.supplierSkuId, variantKey: request.identity.variantKey } });
}

function assertGatewaySourceBinding(job, gatewayJob, jobId) {
  if (job.jobId !== jobId || !isDeepStrictEqual(job.sourceBinding, gatewayJob.sourceBinding)) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_SOURCE_BINDING_MISMATCH", "receipt", "网关回执不属于同一已保存请求与店铺分支，已停止查询", { jobId });
  }
}

export class C1AiGatewayError extends Error {
  constructor(code, layer, message, details = {}) {
    super(message);
    this.name = "C1AiGatewayError";
    this.code = code;
    this.layer = layer;
    this.jobId = details.jobId || null;
    this.providerFailure = details.providerFailure || null;
    this.providerOutcome = details.providerOutcome == null ? null : assertC1ProviderOutcome(details.providerOutcome);
    this.externalRequestState = ["failed", "succeeded"].includes(details.externalRequestState) ? details.externalRequestState : "unknown_outcome";
    if (details.accounting && !validateC1AiAccounting(details.accounting).valid) throw new Error("C1_AI_ACCOUNTING_INVALID: 失败回执的对账记录无效");
    this.accounting = details.accounting ? structuredClone(details.accounting) : createC1AiAccounting({ gatewayJobId: this.jobId });
  }
}

async function jsonResponse(response, layer, jobId = null) {
  let body;
  try { body = await response.json(); }
  catch { throw new C1AiGatewayError("C1_AI_GATEWAY_INVALID_JSON", layer, "C1网关未返回有效JSON", { jobId }); }
  if (!response.ok) {
    throw new C1AiGatewayError(
      /^[A-Z0-9_]{1,80}$/.test(body?.error?.code) ? body.error.code : `HTTP_${response.status}`,
      layer,
      "C1 AI网关请求失败",
      { jobId }
    );
  }
  return body;
}

function assertGatewayJobScope({ job, gatewayJob, jobId }) {
  if (job.jobId !== jobId || job.attempt !== 1 || job.candidateId !== gatewayJob.candidateId ||
      job.skuPackageId !== gatewayJob.skuPackageId || String(job.dataRevision) !== gatewayJob.dataRevision ||
      job.businessPhase !== "C1" || job.taskType !== gatewayJob.taskType || job.model !== gatewayJob.model) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_RECEIPT_MISMATCH", "receipt", "C1网关回执与锁定任务不一致", { jobId });
  }
}

function gatewayAccounting(job, jobId) {
  try {
    return createC1AiAccounting({ gatewayJobId: jobId, providerRequestId: job.receipt?.providerRequestId ?? null,
      usage: job.receipt && Object.hasOwn(job.receipt, "usage") ? job.receipt.usage : "unknown" });
  } catch (error) {
    if (!String(error.message).startsWith("C1_AI_ACCOUNTING_INVALID")) throw error;
    throw new C1AiGatewayError("C1_AI_GATEWAY_ACCOUNTING_INVALID", "receipt", "网关耗用记录格式无效，已保留请求编号供对账", { jobId });
  }
}

function providerOutcomeFromJob(job, jobId) {
  const failureLayer = /^[a-z_]{1,40}$/.test(job.failure?.layer) ? job.failure.layer : "inference";
  const legacyUnknown = !Object.hasOwn(job, "externalRequestState") && !Object.hasOwn(job, "requestTransmission");
  const outcome = { schemaVersion: "c1-provider-outcome-v1", failureLayer,
    externalRequestState: legacyUnknown ? "unknown_outcome" : job.externalRequestState,
    requestTransmission: legacyUnknown ? "unknown" : job.requestTransmission };
  try { return assertC1ProviderOutcome(outcome); }
  catch (error) {
    if (!["C1_PROVIDER_OUTCOME_INVALID", "C1_PROVIDER_OUTCOME_TRANSMISSION_CONFLICT"].some(code => String(error.message).startsWith(code))) throw error;
    throw new C1AiGatewayError("C1_AI_GATEWAY_PROVIDER_OUTCOME_INVALID", "receipt", "网关供应商请求终态不符合回执合同", {
      jobId, accounting: gatewayAccounting(job, jobId) });
  }
}

function assertGatewayReceipt({ job, gatewayJob, jobId, accounting }) {
  assertGatewayJobScope({ job, gatewayJob, jobId });
  if (job.receipt?.validation?.schemaValid !== true || !job.receipt.output || !nonEmpty(job.receipt.providerRequestId)) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_OUTPUT_INVALID", "output_schema", "C1网关输出没有通过严格Schema验证", { jobId, accounting, externalRequestState: "succeeded" });
  }
}

function domainReceipt({ request, job, jobId, softwareJobId, accounting }) {
  const output = structuredClone(job.receipt.output);
  return {
    schemaVersion: "c1-ai-draft-receipt-v1",
    receiptId: `c1-ai-receipt:${jobId}:${job.receipt.requestHash}`,
    providerRequestId: job.receipt.providerRequestId,
    softwareJobId,
    gatewayJobId: jobId,
    accounting,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    provider: request.provider,
    modelVersion: job.model,
    serviceVersion: `ecommerce-ai-gateway/${job.receipt.receiptVersion}`,
    status: "completed",
    attempt: 1,
    startedAt: job.startedAt || job.receipt.requestedAt,
    completedAt: job.completedAt || job.receipt.completedAt,
    externalPlatformAccesses: 0,
    codexDispatches: 0,
    productionWrites: 0,
    inputEvidenceRefs: [...new Set([
      request.competitorTextEvidence.evidenceRef,
      request.keywordEvidence.evidenceId,
      ...request.verifiedFacts.flatMap((fact) => fact.evidenceRefs)
    ])],
    outputFingerprint: sha256(output),
    output
  };
}

export async function runC1AiDraftThroughGateway({
  candidateId,
  dataRevision,
  skuPackage,
  competitorTextSnapshot,
  keywordEvidence,
  seoRules,
  taskClassification,
  requestedAt,
  authorizedExecution,
  paymentAuthorization,
  onGatewayJobAccepted,
  gatewayUrl,
  gatewayDeploymentMode,
  fetchImpl,
  wait,
  maxStatusReads,
  statusIntervalMs,
  totalTimeoutMs,
  clock
}) {
  const request = buildC1AiDraftRequest({
    skuPackage,
    competitorTextSnapshot,
    keywordEvidence,
    seoRules,
    taskClassification,
    requestedAt
  });
  const admitted = assertAuthorizedC1Execution({ request, authorizedExecution });
  if (admitted.candidateRevision !== dataRevision || admitted.identity.candidateId !== candidateId) {
    throw new C1AiGatewayError("C1_AI_AUTHORIZED_EXECUTION_MISMATCH", "admission", "当前候选修订不属于已准入作业");
  }
  return runC1SavedDraftRequestThroughGateway({ request, authorizedExecution: admitted, paymentAuthorization, onGatewayJobAccepted, gatewayUrl,
    gatewayDeploymentMode, fetchImpl, wait, maxStatusReads, statusIntervalMs, totalTimeoutMs, clock });
}

function executionDeadline({ totalTimeoutMs, clock }) {
  let observedAt = clock();
  if (!Number.isFinite(observedAt)) throw new Error("C1_AI_GATEWAY_CLOCK_INVALID: 执行时钟无效");
  const deadline = observedAt + totalTimeoutMs;
  function remaining(layer, jobId) {
    const now = clock();
    if (!Number.isFinite(now) || now < observedAt) throw new C1AiGatewayError("C1_AI_GATEWAY_CLOCK_INVALID", layer, "执行时钟无效，已停止当前作业", { jobId });
    observedAt = now;
    if (deadline - now < 1) throw new C1AiGatewayError("C1_AI_GATEWAY_DEADLINE_EXCEEDED", layer, "C1网关总执行时限已到，结果未知且禁止重复提交", { jobId });
    return Math.floor(deadline - now);
  }
  async function run(operation, layer, jobId = null, maximumMs = 20_000, { preserveAcceptedResponse = false } = {}) {
    const remainingMs = remaining(layer, jobId);
    const timeoutMs = Math.min(maximumMs, remainingMs);
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new C1AiGatewayError(
          remainingMs <= maximumMs ? "C1_AI_GATEWAY_DEADLINE_EXCEEDED" : "C1_AI_GATEWAY_REQUEST_TIMEOUT",
          layer, "C1网关执行超时，结果未知且禁止重复提交", { jobId }
        ));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([operation(controller.signal), expired]);
      if (!preserveAcceptedResponse) remaining(layer, jobId);
      return result;
    } finally { clearTimeout(timer); }
  }
  return { remaining, run };
}

async function saveGatewayAcceptance(onGatewayJobAccepted, jobId, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new C1AiGatewayError("C1_AI_GATEWAY_ACCEPTANCE_SAVE_TIMEOUT", "gateway_acceptance",
      "网关已接受请求，本地编号保存超时；结果待对账且禁止重发", { jobId })), timeoutMs);
  });
  try { await Promise.race([onGatewayJobAccepted(Object.freeze({ gatewayJobId: jobId })), timeout]); }
  finally { clearTimeout(timer); }
}

/** Executes the exact persisted request after this action records its one request-start transition. */
export async function runC1SavedDraftRequestThroughGateway({
  request,
  authorizedExecution,
  paymentAuthorization = null,
  onGatewayJobAccepted,
  gatewayUrl,
  gatewayDeploymentMode = "local_development",
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxStatusReads = 120,
  statusIntervalMs = 500,
  totalTimeoutMs = C1_AI_GATEWAY_TOTAL_TIMEOUT_MS,
  clock = () => performance.now()
}) {
  const admitted = assertAuthorizedC1Execution({ request, authorizedExecution });
  if (!Number.isInteger(maxStatusReads) || maxStatusReads < 1 || maxStatusReads > 120 ||
      !Number.isInteger(statusIntervalMs) || statusIntervalMs < 0 || statusIntervalMs > C1_AI_GATEWAY_TOTAL_TIMEOUT_MS ||
      !Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > C1_AI_GATEWAY_TOTAL_TIMEOUT_MS ||
      typeof fetchImpl !== "function" || typeof wait !== "function" || typeof clock !== "function" ||
      typeof onGatewayJobAccepted !== "function") {
    throw new C1AiGatewayError("C1_AI_GATEWAY_OPTIONS_INVALID", "admission", "网关执行必须使用有界读取次数与不超过60秒的总时限");
  }
  if (paymentAuthorization !== null) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_BUDGET_CONSTRAINT_UNSUPPORTED", "admission", "当前调用携带独立预算约束，现网关无法证明执行该约束，未发送请求");
  }
  const savedRequest = structuredClone(request);
  const gatewayJob = buildSavedC1GatewayJob({ request: savedRequest, authorizedExecution: admitted });
  const baseUrl = normalizeC1GatewayUrl(gatewayUrl, gatewayDeploymentMode);
  const deadline = executionDeadline({ totalTimeoutMs, clock });
  let created;
  try {
    created = await deadline.run(async signal => jsonResponse(await fetchImpl(`${baseUrl}/v1/inference-jobs`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gatewayJob),
      signal
    }), "gateway_create"), "gateway_create", null, 20_000, { preserveAcceptedResponse: true });
  } catch (error) {
    if (error instanceof C1AiGatewayError) throw error;
    throw new C1AiGatewayError("C1_AI_GATEWAY_UNREACHABLE", "gateway_create", "网关请求结果未知，禁止重复提交");
  }
  const jobId = String(created?.jobId || "").trim();
  if (!jobId) throw new C1AiGatewayError("C1_AI_GATEWAY_JOB_ID_MISSING", "gateway_create", "C1网关没有返回任务编号");
  assertCanonicalFrozenRef(jobId, "gatewayJobId");
  // Persist the accepted ID even when the following response binding is invalid.
  // A failed save stops all polling; the already issued request is never replayed.
  // Local evidence persistence has its own bounded wait. An expired network
  // deadline must not discard a response that has already supplied its ID.
  await saveGatewayAcceptance(onGatewayJobAccepted, jobId, Math.min(totalTimeoutMs, 20_000));
  deadline.remaining("gateway_acceptance", jobId);
  assertGatewaySourceBinding(created, gatewayJob, jobId);
  let job = created;
  for (let index = 0; index < maxStatusReads && ["queued", "running"].includes(job.status); index += 1) {
    const waitMs = Math.min(statusIntervalMs, deadline.remaining("gateway_status", jobId));
    await deadline.run(() => wait(waitMs), "gateway_status", jobId, C1_AI_GATEWAY_TOTAL_TIMEOUT_MS);
    try {
      job = await deadline.run(async signal => jsonResponse(await fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`, { redirect: "error", signal }), "gateway_status", jobId), "gateway_status", jobId);
    } catch (error) {
      if (error instanceof C1AiGatewayError) throw error;
      throw new C1AiGatewayError("C1_AI_GATEWAY_STATUS_UNAVAILABLE", "gateway_status", "网关状态读取失败，结果未知", { jobId });
    }
    assertGatewaySourceBinding(job, gatewayJob, jobId);
  }
  if (["queued", "running"].includes(job.status)) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_STATUS_TIMEOUT", "gateway_status", "C1 AI任务状态读取超时；未重复创建任务", { jobId });
  }
  if (job.status !== "completed" || !job.receipt) {
    if (["failed", "completed"].includes(job.status)) assertGatewayJobScope({ job, gatewayJob, jobId });
    const providerOutcome = providerOutcomeFromJob(job, jobId);
    throw new C1AiGatewayError(
      /^[A-Z0-9_]{1,80}$/.test(job.failure?.code) ? job.failure.code : "C1_AI_INFERENCE_FAILED",
      /^[a-z_]{1,40}$/.test(job.failure?.layer) ? job.failure.layer : "inference",
      "C1 AI任务失败并已停止",
      { jobId, externalRequestState: job.status === "completed" ? "succeeded"
          : providerOutcome.externalRequestState === "not_sent" ? "failed" : providerOutcome.externalRequestState,
        providerOutcome,
        accounting: gatewayAccounting(job, jobId) }
    );
  }
  assertGatewayJobScope({ job, gatewayJob, jobId });
  const accounting = gatewayAccounting(job, jobId);
  assertGatewayReceipt({ job, gatewayJob, jobId, accounting });
  const receipt = domainReceipt({ request: savedRequest, job, jobId, softwareJobId: admitted.jobId, accounting });
  const validation = validateC1AiDraftReceipt({ request: savedRequest, receipt });
  if (!validation.valid) throw new C1AiGatewayError("C1_AI_GATEWAY_RECEIPT_REJECTED", "receipt", "网关回执未通过C1事实与请求合同校验", { jobId, accounting, externalRequestState: "succeeded" });
  return Object.freeze({
    orchestrationVersion: C1_AI_GATEWAY_VERSION,
    jobId,
    request: savedRequest,
    receipt,
    status: "receipt_ready",
    supplierAttempts: 1,
    codexWakeups: 0,
    externalPlatformAccesses: 0,
    platformWrites: 0
  });
}
