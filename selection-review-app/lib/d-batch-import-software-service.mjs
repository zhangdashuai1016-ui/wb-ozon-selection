import { isDeepStrictEqual } from 'node:util';
import { createProductionPlan } from './production-plan.mjs';
import { runPlatformWritePreflight } from './platform-write-preflight.mjs';
import { prepareSingleSkuDExecution } from './d-e-software-closure.mjs';
import { createStoreIsolatedOzonSellerApiDEAdapter } from './ozon-seller-api-de-adapter.mjs';
import { createPersistedDBatchImportRuntime } from './d-batch-import-runtime.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';

const clone = value => structuredClone(value);
const text = value => typeof value === 'string' && value.trim() !== '';

function savedBatch(document, batchId) {
  const matches = document.runtime?.dProductionBatches?.filter(batch => batch.batchId === batchId);
  if (matches?.length !== 1 || matches[0].schemaVersion !== 'd-batch-production-authorization-v1') {
    throw new Error('D_BATCH_SERVICE_BATCH_NOT_UNIQUE');
  }
  return matches[0];
}

function candidateFor(document, saved) {
  const matches = document.candidates.filter(candidate => candidate.id === saved.candidateId);
  if (matches.length !== 1) throw new Error('D_BATCH_SERVICE_CANDIDATE_NOT_UNIQUE');
  const candidate = matches[0], sku = candidate.lifecycleV11?.skuPackage;
  if (candidate.dataRevision !== saved.resultRevision || sku?.skuPackageId !== saved.skuPackageId ||
      sku?.productionAuthorization?.authorizationId !== saved.authorizationId ||
      fingerprintCanonicalRecord(sku.productionAuthorization) !== saved.authorizationFingerprint ||
      sku.dSoftwareExecution || sku.productionRecord || sku.eVerificationRecord) {
    throw new Error('D_BATCH_SERVICE_MEMBER_CHANGED');
  }
  return candidate;
}

function memberGrouping(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  const choices = candidate.sourceCapture?.skuChoices;
  const color = choices?.length === 1 && choices[0].sourceSkuId === sku.supplierSkuId
    ? choices[0].attributes?.颜色 : null;
  const model = candidate.siblingSourceV1?.parentCardBinding?.model;
  if (!text(color) || !text(model)) throw new Error('D_BATCH_SERVICE_GROUPING_UNVERIFIED');
  return { colorKey: color.trim(), modelKey: model.trim() };
}

function combineCapabilities(members, batch) {
  const first = members[0].adapterCapabilities;
  if (first?.status !== 'ready' || !sameStoreRef(first.storeRef, batch.storeRef)) {
    throw new Error('D_BATCH_SERVICE_CAPABILITIES_NOT_READY');
  }
  const fields = ['platform','store','storeRef','warehouseRef','credentialAlias','warehouseId',
    'adapterVersion','protocolVersion'];
  const sameProtocol = (a, b) => {
    if (!text(a?.evidenceRef) || !text(b?.evidenceRef)) return false;
    const { evidenceRef: aRef, ...aFacts } = a;
    const { evidenceRef: bRef, ...bFacts } = b;
    return text(aRef) && text(bRef) && isDeepStrictEqual(aFacts, bFacts);
  };
  const assets = new Map();
  for (const member of members) {
    const capability = member.adapterCapabilities;
    if (capability?.status !== 'ready' || fields.some(field => !isDeepStrictEqual(capability[field], first[field])) ||
        ['productImport','inventoryWrite','independentReadback'].some(field =>
          !sameProtocol(capability[field], first[field])) ||
        capability.assetTransport?.status !== 'verified' ||
        !isDeepStrictEqual(capability.assetTransport.approvedHosts, first.assetTransport?.approvedHosts)) {
      throw new Error('D_BATCH_SERVICE_ACCOUNT_EVIDENCE_CONFLICT');
    }
    for (const asset of capability.assetTransport.resolvedAssets) {
      const prior = assets.get(asset.assetId);
      if (prior && !isDeepStrictEqual(prior, asset)) throw new Error('D_BATCH_SERVICE_ASSET_ID_CONFLICT');
      assets.set(asset.assetId, asset);
    }
  }
  if (!Number.isSafeInteger(first.productImport?.maxItemsPerRequest) ||
      !text(first.productImport?.validUntil)) throw new Error('D_BATCH_SERVICE_LIMIT_EVIDENCE_REQUIRED');
  return { ...clone(first), assetTransport: { ...clone(first.assetTransport), resolvedAssets: [...assets.values()].map(asset => clone(asset)) } };
}

function sameCurrentCapabilities(saved, checked) {
  const { inspectedAt: savedAt, ...savedFacts } = saved;
  const { inspectedAt: checkedAt, ...checkedFacts } = checked;
  return text(savedAt) && text(checkedAt) && isDeepStrictEqual(savedFacts, checkedFacts);
}

/** Builds only from saved batch members, current bindings and persisted account evidence. */
export function createDBatchImportSoftwareService({ repository, runtimeMode, workerRegistry, serverClock,
  services, loadCurrentProductionBinding, loadBatchMemberEvidence, requestJson }) {
  if (typeof loadBatchMemberEvidence !== 'function' || typeof requestJson !== 'function') {
    throw new Error('D_BATCH_SERVICE_DEPENDENCY_REQUIRED');
  }
  const resolveService = candidate => {
    const bindingId = candidate.lifecycleV11.skuPackage.productionAuthorization.executionBinding.bindingId;
    const service = services.get(bindingId);
    if (!service) throw new Error('D_BATCH_SERVICE_BINDING_NOT_REGISTERED');
    const binding = loadCurrentProductionBinding(candidate, service);
    if (!binding || binding.then) throw new Error('D_BATCH_SERVICE_CURRENT_BINDING_REQUIRED');
    return { service, binding };
  };
  async function prepare(batchId, createdAt = serverClock()) {
    const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
    if (!['authorized','import_admitted','claimed','waiting_platform','partial_failure','unknown_outcome',
      'imported_awaiting_inventory'].includes(batch.status)) {
      throw new Error('D_BATCH_SERVICE_BATCH_NOT_RUNNABLE');
    }
    const members = [];
    let workerId = null;
    for (const saved of batch.members) {
      const candidate = candidateFor(document, saved);
      const { service, binding } = resolveService(candidate);
      if (workerId !== null && workerId !== service.worker.workerId) throw new Error('D_BATCH_SERVICE_WORKER_CONFLICT');
      workerId = service.worker.workerId;
      const sku = candidate.lifecycleV11.skuPackage;
      const plan = sku.dAssetTransport?.intent?.productionPlan ?? createProductionPlan({
        productionAuthorization: sku.productionAuthorization, candidateId: candidate.id,
        candidateRevision: candidate.dataRevision, skuPackage: sku, createdAt });
      const evidence = await loadBatchMemberEvidence({ candidate: clone(candidate), productionBinding: clone(binding), batch: clone(batch) });
      const preflight = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: evidence.checkedAt,
        inspectPlatform: async () => clone(evidence.inspection) });
      const prepared = prepareSingleSkuDExecution({ productionPlan: plan,
        productionAuthorization: plan.sourceAuthorization, platformWritePreflight: preflight,
        adapterCapabilities: evidence.capabilities, currentProductionBinding: binding, preparedAt: evidence.checkedAt });
      if (prepared.status !== 'ready') throw new Error(`D_BATCH_SERVICE_MEMBER_NOT_READY:${candidate.id}:${prepared.gaps.map(gap => gap.code).join(',')}`);
      const grouping = memberGrouping(candidate);
      members.push({ request: prepared.executableRequest, executionContext: { productionPlan: plan,
        currentProductionBinding: binding, serverClock: () => evidence.checkedAt },
      platformWritePreflight: preflight, adapterCapabilities: evidence.capabilities,
      ...grouping, sourceTechnicalStatus: 'not_started' });
    }
    return { batch, members, adapterCapabilities: combineCapabilities(members, batch), workerId };
  }
  const runtime = createPersistedDBatchImportRuntime({ repository, runtimeMode, workerRegistry, serverClock,
    createAdapter: async ({ adapterCapabilities }) => createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities }),
    verifyCurrentBatchEvidence: async ({ batchId, members, adapterCapabilities, chunkIndex }) => {
      const checked = await prepare(batchId, members[0].executionContext.productionPlan.createdAt);
      if (checked.workerId === null || !sameCurrentCapabilities(adapterCapabilities, checked.adapterCapabilities) ||
          members.length !== checked.members.length || members.some((member, index) =>
            !isDeepStrictEqual(member.request, checked.members[index].request)) ||
          !Number.isSafeInteger(chunkIndex)) throw new Error('D_BATCH_SERVICE_EVIDENCE_DRIFT');
    } });
  return Object.freeze({
    async runAuthorizedBatch({ batchId }) {
      const snapshot = await repository.readSnapshot();
      savedBatch(snapshot, batchId);
      const jobs = snapshot.runtime?.dBatchImportJobs?.filter(job => job.batchId === batchId) ?? [];
      if (jobs.length > 1) throw new Error('D_BATCH_SERVICE_JOB_NOT_UNIQUE');
      if (jobs.length === 1 && (jobs[0].chunks.every(chunk => chunk.status !== 'not_sent') ||
          jobs[0].chunks.some(chunk => ['intent', 'unknown_outcome'].includes(chunk.status)))) {
        return { status: 'idempotent_replay', executionStatus: jobs[0].status, job: clone(jobs[0]) };
      }
      const ready = await prepare(batchId);
      return runtime.run({ batchId, members: ready.members, adapterCapabilities: ready.adapterCapabilities,
        workerId: ready.workerId });
    },
    async observeBatchChunk({ batchId, chunkIndex }) {
      const ready = await prepare(batchId);
      return runtime.observe({ batchId, members: ready.members, adapterCapabilities: ready.adapterCapabilities,
        workerId: ready.workerId, chunkIndex });
    },
    async reclaimBatchLease({ batchId }) {
      const document = await repository.readSnapshot(), batch = savedBatch(document, batchId);
      if (batch.members.length === 0) throw new Error('D_BATCH_SERVICE_EMPTY_BATCH');
      const workerId = resolveService(candidateFor(document, batch.members[0])).service.worker.workerId;
      return runtime.reclaim({ batchId, workerId });
    }
  });
}
