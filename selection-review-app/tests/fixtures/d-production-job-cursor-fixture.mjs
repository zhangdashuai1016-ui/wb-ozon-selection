import { createSyntheticDCompletionAdapter } from "../helpers/d-synthetic-completion-adapter.mjs";
import { preparedFixture, capabilities } from '../helpers/d-software-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { runPersistedDExecution } from '../../lib/d-e-software-integration.mjs';
import { createDProductionJobScope } from '../../lib/d-e-software-job-scope.mjs';
import { createPersistableAliyunOssAssetIntent, markAliyunOssAssetIntentPersisted, executeAliyunOssAssetIntent, settleAliyunOssAssetIntent } from '../../lib/aliyun-oss-d-asset-integration.mjs';

export const CURSOR_NOW = '2026-08-22T07:30:00.000Z';

/** Captures actual domain transitions with synthetic transports; never rewrites a terminal into an in-flight fixture. */
export async function dProductionJobCursorFixture({ oss = false } = {}) {
  const { fixture, plan, preflight, prepared, currentProductionBinding } = await preparedFixture();
  const sku = structuredClone(fixture.skuPackage);
  const initial = { id: fixture.candidateId, dataRevision: fixture.candidateRevision,
    targetStore: sku.targetStore, storeRef: structuredClone(sku.g1Identity.storeRef), lifecycleV11: { skuPackage: sku } };
  const job = { jobType: 'd_production_execution', jobId: 'job:synthetic:d-cursor', candidateId: initial.id,
    skuPackageId: sku.skuPackageId, revision: initial.dataRevision, scopeBinding: createDProductionJobScope({ candidate: initial, observedAt: CURSOR_NOW }) };
  const saved = [structuredClone(initial)];
  const repository = createMemoryBusinessStateRepository({ candidates: [initial] });
  const observedRepository = { ...repository, transact: mutator => repository.transact(async document => {
    const result = await mutator(document);
    if (result.changed) saved.push(structuredClone(result.document.candidates[0]));
    return result;
  }) };
  const request = prepared.executableRequest;
  const adapterCapabilities = capabilities(request.store, plan.sourceAuthorization.lockedScope.finalUploads, request);
  adapterCapabilities.warehouseId = request.inventoryWrite.warehouseId;
  if (oss) {
    let persistedIntent;
    await observedRepository.transact(document => {
      const candidate = document.candidates[0];
      const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision,
        ownerDecision: { confirmed: true, confirmedBy: 'owner', authorizationId: sku.productionAuthorization.authorizationId,
          skuPackageId: sku.skuPackageId, finalUploadAssetIds: request.finalUploads.map(asset => asset.assetId) }, startedAt: plan.createdAt });
      persistedIntent = markAliyunOssAssetIntentPersisted({ intent, persistedAt: CURSOR_NOW, persistedCandidateRevision: candidate.dataRevision + 1 });
      candidate.dataRevision += 1;
      candidate.lifecycleV11.skuPackage.dAssetTransport = { schemaVersion: 'aliyun-oss-d-asset-state-v1', status: 'in_flight', executionRevision: 1,
        intent: structuredClone(persistedIntent), assetTransport: null, automaticRetry: false, platformWrites: 0 };
      return { changed: true, document, result: null };
    });
    const candidate = (await repository.readSnapshot()).candidates[0];
    const result = await executeAliyunOssAssetIntent({ persistedIntent, candidate, currentProductionBinding, serverClock: () => CURSOR_NOW,
      upload: async ({ finalUploads, beforePublicWrite }) => {
        for (const { assetId, sha256, order } of finalUploads) beforePublicWrite({ assetId, sha256, order });
        return { ...structuredClone(adapterCapabilities.assetTransport), mode: 'preapproved_stable_https' };
      } });
    if (result.status !== 'verified') throw new Error(`Synthetic OSS result failed: ${result.status}`);
    await observedRepository.transact(document => {
      const current = document.candidates[0];
      const settled = settleAliyunOssAssetIntent({ candidate: current, persistedIntent, result, settledAt: CURSOR_NOW });
      document.candidates[0] = settled; settled.dataRevision += 1;
      return { changed: true, document, result: null };
    });
  }
  const current = (await repository.readSnapshot()).candidates[0];
  const ownerExecutionDecision = { confirmed: true, authorizationId: request.sourceAuthorizationId, productionPlanId: request.sourceProductionPlanId,
    store: request.store, storeRef: request.storeRef, warehouseRef: request.warehouseRef, credentialAlias: request.credentialAlias,
    merchantSku: request.merchantSku, skuPackageId: request.skuPackageId, supplierSkuId: request.supplierSkuId, publishScope: request.publishScope,
    assetsFinalUploadsVersion: request.assetsFinalUploadsVersion, platformWritePrice: request.platformWritePrice, stock: request.stock,
    finalUploadAssetIds: request.finalUploads.map(asset => asset.assetId) };
  const outcome = await runPersistedDExecution({ repository: observedRepository, runtimeMode: 'local_development',
    actor: createActorContext({ userId: 'owner:synthetic', sessionId: 'session:synthetic:cursor', actorType: 'human', roles: ['owner'],
      source: 'authenticated_identity_provider', authenticatedAt: CURSOR_NOW }), candidateId: current.id, expectedCandidateRevision: current.dataRevision,
    productionPlan: plan, platformWritePreflight: preflight, currentProductionBinding, adapterCapabilities, ownerExecutionDecision, serverClock: () => CURSOR_NOW,
    createAdapter: ({request}) => createSyntheticDCompletionAdapter({request}) });
  if (outcome.status !== 'succeeded') throw new Error(`Synthetic D result failed: ${outcome.status}`);
  return { job, snapshots: saved };
}
