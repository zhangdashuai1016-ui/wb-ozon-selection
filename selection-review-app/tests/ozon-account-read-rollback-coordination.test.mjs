import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { accountReadConcurrencyFixture } from './helpers/account-read-concurrency-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitSingleOwnerProductionAuthorization } from '../lib/production-authorization.mjs';
import { createProductionAuthorizationRollbackUseCase } from '../lib/production-authorization-rollback-use-case.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../lib/software-job-repository.mjs';
import { settleDProductionPreSendStopInDocument } from '../lib/software-job-contract.mjs';
import { ozonAccountReadRefreshProductionBusy } from '../lib/ozon-account-read-coordination.mjs';

const ARCHIVES = 'productionAuthorizationRollbackArchiveV1';
const clone = value => structuredClone(value);
const candidateOf = document => document.candidates[0];
const archiveOf = document => candidateOf(document).lifecycleV11[ARCHIVES][0];
const skuOf = document => candidateOf(document).lifecycleV11.skuPackage;
let baseline;

async function claimDJob(repository, job, at) {
  const scope = job.scopeBinding;
  const binding = {
    schemaVersion: 'd-e-execution-binding-v1', serviceId: 'service:synthetic:rollback-coordination',
    serviceConfigurationVersion: 'service-config:synthetic:rollback-coordination',
    productionBinding: clone(scope.productionBinding), platform: 'ozon',
    storeRef: clone(scope.identity.storeRef), warehouseRef: scope.warehouseRef,
    credentialAlias: scope.credentialAlias, workerId: 'worker:synthetic:rollback-coordination',
    workerVersion: 'version:1', configurationEvidence: {
      evidenceRef: 'evidence:synthetic:rollback-coordination', checkedAt: at,
      expiresAt: new Date(Date.parse(at) + 300_000).toISOString()
    }
  };
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  const worker = registry.register({
    workerId: binding.workerId, version: binding.workerVersion,
    capabilities: ['ozon-production-execution'], observedAt: at
  });
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository, serverClock: () => at, workerRegistry: registry,
    resolveDEExecutionBinding: () => clone(binding)
  });
  await store.claim({
    jobId: job.jobId, worker, leaseId: 'lease:synthetic:rollback-coordination', leaseDurationMs: 60_000
  });
  return (await repository.readSnapshot()).runtime.softwareJobs.find(entry => entry.jobId === job.jobId);
}

before(async () => {
  const source = productionOwnerDecisionFixture();
  await commitSingleOwnerProductionAuthorization(source.args);
  const authorized = await source.repository.readSnapshot();
  const originalJob = authorized.runtime.softwareJobs.find(job => job.jobType === 'd_production_execution');
  const oldAuthorization = clone(skuOf(authorized).productionAuthorization);
  const at = offset => new Date(Date.parse(source.formal.at) + offset).toISOString();
  const claimed = await claimDJob(source.repository, originalJob, at(1000));
  assert.equal(claimed.status, 'claimed');
  assert.notEqual(claimed.leaseId, null);
  await source.repository.transact(document => {
    const settled = settleDProductionPreSendStopInDocument(document, {
      jobId: claimed.jobId, workerId: claimed.workerId, leaseId: claimed.leaseId,
      failureClass: 'd-production-guard-rejected:SYNTHETIC_GUARD_REJECTION'
    }, at(2000));
    assert.equal(settled.status, 'failed');
    assert.equal(settled.externalRequestState, 'not_sent');
    // A separate local revision advance makes the old frozen round no longer dispatchable.
    candidateOf(document).dataRevision += 1;
    return { changed: true, document, result: null };
  });
  const stopped = await source.repository.readSnapshot();
  const stoppedJob = stopped.runtime.softwareJobs.find(job => job.jobId === claimed.jobId);
  assert.equal(stoppedJob.leaseId, claimed.leaseId, 'Settlement preserves historical lease evidence');
  const rollback = createProductionAuthorizationRollbackUseCase({
    repository: source.repository, serverClock: () => at(3000)
  });
  await rollback.rollback({
    actor: source.args.actor,
    input: {
      candidateId: candidateOf(stopped).id, authorizationId: oldAuthorization.authorizationId,
      expectedRevision: candidateOf(stopped).dataRevision, confirmNothingWasSentToPlatform: true
    }
  });
  const archived = await source.repository.readSnapshot();
  assert.deepEqual(archived.runtime.softwareJobs.find(job => job.jobId === claimed.jobId), stoppedJob);
  assert.equal(skuOf(archived).productionAuthorization, null);
  const sku = skuOf(archived), card = sku.productionConfirmationCard;
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  await commitSingleOwnerProductionAuthorization({
    ...source.args, serverClock: () => at(4000),
    input: {
      ...source.args.input, dataRevision: candidateOf(archived).dataRevision, skuRevision: sku.dataRevision,
      cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint
    }
  });
  const signed = await source.repository.readSnapshot();
  assert.notEqual(skuOf(signed).productionAuthorization.authorizationId, oldAuthorization.authorizationId);
  baseline = Object.freeze({
    archived, signed, oldAuthorization, oldJobId: originalJob.jobId, at: at(5000),
    newAuthorizationId: skuOf(signed).productionAuthorization.authorizationId,
    binding: clone(source.configuration.productionBindings[0])
  });
});

function oldJobOf(document) {
  return document.runtime.softwareJobs.find(job => job.jobId === baseline.oldJobId);
}

async function readFixture(document) {
  const repository = createMemoryBusinessStateRepository(document);
  const read = await accountReadConcurrencyFixture({
    repository, clock: () => baseline.at, productionBinding: baseline.binding, candidateId: candidateOf(document).id
  });
  return { repository, read };
}

async function assertBlocked(document, label) {
  const original = clone(document);
  assert.equal(ozonAccountReadRefreshProductionBusy({
    document, candidateId: candidateOf(document).id
  }), true, label);
  assert.deepEqual(document, original, `${label}: coordination is read-only`);
  const { repository, read } = await readFixture(document);
  const before = await repository.readSnapshot();
  await assert.rejects(() => read.enqueue(), { code: 'OZON_ACCOUNT_READ_REFRESH_PRODUCTION_BUSY' }, label);
  assert.deepEqual(await repository.readSnapshot(), before, `${label}: rejected admission is atomic`);
  assert.equal(read.requests.length, 0, `${label}: no connector invocation`);
}

async function assertAllowed(document) {
  const original = clone(document);
  assert.equal(ozonAccountReadRefreshProductionBusy({
    document, candidateId: candidateOf(document).id
  }), false);
  assert.deepEqual(document, original);
  const { repository, read } = await readFixture(document);
  const before = await repository.readSnapshot();
  const result = await read.enqueue();
  assert.equal(result.job.status, 'queued');
  assert.equal(result.job.externalRequestState, 'not_sent');
  const after = await repository.readSnapshot();
  assert.deepEqual(after.candidates, before.candidates, 'Account admission does not change candidate or SKU revisions');
  for (const job of before.runtime.softwareJobs) {
    assert.deepEqual(after.runtime.softwareJobs.find(entry => entry.jobId === job.jobId), job);
  }
  const appended = after.runtime.softwareJobs.filter(job => !before.runtime.softwareJobs.some(old => old.jobId === job.jobId));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].jobType, 'ozon_account_read');
  assert.equal(Object.hasOwn(before.runtime, 'softwareJobAuthorizationRecords'), false,
    'This genuine production baseline has no earlier account-read grant');
  assert.equal(after.runtime.softwareJobAuthorizationRecords.length, 1);
  assert.equal(read.requests.length, 0, 'This test grants and enqueues only; it never runs the read');
}

test('a genuine rollback permits a new account read while retaining the settled historical lease', async () => {
  const document = clone(baseline.archived), job = oldJobOf(document);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempt, 1);
  assert.notEqual(job.leaseId, null);
  assert.notEqual(job.workerId, null);
  assert.notEqual(job.completedAt, null);
  assert.ok(Date.parse(job.leaseExpiresAt) > Date.parse(baseline.at));
  await assertAllowed(document);
});

test('a genuine archived round remains eligible after JSON roundtrip and before the new pristine D job starts', async () => {
  for (const saved of [baseline.archived, baseline.signed]) {
    const document = JSON.parse(JSON.stringify(saved));
    await assertAllowed(document);
  }
});

test('missing, ambiguous or incorrectly identified rollback archives never unlock account admission', async () => {
  const cases = [
    ['missing archive', document => { delete candidateOf(document).lifecycleV11[ARCHIVES]; }],
    ['empty archive', document => { candidateOf(document).lifecycleV11[ARCHIVES] = []; }],
    ['wrong schema', document => { archiveOf(document).schemaVersion = 'unsupported-rollback-archive'; }],
    ['wrong reason', document => { archiveOf(document).reason = 'synthetic-unproven-stop'; }],
    ['wrong archive ID', document => { archiveOf(document).archiveId = 'pa-rollback:someone-else:2'; }],
    ['duplicate archive', document => { candidateOf(document).lifecycleV11[ARCHIVES].push(clone(archiveOf(document))); }],
    ['missing job list', document => { delete archiveOf(document).dProductionJobIds; }],
    ['job not listed', document => { archiveOf(document).dProductionJobIds = ['job:synthetic:other']; }],
    ['duplicate job ID', document => { archiveOf(document).dProductionJobIds.push(baseline.oldJobId); }]
  ];
  for (const [label, mutate] of cases) {
    const document = clone(baseline.archived);
    mutate(document);
    await assertBlocked(document, label);
  }
});

test('every archived zero-send evidence field must remain present and consistent', async () => {
  const cases = [
    ['lifecyclePlatformWrites', 1], ['authorizationPlatformWrites', 1], ['authorizationExternalRequests', 1],
    ['assetTransportIntentAssetCount', 1], ['assetTransportExternalRequestRef', 'request:synthetic:sent'],
    ['assetTransportTransportResult', { status: 'unknown_outcome' }],
    ['productionRecord', { productionRecordId: 'record:synthetic:old' }],
    ['externalListingRecord', { listingId: 'listing:synthetic:old' }],
    ['eVerificationRecord', { verificationId: 'verification:synthetic:old' }], ['readbackHistoryLength', 1]
  ];
  for (const [field, value] of cases) {
    for (const missing of [false, true]) {
      const document = clone(baseline.archived), evidence = archiveOf(document).evidence;
      if (missing) delete evidence[field];
      else evidence[field] = value;
      await assertBlocked(document, `${field}:${missing ? 'missing' : 'changed'}`);
    }
  }
  for (const field of ['platformWrites', 'externalRequests']) {
    const document = clone(baseline.archived);
    archiveOf(document)[field] = 1;
    await assertBlocked(document, `archive.${field}`);
  }
});

test('archived authorization fingerprint and all four source revisions must match the actual job', async () => {
  const cases = [
    ['authorizationId', baseline.newAuthorizationId],
    ['recordFingerprint', 'a'.repeat(64)],
    ...['authorizedDataRevision', 'resultDataRevision', 'sourceCandidateRevision', 'resultCandidateRevision']
      .map(field => [field, archiveOf(baseline.archived).productionAuthorizationRef[field] + 1])
  ];
  for (const [field, value] of cases) {
    const document = clone(baseline.archived);
    archiveOf(document).productionAuthorizationRef[field] = value;
    await assertBlocked(document, `archived authorization ${field}`);
  }
});

test('the archived handoff must identify the same candidate, SKU, authorization and original job source', async () => {
  const cases = [
    ['candidateId', 'candidate:synthetic:other'],
    ['skuPackageId', 'sku:synthetic:other'],
    ['productionAuthorizationId', baseline.newAuthorizationId],
    ['sourceCandidateRevision', 900],
    ['resultCandidateRevision', 901],
    ['sourceSkuRevision', 900],
    ['resultSkuRevision', 901]
  ];
  for (const [field, value] of cases) {
    const document = clone(baseline.archived);
    archiveOf(document).dHandoff[field] = value;
    await assertBlocked(document, `handoff.${field}`);
  }
  for (const field of ['jobId', 'candidateId', 'skuPackageId', 'inputFingerprint']) {
    const document = clone(baseline.archived);
    archiveOf(document).dHandoff.softwareJobRef[field] = field === 'inputFingerprint' ? 'a'.repeat(64) : 'source:synthetic:other';
    await assertBlocked(document, `handoff.softwareJobRef.${field}`);
  }
});

test('a changed archived job scope cannot borrow the unchanged rollback proof', async () => {
  const cases = [
    ['authorization fingerprint', job => {
      job.scopeBinding.authorizationFingerprint = 'b'.repeat(64);
      job.scopeBinding.inputFingerprint = 'b'.repeat(64);
    }],
    ['candidate scope', job => { job.scopeBinding.candidateId = 'candidate:synthetic:other'; }],
    ['SKU scope', job => { job.scopeBinding.skuPackageId = 'sku:synthetic:other'; }],
    ['supplier identity', job => { job.scopeBinding.identity.supplierSkuId = 'supplier:synthetic:other'; }],
    ['store identity', job => { job.scopeBinding.identity.storeRef.platformStoreId = 'store:synthetic:other'; }],
    ['warehouse', job => { job.scopeBinding.warehouseRef = 'warehouse:synthetic:other'; }],
    ['credential binding', job => { job.scopeBinding.credentialAlias = 'credential-alias:synthetic:other'; }],
    ['production binding ID', job => { job.scopeBinding.productionBinding.bindingId = 'binding:synthetic:other'; }],
    ['production binding version', job => { job.scopeBinding.productionBinding.configurationVersion = 'configuration:synthetic:other'; }],
    ['merchant SKU', job => { job.scopeBinding.merchantSku = 'MERCHANT-OTHER'; }],
    ['variant', job => { job.scopeBinding.variantKey = '规格:其他'; }]
  ];
  for (const [label, mutate] of cases) {
    const document = clone(baseline.archived);
    mutate(oldJobOf(document));
    await assertBlocked(document, label);
  }
});

test('active, unknown, sent or result-bearing historical jobs cannot be treated as an archived unsent failure', async () => {
  const cases = [
    ...['queued', 'claimed', 'waiting_platform', 'unknown_outcome', 'completed'].map(status =>
      [`status ${status}`, job => { job.status = status; }]),
    ...['in_flight', 'succeeded', 'failed', 'unknown_outcome'].map(state =>
      [`external state ${state}`, job => { job.externalRequestState = state; }]),
    ['request reference', job => { job.externalRequestRef = 'request:synthetic:sent'; }],
    ['result reference', job => { job.resultRef = 'result:synthetic:old'; }],
    ['result envelope', job => { job.resultEnvelope = { schemaVersion: 'synthetic-result-envelope' }; }]
  ];
  for (const [label, mutate] of cases) {
    const document = clone(baseline.archived);
    mutate(oldJobOf(document));
    await assertBlocked(document, label);
  }
});

test('a missing or changed rollback audit event cannot replace the actual rollback history', async () => {
  for (const mutate of [
    sku => { sku.audit.history = sku.audit.history.filter(event => event.event !== 'production_authorization_rolled_back_to_pre_signature'); },
    sku => { sku.audit.history.find(event => event.event === 'production_authorization_rolled_back_to_pre_signature').archivedAuthorizationId = baseline.newAuthorizationId; },
    sku => { sku.audit.history.find(event => event.event === 'production_authorization_rolled_back_to_pre_signature').resultRevision += 1; }
  ]) {
    const document = clone(baseline.archived);
    mutate(skuOf(document));
    await assertBlocked(document, 'rollback audit source');
  }
});

test('an archived authorization reused as the current authorization never exempts its failed D job', async () => {
  const document = clone(baseline.archived);
  skuOf(document).productionAuthorization = clone(baseline.oldAuthorization);
  await assertBlocked(document, 'current authorization may not be archived away');
});

test('a real claim of the new D job blocks account admission despite the legitimate archived older round', async () => {
  const repository = createMemoryBusinessStateRepository(clone(baseline.signed));
  const current = (await repository.readSnapshot()).runtime.softwareJobs.find(job =>
    job.jobType === 'd_production_execution' && job.jobId !== baseline.oldJobId);
  assert.ok(current);
  const claimed = await claimDJob(repository, current, baseline.at);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.externalRequestState, 'not_sent');
  await assertBlocked(await repository.readSnapshot(), 'new D already claimed');
});

test('a listed archived job cannot disappear from the candidate by changing its envelope identity', async () => {
  const document = clone(baseline.archived), job = oldJobOf(document);
  job.candidateId = 'candidate:synthetic:other';
  job.scopeBinding.candidateId = job.candidateId;
  job.scopeBinding.identity.candidateId = job.candidateId;
  await assertBlocked(document, 'archive points to a job owned by another candidate');
});

test('missing or duplicate persisted jobs cannot satisfy the archived job list', async () => {
  for (const mutate of [
    document => { document.runtime.softwareJobs = document.runtime.softwareJobs.filter(job => job.jobId !== baseline.oldJobId); },
    document => { document.runtime.softwareJobs.push(clone(oldJobOf(document))); }
  ]) {
    const document = clone(baseline.archived);
    mutate(document);
    await assertBlocked(document, 'archived job collection identity');
  }
});
