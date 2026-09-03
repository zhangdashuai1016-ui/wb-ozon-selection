import {
  executeBusinessMutation,
  executeSoftwareJobSettlementMutation
} from "./business-mutation-transaction.mjs";
import {
  stageC2StableAssetTransport
} from "./c2-asset-lifecycle.mjs";
import {
  assertNoProductionSecrets,
  assertNoRawPersistenceKeys,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import {
  assertBoundedResultEnvelopeStructure,
  isReservedSoftwareJobHost
} from "./software-job-contract.mjs";

export const C2_STABLE_ASSET_TRANSPORT_JOB_TYPE = "c2_stable_asset_transport";
export const C2_STABLE_ASSET_TRANSPORT_CAPABILITY = "stable-asset-transport";

function candidateSkuPackage(candidate) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!skuPackage || typeof skuPackage !== "object" || Array.isArray(skuPackage)) {
    throw new Error("C2_STABLE_TRANSPORT_CANDIDATE_INVALID");
  }
  return skuPackage;
}

function findCandidate(document, candidateId) {
  if (!Array.isArray(document?.candidates)) throw new Error("C2_STABLE_TRANSPORT_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new Error("C2_STABLE_TRANSPORT_CANDIDATE_NOT_FOUND");
  return candidate;
}

function normalizeHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 16) {
    throw new Error("C2_STABLE_TRANSPORT_ALLOWED_HOSTS_INVALID");
  }
  const normalized = [...new Set(hosts.map((host) => String(host).trim().toLowerCase()))].sort();
  if (normalized.length !== hosts.length || normalized.some((host) =>
    !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) || isReservedSoftwareJobHost(host))) {
    throw new Error("C2_STABLE_TRANSPORT_ALLOWED_HOSTS_INVALID");
  }
  return normalized;
}

function assertBoundedTransportInput(value, path) {
  assertNoRawPersistenceKeys(value, path, { errorCode: "C2_STABLE_TRANSPORT_INPUT_REJECTED" });
  assertNoProductionSecrets(value, path);
  return value;
}

function stableJobRef({ jobId, candidateId, skuPackageId, sourceRevision, resultRevision, inputFingerprint }) {
  return Object.freeze({
    schemaVersion: "c2-stable-asset-transport-job-ref-v1",
    jobId,
    jobType: C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
    candidateId,
    skuPackageId,
    sourceRevision,
    resultRevision,
    inputFingerprint
  });
}

function stableScope({ skuPackage, sourceRevision, resultRevision, transportAuthorizationRef, credentialAlias,
  inputFingerprint, stagedAssetManifestFingerprint, ownerStagingConfirmationRef, allowedStableAssetHosts }) {
  return {
    schemaVersion: "software-job-scope-v1",
    candidateId: skuPackage.g1Identity.candidateId,
    skuPackageId: skuPackage.skuPackageId,
    sourceRevision,
    resultRevision,
    platform: skuPackage.g1Identity.platform,
    storeRef: structuredClone(skuPackage.g1Identity.storeRef),
    supplierSkuId: skuPackage.g1Identity.supplierSkuId,
    variantKey: skuPackage.variantKey,
    sideEffectScope: "c2_stable_asset_transport",
    authorizationRef: transportAuthorizationRef,
    credentialAlias,
    inputFingerprint,
    stagedAssetManifestFingerprint,
    ownerStagingConfirmationRef,
    allowedStableAssetHosts
  };
}

export async function enqueueC2StableAssetTransport({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedCandidateRevision,
  stagedAssets,
  ownerVideoRequirement = null,
  ownerStagingConfirmation,
  transportAuthorizationRef,
  credentialAlias,
  allowedStableAssetHosts,
  serverTime,
  serverClock
}) {
  assertBoundedTransportInput({
    stagedAssets,
    ownerVideoRequirement,
    ownerStagingConfirmation,
    transportAuthorizationRef,
    credentialAlias,
    allowedStableAssetHosts
  }, "c2StableAssetTransport.enqueueInput");
  const snapshot = await repository.readSnapshot();
  const candidate = findCandidate(snapshot, candidateId);
  const skuPackage = candidateSkuPackage(candidate);
  if (actor?.actorType !== "human" || !actor.roles?.includes("owner") ||
      actor.userId !== ownerStagingConfirmation?.confirmedByUserId) {
    throw new Error("C2_STABLE_TRANSPORT_OWNER_AUTHORIZATION_REQUIRED");
  }
  if (skuPackage.g1Identity?.candidateId !== candidateId || skuPackage.g1Identity?.skuPackageId !== skuPackage.skuPackageId) {
    throw new Error("C2_STABLE_TRANSPORT_REVISION_OR_IDENTITY_CONFLICT");
  }
  const hosts = normalizeHosts(allowedStableAssetHosts);
  const inputFingerprint = fingerprintCanonicalRecord({
    schemaVersion: "c2-stable-asset-transport-enqueue-input-v1",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    sourceRevision: expectedCandidateRevision,
    stagedAssets,
    ownerVideoRequirement,
    ownerStagingConfirmation,
    transportAuthorizationRef,
    credentialAlias,
    allowedStableAssetHosts: hosts
  });
  const resultRevision = expectedCandidateRevision + 1;
  const jobId = `software-job:c2-stable-asset-transport:${inputFingerprint}`;
  const idempotencyKey = `c2-stable-asset-transport:${inputFingerprint}`;
  const jobRef = stableJobRef({
    jobId,
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    sourceRevision: expectedCandidateRevision,
    resultRevision,
    inputFingerprint
  });
  const existingJobRef = skuPackage.c2FinalAssets?.stableAssetTransport?.jobRef;
  const isReplayCandidate = Number(candidate.dataRevision) === resultRevision && existingJobRef?.jobId === jobId &&
    existingJobRef.inputFingerprint === inputFingerprint;
  if (Number(candidate.dataRevision) !== expectedCandidateRevision && !isReplayCandidate) {
    throw new Error("C2_STABLE_TRANSPORT_REVISION_OR_IDENTITY_CONFLICT");
  }
  const jobInput = {
    jobId,
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    revision: resultRevision,
    jobType: C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
    requestedByUserId: actor.userId,
    ownerUserId: ownerStagingConfirmation?.confirmedByUserId,
    requiredCapabilities: [C2_STABLE_ASSET_TRANSPORT_CAPABILITY],
    idempotencyKey,
    scopeBinding: stableScope({
      skuPackage,
      sourceRevision: expectedCandidateRevision,
      resultRevision,
      transportAuthorizationRef,
      credentialAlias,
      inputFingerprint,
      stagedAssetManifestFingerprint: ownerStagingConfirmation?.approvedStagedAssetManifestFingerprint,
      ownerStagingConfirmationRef: ownerStagingConfirmation?.confirmationRef,
      allowedStableAssetHosts: hosts
    })
  };
  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["owner"],
    action: "enqueue_c2_stable_asset_transport",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    expectedRevision: expectedCandidateRevision,
    idempotencyKey,
    inputFingerprint,
    auditEventId: `audit:${jobId}:enqueue`,
    authorizationRef: transportAuthorizationRef,
    serverTime,
    serverClock,
    softwareJobEffect: {
      schemaVersion: "business-mutation-effect-v1",
      kind: "software_job",
      operation: "enqueue",
      jobInput
    },
    mutate: ({ candidate: current, observedAt }) => {
      const currentSkuPackage = candidateSkuPackage(current);
      const staged = stageC2StableAssetTransport({
        skuPackage: currentSkuPackage,
        stagedAssets,
        ownerVideoRequirement,
        ownerStagingConfirmation,
        jobRef,
        stagedAt: observedAt
      });
      current.lifecycleV11.skuPackage = structuredClone(staged.skuPackage);
      return {
        candidate: current,
        result: {
          schemaVersion: "c2-stable-asset-transport-enqueue-result-v1",
          status: "queued",
          jobRef,
          stagedAssetManifestFingerprint: staged.c2AssetLifecycle.stableAssetTransport.stagedAssetManifestFingerprint,
          productionAuthorizationCreated: false,
          dHandoffCreated: false,
          productionPlanCreated: false,
          executionIntentCreated: false,
          externalRequests: 0,
          platformWrites: 0
        }
      };
    }
  });
}

export async function settleC2StableAssetTransportJob({
  repository,
  runtimeMode,
  actor,
  candidateId,
  jobId,
  workerId,
  leaseId,
  status,
  externalRequestState,
  resultRef = null,
  failureClass = null,
  externalRequestRef = null,
  transportResultEnvelope = null,
  serverTime,
  serverClock
}) {
  if (transportResultEnvelope !== null) {
    assertBoundedResultEnvelopeStructure(transportResultEnvelope, "c2StableAssetTransport.transportResultEnvelope");
  }
  assertBoundedTransportInput({
    candidateId,
    jobId,
    workerId,
    leaseId,
    status,
    externalRequestState,
    resultRef,
    failureClass,
    externalRequestRef,
    transportResultEnvelope
  }, "c2StableAssetTransport.settlementInput");
  const snapshot = await repository.readSnapshot();
  const candidate = findCandidate(snapshot, candidateId);
  const skuPackage = candidateSkuPackage(candidate);
  const transport = skuPackage.c2FinalAssets?.stableAssetTransport;
  const jobRef = transport?.jobRef;
  if (!jobRef || jobRef.jobId !== jobId || !["awaiting_verified_result", "verified"].includes(transport.status)) {
    throw new Error("C2_STABLE_TRANSPORT_HALF_STATE_REJECTED");
  }
  if (status === "completed" && !transportResultEnvelope) throw new Error("C2_STABLE_TRANSPORT_RESULT_REQUIRED");
  if (status !== "completed" && transportResultEnvelope !== null) throw new Error("C2_STABLE_TRANSPORT_RESULT_FORBIDDEN");
  const inputFingerprint = fingerprintCanonicalRecord({
    schemaVersion: "c2-stable-asset-transport-settlement-input-v1",
    jobRef,
    workerId,
    leaseId,
    status,
    externalRequestState,
    resultRef,
    failureClass,
    externalRequestRef,
    transportResultEnvelope
  });
  const idempotencyKey = `c2-stable-asset-transport-settle:${jobId}:${inputFingerprint}`;
  const jobRecord = snapshot.runtime?.softwareJobs?.find((job) => job.jobId === jobId);
  const allowedStableAssetHosts = jobRecord?.scopeBinding?.allowedStableAssetHosts;
  if (!allowedStableAssetHosts) throw new Error("C2_STABLE_TRANSPORT_HALF_STATE_REJECTED");
  if (actor?.actorType !== "worker" || actor.userId !== workerId) throw new Error("C2_STABLE_TRANSPORT_WORKER_IDENTITY_REQUIRED");

  const existingSettlementReplay = snapshot.runtime?.idempotencyRecords?.some((entry) =>
    entry?.idempotencyKey === idempotencyKey &&
    entry.inputFingerprint === inputFingerprint &&
    entry.candidateId === candidateId &&
    entry.action === "settle_c2_stable_asset_transport"
  );
  if (status === "completed" && !existingSettlementReplay) {
    if (jobRecord.status !== "waiting_platform" || jobRecord.externalRequestState !== "in_flight") {
      throw new Error("C2_STABLE_TRANSPORT_RESULT_REJECTED: 必须从已持久化in_flight收口");
    }
  }

  return executeSoftwareJobSettlementMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["operator"],
    action: "settle_c2_stable_asset_transport",
    candidateId,
    skuPackageId: jobRef.skuPackageId,
    expectedRevision: jobRef.resultRevision,
    idempotencyKey,
    inputFingerprint,
    auditEventId: `audit:${jobId}:settle:${inputFingerprint}`,
    authorizationRef: jobRecord.scopeBinding.authorizationRef,
    serverTime,
    serverClock,
    settlement: {
      jobId,
      workerId,
      leaseId,
      status,
      externalRequestState,
      resultRef,
      resultEnvelope: transportResultEnvelope,
      failureClass,
      externalRequestRef
    },
    expectedJobScopeBinding: structuredClone(jobRecord.scopeBinding)
  });
}
