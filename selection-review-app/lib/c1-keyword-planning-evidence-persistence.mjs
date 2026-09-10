import { createHash } from "node:crypto";

import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import {
  assertBusinessStateRepositoryBoundary,
  assertCentralPersistenceBoundary
} from "./business-state-repository.mjs";
import {
  assertNormalProductionCodexIndependent,
  CODEX_OFFLINE_MODE,
  NORMAL_PRODUCTION_PATH
} from "./codex-independence.mjs";
import { produceC1KeywordPlanningEvidence } from "./c1-keyword-planning-evidence-producer.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";

export const C1_KEYWORD_PLANNING_PERSISTENCE_VERSION = "c1-keyword-planning-persistence-v1";
const CENTRAL_RUNTIME_MODES = new Set(["central_test", "central_production"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function currentCandidate(document, candidateId) {
  if (!Array.isArray(document?.candidates)) throw new Error("C1_KEYWORD_PLANNING_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new Error("C1_KEYWORD_PLANNING_CANDIDATE_NOT_FOUND");
  return candidate;
}

function assertRepositoryForMode(repository, runtimeMode) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode)) {
    throw new Error("BUSINESS_MUTATION_RUNTIME_MODE_INVALID");
  }
  return CENTRAL_RUNTIME_MODES.has(runtimeMode)
    ? assertCentralPersistenceBoundary(repository)
    : assertBusinessStateRepositoryBoundary(repository);
}

function currentProduction(candidate) {
  return candidate.lifecycleV11?.c1KeywordPlanningProductionV1 ?? null;
}

function currentEvidence(candidate) {
  return candidate.lifecycleV11?.c1KeywordPlanningEvidenceV1 ?? null;
}

function alreadyCurrent(candidate) {
  const production = currentProduction(candidate);
  const evidence = currentEvidence(candidate);
  return production?.status === "ready" && evidence?.binding?.candidateId === candidate.id &&
    evidence.binding.candidateRevision === candidate.dataRevision &&
    evidence.binding.skuPackageId === candidate.lifecycleV11?.skuPackage?.skuPackageId &&
    production.evidenceFingerprint === digest(evidence);
}

function readinessAlreadyCurrent(candidate, inputFingerprint) {
  const production = currentProduction(candidate);
  return ["not_ready", "blocked"].includes(production?.status) &&
    production.candidateId === candidate.id &&
    production.skuPackageId === candidate.lifecycleV11?.skuPackage?.skuPackageId &&
    production.resultCandidateRevision === candidate.dataRevision &&
    production.inputFingerprint === inputFingerprint &&
    production.evidenceFingerprint === null &&
    !currentEvidence(candidate);
}

/**
 * 应用层原子接缝。调用方只能传服务端已读取的正式来源证据，不能传UI拼装结果。
 * 本函数无网络、无AI、无浏览器、无Codex任务，也不创建付费Seerfar作业。
 */
export async function persistC1KeywordPlanningEvidence({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedRevision,
  serverEvidence,
  producedAt,
  codexOffline = true,
  producer = produceC1KeywordPlanningEvidence
}) {
  if (!nonEmpty(candidateId) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !nonEmpty(producedAt) || Number.isNaN(Date.parse(producedAt)) || typeof producer !== "function") {
    throw new Error("C1_KEYWORD_PLANNING_PERSISTENCE_INPUT_INVALID");
  }
  // already_current也是受保护的业务读取，不能绕过角色授权或revision语义。
  authorizeOperation({ actor, requiredRoles: ["operator"] });
  assertRepositoryForMode(repository, runtimeMode);
  const snapshot = await repository.readSnapshot();
  const observed = currentCandidate(snapshot, candidateId);
  if (observed.dataRevision === expectedRevision && alreadyCurrent(observed)) {
    return Object.freeze({
      status: "already_current",
      candidate: structuredClone(observed),
      result: structuredClone(currentProduction(observed)),
      externalCallsPerformed: 0,
      codexDispatchesPerformed: 0
    });
  }
  const skuPackageId = observed.lifecycleV11?.skuPackage?.skuPackageId;
  if (!nonEmpty(skuPackageId)) throw new Error("C1_KEYWORD_PLANNING_SKU_PACKAGE_MISSING");
  if (codexOffline) {
    assertNormalProductionCodexIndependent({
      executionMode: CODEX_OFFLINE_MODE,
      pathType: NORMAL_PRODUCTION_PATH,
      skuPackageId,
      codexDependencies: []
    });
  }
  // 业务幂等身份只绑定输入事实；时间仅用于审计，不能让同一revision的重复触发变成新操作。
  const sourceFingerprint = digest({ candidateId, expectedRevision, skuPackageId, serverEvidence });
  const idempotencyKey = `c1-keyword-planning:${candidateId}:${expectedRevision}:${sourceFingerprint}`;

  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["operator"],
    action: "produce_c1_keyword_planning_evidence",
    candidateId,
    skuPackageId,
    expectedRevision,
    idempotencyKey,
    inputFingerprint: sourceFingerprint,
    auditEventId: `audit:${idempotencyKey}`,
    externalRequestState: "not_sent",
    serverTime: producedAt,
    mutate: ({ candidate }) => {
      const produced = producer({ candidate, expectedRevision, serverEvidence, producedAt });
      if (!isObject(produced?.production) || !["ready", "not_ready", "blocked"].includes(produced.status)) {
        throw new Error("C1_KEYWORD_PLANNING_PRODUCER_RESULT_INVALID");
      }
      const next = structuredClone(candidate);
      next.lifecycleV11 = { ...structuredClone(next.lifecycleV11 || {}) };
      next.lifecycleV11.skuPackage = structuredClone(produced.skuPackage ?? next.lifecycleV11.skuPackage);
      next.lifecycleV11.c1KeywordPlanningProductionV1 = structuredClone(produced.production);
      if (produced.status === "ready") {
        if (!isObject(produced.evidence)) throw new Error("C1_KEYWORD_PLANNING_READY_EVIDENCE_MISSING");
        next.lifecycleV11.c1KeywordPlanningEvidenceV1 = structuredClone(produced.evidence);
      }
      next.updatedAt = producedAt;
      next.lastModifiedBy = "software";
      return {
        candidate: next,
        result: {
          schemaVersion: C1_KEYWORD_PLANNING_PERSISTENCE_VERSION,
          status: produced.status,
          candidateId,
          skuPackageId,
          sourceCandidateRevision: expectedRevision,
          resultCandidateRevision: expectedRevision + 1,
          sourceSkuRevision: produced.production.sourceSkuRevision,
          resultSkuRevision: produced.production.resultSkuRevision,
          factsVerifiedFromFrozenInputs: produced.production.factsVerifiedFromFrozenInputs,
          productionFingerprint: digest(produced.production),
          evidenceFingerprint: produced.production.evidenceFingerprint,
          gaps: structuredClone(produced.production.gaps),
          sideEffects: {
            externalCallsPerformed: 0,
            aiCallsPerformed: 0,
            browserActionsPerformed: 0,
            codexDispatchesPerformed: 0,
            softwareJobsCreated: 0,
            dispatchesCreated: 0,
            c2Started: false,
            dStarted: false,
            eStarted: false
          }
        }
      };
    }
  });
}

/**
 * 已知资料缺口也必须成为可观察、可追溯的正式收据；只是不生成Evidence。
 * 该路径不改变商品业务结论，不创建作业，也不访问任何外部依赖。
 */
export async function persistC1KeywordPlanningReadiness({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedRevision,
  sourceResolution,
  producedAt,
  codexOffline = true
}) {
  if (!nonEmpty(candidateId) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !nonEmpty(producedAt) || Number.isNaN(Date.parse(producedAt)) ||
      !isObject(sourceResolution) || !["not_ready", "blocked"].includes(sourceResolution.status) ||
      !Array.isArray(sourceResolution.gaps) || sourceResolution.gaps.length === 0) {
    throw new Error("C1_KEYWORD_PLANNING_READINESS_INPUT_INVALID");
  }
  authorizeOperation({ actor, requiredRoles: ["operator"] });
  assertRepositoryForMode(repository, runtimeMode);
  const snapshot = await repository.readSnapshot();
  const observed = currentCandidate(snapshot, candidateId);
  const skuPackage = observed.lifecycleV11?.skuPackage;
  if (!nonEmpty(skuPackage?.skuPackageId)) throw new Error("C1_KEYWORD_PLANNING_SKU_PACKAGE_MISSING");
  const inputFingerprint = digest({
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    status: sourceResolution.status,
    sourceRecordFingerprint: sourceResolution.sourceRecordFingerprint ?? null,
    gaps: sourceResolution.gaps
  });
  if (observed.dataRevision === expectedRevision && readinessAlreadyCurrent(observed, inputFingerprint)) {
    return Object.freeze({
      status: "already_current",
      candidate: structuredClone(observed),
      result: structuredClone(currentProduction(observed)),
      externalCallsPerformed: 0,
      codexDispatchesPerformed: 0
    });
  }
  if (codexOffline) {
    assertNormalProductionCodexIndependent({
      executionMode: CODEX_OFFLINE_MODE,
      pathType: NORMAL_PRODUCTION_PATH,
      skuPackageId: skuPackage.skuPackageId,
      codexDependencies: []
    });
  }
  const idempotencyKey = `c1-keyword-planning-readiness:${candidateId}:${expectedRevision}:${inputFingerprint}`;
  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["operator"],
    action: "record_c1_keyword_planning_readiness",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    expectedRevision,
    idempotencyKey,
    inputFingerprint,
    auditEventId: `audit:${idempotencyKey}`,
    externalRequestState: "not_sent",
    serverTime: producedAt,
    mutate: ({ candidate }) => {
      if (currentEvidence(candidate)) throw new Error("C1_KEYWORD_PLANNING_EVIDENCE_ALREADY_EXISTS");
      const currentSku = candidate.lifecycleV11?.skuPackage;
      if (currentSku?.skuPackageId !== skuPackage.skuPackageId) throw new Error("C1_KEYWORD_PLANNING_SKU_DRIFT");
      const production = {
        schemaVersion: "c1-keyword-planning-production-v1",
        candidateId,
        skuPackageId: currentSku.skuPackageId,
        sourceCandidateRevision: expectedRevision,
        resultCandidateRevision: expectedRevision + 1,
        sourceSkuRevision: currentSku.dataRevision ?? null,
        resultSkuRevision: currentSku.dataRevision ?? null,
        factsVerifiedFromFrozenInputs: false,
        inputFingerprint,
        evidenceFingerprint: null,
        status: sourceResolution.status,
        gaps: structuredClone(sourceResolution.gaps),
        producedAt,
        execution: {
          producer: "selection_review_software",
          externalCallsPerformed: 0,
          aiCallsPerformed: 0,
          browserActionsPerformed: 0,
          codexDispatchesPerformed: 0,
          automaticRetries: 0,
          c2Started: false,
          dStarted: false,
          eStarted: false
        }
      };
      const next = structuredClone(candidate);
      next.lifecycleV11 = { ...structuredClone(next.lifecycleV11 || {}) };
      next.lifecycleV11.c1KeywordPlanningProductionV1 = production;
      next.updatedAt = producedAt;
      next.lastModifiedBy = "software";
      return {
        candidate: next,
        result: {
          schemaVersion: C1_KEYWORD_PLANNING_PERSISTENCE_VERSION,
          status: sourceResolution.status,
          candidateId,
          skuPackageId: currentSku.skuPackageId,
          sourceCandidateRevision: expectedRevision,
          resultCandidateRevision: expectedRevision + 1,
          productionFingerprint: digest(production),
          evidenceFingerprint: null,
          gaps: structuredClone(sourceResolution.gaps),
          sideEffects: {
            externalCallsPerformed: 0,
            aiCallsPerformed: 0,
            browserActionsPerformed: 0,
            codexDispatchesPerformed: 0,
            softwareJobsCreated: 0,
            dispatchesCreated: 0,
            c2Started: false,
            dStarted: false,
            eStarted: false
          }
        }
      };
    }
  });
}
