import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation, assertSafeRuntimeRecord, createOperationAuditEvent } from './runtime-identity.mjs';
import { validateProductionAuthorization } from './production-authorization.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { assertDBatchOfferRecord, assertDBatchEJob, createDBatchEReadback } from './d-batch-offer-readback.mjs';
import { observedMediaSequence } from './e-stage-readback.mjs';
import { resolveRegisteredC2FinalAsset } from './c2-upload-draft.mjs';
import { supportsPostImportBatch, assertDBatchPostImportScope } from './d-batch-production-contract.mjs';

export const D_BATCH_E_MEDIA_CONFIRMATION_VERSION = 'd-batch-e-media-confirmation-v1';
const SCOPE_VERSION = 'd-batch-e-media-review-scope-v1';
const VIEW_VERSION = 'd-batch-e-media-review-view-v1';
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value;
const instant = value => text(value) && Number.isFinite(Date.parse(value));
const localAssetId = value => typeof value === 'string' && /^c2-local:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const memberFields = ['candidateId', 'skuPackageId', 'offerId', 'resultRevision', 'authorizationId', 'authorizationFingerprint'];
const assetFields = ['assetId', 'assetRef', 'mediaType', 'assetVersion', 'sha256', 'order', 'role'];
const checks = ['content', 'hero', 'order'];

export class DBatchEMediaReviewError extends Error {
  constructor(code) { super(`D_BATCH_E_MEDIA_${code}`); this.name = 'DBatchEMediaReviewError'; this.code = this.message; }
}
const fail = code => { throw new DBatchEMediaReviewError(code); };

function collection(document, name) {
  const value = document.runtime?.[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('STORE_INVALID');
  return value;
}
function one(values, code) { if (values.length !== 1) fail(code); return values[0]; }
function owner(actor) {
  if (!actor || actor.schemaVersion !== 'actor-context-v1' || !Array.isArray(actor.roles) ||
      actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' || !text(actor.userId)) fail('OWNER_REQUIRED');
  authorizeOperation({ actor, requiredRoles: ['owner'] });
}
function source(document, batchId, candidateId) {
  if (!text(batchId) || !text(candidateId) || !Array.isArray(document?.candidates)) fail('INPUT_INVALID');
  const batch = one(collection(document, 'dProductionBatches').filter(value => value.batchId === batchId), 'BATCH_NOT_UNIQUE');
  if (!supportsPostImportBatch(batch.schemaVersion) ||
      !Array.isArray(batch.members) || batch.members.length < 1 ||
      new Set(batch.members.map(value => value.candidateId)).size !== batch.members.length ||
      new Set(batch.members.map(value => value.offerId)).size !== batch.members.length ||
      !Array.isArray(batch.excludedOfferIds)) fail('BATCH_SCOPE_INVALID');
  assertDBatchPostImportScope(batch.postImportScope, batch.members.map(value => value.offerId), batch.schemaVersion);
  const member = one(batch.members.filter(value => value.candidateId === candidateId), 'MEMBER_NOT_UNIQUE');
  const candidate = one(document.candidates.filter(value => value.id === candidateId), 'CANDIDATE_NOT_UNIQUE');
  const sku = candidate.lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
  if (!Number.isSafeInteger(member.resultRevision) || candidate.dataRevision !== member.resultRevision ||
      sku?.skuPackageId !== member.skuPackageId || authorization?.authorizationId !== member.authorizationId) fail('SOURCE_CHANGED');
  if (!validateProductionAuthorization(authorization, { candidateId, candidateRevision: candidate.dataRevision,
    skuPackage: sku, lifecycleState: 'persisted' }).valid) fail('AUTHORIZATION_INVALID');
  const locked = authorization.lockedScope;
  if (fingerprintCanonicalRecord(authorization) !== member.authorizationFingerprint ||
      authorization.authorizedByActorId !== batch.ownerActorId || authorization.authorizedAt !== batch.confirmedAt ||
      authorization.resultCandidateRevision !== member.resultRevision || locked.candidateId !== candidateId ||
      locked.skuPackageId !== member.skuPackageId || locked.merchantSku !== member.offerId ||
      locked.platform !== 'ozon' || candidate.targetPlatform !== 'ozon' ||
      candidate.targetStore !== locked.storeRef.stableStoreId || batch.excludedOfferIds.includes(member.offerId) ||
      !sameStoreRef(candidate.storeRef, batch.storeRef) || !sameStoreRef(locked.storeRef, batch.storeRef) ||
      !isDeepStrictEqual(sku.c2FinalAssets?.assets?.finalUploads, locked.finalUploads)) fail('SOURCE_CHANGED');
  const records = collection(document, 'dBatchOfferRecords').filter(value => value.batchId === batchId && value.candidateId === candidateId);
  const jobs = collection(document, 'dBatchEJobs').filter(value => value.batchId === batchId && value.candidateId === candidateId);
  if (records.length === 0 && jobs.length === 0) return null;
  const record = one(records, 'SOURCE_RECORD_NOT_UNIQUE'), job = one(jobs, 'READBACK_JOB_NOT_UNIQUE');
  assertDBatchOfferRecord(record); assertDBatchEJob(job);
  if (record.recordId !== job.recordId || record.offerId !== member.offerId || record.skuPackageId !== member.skuPackageId ||
      record.authorizationId !== member.authorizationId || record.authorizationFingerprint !== member.authorizationFingerprint ||
      record.supplierSkuId !== locked.supplierSkuId || record.platform !== locked.platform ||
      record.store !== locked.storeRef.stableStoreId || !sameStoreRef(record.storeRef, locked.storeRef) ||
      record.warehouseRef !== locked.warehouseRef || record.credentialAlias !== locked.credentialAlias ||
      record.warehouseId !== authorization.executionBinding.warehouseId ||
      record.inventoryAction !== batch.postImportScope.inventoryAction ||
      !isDeepStrictEqual(record.expectedPrice, locked.platformWritePrice) ||
      (record.inventoryAction === 'write_authorized_stock' && record.expectedStock !== locked.stock) ||
      job.offerId !== member.offerId || job.authorizationId !== member.authorizationId) fail('SOURCE_CHANGED');
  const expectedMedia = locked.finalUploads.map(asset => ({ assetId: asset.assetId, order: asset.order, sha256: asset.sha256 }));
  if (!isDeepStrictEqual(record.readbackExpectation.media.map(({ assetId, order, sha256 }) => ({ assetId, order, sha256 })), expectedMedia)) fail('SOURCE_CHANGED');
  const readbacks = collection(document, 'dBatchEReadbacks').filter(value => value.sourceRecordId === record.recordId);
  if (new Set(readbacks.map(value => value.readbackId)).size !== readbacks.length) fail('READBACK_NOT_UNIQUE');
  if (!['completed', 'observation_stopped'].includes(job.status)) return null;
  if (!job.resultId) {
    if (readbacks.length) fail('READBACK_SOURCE_INVALID');
    return null;
  }
  const readback = one(readbacks.filter(value => value.readbackId === job.resultId), 'READBACK_NOT_UNIQUE');
  if (readback.schemaVersion !== 'd-batch-e-readback-v2' || job.schemaVersion !== 'd-batch-e-job-v2' ||
      readback.readSequence !== job.readCount || readbacks.some(value => !Number.isSafeInteger(value.readSequence) || value.readSequence > readback.readSequence)) fail('READBACK_SOURCE_INVALID');
  if (readback.observation === null) return null;
  const reconstructed = createDBatchEReadback({ record, observation: readback.observation,
    readAt: readback.readAt, readSequence: readback.readSequence });
  if (!isDeepStrictEqual(readback, reconstructed)) fail('READBACK_SOURCE_INVALID');
  const observation = readback.observation;
  if (['platform', 'store', 'skuPackageId', 'supplierSkuId'].some(key => observation[key] !== record[key]) ||
      observation.merchantSku !== record.offerId || observation.platformProductId !== record.productId ||
      !sameStoreRef(observation.storeRef, record.storeRef) || observation.warehouseRef !== record.warehouseRef ||
      observation.credentialAlias !== record.credentialAlias) fail('READBACK_IDENTITY_MISMATCH');
  return { batch, member, candidate, authorization, record, readback };
}

// These are display URLs from a saved platform observation, never server-fetch targets.
function allowedPlatformImage(value) {
  if (!text(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'ir.ozone.ru' && !url.port && !url.username &&
    !url.password && !url.search && !url.hash && url.pathname !== '/' && url.href === value;
}
function sourcePreview(candidate, asset) {
  if (!localAssetId(asset.assetId) || asset.assetRef !== `local-asset:${asset.assetId}`) return null;
  const draft = candidate.lifecycleV11.c2UploadDraft;
  if (draft === undefined || draft === null) return null;
  if (draft.schemaVersion !== 'c2-upload-draft-v1' || !Array.isArray(draft.uploads) || !Array.isArray(draft.selection) ||
      draft.uploads.length > 100 || new Set(draft.uploads.map(value => value.assetId)).size !== draft.uploads.length ||
      new Set(draft.selection.map(value => value.assetId)).size !== draft.selection.length ||
      draft.selection.some((value, index) => value.order !== index + 1)) fail('REGISTRATION_INVALID');
  try { resolveRegisteredC2FinalAsset(candidate, asset); }
  catch (error) {
    if (['c2_final_registration_mismatch', 'c2_upload_selection_invalid'].includes(error.extra?.code)) return null;
    throw error;
  }
  return `/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2/local-assets/${encodeURIComponent(asset.assetId)}`;
}
function buildView(document, batchId, candidateId) {
  const base = { schemaVersion: VIEW_VERSION, batchId, candidateId, status: 'not_ready', reasonCode: null,
    scope: null, pairs: [], canConfirmMatch: false, canRecordMismatch: false, confirmation: null };
  const current = source(document, batchId, candidateId);
  if (!current) return { ...base, reasonCode: 'D_BATCH_E_MEDIA_READBACK_NOT_READY' };
  const { batch, candidate, authorization, record, readback } = current, locked = authorization.lockedScope;
  const observed = observedMediaSequence(readback.observation.mediaObservation);
  if (!observed || observed.length === 0 || observed.length > 100 || locked.finalUploads.length > 100 ||
      locked.finalUploads.some(asset => asset.mediaType !== 'image')) return { ...base, status: 'blocked', reasonCode: 'D_BATCH_E_MEDIA_SEQUENCE_UNAVAILABLE' };
  if (observed.some(value => !allowedPlatformImage(value))) return { ...base, status: 'blocked', reasonCode: 'D_BATCH_E_MEDIA_PLATFORM_URL_NOT_ALLOWED' };
  const previews = locked.finalUploads.map(asset => sourcePreview(candidate, asset));
  if (previews.some(value => value === null)) return { ...base, status: 'blocked', reasonCode: 'D_BATCH_E_MEDIA_SOURCE_PREVIEW_UNAVAILABLE' };
  const scope = { schemaVersion: SCOPE_VERSION, batchId, batchVersion: batch.schemaVersion,
    batchSource: { ownerActorId: batch.ownerActorId, confirmedAt: batch.confirmedAt, storeRef: clone(batch.storeRef),
      excludedOfferIds: clone(batch.excludedOfferIds), postImportScope: clone(batch.postImportScope),
      members: batch.members.map(member => Object.fromEntries(memberFields.map(key => [key, member[key]]))) },
    candidateId, skuPackageId: record.skuPackageId, sourceRevision: candidate.dataRevision,
    authorizationId: authorization.authorizationId, authorizationFingerprint: record.authorizationFingerprint,
    sourceRecordId: record.recordId, readbackId: readback.readbackId,
    sourceRecord: clone(record), readback: clone(readback),
    expectedSequence: { schemaVersion: 'd-batch-e-expected-media-sequence-v1',
      finalManifestVersion: locked.finalManifestVersion, finalManifestSha256: locked.finalManifestSha256,
      mainImageAssetId: locked.mainImageAssetId,
      assets: locked.finalUploads.map(asset => Object.fromEntries(assetFields.map(key => [key, asset[key]]))) },
    observedSequence: { schemaVersion: 'd-batch-e-observed-media-sequence-v1',
      sourceProtocol: readback.observation.mediaObservation.sourceProtocol, urls: clone(observed) } };
  assertSafeRuntimeRecord(scope, 'dBatchEMediaReviewScope');
  const pairs = Array.from({ length: Math.max(locked.finalUploads.length, observed.length) }, (_, index) => ({
    order: index + 1, expected: index < locked.finalUploads.length
      ? { ...clone(scope.expectedSequence.assets[index]), previewSrc: previews[index] } : null,
    observed: index < observed.length ? { platformUrl: observed[index], previewSrc: observed[index] } : null }));
  const canConfirmMatch = observed.length === locked.finalUploads.length && new Set(observed).size === observed.length &&
    readback.observation.imageCount === observed.length;
  return { ...base, status: 'awaiting_owner_review', scope, pairs, canConfirmMatch, canRecordMismatch: true,
    reasonCode: canConfirmMatch ? null : 'D_BATCH_E_MEDIA_SEQUENCE_MISMATCH' };
}

function assertConfirmation(record) {
  if (!closed(record, ['schemaVersion', 'confirmationId', 'scope', 'decision', 'checks', 'confirmedByUserId',
    'confirmedAt', 'actorType', 'actorSource', 'role', 'externalRequests', 'platformWrites']) ||
      record.schemaVersion !== D_BATCH_E_MEDIA_CONFIRMATION_VERSION || record.scope?.schemaVersion !== SCOPE_VERSION ||
      !text(record.scope.readbackId) || record.confirmationId !== `d-batch-e-media:${record.scope.readbackId}` ||
      !['matches', 'mismatch'].includes(record.decision) || !closed(record.checks, checks) ||
      checks.some(key => typeof record.checks[key] !== 'boolean') ||
      (record.decision === 'matches' && checks.some(key => record.checks[key] !== true)) ||
      !text(record.confirmedByUserId) || !instant(record.confirmedAt) || !instant(record.scope.readback?.readAt) ||
      Date.parse(record.confirmedAt) < Date.parse(record.scope.readback.readAt) || record.actorType !== 'human' ||
      record.actorSource !== 'authenticated_identity_provider' || record.role !== 'owner' ||
      record.externalRequests !== 0 || record.platformWrites !== 0) fail('CONFIRMATION_INVALID');
  assertSafeRuntimeRecord(record, 'dBatchEMediaConfirmation');
  return record;
}
function savedConfirmation(document, scope) {
  const records = collection(document, 'dBatchEMediaConfirmations').filter(value => value.scope?.batchId === scope.batchId &&
    value.scope?.candidateId === scope.candidateId && value.scope?.readbackId === scope.readbackId);
  if (records.length > 1) fail('CONFIRMATION_NOT_UNIQUE');
  if (!records.length) return null;
  const record = assertConfirmation(records[0]);
  if (!isDeepStrictEqual(record.scope, scope)) fail('CONFIRMATION_SOURCE_CHANGED');
  return record;
}

/** Pure projection. The HTTP owner boundary controls access to this view and its existing local image route. */
export function projectDBatchEMediaReview({ document, batchId, candidateId }) {
  const view = buildView(document, batchId, candidateId);
  if (!view.scope) return Object.freeze(view);
  const confirmation = savedConfirmation(document, view.scope);
  return Object.freeze(confirmation ? { ...view, status: confirmation.decision === 'matches' ? 'owner_confirmed' : 'owner_mismatch',
    confirmation: clone(confirmation), canConfirmMatch: false, canRecordMismatch: false } : view);
}

/** A matching saved owner decision is evidence only; final E independently checks every other platform fact. */
export function readDBatchEMediaConfirmation({ document, batchId, candidateId }) {
  let view;
  try { view = buildView(document, batchId, candidateId); }
  catch (error) { if (error instanceof DBatchEMediaReviewError && error.code === 'D_BATCH_E_MEDIA_SOURCE_CHANGED') return null; throw error; }
  if (!view.scope || !view.canConfirmMatch) return null;
  const confirmation = savedConfirmation(document, view.scope);
  return confirmation?.decision === 'matches' ? clone(confirmation) : null;
}

/** One local owner decision and its audit record commit together without changing candidate, PA, D or readback. */
export async function confirmDBatchEMediaReview({ repository, runtimeMode, serverClock, actor, input }) {
  if (!['local_development', 'central_test', 'central_production'].includes(runtimeMode) || typeof serverClock !== 'function') fail('DEPENDENCY_INVALID');
  assertBusinessStateRepositoryBoundary(repository);
  if (runtimeMode !== 'local_development') assertCentralPersistenceBoundary(repository);
  owner(actor);
  if (!closed(input, ['scope', 'decision', 'confirmContent', 'confirmHero', 'confirmOrder']) ||
      input.scope?.schemaVersion !== SCOPE_VERSION || !['matches', 'mismatch'].includes(input.decision) ||
      ['confirmContent', 'confirmHero', 'confirmOrder'].some(key => typeof input[key] !== 'boolean') ||
      (input.decision === 'matches' && ['confirmContent', 'confirmHero', 'confirmOrder'].some(key => input[key] !== true))) fail('INPUT_INVALID');
  assertSafeRuntimeRecord(input, 'dBatchEMediaReviewInput');
  const submitted = clone(input), ownerActor = clone(actor);
  return repository.transact(document => {
    const view = buildView(document, submitted.scope.batchId, submitted.scope.candidateId);
    if (!view.scope || !isDeepStrictEqual(view.scope, submitted.scope)) fail('SOURCE_CHANGED');
    if (submitted.decision === 'matches' && !view.canConfirmMatch) fail('SEQUENCE_MISMATCH');
    const decisionChecks = { content: submitted.confirmContent, hero: submitted.confirmHero, order: submitted.confirmOrder };
    const prior = savedConfirmation(document, view.scope);
    if (prior) {
      if (prior.decision !== submitted.decision || !isDeepStrictEqual(prior.checks, decisionChecks)) fail('DECISION_ALREADY_RECORDED');
      return { changed: false, result: { status: prior.decision === 'matches' ? 'owner_confirmed' : 'owner_mismatch',
        confirmation: clone(prior), idempotent: true, externalRequests: 0, platformWrites: 0 } };
    }
    const observedAt = serverClock();
    const confirmation = assertConfirmation({ schemaVersion: D_BATCH_E_MEDIA_CONFIRMATION_VERSION,
      confirmationId: `d-batch-e-media:${view.scope.readbackId}`, scope: clone(view.scope), decision: submitted.decision,
      checks: decisionChecks, confirmedByUserId: ownerActor.userId, confirmedAt: observedAt,
      actorType: 'human', actorSource: 'authenticated_identity_provider', role: 'owner', externalRequests: 0, platformWrites: 0 });
    const audit = createOperationAuditEvent({ eventId: `audit:${confirmation.confirmationId}`, action: 'confirm_batch_e_media',
      actor: ownerActor, candidateId: view.scope.candidateId, skuPackageId: view.scope.skuPackageId,
      sourceRevision: view.scope.sourceRevision, resultRevision: view.scope.sourceRevision, fromState: 'E', toState: 'E',
      authorizationRef: view.scope.authorizationId, idempotencyKey: confirmation.confirmationId, serverTime: observedAt });
    const records = collection(document, 'dBatchEMediaConfirmations'), audits = collection(document, 'operationAudit');
    if (audits.some(value => value.eventId === audit.eventId)) fail('AUDIT_CONFLICT');
    document.runtime.dBatchEMediaConfirmations = [...records, clone(confirmation)];
    document.runtime.operationAudit = [...audits, clone(audit)];
    return { changed: true, document, result: { status: submitted.decision === 'matches' ? 'owner_confirmed' : 'owner_mismatch',
      confirmation: clone(confirmation), idempotent: false, externalRequests: 0, platformWrites: 0 } };
  });
}
