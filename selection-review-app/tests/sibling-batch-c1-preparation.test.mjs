import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitSiblingBatchC1Preparation } from '../lib/sibling-batch-c1-preparation.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { commitBatchOwnerProductionAuthorization } from '../lib/d-batch-production-authorization.mjs';
import { siblingBatchAuthorizationInput } from '../src/siblingBatchAuthorizationInput.js';
import { prepareProductionCommercialDraft } from '../lib/production-commercial-draft.mjs';
import { buildProductionOwnerPreparationView } from '../lib/production-owner-preparation.mjs';
import { at, oneColorFixture, threeColorFixture, threeColorC2Fixture } from './fixtures/sibling-batch-final-family-fixture.mjs';

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

async function authorizePreparedColors(repository, actor, checkStale) {
  const saved = await repository.readSnapshot();
  const decisions = saved.candidates.slice(1).map((child, index) => {
    const fixture = productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
      { sourceCandidate: child, sourceAt: at });
    const candidate = prepareProductionCommercialDraft({ candidate: fixture.candidate,
      merchantSku: `SYNTHETIC-COLOR-${index}`, stock: 50 + index,
      savedByUserId: 'synthetic-owner', savedAt: at, merchantSkuClaims: [] }).candidate;
    const preparation = buildProductionOwnerPreparationView({ candidate,
      configuration: fixture.configuration, evidencePacks: fixture.evidencePacks,
      currentCommissionCatalogs: fixture.currentCommissionCatalogs, observedAt: at });
    assert.equal(preparation.ready, true);
    return { candidateId: child.id, candidate, preparation, fixture };
  });
  await repository.transact(document => {
    for (const { candidateId, candidate } of decisions) {
      const index = document.candidates.findIndex(item => item.id === candidateId);
      document.candidates[index] = structuredClone(candidate);
    }
    document.evidencePacks = structuredClone(decisions[0].fixture.evidencePacks);
    document.currentCommissionCatalogs = structuredClone(decisions[0].fixture.currentCommissionCatalogs);
    return { changed: true, document, result: null };
  });
  const parent=(await repository.readSnapshot()).candidates[0];
  const pageDecision = siblingBatchAuthorizationInput(parent,
    decisions.map(({ candidate, preparation }) => ({ ...candidate, productionOwnerPreparation: preparation })),
    decisions[0].fixture.args.input.bindingId, { inventoryAction: 'create_only' });
  assert.equal(pageDecision.ready, true, pageDecision.reason);
  const authorizationInput = pageDecision.input;
  assert.deepEqual(authorizationInput.members.map(member => member.candidateId),
    decisions.map(({ candidateId }) => candidateId));
  const beforeAuthorization = await repository.readSnapshot();
  if (checkStale) {
    const stale = structuredClone(authorizationInput);
    stale.members[stale.members.length - 1].ownerInput.dataRevision += 1;
    await assert.rejects(() => commitBatchOwnerProductionAuthorization({ repository,
      runtimeMode: 'local_development', actor, input: stale,
      configuration: decisions[0].fixture.configuration, serverClock: () => at }));
    for(const change of [
      input=>{input.members.pop();input.postImportScope.eReadbackOfferIds.pop();},
      input=>{input.members[0].candidateId='candidate:unselected';},
      input=>{input.members[1]=structuredClone(input.members[0]);},
      input=>{input.members.reverse();input.postImportScope.eReadbackOfferIds.reverse();},
      input=>{input.parentRevision+=1;},
      input=>{input.excludedOfferIds=['SYNTHETIC-WRONG-FIRST'];}
    ]){
      const altered=structuredClone(authorizationInput);change(altered);
      await assert.rejects(()=>commitBatchOwnerProductionAuthorization({repository,
        runtimeMode:'local_development',actor,input:altered,
        configuration:decisions[0].fixture.configuration,serverClock:()=>at}));
    }
    assert.deepEqual(await repository.readSnapshot(), beforeAuthorization);
  }
  const batch = await commitBatchOwnerProductionAuthorization({ repository, runtimeMode: 'local_development',
    actor, input: authorizationInput, configuration: decisions[0].fixture.configuration,
    serverClock: () => at });
  const authorized = await repository.readSnapshot();
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({repository,runtimeMode:'local_development',
    actor,input:authorizationInput,configuration:decisions[0].fixture.configuration,
    serverClock:()=>at}),batch);
  assert.deepEqual(await repository.readSnapshot(),authorized);
  assert.deepEqual(authorized.candidates[0], saved.candidates[0]);
  assert.equal(authorized.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.productionAuthorization), true);
  return batch;
}

test('a selected 32-variant family prepares exactly 31 C1/C2 cards and one 31-member authorization', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture(31);
  const before = await repository.readSnapshot();
  assert.equal(before.candidates.length, 32);
  assert.equal(before.candidates[0].lifecycleV11.skuPackage.technicalStatus, 'unknown_outcome');
  const result = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  assert.equal(result.members.length, 31);
  const saved = await repository.readSnapshot();
  assert.equal(saved.candidates.slice(1).filter(child =>
    child.lifecycleV11.skuPackage.productionConfirmationCard?.status === 'awaiting_owner_business_confirmation').length, 31);
  assert.deepEqual(saved.candidates[0], before.candidates[0]);
  const batch = await authorizePreparedColors(repository, actor, false);
  assert.equal(batch.members.length, 31);
});

test('one final owner decision authorizes all three prepared colors without authorizing the unknown first item', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  const batch = await authorizePreparedColors(repository, actor, true);
  assert.equal(batch.members.length, 3);
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
  const { repository, actor, input, childId } = await oneColorFixture();
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
    const { repository, actor, input } = await oneColorFixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});
