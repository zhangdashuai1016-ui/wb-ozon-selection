import { isDeepStrictEqual } from "node:util";
import { dProductionJobIdForRound, dProductionJobRound } from "./production-contract-primitives.mjs";
import { isProductionExecutionBinding } from "./production-authorization-preparation.mjs";
import { sameStoreRef } from "./store-binding.mjs";

export const PRODUCTION_AUTHORIZATION_ROLLBACK_ARCHIVE_VERSION = "production-authorization-rollback-archive-v1";
export const PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD = "productionAuthorizationRollbackArchiveV1";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => text(value) && Number.isFinite(Date.parse(value));
const fingerprint = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const D_JOB_TYPE = "d_production_execution";
const UNSENT_EVIDENCE = Object.freeze({
  lifecyclePlatformWrites: 0,
  authorizationPlatformWrites: 0,
  authorizationExternalRequests: 0,
  assetTransportIntentAssetCount: 0,
  assetTransportExternalRequestRef: null,
  assetTransportTransportResult: null,
  productionRecord: null,
  externalListingRecord: null,
  eVerificationRecord: null,
  readbackHistoryLength: 0
});

function archivedTransportIsUnsent(transport) {
  if (transport === null) return true;
  if (!object(transport) || (transport.externalRequestRef !== null && transport.externalRequestRef !== undefined) ||
      (transport.transportResult !== null && transport.transportResult !== undefined)) return false;
  const intent = transport.intent;
  return intent === null || intent === undefined ||
    (object(intent) && Array.isArray(intent.assets) && intent.assets.length === 0);
}

function archiveSourceMatches(candidate, archive) {
  const sku = candidate.lifecycleV11.skuPackage;
  if (!object(archive) || archive.schemaVersion !== PRODUCTION_AUTHORIZATION_ROLLBACK_ARCHIVE_VERSION ||
      archive.reason !== "d_rounds_failed_before_any_external_request" ||
      !timestamp(archive.archivedAt) || !text(archive.archivedByActorId) ||
      !revision(archive.supersededAuthorizationRound) || archive.supersededAuthorizationRound < 1 ||
      archive.resultAuthorizationRound !== archive.supersededAuthorizationRound + 1 ||
      !revision(sku.productionAuthorizationRoundV1) || sku.productionAuthorizationRoundV1 < archive.resultAuthorizationRound ||
      archive.archiveId !== `pa-rollback:${sku.skuPackageId}:${archive.resultAuthorizationRound}` ||
      archive.platformWrites !== 0 || archive.externalRequests !== 0 || archive.productionAuthorizationCreated !== false ||
      !isDeepStrictEqual(archive.evidence, UNSENT_EVIDENCE) || !archivedTransportIsUnsent(archive.dAssetTransport)) return false;

  const authorization = archive.productionAuthorizationRef;
  if (!object(authorization) || !text(authorization.authorizationId) || !fingerprint(authorization.recordFingerprint) ||
      sku.productionAuthorization?.authorizationId === authorization.authorizationId ||
      ![authorization.authorizedDataRevision, authorization.resultDataRevision,
        authorization.sourceCandidateRevision, authorization.resultCandidateRevision,
        archive.sourceCandidateRevision, archive.sourceSkuRevision, archive.restoredSkuRevision].every(revision) ||
      authorization.resultDataRevision !== authorization.authorizedDataRevision + 1 ||
      authorization.resultCandidateRevision !== authorization.sourceCandidateRevision + 1 ||
      archive.restoredSkuRevision !== authorization.authorizedDataRevision ||
      archive.sourceSkuRevision < authorization.resultDataRevision ||
      archive.sourceCandidateRevision < authorization.resultCandidateRevision ||
      candidate.dataRevision <= archive.sourceCandidateRevision || sku.dataRevision < archive.restoredSkuRevision) return false;

  const handoff = archive.dHandoff;
  if (!object(handoff) || handoff.schemaVersion !== "c2-d-handoff-v2" || handoff.status !== "software_job_queued" ||
      handoff.candidateId !== candidate.id || handoff.skuPackageId !== sku.skuPackageId ||
      !object(handoff.identity) ||
      handoff.variantKey !== sku.variantKey || handoff.productionAuthorizationId !== authorization.authorizationId ||
      handoff.handoffId !== `d-handoff:${authorization.authorizationId}` ||
      handoff.ownerDecisionId !== authorization.ownerDecisionId ||
      handoff.sourceCandidateRevision !== authorization.sourceCandidateRevision ||
      handoff.resultCandidateRevision !== authorization.resultCandidateRevision ||
      handoff.sourceSkuRevision !== authorization.authorizedDataRevision ||
      handoff.resultSkuRevision !== authorization.resultDataRevision ||
      handoff.uniqueOwner !== "d_software" || handoff.softwareJobCreated !== true ||
      handoff.productionPlanCreated !== false || handoff.executionIntentCreated !== false ||
      handoff.dWritePermissionGranted !== false || handoff.externalRequests !== 0 || handoff.platformWrites !== 0) return false;
  const firstJobId = dProductionJobIdForRound(authorization.recordFingerprint, 1);
  const firstJobRef = { jobId: firstJobId, jobType: D_JOB_TYPE, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    sourceRevision: authorization.sourceCandidateRevision, resultRevision: authorization.resultCandidateRevision,
    inputFingerprint: authorization.recordFingerprint };
  if (!isDeepStrictEqual(handoff.softwareJobRef, firstJobRef) ||
      !Array.isArray(archive.dProductionJobIds) || archive.dProductionJobIds.length === 0 ||
      new Set(archive.dProductionJobIds).size !== archive.dProductionJobIds.length ||
      !archive.dProductionJobIds.includes(firstJobId) ||
      archive.dProductionJobIds.some(id => dProductionJobRound(id, authorization.recordFingerprint) === null)) return false;

  const history = sku.audit?.history;
  if (!Array.isArray(history)) return false;
  const events = history.filter(event => object(event) &&
    event.event === "production_authorization_rolled_back_to_pre_signature" && event.archiveId === archive.archiveId);
  if (events.length !== 1) return false;
  const event = events[0];
  return event.at === archive.archivedAt && event.archivedAuthorizationId === authorization.authorizationId &&
    event.sourceRevision === archive.sourceSkuRevision && event.resultRevision === archive.restoredSkuRevision &&
    event.resultAuthorizationRound === archive.resultAuthorizationRound &&
    event.externalRequests === 0 && event.platformWrites === 0 &&
    event.productionAuthorizationCreated === false && event.dHandoffCreated === false;
}

function archivedJobMatches(candidate, archive, job) {
  const sku = candidate.lifecycleV11.skuPackage, authorization = archive.productionAuthorizationRef;
  if (!object(job) || job.schemaVersion !== "software-job-v1" || job.jobType !== D_JOB_TYPE ||
      job.candidateId !== candidate.id || job.skuPackageId !== sku.skuPackageId ||
      job.status !== "failed" || job.externalRequestState !== "not_sent" ||
      job.externalRequestRef !== null || job.resultRef !== null || job.resultEnvelope !== null) return false;
  const scope = job.scopeBinding;
  const ownerDecision = archive.confirmationCard?.ownerDecision;
  if (!object(scope) || !object(scope.identity) ||
      ![scope.merchantSku, scope.warehouseRef, scope.credentialAlias].every(text) ||
      !object(ownerDecision) || ownerDecision.decisionId !== authorization.ownerDecisionId) return false;
  const authorizedIdentity = { ...scope.identity, merchantSku: scope.merchantSku,
    warehouseRef: scope.warehouseRef, credentialAlias: scope.credentialAlias };
  return scope.schemaVersion === "software-job-scope-v1" && scope.sideEffectScope === D_JOB_TYPE &&
    scope.candidateId === candidate.id && scope.skuPackageId === sku.skuPackageId &&
    scope.authorizationRef === authorization.authorizationId &&
    scope.authorizationFingerprint === authorization.recordFingerprint && scope.inputFingerprint === authorization.recordFingerprint &&
    scope.sourceRevision === authorization.sourceCandidateRevision && scope.resultRevision === authorization.resultCandidateRevision &&
    scope.sourceSkuRevision === authorization.authorizedDataRevision && scope.resultSkuRevision === authorization.resultDataRevision &&
    job.revision === scope.resultRevision && isDeepStrictEqual(scope.identity, sku.g1Identity) &&
    isDeepStrictEqual(authorizedIdentity, archive.dHandoff.identity) &&
    scope.variantKey === archive.dHandoff.variantKey && isProductionExecutionBinding(scope.productionBinding) &&
    isDeepStrictEqual(scope.productionBinding, ownerDecision.executionBinding);
}

/**
 * Classify saved rollback history without changing jobs or re-running rollback.
 * Invalid or missing archive members are explicit conflicts, never an empty history.
 * Failed jobs may retain their settled worker/lease/attempt fields; only the saved
 * no-send proof and exact archived source let them leave the current D occupancy set.
 */
export function classifyArchivedDProductionJobs({ candidate, jobs }) {
  const invalid = () => ({ valid: false, archivedJobIds: null });
  if (!object(candidate) || !object(candidate.lifecycleV11) ||
      !object(candidate.lifecycleV11.skuPackage) || !Array.isArray(jobs)) return invalid();
  const archivedJobIds = new Set();
  if (!Object.hasOwn(candidate.lifecycleV11, PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD)) {
    return { valid: true, archivedJobIds };
  }
  const archives = candidate.lifecycleV11[PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD];
  if (!Array.isArray(archives)) return invalid();
  if (archives.length === 0) return { valid: true, archivedJobIds };
  const sku = candidate.lifecycleV11.skuPackage;
  if (!text(candidate.id) || !text(sku.skuPackageId) ||
      !revision(candidate.dataRevision) || !revision(sku.dataRevision) ||
      !object(sku.g1Identity) || sku.g1Identity.candidateId !== candidate.id ||
      sku.g1Identity.skuPackageId !== sku.skuPackageId || sku.g1Identity.platform !== sku.targetPlatform ||
      candidate.targetPlatform !== sku.targetPlatform || candidate.targetStore !== sku.targetStore ||
      sku.g1Identity.storeRef?.stableStoreId !== sku.targetStore ||
      !sameStoreRef(candidate.storeRef, sku.g1Identity.storeRef)) return invalid();
  const jobsById = new Map();
  for (const job of jobs) {
    if (!object(job) || !text(job.jobId)) return invalid();
    const matches = jobsById.get(job.jobId);
    if (matches) matches.push(job);
    else jobsById.set(job.jobId, [job]);
  }
  const archiveIds = new Set(), authorizationIds = new Set();
  for (const archive of archives) {
    if (!archiveSourceMatches(candidate, archive) || archiveIds.has(archive.archiveId) ||
        authorizationIds.has(archive.productionAuthorizationRef.authorizationId)) return invalid();
    archiveIds.add(archive.archiveId);
    authorizationIds.add(archive.productionAuthorizationRef.authorizationId);
    for (const jobId of archive.dProductionJobIds) {
      const matches = jobsById.get(jobId);
      if (!matches || matches.length !== 1 || archivedJobIds.has(jobId) ||
          !archivedJobMatches(candidate, archive, matches[0])) return invalid();
      archivedJobIds.add(jobId);
    }
  }
  return { valid: true, archivedJobIds };
}
