import { createC1PaidFormalFixture, c1DraftPaidReceipt } from "./c1-draft-source-fixture.mjs";
import { createSoftwareJobEnvelope, createSoftwareJobResultEnvelope, C1_AI_DRAFT_JOB_TYPE, C1_AI_DRAFT_CAPABILITY } from "../../lib/software-job-contract.mjs";
import { createWorkerDescriptor } from "../../lib/runtime-identity.mjs";
import { CREATED_AT } from "./c1-ai-draft-fixture.mjs";

export function c1AiSoftwareJobFixture({ sourceCandidateRevision, candidateId, supplierSkuId, storeRef, formalDraftFixture = null,
  jobId = "software-job:c1-draft:1", authorizationId = "authorization:c1-ai-draft:fixture-one",
  credentialAlias = "gateway-alias:fixture-one" } = {}) {
  sourceCandidateRevision ??= formalDraftFixture?.candidate.dataRevision ?? 11;
  // An explicitly supplied legacy formal fixture represents historical occupancy only, never a new paid permission.
  const formal = formalDraftFixture ?? createC1PaidFormalFixture({ at: CREATED_AT, candidateRevision: sourceCandidateRevision,
    candidateId: candidateId ?? 'GENERIC-SINK-001', supplierSkuId: supplierSkuId ?? 'SINK-BLUE',
    variantKey: '颜色:蓝色', productName: '水槽收纳架', categoryName: 'Органайзер для раковины', material: 'silicone',
    ...(storeRef ? { storeRef } : {}), credentialAlias, softwareJobId: jobId, authorizationId });
  const skuPackage = formal.candidate.lifecycleV11.skuPackage;
  const request = formal.request;
  const at = formal.at;
  const identity = request.sourceIdentity;
  const candidate = { id: identity.candidateId, dataRevision: sourceCandidateRevision + 1, targetStore: identity.storeRef.stableStoreId,
    storeRef: structuredClone(identity.storeRef), lifecycleV11: { ...structuredClone(formal.candidate.lifecycleV11), skuPackage } };
  const scopeBinding = {
    schemaVersion: "software-job-scope-v1", candidateId: candidate.id, skuPackageId: skuPackage.skuPackageId,
    sourceRevision: sourceCandidateRevision, resultRevision: candidate.dataRevision, sourceSkuRevision: request.sourceSkuRevision,
    identity: structuredClone(identity), variantKey: request.identity.variantKey, sideEffectScope: C1_AI_DRAFT_JOB_TYPE,
    authorizationRef: authorizationId, credentialAlias, inputFingerprint: request.requestFingerprint,
    requestFingerprint: request.requestFingerprint, provider: request.provider
  };
  const job = createSoftwareJobEnvelope({ jobId, candidateId: candidate.id, skuPackageId: skuPackage.skuPackageId,
    revision: candidate.dataRevision, jobType: C1_AI_DRAFT_JOB_TYPE, createdAt: at,
    requestedByUserId: "owner-1", ownerUserId: "owner-1", requiredCapabilities: [C1_AI_DRAFT_CAPABILITY],
    idempotencyKey: `c1-draft:${jobId}:${sourceCandidateRevision}`, scopeBinding });

  const authorizationRecord = {
    schemaVersion: "software-job-authorization-record-v1", authorizationId, authorizationType: "paid_ai_draft",
    status: "active", action: C1_AI_DRAFT_JOB_TYPE, scopeBinding: structuredClone(job.scopeBinding), authorizedByUserId: "owner-1",
    authorizedAt: at, expiresAt: null, maxUses: 1, useCount: 0, consumedByJobId: null, consumedAt: null
  };
  const credentialBinding = {
    schemaVersion: "software-job-credential-binding-v1", bindingId: `binding:${jobId}`, credentialAlias,
    status: "active", provider: request.provider, sideEffectScope: C1_AI_DRAFT_JOB_TYPE,
    scopeBinding: structuredClone(job.scopeBinding), allowedWorkerIds: ["worker-c1-draft"],
    redaction: "credential_alias_only", boundAt: at, expiresAt: null
  };
  const worker = createWorkerDescriptor({ workerId: "worker-c1-draft", capabilities: [C1_AI_DRAFT_CAPABILITY], version: "1", observedAt: at });
  const document = { candidates: [candidate], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [authorizationRecord], softwareJobCredentialBindings: [credentialBinding] } };
  return { at, candidate, request, job, worker, authorizationRecord, credentialBinding, document };
}

export function c1AiSoftwareJobResultEnvelope(job, request, receiptOverrides = {}) {
  const result = { ...c1DraftPaidReceipt({ request, authorizedExecution: { jobId: job.jobId } }, "2026-08-22T02:01:00.000Z"),
    completedAt: "2026-08-22T02:01:01.000Z", ...receiptOverrides };
  return createSoftwareJobResultEnvelope({ job, resultRef: result.receiptId, payloadKind: C1_AI_DRAFT_JOB_TYPE,
    payload: { schemaVersion: "c1-ai-draft-software-result-v1", request, receipt: result }, recordedAt: result.completedAt });
}
