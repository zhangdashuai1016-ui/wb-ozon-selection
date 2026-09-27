import test from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { createFormalC1C2Fixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { localFinalAssets, ownerDecision } from './helpers/c2-software-fixture.mjs';
import { prepareC2FinalUploadManifest, confirmC2SoftwareFinalUploads } from '../lib/c2-software-orchestrator.mjs';
import { createFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { attachSyntheticFinalPricingReview } from './fixtures/final-pricing-review-fixture.mjs';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { commitBatchOwnerProductionAuthorization } from '../lib/d-batch-production-authorization.mjs';

function fixture() {
  const source = productionOwnerDecisionFixture();
  const input = { confirmAll: true, excludedOfferIds: ['MERCHANT-FIRST-ALREADY-SENT'],
    members: [{ candidateId: source.candidate.id, ownerInput: source.args.input }],
    postImportScope: { schemaVersion: 'd-batch-post-import-scope-v1', inventoryAction: 'create_only',
      eReadbackOfferIds: [source.args.input.merchantSku] } };
  return { source, input, args: { repository: source.repository, runtimeMode: 'local_development',
    actor: source.args.actor, configuration: source.configuration, serverClock: source.args.serverClock } };
}

function twoMemberFixture() {
  const first = productionOwnerDecisionFixture();
  const formal = createFormalC1C2Fixture({ candidateId: 'candidate:batch-second', supplierSkuId: 'SHELF-SECOND',
    variantKey: '规格:黑色置物架', productName: '测试置物架', categoryPath: 'Дом / Полки' });
  const source = formal.c2.skuPackage;
  const manifest = prepareC2FinalUploadManifest({ skuPackage: source, expectedDataRevision: source.dataRevision,
    finalUploadAssets: localFinalAssets(), preparedAt: formal.at });
  const confirmed = confirmC2SoftwareFinalUploads({ skuPackage: source, expectedDataRevision: source.dataRevision,
    finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: formal.at });
  const reviewed = attachSyntheticFinalPricingReview(confirmed.skuPackage,
    { at: formal.at, candidateRevision: formal.candidate.dataRevision });
  const card = createFinalProductPlanConfirmationCard({ skuPackage: reviewed, createdAt: formal.at });
  const candidate = { ...formal.candidate, lifecycleV11: { ...formal.candidate.lifecycleV11, skuPackage: card.skuPackage } };
  const second = productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    { sourceCandidate: candidate, sourceAt: formal.at });
  const document = initialBusinessStateDocument({ now: formal.at });
  document.candidates = [first.candidate, second.candidate];
  document.evidencePacks = first.evidencePacks;
  document.currentCommissionCatalogs = first.currentCommissionCatalogs;
  const repository = createMemoryBusinessStateRepository(document);
  const input = { confirmAll: true, excludedOfferIds: ['MERCHANT-FIRST-ALREADY-SENT'], members: [
    { candidateId: first.candidate.id, ownerInput: first.args.input },
    { candidateId: second.candidate.id, ownerInput: { ...second.args.input, merchantSku: 'MERCHANT-SECOND' } }
  ], postImportScope: { schemaVersion: 'd-batch-post-import-scope-v1', inventoryAction: 'create_only',
    eReadbackOfferIds: [first.args.input.merchantSku, 'MERCHANT-SECOND'] } };
  const args = { repository, runtimeMode: 'local_development', actor: first.args.actor,
    configuration: first.configuration, serverClock: first.args.serverClock };
  return { repository, input, args };
}

test('two member authorization is atomic and each member gets its own identity', async () => {
  const { repository, input, args } = twoMemberFixture();
  const batch = await commitBatchOwnerProductionAuthorization({ ...args, input });
  assert.equal(batch.members.length, 2);
  assert.deepEqual(batch.postImportScope.eReadbackOfferIds,batch.members.map(member=>member.offerId));
  assert.equal(new Set(batch.members.map(member => member.authorizationId)).size, 2);
  const saved = await repository.readSnapshot();
  assert.equal(saved.candidates.filter(candidate => candidate.lifecycleV11.skuPackage.productionAuthorization).length, 2);
  const stale = twoMemberFixture();
  stale.input.members[1].ownerInput.dataRevision += 1;
  const before = await stale.repository.readSnapshot();
  await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...stale.args, input: stale.input }));
  assert.deepEqual(await stale.repository.readSnapshot(), before);
});

test('one batch decision saves a member authorization and a batch reservation atomically', async () => {
  const { source, input, args } = fixture();
  const first = await commitBatchOwnerProductionAuthorization({ ...args, input });
  assert.equal(first.status, 'authorized');
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].status, 'authorized');
  const saved = await source.repository.readSnapshot();
  assert.equal(saved.runtime.dProductionBatches.length, 1);
  assert.equal(saved.candidates[0].dataRevision, source.candidate.dataRevision + 1);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId,
    first.members[0].authorizationId);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.productionRecord, null);
  assert.equal(saved.runtime.softwareJobs, undefined);
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({ ...args, input }), first);
  assert.deepEqual(await source.repository.readSnapshot(), saved);
});

test('stale revision, exclusion and existing unknown outcome leave every record unchanged', async () => {
  for (const change of [
    input => { input.members[0].ownerInput.dataRevision += 1; },
    input => { input.excludedOfferIds.push(input.members[0].ownerInput.merchantSku); }
  ]) {
    const { source, input, args } = fixture();
    change(input);
    const before = await source.repository.readSnapshot();
    await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...args, input }));
    assert.deepEqual(await source.repository.readSnapshot(), before);
  }
  const { source, input, args } = fixture();
  await source.repository.transact(document => {
    document.candidates[0].lifecycleV11.skuPackage.technicalStatus = 'unknown_outcome';
    return { changed: true, document, result: null };
  });
  const before = await source.repository.readSnapshot();
  await assert.rejects(() => commitBatchOwnerProductionAuthorization({ ...args, input }), /ALREADY_STARTED/);
  assert.deepEqual(await source.repository.readSnapshot(), before);
});
test('post-import action and exact E member scope require one explicit owner decision',async()=>{
 for(const change of [
  input=>{delete input.postImportScope;},
  input=>{input.postImportScope.inventoryAction='automatic';},
  input=>{input.postImportScope.eReadbackOfferIds=[];},
  input=>{input.postImportScope.eReadbackOfferIds=['OTHER-OFFER'];}
 ]){
  const {source,input,args}=fixture();change(input);
  const before=await source.repository.readSnapshot();
  await assert.rejects(()=>commitBatchOwnerProductionAuthorization({...args,input}),
    /D_BATCH_(POST_IMPORT_SCOPE|AUTHORIZATION_INPUT)_INVALID/);
  assert.deepEqual(await source.repository.readSnapshot(),before);
 }
});
