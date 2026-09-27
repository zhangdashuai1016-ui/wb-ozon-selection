import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createC1ColorDictionaryReadUseCase } from '../lib/c1-color-dictionary-read-use-case.mjs';
import { siblingColorState } from './fixtures/sibling-color-state.mjs';
import { commitSiblingBatchC1Preparation } from '../lib/sibling-batch-c1-preparation.mjs';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { c1AiSoftwareJobFixture } from './fixtures/c1-ai-software-job-fixture.mjs';
import { normalizeSoftwareJobScopeKey } from '../lib/software-job-admission.mjs';
import { bindSoftwareJobAdmissionDecision, claimSoftwareJobLease, markSoftwareJobExternalRequestStarted,
  settleSoftwareJob, createSoftwareJobResultEnvelope } from '../lib/software-job-contract.mjs';
import { C1_SCHEMA_CONTENT_FIELDS } from '../lib/lifecycle-b-input-bundle.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { finalAssets } from './helpers/c2-software-fixture.mjs';

const at = '2026-08-12T13:00:00.000Z';

async function fixture() {
  const state = siblingColorState();
  const child = state.candidates[1];
  delete child.lifecycleV11.skuPackage.c1RightsReviewRecord;
  const formal = createFormalC1DraftFixture({ at, candidateId: 'candidate:synthetic-parent',
    supplierSkuId: 'synthetic-first', variantKey: '颜色:黑cp',
    skuAttributes: { 颜色: '黑cp', model_name: 'synthetic-model' },
    platformAttributes: structuredClone(child.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes),
    platformRequiredFields: structuredClone(child.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.requiredFields) });
  const merged = mergeC1AiDraftReceipt({ skuPackage: formal.checked.skuPackage,
    request: formal.request, receipt: formal.receipt, settledExecution: formal.settledExecution, mergedAt: at });
  const sourcePlan = merged.skuPackage.c1ProductPlan;
  const jobFixture = c1AiSoftwareJobFixture({ formalDraftFixture: formal,
    sourceCandidateRevision: formal.candidate.dataRevision, jobId: formal.receipt.softwareJobId,
    authorizationId: 'authorization:c1-ai-draft:FORMAL-C1' });
  const admitted = bindSoftwareJobAdmissionDecision(jobFixture.job, {
    schemaVersion: 'software-job-admission-v1', admissionId: 'software-job-admission:synthetic-batch-c1',
    jobId: jobFixture.job.jobId, candidateId: jobFixture.job.candidateId,
    skuPackageId: jobFixture.job.skuPackageId, revision: jobFixture.job.revision,
    jobType: jobFixture.job.jobType, normalizedScopeKey: normalizeSoftwareJobScopeKey(jobFixture.job),
    authorizationRef: jobFixture.authorizationRecord.authorizationId,
    authorizationFingerprint: 'a'.repeat(64), credentialBindingRef: jobFixture.credentialBinding.bindingId,
    credentialAlias: jobFixture.credentialBinding.credentialAlias,
    credentialBindingFingerprint: 'b'.repeat(64), phase: 'enqueue_current', observedAt: at });
  const claimed = claimSoftwareJobLease({ job: admitted, worker: jobFixture.worker,
    leaseId: 'lease:synthetic-batch-c1', serverTime: at, leaseDurationMs: 300000 });
  const inFlight = markSoftwareJobExternalRequestStarted({ job: claimed,
    workerId: jobFixture.worker.workerId, leaseId: claimed.leaseId,
    externalRequestRef: 'request:synthetic-batch-c1', serverTime: at });
  const payload = { schemaVersion: 'c1-ai-draft-software-result-v1',
    request: formal.request, receipt: formal.receipt };
  const envelope = createSoftwareJobResultEnvelope({ job: inFlight,
    resultRef: formal.receipt.receiptId, payloadKind: inFlight.jobType, payload, recordedAt: at });
  const job = settleSoftwareJob({ job: inFlight, workerId: jobFixture.worker.workerId,
    leaseId: inFlight.leaseId, status: 'completed', externalRequestState: 'succeeded',
    serverTime: at, resultEnvelope: envelope });
  job.resultEnvelope.applicationDisposition = 'applied';
  child.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules = structuredClone(sourcePlan.inputSnapshots.platformSchemaRules);
  state.evidencePacks[0].scope.ruleVersion = sourcePlan.inputSnapshots.platformSchemaRules.ruleVersion;
  state.evidencePacks[0].evidenceData = Object.fromEntries([...C1_SCHEMA_CONTENT_FIELDS, 'schemaRevision', 'requiredFields']
    .map(field => [field, structuredClone(sourcePlan.inputSnapshots.platformSchemaRules[field])]));
  const parent = { id: 'candidate:synthetic-parent', dataRevision: 7, targetStore: child.targetStore,
    storeRef: structuredClone(child.storeRef),
    sourceCapture: { captureId: 'synthetic:one-capture', offerId: 'synthetic:one-offer',
      selectedSkuIds: ['synthetic-first', child.siblingSourceV1.supplierSkuId] },
    lifecycleV11: { skuPackage: { ...merged.skuPackage, technicalStatus: 'unknown_outcome' },
      c1AiDraftRequestV1: structuredClone(formal.request), c1AiDraftJobRefV1: {
        jobId: job.jobId, jobType: job.jobType, candidateId: formal.candidate.id,
        skuPackageId: merged.skuPackage.skuPackageId, resultRevision: job.revision,
        sourceRevision: job.scopeBinding.sourceRevision, inputFingerprint: job.scopeBinding.inputFingerprint } } };
  child.sourceCapture.captureId = parent.sourceCapture.captureId;
  child.sourceCapture.offerId = parent.sourceCapture.offerId;
  state.candidates = [parent, child];
  state.runtime = { softwareJobs: [job] };
  const repository = createMemoryBusinessStateRepository(state);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'synthetic-batch-c1',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: at });
  const reader = createC1ColorDictionaryReadUseCase({ repository, runtimeMode: 'local_development',
    serverClock: () => at, readDictionaryValues: async () => ({ sourceRef: 'synthetic:official-dictionary',
      checkedAt: at, expiresAt: '2099-01-01T00:00:00.000Z', evidenceData: { complete: true,
        values: [{ value: 'synthetic-broad-color', dictionaryValueId: 910096 },
          { value: 'synthetic-broad-cp', dictionaryValueId: 910097 },
          { value: 'synthetic-broad-black', dictionaryValueId: 910098 }] } }) });
  const authorized = await reader.authorize({ actor, input: { candidateId: child.id,
    skuPackageId: child.lifecycleV11.skuPackage.skuPackageId, expectedRevision: child.dataRevision,
    attributeId: '10096' } });
  const read = await reader.continueSaved({ actor, input: { candidateId: child.id,
    skuPackageId: child.lifecycleV11.skuPackage.skuPackageId,
    expectedRevision: authorized.candidate.dataRevision, attributeId: '10096',
    authorizationId: authorized.result.authorizationId } });
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    dictionarySourceCandidateId: child.id, confirmed: true,
    rightsDeclaration: { brand: { status: 'unbranded', name: null },
      rights: { status: 'verified', basis: 'no_third_party_rights_identified' },
      reviewedAt: at, expiresAt: '2099-01-01T00:00:00.000Z' },
    members: [{ candidateId: child.id, candidateRevision: read.candidate.dataRevision,
      colorMappings: { '10096': 'synthetic-broad-color', '10097': 'synthetic-exact-color' } }] };
  return { repository, actor, input, childId: child.id };
}

async function threeColorFixture() {
  const base = await fixture();
  const additions = [
    { id: 'synthetic-cp', color: 'CP', broad: 'synthetic-broad-cp' },
    { id: 'synthetic-black', color: '黑色', broad: 'synthetic-broad-black' }
  ];
  await base.repository.transact(document => {
    const parent = document.candidates[0];
    const schema = parent.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
    for (const addition of additions) {
      const formal = createFormalC1DraftFixture({ at, candidateId: `candidate:${addition.id}`,
        supplierSkuId: addition.id, variantKey: `颜色:${addition.color}`,
        skuAttributes: { 颜色: addition.color, model_name: 'synthetic-model' },
        platformAttributes: schema.attributes, platformRequiredFields: schema.requiredFields });
      const child = structuredClone(formal.candidate);
      child.lifecycleV11.skuPackage = structuredClone(formal.created.skuPackage);
      child.storeRef = structuredClone(parent.storeRef);
      child.siblingSourceV1 = { parentCandidateId: parent.id, supplierSkuId: addition.id,
        parentCardBinding: structuredClone(document.candidates[1].siblingSourceV1.parentCardBinding) };
      child.sourceCapture = { captureId: parent.sourceCapture.captureId, offerId: parent.sourceCapture.offerId,
        selectedSkuIds: [addition.id], skuChoices: [{ sourceSkuId: addition.id,
          attributes: { 颜色: addition.color } }] };
      document.candidates.push(child);
      parent.sourceCapture.selectedSkuIds.push(addition.id);
      parent.sourceCapture.skuChoices ??= [];
      parent.sourceCapture.skuChoices.push({ sourceSkuId: addition.id, attributes: { 颜色: addition.color } });
    }
    return { changed: true, document, result: null };
  });
  const saved = await base.repository.readSnapshot();
  const members = saved.candidates.slice(1).map((child, index) => ({ candidateId: child.id,
    candidateRevision: child.dataRevision, colorMappings: { '10096': index === 0 ? 'synthetic-broad-color' : additions[index - 1].broad,
      '10097': index === 0 ? 'synthetic-exact-color' : additions[index - 1].color } }));
  return { ...base, input: { ...base.input, members }, ids: saved.candidates.slice(1).map(child => child.id) };
}

test('three selected colors share one saved dictionary and one formal parent draft but each receives its own C1 and C2', async () => {
  const { repository, actor, input, ids } = await threeColorFixture();
  const result = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(result.members.length, 3);
  assert.equal(result.externalRequests, 0);
  assert.equal(result.paidCalls, 0);
  const saved = await repository.readSnapshot();
  for (const id of ids) {
    const sku = saved.candidates.find(item => item.id === id).lifecycleV11.skuPackage;
    assert.equal(sku.businessPhase, 'C2');
    assert.equal(sku.c2FinalAssets.status, 'awaiting_final_uploads');
    assert.equal(sku.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted, false);
  }
  assert.equal(new Set(ids.map(id => saved.candidates.find(item => item.id === id).lifecycleV11.skuPackage.c1ProductPlan.c1PlanId)).size, 3);
  const replay = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test('one wrong color or one stale row saves no C1/C2 state for any of three colors', async () => {
  for (const change of [
    input => { input.members[1].colorMappings['10096'] = 'not-official'; },
    input => { input.members[2].candidateRevision += 1; }
  ]) {
    const { repository, actor, input } = await threeColorFixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

async function threeColorC2Fixture() {
  const { repository, actor, input } = await threeColorFixture();
  await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => at });
  const verifiedAssets = new Map();
  const assets = finalAssets();
  await repository.transact(document => {
    for (const [index, child] of document.candidates.slice(1).entries()) {
      const sku = child.lifecycleV11.skuPackage;
      const mainSha = String(index + 1).repeat(64);
      const main = { ...structuredClone(assets[0]), assetId: `final:synthetic:color-main:${index}`,
        assetRef: `https://assets.example.com/sibling/${index}.jpg`, sha256: mainSha,
        assetVersion: `sha256:${mainSha}`, order: 1 };
      const gallery = { ...structuredClone(assets[1]), assetId: `final:synthetic:shared-gallery:${index}`,
        assetRef: `https://assets.example.com/sibling/shared-${index}.jpg`, sha256: 'f'.repeat(64),
        assetVersion: `sha256:${'f'.repeat(64)}`, order: 2 };
      const selected = [main, gallery];
      verifiedAssets.set(child.id, selected);
      child.lifecycleV11.c2UploadDraft = { schemaVersion: 'c2-upload-draft-v1', candidateId: child.id,
        skuPackageId: sku.skuPackageId, sourceCandidateRevision: child.dataRevision,
        sourceSkuRevision: sku.dataRevision, sourceC1Fingerprint: sku.c2FinalAssets.softwareState.sourceC1Fingerprint,
        schemaEvidenceRef: sku.c2FinalAssets.targetContext.schemaEvidenceRef,
        revision: 1, uploads: selected.map(asset => ({ ...structuredClone(asset), status: 'ready' })),
        selection: selected.map(asset => ({ assetId: asset.assetId, order: asset.order })) };
    }
    return { changed: true, document, result: null };
  });
  const saved = await repository.readSnapshot();
  const c2Input = { parentCandidateId: saved.candidates[0].id,
    parentRevision: saved.candidates[0].dataRevision, confirmed: true,
    members: saved.candidates.slice(1).map(child => ({ candidateId: child.id,
      candidateRevision: child.dataRevision, draftRevision: 1,
      approvedAssetIds: child.lifecycleV11.c2UploadDraft.selection.map(item => item.assetId) })) };
  return { repository, actor, input: c2Input, verifiedAssets };
}

test('one C2 confirmation creates three independent final cards from the three-color C1 batch', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  const result = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  assert.equal(result.members.length, 3);
  const saved = await repository.readSnapshot();
  assert.equal(saved.candidates.slice(1).every(child =>
    child.lifecycleV11.skuPackage.productionConfirmationCard?.status === 'awaiting_owner_business_confirmation'), true);
  assert.equal(new Set(saved.candidates.slice(1).map(child => child.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads[0].sha256)).size, 3);
  const replay = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets: new Map(), serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test('a cross-color main image conflict saves no final card for any row', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  const saved = await repository.readSnapshot();
  const second = saved.candidates[2];
  const wrongHash = verifiedAssets.get(saved.candidates[1].id)[0].sha256;
  const secondAssets = verifiedAssets.get(second.id);
  secondAssets[0].sha256 = wrongHash;
  await repository.transact(document => {
    document.candidates[2].lifecycleV11.c2UploadDraft.uploads[0].sha256 = wrongHash;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at }));
  assert.deepEqual(await repository.readSnapshot(), before);
});

test('one saved official color receipt and common facts advance a sibling from C1 to C2 without another read', async () => {
  const { repository, actor, input, childId } = await fixture();
  const result = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(result.externalRequests, 0);
  assert.equal(result.members.length, 1);
  const saved = await repository.readSnapshot();
  const sku = saved.candidates.find(item => item.id === childId).lifecycleV11.skuPackage;
  assert.equal(sku.c1ProductPlan.status, 'seo_draft_ready');
  assert.equal(sku.c2FinalAssets.status, 'awaiting_final_uploads');
  assert.equal(sku.ozonAttributeMappingsV1.mappings[0].dictionaryValueId, 910096);
  assert.equal(sku.productionAuthorization, null);
});

test('stale revision or unsupported official color saves no partial C1 state', async () => {
  for (const change of [
    input => { input.members[0].candidateRevision += 1; },
    input => { input.members[0].colorMappings['10096'] = 'not-in-official-receipt'; }
  ]) {
    const { repository, actor, input } = await fixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});
