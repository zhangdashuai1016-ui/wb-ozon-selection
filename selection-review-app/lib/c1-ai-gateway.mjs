import { createHash } from "node:crypto";
import {
  buildC1AiDraftRequest,
  mergeC1AiDraftReceipt
} from "./c1-ai-draft-contract.mjs";
import { normalizeServiceOrigin } from "./runtime-configuration.mjs";

export const C1_AI_GATEWAY_VERSION = "c1-ai-gateway-v1";

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
  if (!nonEmpty(candidateId) || !Number.isInteger(dataRevision)) {
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

export class C1AiGatewayError extends Error {
  constructor(code, layer, message, details = {}) {
    super(message);
    this.name = "C1AiGatewayError";
    this.code = code;
    this.layer = layer;
    this.jobId = details.jobId || null;
    this.providerFailure = details.providerFailure || null;
  }
}

async function jsonResponse(response, layer, jobId = null) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new C1AiGatewayError(
      String(body?.error?.code || `HTTP_${response.status}`),
      layer,
      String(body?.error?.message || "C1 AI网关请求失败"),
      { jobId }
    );
  }
  return body;
}

function assertGatewayReceipt({ job, gatewayJob, jobId }) {
  if (job.attempt !== 1 || job.candidateId !== gatewayJob.candidateId ||
      job.skuPackageId !== gatewayJob.skuPackageId || String(job.dataRevision) !== gatewayJob.dataRevision ||
      job.businessPhase !== "C1" || job.taskType !== gatewayJob.taskType || job.model !== gatewayJob.model) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_RECEIPT_MISMATCH", "receipt", "C1网关回执与锁定任务不一致", { jobId });
  }
  if (job.receipt?.validation?.schemaValid !== true || !job.receipt.output || !nonEmpty(job.receipt.providerRequestId)) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_OUTPUT_INVALID", "output_schema", "C1网关输出没有通过严格Schema验证", { jobId });
  }
}

function domainReceipt({ request, job, jobId }) {
  const output = structuredClone(job.receipt.output);
  return {
    schemaVersion: "c1-ai-draft-receipt-v1",
    receiptId: `c1-ai-receipt:${jobId}:${job.receipt.requestHash}`,
    providerRequestId: job.receipt.providerRequestId,
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
  mergedAt = requestedAt,
  gatewayUrl,
  gatewayDeploymentMode = "local_development",
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxStatusReads = 120,
  statusIntervalMs = 500
}) {
  const request = buildC1AiDraftRequest({
    skuPackage,
    competitorTextSnapshot,
    keywordEvidence,
    seoRules,
    taskClassification,
    requestedAt
  });
  const gatewayJob = buildC1GatewayJob({ candidateId, dataRevision, request });
  const baseUrl = normalizeC1GatewayUrl(gatewayUrl, gatewayDeploymentMode);
  let created;
  try {
    created = await jsonResponse(await fetchImpl(`${baseUrl}/v1/inference-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gatewayJob)
    }), "gateway_create");
  } catch (error) {
    if (error instanceof C1AiGatewayError) throw error;
    throw new C1AiGatewayError("C1_AI_GATEWAY_UNREACHABLE", "gateway_create", String(error?.message || error));
  }
  const jobId = String(created?.jobId || "").trim();
  if (!jobId) throw new C1AiGatewayError("C1_AI_GATEWAY_JOB_ID_MISSING", "gateway_create", "C1网关没有返回任务编号");
  let job = created;
  for (let index = 0; index < maxStatusReads && ["queued", "running"].includes(job.status); index += 1) {
    await wait(statusIntervalMs);
    try {
      job = await jsonResponse(await fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`), "gateway_status", jobId);
    } catch (error) {
      if (error instanceof C1AiGatewayError) throw error;
      throw new C1AiGatewayError("C1_AI_GATEWAY_STATUS_UNAVAILABLE", "gateway_status", String(error?.message || error), { jobId });
    }
  }
  if (["queued", "running"].includes(job.status)) {
    throw new C1AiGatewayError("C1_AI_GATEWAY_STATUS_TIMEOUT", "gateway_status", "C1 AI任务状态读取超时；未重复创建任务", { jobId });
  }
  if (job.status !== "completed" || !job.receipt) {
    throw new C1AiGatewayError(
      String(job.failure?.code || "C1_AI_INFERENCE_FAILED"),
      String(job.failure?.layer || "inference"),
      String(job.failure?.message || "C1 AI任务失败并已停止"),
      { jobId, providerFailure: job.failure || null }
    );
  }
  assertGatewayReceipt({ job, gatewayJob, jobId });
  const receipt = domainReceipt({ request, job, jobId });
  const merged = mergeC1AiDraftReceipt({ skuPackage, request, receipt, mergedAt });
  return Object.freeze({
    orchestrationVersion: C1_AI_GATEWAY_VERSION,
    jobId,
    request,
    receipt,
    skuPackage: merged.skuPackage,
    c1ProductPlan: merged.c1ProductPlan,
    idempotent: merged.idempotent,
    supplierAttempts: 1,
    codexWakeups: 0,
    externalPlatformAccesses: 0,
    platformWrites: 0
  });
}
