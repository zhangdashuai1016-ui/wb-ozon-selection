import { ozonAccountReadCoordinationState, ozonAccountReadProductionBlocker, ozonAccountReadProductionEvidenceCurrent } from './ozon-account-read-coordination.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { assertWorkerRegistryBoundary } from './worker-registry.mjs';
import { assertDExecutableRequest } from './d-executable-request-contract.mjs';
import { assertCurrentDExecutionContext } from './platform-write-preflight.mjs';
import { projectPreparedBatchImportRequests } from './ozon-seller-api-de-adapter.mjs';
import { createDBatchImportJob, applyDBatchImportEvent, reclaimDBatchImportJob,
  assertDBatchFrozenImport, D_BATCH_FROZEN_IMPORT_VERSION,
  projectDBatchFrozenMemberSource, D_BATCH_OBSERVATION_BLOCK_REASONS } from './d-batch-import-state.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { assertDPlatformObservationPolicy } from './d-platform-observation-policy.mjs';
import { OzonDEHttpTransportError } from './ozon-de-http-configuration.mjs';
import { createDBatchStockJob } from './d-batch-stock-state.mjs';
import { supportedBatchVersion, supportsPostImportBatch, assertDBatchPostImportScope } from './d-batch-production-contract.mjs';
import { assertOzonBatchImportLimitCapability, assertOzonProductImportBatchLimitUse } from './ozon-product-import-batch-limit.mjs';

export const D_BATCH_IMPORT_RUNTIME_VERSION = 'd-batch-import-runtime-v1';
const clone = value => structuredClone(value);
const terminal = new Set(['completed', 'failed', 'unknown_outcome']);

function locate(document, batchId) {
  const batches = document.runtime?.dProductionBatches;
  const jobs = document.runtime?.dBatchImportJobs ?? [];
  if (!Array.isArray(batches) || !Array.isArray(jobs)) throw new Error('D_BATCH_IMPORT_STORE_INVALID');
  const matches = batches.filter(batch => batch.batchId === batchId);
  if (matches.length !== 1) throw new Error('D_BATCH_IMPORT_BATCH_NOT_UNIQUE');
  const jobMatches = jobs.filter(job => job.batchId === batchId);
  if (jobMatches.length > 1) throw new Error('D_BATCH_IMPORT_JOB_NOT_UNIQUE');
  return { batch: matches[0], job: jobMatches[0] ?? null, jobs };
}

function assertCurrentMembers(document, batch, members) {
  if (!supportedBatchVersion(batch.schemaVersion) ||
      !Array.isArray(members) || members.length !== batch.members.length ||
      members.some((member, index) => member.request?.merchantSku !== batch.members[index].offerId ||
        member.request?.candidateId !== batch.members[index].candidateId)) {
    throw new Error('D_BATCH_IMPORT_MEMBER_SCOPE_MISMATCH');
  }
  if (supportsPostImportBatch(batch.schemaVersion)) {
    assertDBatchPostImportScope(batch.postImportScope, batch.members.map(member => member.offerId), batch.schemaVersion);
  }
  if (batch.schemaVersion === 'd-batch-production-authorization-v3') {
    assertOzonProductImportBatchLimitUse(batch.importLimitUse, { batch });
  }
  for (let index = 0; index < members.length; index++) {
    const member = members[index], saved = batch.members[index];
    const matches = document.candidates.filter(candidate => candidate.id === saved.candidateId);
    if (matches.length !== 1) throw new Error('D_BATCH_IMPORT_CANDIDATE_NOT_UNIQUE');
    const candidate = matches[0], sku = candidate.lifecycleV11?.skuPackage;
    if (candidate.dataRevision !== saved.resultRevision || sku?.skuPackageId !== saved.skuPackageId ||
        sku?.productionAuthorization?.authorizationId !== saved.authorizationId ||
        fingerprintCanonicalRecord(sku.productionAuthorization) !== saved.authorizationFingerprint ||
        !sameStoreRef(candidate.storeRef, batch.storeRef) ||
        !isDeepStrictEqual(sku.productionAuthorization, member.executionContext?.productionPlan?.sourceAuthorization) ||
        sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord ||
        member.sourceTechnicalStatus !== 'not_started' ||
        (document.runtime.softwareJobs ?? []).some(job => job.candidateId === candidate.id &&
          job.jobType === 'd_production_execution' && !terminal.has(job.status))) {
      throw new Error('D_BATCH_IMPORT_MEMBER_CHANGED_OR_SINGLE_BUSY');
    }
    assertDExecutableRequest(member.request);
    assertCurrentDExecutionContext({ request: member.request, executionContext: member.executionContext });
  }
}

function assertFrozenObservationSource(document, batch, job, chunkIndex) {
  if (!supportedBatchVersion(batch.schemaVersion) ||
      job.batchId !== batch.batchId || !Array.isArray(batch.members) || !Array.isArray(document.candidates) ||
      !Array.isArray(batch.excludedOfferIds))
    throw new Error('D_BATCH_IMPORT_OBSERVATION_SOURCE_CHANGED');
  if (supportsPostImportBatch(batch.schemaVersion)) {
    assertDBatchPostImportScope(batch.postImportScope, batch.members.map(member => member.offerId), batch.schemaVersion);
  }
  if (batch.schemaVersion === 'd-batch-production-authorization-v3') {
    assertOzonProductImportBatchLimitUse(batch.importLimitUse, { batch });
    if (!isDeepStrictEqual(job.importLimitUse, batch.importLimitUse)) throw new Error('D_BATCH_IMPORT_LIMIT_USE_SOURCE_CHANGED');
  }
  const chunk = job.chunks[chunkIndex];
  if (!chunk?.frozenImport) throw new Error('D_BATCH_IMPORT_FROZEN_SOURCE_REQUIRED');
  assertDBatchFrozenImport(chunk.frozenImport, chunk.offerIds);
  for (const source of chunk.frozenImport.memberSources) {
    const members = batch.members.filter(member => member.offerId === source.merchantSku);
    const candidates = document.candidates.filter(candidate => candidate.id === source.candidateId);
    if (members.length !== 1 || candidates.length !== 1)
      throw new Error('D_BATCH_IMPORT_OBSERVATION_SOURCE_CHANGED');
    const member = members[0], candidate = candidates[0], sku = candidate.lifecycleV11?.skuPackage;
    if (member.candidateId !== source.candidateId || member.skuPackageId !== source.skuPackageId ||
        member.authorizationId !== source.sourceAuthorizationId ||
        member.authorizationFingerprint !== source.sourceAuthorizationFingerprint ||
        candidate.dataRevision !== member.resultRevision || sku?.skuPackageId !== source.skuPackageId ||
        sku.productionAuthorization?.authorizationId !== source.sourceAuthorizationId ||
        fingerprintCanonicalRecord(sku.productionAuthorization) !== source.sourceAuthorizationFingerprint ||
        candidate.targetPlatform !== source.platform || candidate.targetStore !== source.store ||
        !sameStoreRef(candidate.storeRef, source.storeRef) || !sameStoreRef(batch.storeRef, source.storeRef) ||
        batch.excludedOfferIds.includes(source.merchantSku))
      throw new Error('D_BATCH_IMPORT_OBSERVATION_SOURCE_CHANGED');
  }
}

function assertReadyMembers(members, adapterCapabilities, preparedAt) {
  if (adapterCapabilities?.status !== 'ready') throw new Error('D_BATCH_IMPORT_CAPABILITIES_NOT_READY');
  const observationPolicy = assertDPlatformObservationPolicy(members[0]?.observationPolicy);
  if (members.some(member => !isDeepStrictEqual(member.observationPolicy, observationPolicy)) ||
      Date.parse(preparedAt) >= Date.parse(observationPolicy.expiresAt) ||
      Date.parse(observationPolicy.expiresAt) - Date.parse(preparedAt) <
        observationPolicy.maxQueries * observationPolicy.intervalMs + observationPolicy.requestTimeoutMs) {
    throw new Error('D_BATCH_IMPORT_OBSERVATION_POLICY_NOT_CURRENT');
  }
  for (const member of members) {
    const productionPlan = member.executionContext?.productionPlan;
    if (!member.platformWritePreflight || !productionPlan) throw new Error('D_BATCH_IMPORT_PREFLIGHT_REQUIRED');
    const memberCapabilities = member.adapterCapabilities ?? adapterCapabilities;
    const prepared = prepareSingleSkuDExecution({ productionPlan,
      productionAuthorization: productionPlan.sourceAuthorization,
      platformWritePreflight: member.platformWritePreflight, adapterCapabilities: memberCapabilities,
      currentProductionBinding: member.executionContext.currentProductionBinding, preparedAt });
    if (prepared.status !== 'ready' || !isDeepStrictEqual(prepared.executableRequest, member.request)) {
      const drift = prepared.executableRequest && member.request ? Object.keys(prepared.executableRequest)
        .filter(key => !isDeepStrictEqual(prepared.executableRequest[key], member.request[key])) : [];
      throw new Error(`D_BATCH_IMPORT_MEMBER_NOT_READY:${prepared.status}:${prepared.gaps.map(gap => gap.code).join(',')}:${drift.join(',')}`);
    }
  }
}

function assertWorker(workerRegistry, workerId) {
  const worker = workerRegistry.findEligible(['ozon-production-execution']).find(value => value.workerId === workerId);
  if (!worker) {
    throw new Error('D_BATCH_IMPORT_WORKER_NOT_CURRENT');
  }
  return worker;
}

function refreshWorker(workerRegistry, workerId, expectedVersion) {
  const worker = workerRegistry.get(workerId);
  const eligible = workerRegistry.findEligible(['ozon-production-execution'])
    .find(value => value.workerId === workerId);
  if (worker?.status !== 'online' || worker.version !== expectedVersion ||
      !eligible || !isDeepStrictEqual(eligible, worker)) {
    throw new Error('D_BATCH_IMPORT_WORKER_CHANGED');
  }
  workerRegistry.heartbeat({ workerId, version: worker.version, capabilities: worker.capabilities,
    status: worker.status });
}

/** Backend-only orchestration. There is deliberately no HTTP route or autonomous retry. */
export function createPersistedDBatchImportRuntime({ repository, runtimeMode = 'local_development',
  workerRegistry, serverClock, createAdapter, verifyCurrentBatchEvidence,
  leaseDurationMs = 300_000 }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (['central_test', 'central_production'].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  const workerBoundary = assertWorkerRegistryBoundary(workerRegistry);
  if (typeof workerRegistry.get !== 'function' || typeof workerRegistry.heartbeat !== 'function') {
    throw new Error('D_BATCH_IMPORT_WORKER_REGISTRY_INCOMPLETE');
  }
  if (['central_test', 'central_production'].includes(runtimeMode) && !workerBoundary.multiUserReady) {
    throw new Error('D_BATCH_IMPORT_CENTRAL_WORKER_REQUIRED');
  }
  if (typeof serverClock !== 'function' || typeof createAdapter !== 'function' ||
      typeof verifyCurrentBatchEvidence !== 'function' ||
      !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 300_000) {
    throw new Error('D_BATCH_IMPORT_RUNTIME_DEPENDENCY_INVALID');
  }
  const now = () => {
    const value = serverClock();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('D_BATCH_IMPORT_CLOCK_INVALID');
    return value;
  };
  async function admit({ batchId, members, adapterCapabilities, workerId, accountReadState }) {
    const worker = assertWorker(workerRegistry, workerId);
    const observedAt = now();
    const prepared = members.map(member => ({ ...member, executionContext: { ...member.executionContext,
      serverClock: () => observedAt } }));
    const snapshot = await repository.readSnapshot();
    const { batch, job: existingJob } = locate(snapshot, batchId);
    if (existingJob) return { job: clone(existingJob), admitted: false };
    const snapshotReads = ozonAccountReadCoordinationState({ document: snapshot, candidateIds: batch.members.map(member => member.candidateId) });
    // Legacy adapter-level callers with no account jobs have no account source to carry.
    const preparedReads = accountReadState === undefined && snapshotReads.length === 0 ? [] : accountReadState;
    if (preparedReads === undefined) throw new Error('D_BATCH_IMPORT_ACCOUNT_READ_SOURCE_REQUIRED');
    if (ozonAccountReadProductionBlocker(snapshotReads)) throw new Error('D_BATCH_IMPORT_ACCOUNT_READ_BLOCKED');
    if (!isDeepStrictEqual(snapshotReads, preparedReads)) throw new Error('D_BATCH_IMPORT_ACCOUNT_READ_CHANGED');
    assertCurrentMembers(snapshot, batch, prepared);
    assertOzonBatchImportLimitCapability(adapterCapabilities.productImport, { batch, checkedAt: observedAt });
    assertReadyMembers(prepared, adapterCapabilities, observedAt);
    const chunks = projectPreparedBatchImportRequests({ members: prepared, excludedOfferIds: batch.excludedOfferIds,
      adapterCapabilities, checkedAt: observedAt });
    const byOfferId=new Map(prepared.map(member=>[member.request.merchantSku,member.request]));
    const frozenChunks = chunks.map(chunk => {
      const items=clone(chunk.body.items);
      const memberSources=chunk.offerIds.map(offerId=>projectDBatchFrozenMemberSource(byOfferId.get(offerId)));
      return {...chunk,frozenImport:{schemaVersion:D_BATCH_FROZEN_IMPORT_VERSION,
        items,memberSources,itemFingerprint:fingerprintCanonicalRecord(items),
        contentFingerprint:fingerprintCanonicalRecord({items,memberSources})}};
    });
    const leaseId = `lease:${randomUUID()}`;
    const leaseExpiresAt = new Date(Date.parse(observedAt) + leaseDurationMs).toISOString();
    return repository.transact(document => {
      const current = locate(document, batchId);
      assertCurrentMembers(document, current.batch, prepared);
      if (current.job) return { changed: false, result: { job: clone(current.job), admitted: false } };
      if (!isDeepStrictEqual(current.batch,batch)) throw new Error('D_BATCH_IMPORT_BATCH_CHANGED_DURING_ADMISSION');
      const currentReads = ozonAccountReadCoordinationState({ document, candidateIds: current.batch.members.map(member => member.candidateId) });
      if (ozonAccountReadProductionBlocker(currentReads)) throw new Error('D_BATCH_IMPORT_ACCOUNT_READ_BLOCKED');
      if (!isDeepStrictEqual(currentReads, preparedReads)) throw new Error('D_BATCH_IMPORT_ACCOUNT_READ_CHANGED');
      if (!ozonAccountReadProductionEvidenceCurrent({ document, state: currentReads, observedAt: now() })) {
        throw new Error('D_BATCH_IMPORT_ACCOUNT_EVIDENCE_NOT_CURRENT');
      }
      const job = createDBatchImportJob({ batch: current.batch, chunks: frozenChunks, workerId,
        workerVersion: worker.version, leaseId, leaseExpiresAt, createdAt: observedAt,
        observationPolicy: prepared[0].observationPolicy });
      document.runtime.dBatchImportJobs = [...current.jobs, job];
      current.batch.status = 'import_admitted';
      return { changed: true, document, result: { job: clone(job), admitted: true } };
    });
  }
  async function checkpoint({ batchId, workerId, leaseId, event, members,
    expectedJob = null, expectedBatch = null }) {
    // Central software can record why a saved task cannot be read even when its old service no longer exists.
    const softwareObservationStop = event.kind === 'batch_observation_blocked';
    const savedWorker = softwareObservationStop ? null : workerRegistry.get(workerId);
    if (!softwareObservationStop && !savedWorker) throw new Error('D_BATCH_IMPORT_WORKER_NOT_CURRENT');
    const settlesExistingAction = ['batch_import_task_received', 'batch_import_unknown',
      'batch_import_prewrite_blocked', 'batch_observation_blocked'].includes(event.kind);
    if (!settlesExistingAction) refreshWorker(workerRegistry, workerId, savedWorker.version);
    return repository.transact(document => {
      const { batch, job, jobs } = locate(document, batchId);
      if (!job) throw new Error('D_BATCH_IMPORT_JOB_MISSING');
      if (!softwareObservationStop && job.workerVersion !== savedWorker.version)
        throw new Error('D_BATCH_IMPORT_WORKER_CHANGED');
      if (settlesExistingAction && !softwareObservationStop) {
        const currentWorker = workerRegistry.get(workerId);
        if (currentWorker?.status !== 'online' || currentWorker.version !== job.workerVersion ||
            !currentWorker.capabilities.includes('ozon-production-execution'))
          throw new Error('D_BATCH_IMPORT_WORKER_CHANGED');
      }
      if (expectedJob && (job.jobId !== expectedJob.jobId || job.batchId !== expectedJob.batchId ||
          job.workerId !== expectedJob.workerId || job.workerVersion !== expectedJob.workerVersion ||
          job.leaseId !== expectedJob.leaseId ||
          !isDeepStrictEqual(job.importLimitUse, expectedJob.importLimitUse) ||
          event.kind === 'batch_observation_blocked' && job.revision !== expectedJob.revision ||
          !isDeepStrictEqual(job.chunks[event.chunkIndex]?.frozenImport,
            expectedJob.chunks[event.chunkIndex]?.frozenImport)))
        throw new Error('D_BATCH_IMPORT_CHECKPOINT_SCOPE_CHANGED');
      if (expectedBatch && (['batchId', 'schemaVersion', 'inputFingerprint', 'ownerActorId', 'confirmedAt']
          .some(key => batch[key] !== expectedBatch[key]) || !sameStoreRef(batch.storeRef, expectedBatch.storeRef) ||
          !isDeepStrictEqual(batch.excludedOfferIds, expectedBatch.excludedOfferIds) ||
          !isDeepStrictEqual(batch.postImportScope, expectedBatch.postImportScope) ||
          !isDeepStrictEqual(batch.importLimitUse, expectedBatch.importLimitUse) ||
          batch.members.length !== expectedBatch.members.length || batch.members.some((member, index) =>
            ['candidateId', 'skuPackageId', 'offerId', 'resultRevision', 'authorizationId',
              'authorizationFingerprint'].some(key => member[key] !== expectedBatch.members[index][key]))))
        throw new Error('D_BATCH_IMPORT_CHECKPOINT_SCOPE_CHANGED');
      if (event.kind === 'batch_observation_blocked')
        assertFrozenObservationSource(document, batch, job, event.chunkIndex);
      if (event.kind === 'batch_import_intent') assertCurrentMembers(document, batch, members);
      const checkpointAt=now();
      const next = applyDBatchImportEvent({ job, event, workerId, leaseId, observedAt: checkpointAt });
      if (next === job) return { changed: false, result: clone(job) };
      jobs[jobs.indexOf(job)] = next;
      if (event.kind === 'batch_import_intent') batch.externalRequestState = 'intent_persisted';
      if (event.kind === 'batch_import_task_received') batch.externalRequestState = 'task_received';
      if (event.kind === 'batch_import_unknown') batch.externalRequestState = 'unknown_outcome';
      if (event.kind === 'batch_import_prewrite_blocked') {
        batch.externalRequestState = next.chunks.some(chunk => chunk.status === 'unknown_outcome' || chunk.status === 'intent')
          ? 'unknown_outcome' : next.chunks.some(chunk => chunk.taskId !== null) ? 'task_received' : 'not_sent';
        for (const offerId of event.offerIds) {
          const member = batch.members.find(value => value.offerId === offerId);
          if (!member) throw new Error('D_BATCH_IMPORT_PREWRITE_OFFER_MISSING');
          member.status = 'prewrite_blocked';
        }
      }
      if (event.kind === 'batch_import_observed') {
        const stockJobs=document.runtime.dBatchStockJobs ?? [];
        if(!Array.isArray(stockJobs))throw new Error('D_BATCH_STOCK_STORE_INVALID');
        for (const result of event.results) {
          const target = batch.members.find(member => member.offerId === result.offerId);
          if (!target) throw new Error('D_BATCH_IMPORT_OBSERVED_OFFER_MISSING');
          target.status = result.classification === 'imported' ? 'imported_awaiting_inventory_and_e' : result.classification;
          target.taskId = event.taskId;
          target.productId = result.importObservation?.productId ?? null;
          if(supportsPostImportBatch(batch.schemaVersion) && result.classification==='imported'){
            const existing=stockJobs.filter(entry=>entry.batchId===batchId&&entry.offerId===result.offerId);
            if(existing.length>1)throw new Error('D_BATCH_STOCK_JOB_NOT_UNIQUE');
            if(existing.length===0)stockJobs.push(createDBatchStockJob({batch,member:target,
              taskId:event.taskId,productId:result.importObservation.productId,
              workerId:job.workerId,workerVersion:job.workerVersion,leaseId:job.leaseId,
              leaseExpiresAt:job.leaseExpiresAt,leaseDurationMs,createdAt:checkpointAt,
              observationPolicy:job.observationPolicy}));
            else if(existing[0].candidateId!==target.candidateId||existing[0].productId!==result.importObservation.productId||
                existing[0].taskId!==event.taskId||existing[0].authorizationFingerprint!==target.authorizationFingerprint)
              throw new Error('D_BATCH_STOCK_JOB_SOURCE_CONFLICT');
          }
        }
        if(supportsPostImportBatch(batch.schemaVersion))document.runtime.dBatchStockJobs=stockJobs;
      }
      batch.status = next.status;
      return { changed: true, document, result: clone(next) };
    });
  }
  async function run({ batchId, members, adapterCapabilities, workerId, accountReadState }) {
    const admission = await admit({ batchId, members, adapterCapabilities, workerId, accountReadState });
    const { job } = admission;
    if (!admission.admitted && (job.workerId !== workerId || Date.parse(now()) >= Date.parse(job.leaseExpiresAt) ||
        job.chunks.some(chunk => ['intent','unknown_outcome','prewrite_blocked'].includes(chunk.status)) ||
        job.chunks.every(chunk => chunk.status !== 'not_sent'))) {
      return { status: 'idempotent_replay', executionStatus: job.status, job };
    }
    const savedBatch = locate(await repository.readSnapshot(), batchId).batch;
    const adapter = await createAdapter({ adapterCapabilities });
    if (typeof adapter?.executeBatchImport !== 'function') throw new Error('D_BATCH_IMPORT_ADAPTER_INVALID');
    const memberRequestByOffer=new Map(members.map(member=>[member.request.merchantSku,member.request]));
    for (const chunk of job.chunks.filter(value => value.status === 'not_sent')) {
      if (Date.parse(now()) >= Date.parse(job.leaseExpiresAt)) break;
      if (!chunk.frozenImport) throw new Error('D_BATCH_IMPORT_FROZEN_SOURCE_REQUIRED');
      assertDBatchFrozenImport(chunk.frozenImport, chunk.offerIds);
      await verifyCurrentBatchEvidence({ batchId, members, adapterCapabilities, chunkIndex: chunk.index });
      let intentCommitted = false;
      const persistCheckpoint = async event => {
        if (event.batchId !== batchId || event.chunkIndex !== chunk.index)
          throw new Error('D_BATCH_IMPORT_CHECKPOINT_SCOPE_CHANGED');
        const saved = await checkpoint({ batchId, workerId, leaseId: job.leaseId,
          members, expectedJob: job, expectedBatch: savedBatch, event });
        if (event.kind === 'batch_import_intent') intentCommitted = true;
        return saved;
      };
      try {
        const result = await adapter.executeBatchImport({ batchId, members,
          excludedOfferIds: savedBatch.excludedOfferIds, chunkIndex: chunk.index },
          { persistCheckpoint, beforeRequestSend: async () => {
            refreshWorker(workerRegistry, workerId, job.workerVersion);
            await verifyCurrentBatchEvidence({ batchId, members, adapterCapabilities, chunkIndex: chunk.index });
            const snapshot = await repository.readSnapshot();
            const current = locate(snapshot, batchId);
            assertCurrentMembers(snapshot, current.batch, members);
            assertOzonBatchImportLimitCapability(adapterCapabilities.productImport, { batch: current.batch, checkedAt: now() });
            if (!isDeepStrictEqual(current.job?.importLimitUse, current.batch.importLimitUse)) {
              throw new Error('D_BATCH_IMPORT_LIMIT_USE_SOURCE_CHANGED');
            }
            assertReadyMembers(members, adapterCapabilities, now());
            const currentChunk=current.job?.chunks[chunk.index];
            if (!currentChunk?.frozenImport || !isDeepStrictEqual(currentChunk.frozenImport, chunk.frozenImport) ||
                !isDeepStrictEqual(projectPreparedBatchImportRequests({members,
                  excludedOfferIds:current.batch.excludedOfferIds,adapterCapabilities,checkedAt:now()})[chunk.index]?.body.items,
                  currentChunk.frozenImport.items) ||
                !isDeepStrictEqual(currentChunk.offerIds.map(offerId => projectDBatchFrozenMemberSource(
                  memberRequestByOffer.get(offerId))),
                  currentChunk.frozenImport.memberSources))
              throw new Error('D_BATCH_IMPORT_FROZEN_SOURCE_DRIFT');
            if (current.job?.leaseId !== job.leaseId ||
                current.job.chunks[chunk.index].status !== 'intent' || Date.parse(now()) >= Date.parse(current.job.leaseExpiresAt)) {
              throw new Error('D_BATCH_IMPORT_SEND_GUARD_BLOCKED');
            }
          } });
        if (result.status === 'rejected_before_write' && result.writeOccurred === false &&
            result.requestTransmission === 'not_attempted') {
          await persistCheckpoint({ kind: 'batch_import_prewrite_blocked', batchId, chunkIndex: chunk.index,
            offerIds: chunk.offerIds, requestTransmission: result.requestTransmission,
            reasonCode: result.reasonCode });
          break;
        }
        if (result.status !== 'waiting_platform') {
          await persistCheckpoint({ kind: 'batch_import_unknown', batchId, chunkIndex: chunk.index,
            offerIds: chunk.offerIds, reason: result.reason ?? result.status });
          break;
        }
      } catch (error) {
        const current = locate(await repository.readSnapshot(), batchId).job;
        if (current?.chunks[chunk.index].status === 'intent') {
          if (!intentCommitted) return { status: 'idempotent_replay', executionStatus: current.status, job: current };
          if (error instanceof OzonDEHttpTransportError && error.externalRequestState === 'not_sent' &&
              error.requestTransmission === 'not_attempted') {
            await persistCheckpoint({ kind: 'batch_import_prewrite_blocked', batchId,
              chunkIndex: chunk.index, offerIds: chunk.offerIds,
              requestTransmission: 'not_attempted', reasonCode: error.code });
            throw error;
          }
          return { status: 'unknown_outcome', job: current, causeCode: error.code ?? error.message };
        }
        if (!intentCommitted && ['waiting_platform','observed_pending','observed_imported',
          'platform_failed','platform_skipped','unknown_outcome','observation_stopped',
          'prewrite_blocked'].includes(current?.chunks[chunk.index].status))
          return { status: 'idempotent_replay', executionStatus: current.status, job: current };
        throw error;
      }
    }
    const current = locate(await repository.readSnapshot(), batchId).job;
    return { status: current.status, job: current };
  }
  async function observe({ batchId, members, adapterCapabilities, workerId, chunkIndex }) {
    const worker = workerRegistry.get(workerId);
    if (!worker) throw new Error('D_BATCH_IMPORT_WORKER_NOT_CURRENT');
    refreshWorker(workerRegistry, workerId, worker.version);
    const snapshot = await repository.readSnapshot(), { batch, job } = locate(snapshot, batchId);
    if (!job || job.workerId !== workerId || job.workerVersion !== worker.version ||
        Date.parse(now()) >= Date.parse(job.leaseExpiresAt) ||
        !Number.isSafeInteger(chunkIndex) ||
        !['waiting_platform', 'observed_pending', 'unknown_outcome'].includes(job.chunks[chunkIndex]?.status) ||
        job.chunks[chunkIndex].taskId === null || job.chunks[chunkIndex].observationInFlight ||
        job.chunks[chunkIndex].observationReads >= job.observationPolicy.maxQueries ||
        Date.parse(now()) < Date.parse(job.chunks[chunkIndex].nextObservationAt) ||
        Date.parse(now()) >= Date.parse(job.observationPolicy.expiresAt)) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_NOT_ADMITTED');
    }
    if (!sameStoreRef(adapterCapabilities?.storeRef, batch.storeRef)) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_STORE_MISMATCH');
    }
    const chunk = job.chunks[chunkIndex];
    await checkpoint({ batchId, workerId, leaseId: job.leaseId, members,
      event: { kind: 'batch_observation_started', chunkIndex, offerIds: chunk.offerIds, taskId: chunk.taskId } });
    const controller = new AbortController();
    const remaining = Math.min(job.observationPolicy.requestTimeoutMs,
      Date.parse(job.leaseExpiresAt) - Date.parse(now()),
      Date.parse(job.observationPolicy.expiresAt) - Date.parse(now()));
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => { const error = new Error('D_BATCH_IMPORT_OBSERVATION_TIMEOUT');
        controller.abort(error); reject(error); }, Math.max(1, remaining));
    });
    try {
      const adapter = await createAdapter({ adapterCapabilities });
      const observation = await Promise.race([adapter.observeBatchImportTask({ batchId, chunkIndex,
        taskId: chunk.taskId, offerIds: chunk.offerIds }, { signal: controller.signal,
        beforeRequestSend: () => {
          refreshWorker(workerRegistry, workerId, job.workerVersion);
          if (Date.parse(now()) >= Date.parse(job.leaseExpiresAt)) throw new Error('D_BATCH_IMPORT_LEASE_EXPIRED');
        } }), timeout]);
      const saved = await checkpoint({ batchId, workerId, leaseId: job.leaseId, members,
        event: { kind: 'batch_import_observed', chunkIndex, offerIds: chunk.offerIds,
          taskId: chunk.taskId, results: observation.results } });
      return { status: saved.status, job: saved, results: observation.results };
    } catch (error) {
      const reason = error.message === 'D_BATCH_IMPORT_OBSERVATION_TIMEOUT' ? 'request_timeout' :
        error instanceof OzonDEHttpTransportError ? 'transport_failure' : 'system_failure';
      await checkpoint({ batchId, workerId, leaseId: job.leaseId, members,
        event: { kind: 'batch_observation_failed', chunkIndex, offerIds: chunk.offerIds,
          taskId: chunk.taskId, reason } });
      if (reason === 'system_failure') throw error;
      return { status: 'observation_failed', reason, job: locate(await repository.readSnapshot(), batchId).job };
    } finally { clearTimeout(timeoutId); }
  }
  async function reclaim({ batchId, workerId }) {
    const worker = assertWorker(workerRegistry, workerId);
    return repository.transact(document => {
      const { job, jobs } = locate(document, batchId);
      if (!job) throw new Error('D_BATCH_IMPORT_JOB_MISSING');
      const observedAt = now();
      const next = reclaimDBatchImportJob({ job, workerId, workerVersion: worker.version,
        leaseId: `lease:${randomUUID()}`,
        leaseExpiresAt: new Date(Date.parse(observedAt) + leaseDurationMs).toISOString(), observedAt });
      jobs[jobs.indexOf(job)] = next;
      return { changed: true, document, result: clone(next) };
    });
  }
  async function stopObservation({ batchId, workerId, chunkIndex, reason }) {
    const worker = assertWorker(workerRegistry, workerId);
    const { job } = locate(await repository.readSnapshot(), batchId);
    if (!job || job.workerId !== workerId || job.workerVersion !== worker.version ||
        !Number.isSafeInteger(chunkIndex) || !job.chunks[chunkIndex]) {
      throw new Error('D_BATCH_IMPORT_OBSERVATION_STOP_NOT_ADMITTED');
    }
    const chunk = job.chunks[chunkIndex];
    return checkpoint({ batchId, workerId, leaseId: job.leaseId, members: [],
      event: { kind: 'batch_observation_stopped', chunkIndex, offerIds: chunk.offerIds,
        taskId: chunk.taskId, reason } });
  }
  async function blockObservation({ batchId, chunkIndex, reason, expectedSource, expectedBatch }) {
    if (typeof batchId !== 'string' || batchId.trim() === '' ||
        !D_BATCH_OBSERVATION_BLOCK_REASONS.includes(reason) ||
        !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 ||
        expectedSource?.batchId !== batchId || !Number.isSafeInteger(expectedSource.revision) ||
        expectedSource.revision < 1 ||
        !Array.isArray(expectedSource.chunks) || !expectedSource.chunks[chunkIndex] ||
        expectedBatch?.batchId !== batchId || !Array.isArray(expectedBatch.members) ||
        !Array.isArray(expectedBatch.excludedOfferIds))
      throw new Error('D_BATCH_IMPORT_OBSERVATION_BLOCK_NOT_ADMITTED');
    const { job } = locate(await repository.readSnapshot(), batchId);
    const sourceChunk = expectedSource.chunks[chunkIndex];
    const chunk = job?.chunks[chunkIndex];
    if (!job || job.jobId !== expectedSource.jobId || job.revision !== expectedSource.revision ||
        job.workerId !== expectedSource.workerId || job.workerVersion !== expectedSource.workerVersion ||
        job.leaseId !== expectedSource.leaseId || chunk?.taskId !== sourceChunk.taskId ||
        !isDeepStrictEqual(chunk?.offerIds, sourceChunk.offerIds) ||
        !isDeepStrictEqual(chunk?.frozenImport, sourceChunk.frozenImport))
      throw new Error('D_BATCH_IMPORT_CHECKPOINT_SCOPE_CHANGED');
    if (!chunk || !['waiting_platform', 'observed_pending', 'unknown_outcome', 'observation_stopped']
      .includes(chunk.status) || typeof chunk.taskId !== 'string' || !/^[1-9][0-9]*$/.test(chunk.taskId) ||
      !Number.isSafeInteger(Number(chunk.taskId)) || chunk.observationInFlight)
      throw new Error('D_BATCH_IMPORT_OBSERVATION_BLOCK_NOT_ADMITTED');
    return checkpoint({ batchId, workerId: job.workerId, leaseId: job.leaseId, members: [],
      expectedJob: expectedSource, expectedBatch,
      event: { kind: 'batch_observation_blocked', chunkIndex, offerIds: chunk.offerIds,
        taskId: chunk.taskId, reason } });
  }
  return Object.freeze({ schemaVersion: D_BATCH_IMPORT_RUNTIME_VERSION, run, observe, reclaim,
    stopObservation, blockObservation });
}
