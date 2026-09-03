import { verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { C1AiGatewayError, runC1AiDraftThroughGateway } from "./c1-ai-gateway.mjs";
import { prepareC1SoftwareInputs } from "./c1-software-input-preparation.mjs";

export const C1_SOFTWARE_ORCHESTRATOR_VERSION = "c1-software-orchestrator-v1";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function failureReason(error) {
  if (error instanceof C1AiGatewayError) {
    const requiresMaintenance = error.layer === "output_schema" || error.layer === "receipt";
    const unknownOutcome = Boolean(error.jobId) && ["gateway_status", "inference"].includes(error.layer);
    return {
      disposition: requiresMaintenance ? "exception_case" : "technical_failure",
      reasonCode: error.layer === "output_schema" || error.layer === "receipt" ? "output_schema_mismatch" : "system_failure",
      technicalFailureKind: unknownOutcome ? "unknown_outcome" : "external_dependency",
      failureLayer: error.layer,
      errorCode: error.code,
      message: requiresMaintenance
        ? "C1严格输出结构或网关回执身份与冻结输入不一致。"
        : unknownOutcome
          ? "C1外部AI作业结果无法确定，软件已停止且不会创建第二个作业。"
          : "C1外部AI服务当前不可用，软件已安全停止且不会自动重试或换模型。",
      evidenceRefs: error.jobId ? [`inference-job:${error.jobId}`] : []
    };
  }
  const message = String(error?.message || error);
  const requiresMaintenance = /SCHEMA|FACT|RECEIPT|KEYWORD|EVIDENCE|GATE/i.test(message);
  return {
    disposition: requiresMaintenance ? "exception_case" : "technical_failure",
    reasonCode: requiresMaintenance ? "output_schema_mismatch" : "system_failure",
    technicalFailureKind: "known_technical_failure",
    failureLayer: "c1_software_orchestration",
    errorCode: String(message.split(":", 1)[0] || "C1_SOFTWARE_FAILURE"),
    message: requiresMaintenance
      ? "C1冻结事实或证据契约不满足严格软件不变量。"
      : "C1软件遇到已记录的技术失败并已安全停止。",
    evidenceRefs: []
  };
}

export async function runC1SoftwareOrchestration({
  candidateId,
  candidateRevision,
  skuPackage,
  competitorTextSnapshot,
  keywordEvidence,
  seoRules,
  taskClassification,
  frozenSeoRules = null,
  k3KeywordEvidenceSnapshot = null,
  k3CurrentBinding = null,
  savedKeywordEvidence = null,
  legacySavedKeywordEvidenceReadOnly = false,
  frozenComplexityDecision = null,
  startedAt,
  gatewayOptions = {}
}) {
  const before = structuredClone(skuPackage);
  let prepared = skuPackage;
  try {
    if (prepared?.c1ProductPlan?.status === "inputs_ready") {
      prepared = verifyC1ProductFacts({ skuPackage: prepared, verifiedAt: startedAt }).skuPackage;
    }
    if (prepared?.c1ProductPlan?.status !== "facts_checked") {
      throw new Error("C1_SOFTWARE_GATE_REJECTED: C1事实核验未完成");
    }
    let inputs;
    if (competitorTextSnapshot && keywordEvidence && seoRules && taskClassification) {
      inputs = { competitorTextSnapshot, keywordEvidence, seoRules, taskClassification };
    } else {
      const preparation = prepareC1SoftwareInputs({
        skuPackage: prepared,
        frozenSeoRules,
        k3KeywordEvidenceSnapshot,
        k3CurrentBinding,
        savedKeywordEvidence,
        legacySavedKeywordEvidenceReadOnly,
        frozenComplexityDecision,
        preparedAt: startedAt
      });
      if (preparation.status !== "ready") {
        return freeze({
          orchestrationVersion: C1_SOFTWARE_ORCHESTRATOR_VERSION,
          status: "not_ready",
          skuPackage: prepared,
          c1ProductPlan: prepared.c1ProductPlan,
          inferenceJobId: null,
          inferenceReceiptId: null,
          inferenceReceipt: null,
          technicalFailure: null,
          exceptionCase: null,
          gaps: structuredClone(preparation.gaps),
          businessResultChanged: false,
          codexDispatches: 0,
          externalPlatformAccesses: 0,
          platformWrites: 0
        });
      }
      inputs = preparation.inputs;
    }
    const result = await runC1AiDraftThroughGateway({
      candidateId,
      dataRevision: candidateRevision,
      skuPackage: prepared,
      ...inputs,
      requestedAt: startedAt,
      mergedAt: startedAt,
      ...gatewayOptions
    });
    return freeze({
      orchestrationVersion: C1_SOFTWARE_ORCHESTRATOR_VERSION,
      status: "completed",
      skuPackage: result.skuPackage,
      c1ProductPlan: result.c1ProductPlan,
      inferenceJobId: result.jobId,
      inferenceReceiptId: result.receipt.receiptId,
      inferenceReceipt: structuredClone(result.receipt),
      technicalFailure: null,
      exceptionCase: null,
      businessResultChanged: false,
      codexDispatches: 0,
      externalPlatformAccesses: 0,
      platformWrites: 0
    });
  } catch (error) {
    const failure = failureReason(error);
    const technicalFailure = failure.disposition === "technical_failure" ? {
      schemaVersion: "technical-failure-draft-v1",
      candidateId,
      dataRevision: candidateRevision,
      businessPhase: "C1",
      businessStateChanged: false,
      kind: failure.technicalFailureKind,
      errorCode: failure.errorCode,
      failureLayer: failure.failureLayer,
      message: failure.message,
      evidenceRefs: failure.evidenceRefs,
      softwareJobId: error instanceof C1AiGatewayError ? error.jobId : null,
      automaticRetryAllowed: false,
      status: "stopped",
      stoppedAt: startedAt
    } : null;
    return freeze({
      orchestrationVersion: C1_SOFTWARE_ORCHESTRATOR_VERSION,
      status: technicalFailure ? "technical_failure" : "blocked",
      skuPackage: before,
      c1ProductPlan: before?.c1ProductPlan || null,
      inferenceJobId: error instanceof C1AiGatewayError ? error.jobId : null,
      inferenceReceiptId: null,
      inferenceReceipt: null,
      technicalFailure,
      exceptionCase: technicalFailure ? null : {
        schemaVersion: "exception-case-draft-v1",
        candidateId,
        dataRevision: candidateRevision,
        businessPhase: "C1",
        businessStateChanged: false,
        ...failure,
        status: "open",
        openedAt: startedAt
      },
      businessResultChanged: false,
      codexDispatches: 0,
      externalPlatformAccesses: 0,
      platformWrites: 0
    });
  }
}
