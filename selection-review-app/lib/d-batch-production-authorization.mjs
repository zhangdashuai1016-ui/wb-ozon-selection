import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation, assertSafeBusinessMutationCandidate, assertSafeRuntimeRecord,
  createOperationAuditEvent } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord, assertNoProductionSecrets } from './production-contract-primitives.mjs';
import { resolveProductionOwnerPreparation } from './production-owner-preparation.mjs';
import { createProductionAuthorization } from './production-authorization.mjs';
import { sameStoreRef } from './store-binding.mjs';

export const D_BATCH_PRODUCTION_AUTHORIZATION_VERSION = 'd-batch-production-authorization-v1';
const CENTRAL_MODES = new Set(['central_test', 'central_production']);
const text = value => typeof value === 'string' && value.trim().length > 0;

function assertBatchInput(input) {
  if (!input || Object.keys(input).sort().join() !== 'confirmAll,excludedOfferIds,members' || input.confirmAll !== true ||
      !Array.isArray(input.members) || input.members.length === 0 || !Array.isArray(input.excludedOfferIds) ||
      input.excludedOfferIds.some(value => !text(value)) || new Set(input.excludedOfferIds).size !== input.excludedOfferIds.length ||
      input.members.some(member => !member || Object.keys(member).sort().join() !== 'candidateId,ownerInput' || !text(member.candidateId) ||
        !member.ownerInput || typeof member.ownerInput !== 'object') ||
      new Set(input.members.map(member => member.candidateId)).size !== input.members.length) {
    throw new Error('D_BATCH_AUTHORIZATION_INPUT_INVALID');
  }
  assertNoProductionSecrets(input, 'dBatchAuthorizationInput');
}

/** One owner decision, one transaction, one independent authorization per member. */
export async function commitBatchOwnerProductionAuthorization({ repository, runtimeMode, actor, input,
  configuration, serverClock }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (CENTRAL_MODES.has(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' ||
      typeof serverClock !== 'function' || !configuration) throw new Error('D_BATCH_AUTHORIZATION_CONTEXT_INVALID');
  assertBatchInput(input);
  const inputFingerprint = fingerprintCanonicalRecord({ actorId: actor.userId, input });
  const batchId = `d-batch:${inputFingerprint.slice(0, 32)}`;
  return repository.transact(document => {
    const batches = document.runtime?.dProductionBatches ?? [];
    if (!Array.isArray(batches)) throw new Error('D_BATCH_STORE_INVALID');
    const prior = batches.find(batch => batch.batchId === batchId);
    if (prior) {
      if (prior.inputFingerprint !== inputFingerprint) throw new Error('D_BATCH_REPLAY_CONFLICT');
      return { changed: false, result: structuredClone(prior) };
    }
    const observedAt = serverClock();
    const evidencePacks = document.evidencePacks ?? [];
    const currentCommissionCatalogs = document.currentCommissionCatalogs ?? [];
    const prepared = [];
    for (const member of input.members) {
      const matches = document.candidates.filter(candidate => candidate.id === member.candidateId);
      if (matches.length !== 1) throw new Error('D_BATCH_CANDIDATE_NOT_UNIQUE');
      const candidate = matches[0];
      const sku = candidate.lifecycleV11?.skuPackage;
      if (!sku || sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord ||
          sku.technicalStatus === 'unknown_outcome' || candidate.lifecycleV11?.technicalStatus === 'unknown_outcome') {
        throw new Error('D_BATCH_MEMBER_ALREADY_STARTED');
      }
      const offerId = member.ownerInput.merchantSku;
      if (input.excludedOfferIds.includes(offerId)) throw new Error('D_BATCH_EXCLUDED_OFFER');
      const decision = resolveProductionOwnerPreparation({ candidate, input: member.ownerInput, configuration,
        evidencePacks, currentCommissionCatalogs, observedAt });
      const result = createProductionAuthorization({ candidate, evidencePacks, currentCommissionCatalogs,
        candidateId: candidate.id, sourceCandidateRevision: member.ownerInput.dataRevision,
        currentCandidateRevision: candidate.dataRevision, skuPackage: sku, commercialDecision: decision,
        ownerActor: actor, authorizedAt: observedAt });
      prepared.push({ candidate, sku, result, offerId });
    }
    const first = prepared[0];
    const offerIds = new Set();
    for (const member of prepared) {
      if (offerIds.has(member.offerId)) throw new Error('D_BATCH_DUPLICATE_OFFER');
      offerIds.add(member.offerId);
      if (!text(first.candidate.sourceCapture?.offerId) ||
          member.candidate.sourceCapture?.offerId !== first.candidate.sourceCapture.offerId ||
          member.candidate.sourceUrl !== first.candidate.sourceUrl) throw new Error('D_BATCH_PRODUCT_FAMILY_MISMATCH');
      if (!sameStoreRef(member.candidate.storeRef, first.candidate.storeRef) ||
          member.candidate.targetPlatform !== first.candidate.targetPlatform) throw new Error('D_BATCH_STORE_SCOPE_MISMATCH');
      if (batches.some(batch => batch.members.some(saved => saved.offerId === member.offerId))) throw new Error('D_BATCH_OFFER_RESERVED');
    }
    if (first.candidate.targetPlatform !== 'ozon') throw new Error('D_BATCH_PLATFORM_UNSUPPORTED');
    const members = prepared.map(({ candidate, sku, result, offerId }) => ({
      candidateId: candidate.id, skuPackageId: sku.skuPackageId, offerId,
      sourceRevision: candidate.dataRevision, resultRevision: candidate.dataRevision + 1,
      authorizationId: result.productionAuthorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(result.productionAuthorization),
      status: 'authorized', taskId: null, productId: null, eVerificationId: null
    }));
    const batch = { schemaVersion: D_BATCH_PRODUCTION_AUTHORIZATION_VERSION, batchId,
      inputFingerprint, ownerActorId: actor.userId, confirmedAt: observedAt,
      storeRef: structuredClone(first.candidate.storeRef), excludedOfferIds: [...input.excludedOfferIds],
      status: 'authorized', externalRequestState: 'not_sent', members };
    assertSafeRuntimeRecord(batch, 'dBatchAuthorization');
    for (const { candidate, sku, result } of prepared) {
      candidate.lifecycleV11.skuPackage = structuredClone(result.skuPackage);
      candidate.lifecycleV11.status = 'production_authorized_awaiting_explicit_d_start';
      candidate.lifecycleV11.platformWrites = 0;
      candidate.dataRevision += 1;
      candidate.updatedAt = observedAt;
      candidate.lastModifiedBy = actor.userId;
      assertSafeBusinessMutationCandidate(candidate);
      document.runtime.operationAudit.push(createOperationAuditEvent({
        eventId: `audit:${batchId}:${candidate.id}`, action: 'authorize_batch_production_member', actor,
        candidateId: candidate.id, skuPackageId: sku.skuPackageId,
        sourceRevision: candidate.dataRevision - 1, resultRevision: candidate.dataRevision,
        fromState: 'awaiting_owner_business_confirmation', toState: 'production_authorized_awaiting_explicit_d_start',
        authorizationRef: result.productionAuthorization.authorizationId,
        idempotencyKey: batchId, serverTime: observedAt
      }));
    }
    document.runtime.dProductionBatches = [...batches, batch];
    return { changed: true, document, result: structuredClone(batch) };
  });
}
