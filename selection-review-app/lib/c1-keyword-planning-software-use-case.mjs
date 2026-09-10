import {
  assertNormalProductionCodexIndependent,
  CODEX_OFFLINE_MODE,
  NORMAL_PRODUCTION_PATH
} from "./codex-independence.mjs";
import {
  persistC1KeywordPlanningEvidence,
  persistC1KeywordPlanningReadiness
} from "./c1-keyword-planning-evidence-persistence.mjs";
import { persistC1KeywordPlanningLocalMaterial } from "./c1-keyword-planning-local-material-persistence.mjs";
import { resolveC1KeywordPlanningSourceEvidence } from "./c1-keyword-planning-source-resolver.mjs";

export const C1_KEYWORD_PLANNING_SOFTWARE_USE_CASE_VERSION = "c1-keyword-planning-software-use-case-v1";

export function assertC1KeywordPlanningSoftwareClientInput(input) {
  if (!isObject(input) || Object.keys(input).length !== 1 || !Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
    throw new Error("C1_KEYWORD_PLANNING_CLIENT_INPUT_REJECTED: 客户端只允许提交dataRevision");
  }
  return Object.freeze({ dataRevision: input.dataRevision });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function currentCandidate(document, candidateId) {
  if (!Array.isArray(document?.candidates)) throw new Error("C1_KEYWORD_PLANNING_SOFTWARE_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new Error("C1_KEYWORD_PLANNING_SOFTWARE_CANDIDATE_NOT_FOUND");
  return candidate;
}

/**
 * 正常软件路径的确定性用例。它只解析已保存来源并原子生产planning evidence；
 * 不创建付费作业，也不访问Seerfar、浏览器、AI网关或Codex。
 */
export async function runC1KeywordPlanningEvidenceProduction({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedRevision,
  producedAt,
  codexOffline = true,
  resolveSource = resolveC1KeywordPlanningSourceEvidence,
  persistEvidence = persistC1KeywordPlanningEvidence,
  persistReadiness = persistC1KeywordPlanningReadiness,
  persistLocalMaterial = persistC1KeywordPlanningLocalMaterial
}) {
  if (!repository || !nonEmpty(candidateId) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !nonEmpty(producedAt) || Number.isNaN(Date.parse(producedAt)) || typeof resolveSource !== "function" ||
      typeof persistEvidence !== "function" || typeof persistReadiness !== "function" ||
      typeof persistLocalMaterial !== "function") {
    throw new Error("C1_KEYWORD_PLANNING_SOFTWARE_INPUT_INVALID");
  }
  const snapshot = await repository.readSnapshot();
  const candidate = currentCandidate(snapshot, candidateId);
  if (candidate.dataRevision !== expectedRevision) throw new Error("C1_KEYWORD_PLANNING_SOFTWARE_REVISION_CONFLICT");
  const skuPackageId = candidate.lifecycleV11?.skuPackage?.skuPackageId;
  if (codexOffline && nonEmpty(skuPackageId)) {
    assertNormalProductionCodexIndependent({
      executionMode: CODEX_OFFLINE_MODE,
      pathType: NORMAL_PRODUCTION_PATH,
      skuPackageId,
      codexDependencies: []
    });
  }
  const resolved = resolveSource({ candidate, expectedRevision, resolvedAt: producedAt });
  if (!isObject(resolved) || !["ready", "not_ready", "blocked"].includes(resolved.status)) {
    throw new Error("C1_KEYWORD_PLANNING_SOURCE_RESOLUTION_INVALID");
  }
  if (resolved.status === "not_ready" && resolved.gaps?.[0]?.code === "planning_source_record_missing") {
    const persisted = await persistLocalMaterial({
      repository,
      runtimeMode,
      actor,
      candidateId,
      expectedRevision,
      producedAt,
      codexOffline
    });
    return freeze({
      schemaVersion: C1_KEYWORD_PLANNING_SOFTWARE_USE_CASE_VERSION,
      status: persisted.status,
      candidate: structuredClone(persisted.candidate),
      result: structuredClone(persisted.result),
      sourceResolution: structuredClone(resolved),
      stage: "local_material",
      sideEffects: {
        externalCallsPerformed: 0,
        aiCallsPerformed: 0,
        browserActionsPerformed: 0,
        codexDispatchesPerformed: 0,
        softwareJobsCreated: 0,
        businessMutationsPerformed: persisted.status === "committed" ? 1 : 0
      }
    });
  }
  if (resolved.status !== "ready") {
    const persisted = await persistReadiness({
      repository,
      runtimeMode,
      actor,
      candidateId,
      expectedRevision,
      sourceResolution: resolved,
      producedAt,
      codexOffline
    });
    return freeze({
      schemaVersion: C1_KEYWORD_PLANNING_SOFTWARE_USE_CASE_VERSION,
      status: persisted.status,
      candidate: structuredClone(persisted.candidate),
      result: structuredClone(persisted.result),
      sourceResolution: structuredClone(resolved),
      sideEffects: {
        externalCallsPerformed: 0,
        aiCallsPerformed: 0,
        browserActionsPerformed: 0,
        codexDispatchesPerformed: 0,
        softwareJobsCreated: 0,
        businessMutationsPerformed: persisted.status === "committed" ? 1 : 0
      }
    });
  }
  const persisted = await persistEvidence({
    repository,
    runtimeMode,
    actor,
    candidateId,
    expectedRevision,
    serverEvidence: resolved.sourceEvidence,
    producedAt,
    codexOffline
  });
  return freeze({
    schemaVersion: C1_KEYWORD_PLANNING_SOFTWARE_USE_CASE_VERSION,
    status: persisted.status,
    candidate: structuredClone(persisted.candidate),
    result: structuredClone(persisted.result),
    sourceResolution: structuredClone(resolved),
    sideEffects: {
      externalCallsPerformed: 0,
      aiCallsPerformed: 0,
      browserActionsPerformed: 0,
      codexDispatchesPerformed: 0,
      softwareJobsCreated: 0,
      businessMutationsPerformed: persisted.status === "committed" ? 1 : 0
    }
  });
}
