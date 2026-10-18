import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { assertWorkerRegistryBoundary } from './worker-registry.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import {supportedBatchVersion,supportsPostImportBatch,assertDBatchPostImportScope} from './d-batch-production-contract.mjs';
import {assertOzonProductImportBatchLimitUse} from './ozon-product-import-batch-limit.mjs';
import { resolveRegisteredC2FinalAsset } from './c2-upload-draft.mjs';
import { assertCurrentProductionExecutionBinding, runPlatformWritePreflight } from './platform-write-preflight.mjs';
import { createProductionPlan } from './production-plan.mjs';
import { createPersistableAliyunOssAssetIntent, markAliyunOssAssetIntentPersisted,
  executeAliyunOssAssetIntent, settleAliyunOssAssetState, verifiedAliyunOssAssetTransport,
  assertPersistedAliyunOssAssetIntent } from './aliyun-oss-d-asset-integration.mjs';
import { AliyunOssLocalPreparationError, OSS_LOCAL_PREPARATION_FAILURE_CODES,
  productionExecutionPrewriteFailure } from './production-execution-failure.mjs';

const VERSION = 'd-batch-asset-transport-v1';
const LEASE_EXPIRY_VERSION = 'd-batch-asset-lease-expiry-v1';
const MAX_BATCH_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const BLOCKED_BATCH_CODES = new Set([
  'D_BATCH_ASSET_WORKER_NOT_CURRENT', 'D_BATCH_ASSET_MIXED_SOURCE_UNSUPPORTED',
  'D_BATCH_ASSET_LOCAL_BATCH_TOO_LARGE', 'D_BATCH_ASSET_ACCOUNT_EVIDENCE_NOT_READY',
  'D_BATCH_ASSET_EXECUTION_ALREADY_STARTED', 'D_BATCH_ASSET_SEND_GUARD_BLOCKED'
]);
const BLOCKED_PREWRITE_CODES = new Set([
  'PRODUCTION_EXECUTION_BINDING_REQUIRED', 'PRODUCTION_EXECUTION_BINDING_DRIFT',
  'PRODUCTION_EXECUTION_BINDING_UNVERIFIED', 'PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED',
  'C1_SKU_RIGHTS_REVIEW_REQUIRED', 'C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID', 'C1_SKU_RIGHTS_REVIEW_EXPIRED',
  'C1_SKU_RIGHTS_REVIEW_BLOCKED', 'C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED', 'C1_SKU_RIGHTS_REVIEW_UNKNOWN'
]);
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

export class DBatchAssetTransportError extends Error {
  constructor(code) {
    super(`D_BATCH_ASSET_${code}`);
    this.name = 'DBatchAssetTransportError';
    this.code = this.message;
  }
}
const fail = code => { throw new DBatchAssetTransportError(code); };

// Only actionable gaps are business stops. Corrupt persistence and contradictory identities propagate.
function preparationBlockCode(error) {
  if (error instanceof DBatchAssetTransportError && BLOCKED_BATCH_CODES.has(error.code)) return error.code;
  if (error instanceof AliyunOssLocalPreparationError && OSS_LOCAL_PREPARATION_FAILURE_CODES.includes(error.code)) return error.code;
  const failure = productionExecutionPrewriteFailure(error);
  return failure !== null && BLOCKED_PREWRITE_CODES.has(failure.code) ? failure.code : null;
}

function batchIn(document, batchId) {
  const batches = document.runtime?.dProductionBatches?.filter(value => value.batchId === batchId);
  if (batches?.length !== 1 || !supportedBatchVersion(batches[0].schemaVersion)) fail('BATCH_NOT_UNIQUE');
  const batch = batches[0];
  if (!Array.isArray(batch.members) || batch.members.length === 0 || batch.members.length > 100 ||
      new Set(batch.members.map(member => member.candidateId)).size !== batch.members.length ||
      new Set(batch.members.map(member => member.offerId)).size !== batch.members.length) fail('BATCH_SCOPE_INVALID');
  return batch;
}

function sourceIn(document, batchId, candidateId) {
  const batch = batchIn(document, batchId);
  const members = batch.members.filter(member => member.candidateId === candidateId);
  const candidates = document.candidates.filter(candidate => candidate.id === candidateId);
  if (members.length !== 1 || candidates.length !== 1) fail('MEMBER_NOT_UNIQUE');
  const member = members[0], candidate = candidates[0], sku = candidate.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  if (candidate.dataRevision !== member.resultRevision || sku?.skuPackageId !== member.skuPackageId ||
      authorization?.authorizationId !== member.authorizationId ||
      fingerprintCanonicalRecord(authorization) !== member.authorizationFingerprint ||
      authorization.lockedScope.merchantSku !== member.offerId || candidate.targetPlatform !== 'ozon' ||
      !sameStoreRef(candidate.storeRef, batch.storeRef) ||
      !sameStoreRef(authorization.lockedScope.storeRef, batch.storeRef)) fail('MEMBER_CHANGED');
  return { batch, member, candidate, authorization };
}

function immutableScope({ batch, member, authorization }) {
  return { batchId: batch.batchId, schemaVersion: batch.schemaVersion,
    ...(batch.schemaVersion==='d-batch-production-authorization-v3'?{importLimitUse:clone(batch.importLimitUse)}:{}),
    ownerActorId: batch.ownerActorId, confirmedAt: batch.confirmedAt, storeRef: clone(batch.storeRef),
    excludedOfferIds: clone(batch.excludedOfferIds), postImportScope: clone(batch.postImportScope),
    members: batch.members.map(value => Object.fromEntries(['candidateId', 'skuPackageId', 'offerId',
      'resultRevision', 'authorizationId', 'authorizationFingerprint'].map(key => [key, value[key]]))),
    candidateId: member.candidateId, skuPackageId: member.skuPackageId, sourceRevision: member.resultRevision,
    authorizationId: member.authorizationId, authorizationFingerprint: member.authorizationFingerprint,
    finalUploads: clone(authorization.lockedScope.finalUploads) };
}

function recordsIn(document) {
  const records = document.runtime?.dBatchAssetTransports;
  if (records === undefined) return [];
  if (!Array.isArray(records)) fail('STORE_INVALID');
  return records;
}
function recordFor(document, batchId, candidateId) {
  const matches = recordsIn(document).filter(record => record.batchId === batchId && record.candidateId === candidateId);
  if (matches.length > 1) fail('RECORD_NOT_UNIQUE');
  return matches[0] ?? null;
}
function assertRecord(record, source) {
  if (record.schemaVersion !== VERSION || record.recordId !== `d-batch-assets:${source.batch.batchId}:${source.member.candidateId}` ||
      !isDeepStrictEqual(record.scope, immutableScope(source)) ||
      !['in_flight', 'verified', 'failed', 'unknown_outcome'].includes(record.status) ||
      record.status !== record.state?.status || !text(record.workerId) || !text(record.workerVersion) ||
      !text(record.leaseId) || !Number.isFinite(Date.parse(record.leaseExpiresAt)) ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 || !Array.isArray(record.writeIntents) ||
      record.writeIntents.length > source.authorization.lockedScope.finalUploads.length ||
      record.status === 'verified' && record.writeIntents.length !== source.authorization.lockedScope.finalUploads.length ||
      record.writeIntents.some((intent, index) => ['assetId', 'order', 'sha256'].some(key =>
        intent[key] !== source.authorization.lockedScope.finalUploads[index][key]))) fail('RECORD_SCOPE_CHANGED');
  assertSafeRecord(record);
}

function assertSafeRecord(record) {
  // Preserve the existing declared authorization-reference context of the OSS state.
  // The batch envelope has no authority to grant that context to arbitrary fields.
  const { state, ...envelope } = record;
  assertSafeRuntimeRecord(envelope, 'dBatchAssetTransport');
  if (state?.schemaVersion !== 'aliyun-oss-d-asset-state-v1') fail('STATE_INVALID');
  assertSafeRuntimeRecord(state, 'dAssetTransport');
}

function assertFrozenInFlightRecord(record) {
  assertSafeRecord(record);
  const intent = assertPersistedAliyunOssAssetIntent(record.state.intent);
  const scope = record.scope, authorization = intent.productionPlan.sourceAuthorization;
  const fields = ['schemaVersion', 'recordId', 'batchId', 'candidateId', 'scope', 'status', 'revision',
    'workerId', 'workerVersion', 'leaseId', 'leaseExpiresAt', 'createdAt', 'updatedAt', 'writeIntents', 'state'];
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)) ||
      record.status !== 'in_flight' || record.batchId !== scope?.batchId || record.candidateId !== scope.candidateId ||
      !supportsPostImportBatch(scope.schemaVersion) ||
      !Array.isArray(scope.members) || scope.members.length === 0 || scope.members.length > 100 ||
      scope.members.some(member => !member || ['candidateId', 'skuPackageId', 'offerId', 'authorizationId',
        'authorizationFingerprint'].some(field => !text(member[field])) ||
        !Number.isSafeInteger(member.resultRevision) || member.resultRevision < 0) ||
      ['candidateId', 'skuPackageId', 'offerId', 'authorizationId'].some(field =>
        new Set(scope.members.map(member => member[field])).size !== scope.members.length) ||
      !Array.isArray(scope.excludedOfferIds) || scope.excludedOfferIds.some(value => !text(value)) ||
      scope.postImportScope?.schemaVersion !== (scope.schemaVersion==='d-batch-production-authorization-v3'
        ?'d-batch-post-import-scope-v2':'d-batch-post-import-scope-v1') ||
      !['create_only', 'write_authorized_stock'].includes(scope.postImportScope.inventoryAction) ||
      !isDeepStrictEqual(scope.postImportScope.eReadbackOfferIds, scope.members.map(member => member.offerId)) ||
      scope.ownerActorId !== authorization.authorizedByActorId || scope.confirmedAt !== authorization.authorizedAt ||
      scope.candidateId !== intent.candidateId || scope.skuPackageId !== intent.skuPackageId ||
      scope.sourceRevision !== intent.candidateDataRevision || scope.sourceRevision !== intent.persistedCandidateRevision ||
      scope.sourceRevision !== authorization.resultCandidateRevision ||
      scope.authorizationId !== intent.authorizationId || scope.authorizationFingerprint !== intent.authorizationFingerprint ||
      !sameStoreRef(scope.storeRef, authorization.lockedScope.storeRef) ||
      !isDeepStrictEqual(scope.finalUploads, authorization.lockedScope.finalUploads) ||
      record.createdAt !== intent.persistedAt || !Number.isFinite(Date.parse(record.updatedAt)) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
      Date.parse(record.leaseExpiresAt) <= Date.parse(record.createdAt) ||
      Object.hasOwn(record, 'leaseExpiryResolution')) fail('FROZEN_RECORD_INVALID');
  assertDBatchPostImportScope(scope.postImportScope,scope.members.map(member=>member.offerId),scope.schemaVersion);
  if(scope.schemaVersion==='d-batch-production-authorization-v3')assertOzonProductImportBatchLimitUse(scope.importLimitUse);
  const members = scope.members.filter(member => member.candidateId === scope.candidateId);
  if (members.length !== 1 || members[0].offerId !== authorization.lockedScope.merchantSku ||
      members[0].resultRevision !== scope.sourceRevision || scope.excludedOfferIds.includes(members[0].offerId))
    fail('FROZEN_RECORD_INVALID');
  assertRecord(record, { batch: { ...scope, schemaVersion: scope.schemaVersion }, member: members[0], authorization });
  if (record.revision !== record.writeIntents.length + 1 ||
      !isDeepStrictEqual(record.state, { schemaVersion: 'aliyun-oss-d-asset-state-v1', status: 'in_flight',
        executionRevision: 1, intent, assetTransport: null, automaticRetry: false, platformWrites: 0 }) ||
      record.writeIntents.some((write, index) => Object.keys(write).sort().join() !== 'assetId,order,sha256,startedAt' ||
        !Number.isFinite(Date.parse(write.startedAt)) || Date.parse(write.startedAt) < Date.parse(record.createdAt) ||
        Date.parse(write.startedAt) > Date.parse(record.updatedAt) || index > 0 &&
        Date.parse(write.startedAt) < Date.parse(record.writeIntents[index - 1].startedAt))) fail('FROZEN_RECORD_INVALID');
  return record;
}

function resolveExpiredRecord(record, observedAt) {
  assertFrozenInFlightRecord(record);
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < Date.parse(record.leaseExpiresAt) ||
      Date.parse(observedAt) < Date.parse(record.updatedAt)) fail('LEASE_EXPIRY_TIME_INVALID');
  const notAttempted = record.writeIntents.length === 0, status = notAttempted ? 'failed' : 'unknown_outcome';
  const next = { ...clone(record), status, revision: record.revision + 1, updatedAt: observedAt,
    leaseExpiryResolution: { schemaVersion: LEASE_EXPIRY_VERSION, sourceRecordRevision: record.revision, observedAt },
    state: { ...clone(record.state), status, executionRevision: 2,
      intent: { ...clone(record.state.intent), status, completedAt: observedAt,
        failureCode: notAttempted ? 'OSS_D_BATCH_LEASE_EXPIRED_BEFORE_WRITE' : 'OSS_D_BATCH_LEASE_EXPIRED_OUTCOME_UNKNOWN',
        failureLayer: notAttempted ? 'production_admission' : 'aliyun_oss_asset_transport',
        ...(notAttempted ? { externalRequestState: 'not_attempted' } : {}), ossWrites: notAttempted ? 0 : 'unknown' },
      continuationBlocked: true, blockReason: 'asset_transport_lease_expired', settledAt: observedAt } };
  assertSafeRecord(next);
  return next;
}

// Only the original invocation can supply its held intent. Recompute the entire
// expiry result; a marker alone cannot make a terminal record accept a receipt.
function isOriginalHolderExpiryResolution(record, held) {
  const resolution = record.leaseExpiryResolution;
  if (!resolution || Object.keys(resolution).sort().join() !== 'observedAt,schemaVersion,sourceRecordRevision' ||
      resolution.schemaVersion !== LEASE_EXPIRY_VERSION || record.status !== 'unknown_outcome' ||
      !Array.isArray(record.writeIntents) || record.writeIntents.length === 0 ||
      resolution.sourceRecordRevision !== held.revision + record.writeIntents.length) return false;
  const beforeExpiry = { ...clone(held), writeIntents: clone(record.writeIntents),
    revision: resolution.sourceRecordRevision, updatedAt: record.writeIntents.at(-1).startedAt };
  return isDeepStrictEqual(record, resolveExpiredRecord(beforeExpiry, resolution.observedAt));
}

/** One local settlement per pass. The optional snapshot only selects work; the transaction revalidates it. */
export async function reconcileExpiredDBatchAssetTransport({ repository, serverClock, snapshot = null, batchId = null }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof serverClock !== 'function' || batchId !== null && !text(batchId)) fail('RECOVERY_INPUT_INVALID');
  const document = snapshot ?? await repository.readSnapshot(), observedAt = serverClock();
  if (!Number.isFinite(Date.parse(observedAt))) fail('CLOCK_INVALID');
  for (const record of recordsIn(document)) {
    if (record.status !== 'in_flight' || batchId !== null && record.batchId !== batchId) continue;
    assertFrozenInFlightRecord(record);
    if (Date.parse(observedAt) < Date.parse(record.leaseExpiresAt)) continue;
    return repository.transact(current => {
      const held = recordFor(current, record.batchId, record.candidateId);
      if (!held) fail('RECOVERY_RECORD_MISSING');
      if (!isDeepStrictEqual(held, record)) return { changed: false, result: { status: 'idle' } };
      const recovered = resolveExpiredRecord(held, serverClock());
      const records = recordsIn(current);
      records[records.indexOf(held)] = recovered;
      return { changed: true, document: current, result: { status: recovered.status,
        batchId: recovered.batchId, candidateId: recovered.candidateId, recordId: recovered.recordId,
        executionStage: 'asset_transport', reasonCode: recovered.state.intent.failureCode } };
    });
  }
  return { status: 'idle' };
}

/** Independent, validated proof; absence is not a verified capability. This does not mutate the candidate. */
export function readDBatchAssetTransportProof({ document, batchId, candidateId }) {
  const record = recordFor(document, batchId, candidateId);
  if (record === null) return null;
  const source = sourceIn(document, batchId, candidateId);
  assertRecord(record, source);
  if (record.status !== 'verified') return null;
  const assetTransport = verifiedAliyunOssAssetTransport({ state: record.state, candidateId,
    skuPackageId: source.member.skuPackageId, productionAuthorization: source.authorization });
  if (record.state.intent.candidateDataRevision !== source.member.resultRevision ||
      record.state.intent.persistedCandidateRevision !== source.member.resultRevision) fail('RECORD_SCOPE_CHANGED');
  return Object.freeze({ schemaVersion: 'd-batch-asset-proof-v1', recordId: record.recordId,
    batchId, candidateId, skuPackageId: source.member.skuPackageId, sourceRevision: source.member.resultRevision,
    authorizationId: source.member.authorizationId, authorizationFingerprint: source.member.authorizationFingerprint,
    finalUploadAssetIds: clone(record.state.intent.finalUploadAssetIds), storeRef: clone(source.batch.storeRef),
    productionPlan: clone(record.state.intent.productionPlan), assetTransport });
}

/** Batch execution adapter only. Existing OSS domain rules own manifests, upload receipts and stable URL validation. */
export function createDBatchAssetTransport({ repository, runtimeMode, workerRegistry, serverClock,
  upload = null, resolveLocalAsset = null, loadCurrentProductionBinding,
  getBatchMemberEvidence, leaseDurationMs }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (['central_test', 'central_production'].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  else if (runtimeMode !== 'local_development') fail('RUNTIME_MODE_INVALID');
  assertWorkerRegistryBoundary(workerRegistry);
  if ([serverClock, loadCurrentProductionBinding, getBatchMemberEvidence].some(value => typeof value !== 'function') ||
      [upload, resolveLocalAsset].some(value => value !== null && typeof value !== 'function') ||
      !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1000 || leaseDurationMs > 1_800_000) fail('DEPENDENCY_INVALID');
  const active = new Map();
  const now = () => {
    const value = serverClock();
    if (!Number.isFinite(Date.parse(value))) fail('CLOCK_INVALID');
    return new Date(value).toISOString();
  };
  const workerFor = (workerId, version = null) => {
    const worker = workerRegistry.findEligible(['ozon-production-execution']).find(value => value.workerId === workerId);
    if (!worker || version !== null && worker.version !== version) fail('WORKER_NOT_CURRENT');
    return worker;
  };
  const bindingFor = candidate => {
    const binding = loadCurrentProductionBinding({ candidate: clone(candidate) });
    if (binding?.then) throw new TypeError('D_BATCH_ASSET_BINDING_MUST_BE_SYNCHRONOUS');
    assertCurrentProductionExecutionBinding({ productionAuthorization: candidate.lifecycleV11.skuPackage.productionAuthorization,
      currentProductionBinding: binding, checkedAt: now() });
    return binding;
  };
  const outcome = (batchId, status, members, reasonCode = null) => ({ status, batchId, members,
    reasonCode, platformWrites: 0 });

  async function filesFor(sources) {
    const files = new Map();
    let totalBytes = 0;
    for (const source of sources) {
      for (const asset of source.authorization.lockedScope.finalUploads) {
        if (!asset.assetRef.startsWith('local-asset:')) fail('MIXED_SOURCE_UNSUPPORTED');
        const draft = source.candidate.lifecycleV11.c2UploadDraft;
        if (draft === undefined || draft === null) throw new AliyunOssLocalPreparationError('OSS_LOCAL_ASSET_INVALID');
        resolveRegisteredC2FinalAsset(source.candidate, asset);
        if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || asset.byteSize > MAX_ASSET_BYTES ||
            totalBytes + asset.byteSize > MAX_BATCH_BYTES) fail('LOCAL_BATCH_TOO_LARGE');
        const resolved = await resolveLocalAsset(asset, { candidate: clone(source.candidate) });
        // Existing manifest hashes detect accidental file changes; they are not authentication.
        if (!Buffer.isBuffer(resolved?.body) || resolved.body.length !== asset.byteSize ||
            createHash('sha256').update(resolved.body).digest('hex') !== asset.sha256 ||
            typeof resolved.contentType !== 'string') throw new AliyunOssLocalPreparationError('OSS_LOCAL_ASSET_INVALID');
        totalBytes += resolved.body.length;
        files.set(`${source.candidate.id}:${asset.assetId}`, resolved);
      }
    }
    return files;
  }

  async function checkEvidence(source, binding, plan) {
    const evidence = await getBatchMemberEvidence({ candidate: clone(source.candidate),
      productionBinding: clone(binding), batch: clone(source.batch), purpose: 'asset_transport' });
    const capabilities = evidence?.capabilities;
    if (!capabilities || !['ready', 'not_ready'].includes(capabilities.status) ||
        !Array.isArray(capabilities.gaps) || capabilities.gaps.some(gap => !gap || !text(gap.code))) fail('ACCOUNT_EVIDENCE_INVALID');
    if (!sameStoreRef(capabilities.storeRef, source.batch.storeRef) ||
        capabilities.warehouseRef !== binding.warehouseRef || capabilities.credentialAlias !== binding.credentialAlias ||
        String(capabilities.warehouseId) !== String(binding.warehouseId)) fail('ACCOUNT_EVIDENCE_SCOPE_MISMATCH');
    if (capabilities.gaps.some(gap => gap.code !== 'asset_transport_not_verified')) fail('ACCOUNT_EVIDENCE_NOT_READY');
    const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: evidence.checkedAt,
      inspectPlatform: async () => clone(evidence.inspection) });
    if (preflight.technicalStatus !== 'completed' || preflight.risks.length !== 0) fail('ACCOUNT_EVIDENCE_NOT_READY');
  }

  async function executeMember(source, worker, files) {
    const candidateId = source.candidate.id, batchId = source.batch.batchId;
    const admitted = await repository.transact(document => {
      const current = sourceIn(document, batchId, candidateId);
      if (!isDeepStrictEqual(immutableScope(current), immutableScope(source))) fail('SOURCE_CHANGED');
      const prior = recordFor(document, batchId, candidateId);
      if (prior !== null) { assertRecord(prior, current); return { changed: false, result: { admitted: false, record: clone(prior) } }; }
      if (current.batch.externalRequestState !== 'not_sent' ||
          current.candidate.lifecycleV11.skuPackage.dAssetTransport || current.candidate.lifecycleV11.skuPackage.dSoftwareExecution) fail('EXECUTION_ALREADY_STARTED');
      workerFor(worker.workerId, worker.version);
      bindingFor(current.candidate);
      const at = now();
      const intent = markAliyunOssAssetIntentPersisted({
        intent: createPersistableAliyunOssAssetIntent({ candidate: current.candidate,
          expectedDataRevision: current.member.resultRevision, startedAt: at,
          ownerDecision: { confirmed: true, confirmedBy: 'owner', authorizationId: current.member.authorizationId,
            skuPackageId: current.member.skuPackageId, finalUploadAssetIds: current.authorization.lockedScope.finalUploads.map(asset => asset.assetId) } }),
        persistedAt: at, persistedCandidateRevision: current.member.resultRevision });
      const record = { schemaVersion: VERSION, recordId: `d-batch-assets:${batchId}:${candidateId}`,
        batchId, candidateId, scope: immutableScope(current), status: 'in_flight', revision: 1,
        workerId: worker.workerId, workerVersion: worker.version, leaseId: `lease:${randomUUID()}`,
        leaseExpiresAt: new Date(Date.parse(at) + leaseDurationMs).toISOString(), createdAt: at, updatedAt: at,
        writeIntents: [], state: { schemaVersion: 'aliyun-oss-d-asset-state-v1', status: 'in_flight',
          executionRevision: 1, intent, assetTransport: null, automaticRetry: false, platformWrites: 0 } };
      assertRecord(record, current);
      document.runtime.dBatchAssetTransports = [...recordsIn(document), record];
      return { changed: true, document, result: { admitted: true, record: clone(record) } };
    });
    if (!admitted.admitted) return admitted.record;
    const held = admitted.record;
    let result, executionError = null;
    try {
      result = await executeAliyunOssAssetIntent({ persistedIntent: held.state.intent,
        candidate: source.candidate, currentProductionBinding: bindingFor(source.candidate), serverClock: now,
        resolveLocalAsset: asset => {
          const file = files.get(`${candidateId}:${asset.assetId}`);
          if (!file) throw new AliyunOssLocalPreparationError('OSS_LOCAL_ASSET_UNAVAILABLE');
          return file;
        }, upload, beforePublicWrite: async asset => {
          const currentSource = sourceIn(await repository.readSnapshot(), batchId, candidateId);
          await checkEvidence(currentSource, bindingFor(currentSource.candidate), held.state.intent.productionPlan);
          return repository.transact(document => {
          const current = sourceIn(document, batchId, candidateId), record = recordFor(document, batchId, candidateId);
          assertRecord(record, current);
          if (record.leaseId !== held.leaseId || record.workerId !== held.workerId || record.workerVersion !== held.workerVersion ||
              !isDeepStrictEqual(record.state.intent, held.state.intent) ||
              record.status !== 'in_flight') fail('RECORD_SCOPE_CHANGED');
          if (record.writeIntents.length !== asset.order - 1) fail('WRITE_ORDER_CHANGED');
          if (Date.parse(now()) >= Date.parse(record.leaseExpiresAt)) fail('SEND_GUARD_BLOCKED');
          workerFor(record.workerId, record.workerVersion);
          bindingFor(current.candidate);
          const expected = current.authorization.lockedScope.finalUploads[asset.order - 1];
          if (!expected || ['assetId', 'order', 'sha256'].some(key => expected[key] !== asset[key])) fail('MANIFEST_CHANGED');
          resolveRegisteredC2FinalAsset(current.candidate, expected);
          record.writeIntents.push({ ...asset, startedAt: now() }); record.revision++; record.updatedAt = now();
          return { changed: true, document, result: null };
          });
        } });
    } catch (error) { executionError = error; }
    let settled;
    try { settled = await repository.transact(document => {
      const record = recordFor(document, batchId, candidateId);
      if (!record || record.leaseId !== held.leaseId || record.workerId !== held.workerId ||
          record.workerVersion !== held.workerVersion || !isDeepStrictEqual(record.scope, held.scope)) fail('SETTLEMENT_CONFLICT');
      const expiredResolution = record.status !== 'in_flight' && isOriginalHolderExpiryResolution(record, held);
      if (!expiredResolution && (!isDeepStrictEqual(record.state.intent, held.state.intent) ||
          record.status !== 'in_flight')) fail('SETTLEMENT_CONFLICT');
      const candidate = document.candidates.find(value => value.id === candidateId);
      if (!candidate?.lifecycleV11?.skuPackage) fail('SETTLEMENT_SOURCE_MISSING');
      const at = now();
      if (executionError !== null) {
        record.status = record.writeIntents.length === 0 ? 'failed' : 'unknown_outcome';
        record.state.status = record.status; record.state.executionRevision = 2;
        record.state.intent = { ...clone(record.state.intent), status: record.status, completedAt: at,
          failureCode: record.status === 'failed' ? 'OSS_D_BATCH_PREWRITE_FAILED' : 'OSS_D_BATCH_UPLOAD_UNKNOWN',
          failureLayer: record.status === 'failed' ? 'production_admission' : 'aliyun_oss_asset_transport',
          ...(record.status === 'failed' ? { externalRequestState: 'not_attempted' } : {}),
          ossWrites: record.status === 'failed' ? 0 : 'unknown' };
        record.state.continuationBlocked = true; record.state.blockReason = 'asset_transport_failed';
      } else {
        record.state = settleAliyunOssAssetState({ candidateId, skuPackageId: record.scope.skuPackageId,
          currentCandidateRevision: candidate.dataRevision, productionAuthorization: candidate.lifecycleV11.skuPackage.productionAuthorization,
          state: expiredResolution ? held.state : record.state, persistedIntent: held.state.intent, result, settledAt: at });
        record.status = record.state.status;
      }
      record.revision++; record.updatedAt = at;
      assertSafeRecord(record);
      return { changed: true, document, result: clone(record) };
    }); } catch (settlementError) {
      if (executionError !== null) throw new AggregateError([executionError, settlementError], 'D_BATCH_ASSET_SETTLEMENT_FAILED');
      throw settlementError;
    }
    if (executionError !== null) throw executionError;
    return settled;
  }

  async function perform({ batchId, workerId }) {
    let document = await repository.readSnapshot();
    const recovered = await reconcileExpiredDBatchAssetTransport({ repository, serverClock, snapshot: document, batchId });
    if (recovered.status !== 'idle') return outcome(batchId, recovered.status,
      [{ candidateId: recovered.candidateId, status: recovered.status, recordId: recovered.recordId }], recovered.reasonCode);
    const batch = batchIn(document, batchId), sources = batch.members.map(member => sourceIn(document, batchId, member.candidateId));
    const required = sources.filter(source => source.authorization.lockedScope.finalUploads.some(asset => asset.assetRef.startsWith('local-asset:')));
    if (required.length === 0) return outcome(batchId, 'verified', []);
    if (!supportsPostImportBatch(batch.schemaVersion)) return outcome(batchId, 'blocked', [], 'D_BATCH_ASSET_LEGACY_SCOPE_NOT_SUPPORTED');
    assertDBatchPostImportScope(batch.postImportScope,batch.members.map(member=>member.offerId),batch.schemaVersion);
    if (required.some(source => source.authorization.authorizedByActorId !== batch.ownerActorId ||
        !source.authorization.lockedScope.allowedWriteFields.includes('assets.finalUploads'))) fail('OWNER_AUTHORIZATION_REQUIRED');
    const members = [];
    for (const source of required) {
      const record = recordFor(document, batchId, source.candidate.id);
      if (record === null) continue;
      assertRecord(record, source);
      if (record.status === 'verified') {
        readDBatchAssetTransportProof({ document, batchId, candidateId: source.candidate.id });
        members.push({ candidateId: source.candidate.id, status: 'verified', recordId: record.recordId });
      } else return outcome(batchId, record.status, [{ candidateId: source.candidate.id, status: record.status, recordId: record.recordId }]);
    }
    const pending = required.filter(source => !members.some(member => member.candidateId === source.candidate.id));
    if (pending.length === 0) return outcome(batchId, 'verified', members);
    if (upload === null || resolveLocalAsset === null) return outcome(batchId, 'blocked', members, 'D_BATCH_ASSET_TRANSPORT_NOT_CONFIGURED');
    try {
      const worker = workerFor(workerId);
      const files = await filesFor(pending);
      for (const source of sources) {
        const binding = bindingFor(source.candidate);
        const plan = createProductionPlan({ productionAuthorization: source.authorization, candidateId: source.candidate.id,
          candidateRevision: source.member.resultRevision, skuPackage: source.candidate.lifecycleV11.skuPackage, createdAt: now() });
        await checkEvidence(source, binding, plan);
      }
      for (const source of pending) {
        const record = await executeMember(source, worker, files);
        members.push({ candidateId: source.candidate.id, status: record.status, recordId: record.recordId });
        if (record.state.continuationBlocked) return outcome(batchId, 'blocked', members, 'D_BATCH_ASSET_SOURCE_CHANGED');
        if (record.status !== 'verified') return outcome(batchId, record.status, members);
      }
      document = await repository.readSnapshot();
      for (const source of required) readDBatchAssetTransportProof({ document, batchId, candidateId: source.candidate.id });
      return outcome(batchId, 'verified', members);
    } catch (error) {
      const code = preparationBlockCode(error);
      if (code !== null) return outcome(batchId, 'blocked', members, code);
      throw error;
    }
  }
  return Object.freeze({
    async run(input) {
      if (!input || !text(input.batchId) || !text(input.workerId) ||
          Object.keys(input).sort().join() !== 'batchId,workerId') fail('INPUT_INVALID');
      if (active.has(input.batchId)) return active.get(input.batchId);
      if (active.size >= 32) fail('CAPACITY_EXCEEDED');
      const promise = perform(input); active.set(input.batchId, promise);
      try { return await promise; } finally { active.delete(input.batchId); }
    }
  });
}
