import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { commitSiblingBatchABAndC1 } from '../lib/sibling-batch-a-b-c1.mjs';
import { candidate, addEvidenceContext, confirmedAt, currentCostRule, evidencePacks } from './fixtures/real-a-b-flow-fixture.mjs';
import { buildOwnerSkuUniformSupplyRecord } from '../lib/sku-choice-estimate.mjs';
import { parentCardBinding } from '../lib/sibling-sku-card-guard.mjs';
import { prepareSiblingBatchEvidenceInputs, runSiblingBatchEvidencePreparation,
  resolveSiblingBatchEvidenceCandidate } from '../lib/sibling-batch-evidence-preparation.mjs';
import { prepareSiblingBatchLocalEvidence, siblingBatchEvidencePreparationView } from '../lib/sibling-batch-local-evidence-use-case.mjs';

const guooFilePath = '/synthetic/GUOO-2026.7.20.xlsx';
const category = 'ozon:17028966:96063';

async function fixture({ memberCount = 2 } = {}) {
  const base = addEvidenceContext(await candidate());
  base.lifecycleEvidenceContextV11.category = category;
  const parent = structuredClone(base);
  parent.id = 'candidate:synthetic-parent';
  const parentAssets = [{ sha256: 'a'.repeat(64) }];
  parent.lifecycleV11 = { skuPackage: { supplierSkuId: '6222816678021', skuPackageId: 'sku:synthetic-parent',
    g1Identity: { candidateId: parent.id, skuPackageId: 'sku:synthetic-parent', supplierSkuId: '6222816678021',
      platform: parent.targetPlatform, storeRef: structuredClone(parent.storeRef) }, technicalStatus: 'unknown_outcome',
    productionAuthorization: { lockedScope: { supplierSkuId: '6222816678021', finalUploads: parentAssets } },
    c2FinalAssets: { productionAuthorizationPreparation: { finalUploads: parentAssets } },
    dSoftwareExecution: { checkpoints: [{ kind: 'import_task_received', taskId: 'synthetic-parent-import' }],
      attempt: { request: { productImport: { body: { items: [{ description_category_id: 17028966, type_id: 96063,
        attributes: [{ id: 9048, values: [{ value: 'SYNTHETIC-FAMILY' }] },
          { id: 85, values: [{ value: 'Нет бренда' }] }] }] } } } } } } };
  const ids = ['6222816678023', '6222816678020', '6222816678019'].slice(0, memberCount);
  parent.sourceCapture = { captureId: 'synthetic:one-capture', mode: 'a_supplier_capture',
    status: 'captured_waiting_owner_selection', sourceUrl: base.sourceCapture.sourceUrl,
    offerId: base.sourceCapture.offerId, observedAt: confirmedAt,
    selectedSkuIds: ['6222816678021', ...ids],
    skuChoices: ids.map((sourceSkuId, index) => ({ sourceSkuId, variantName: `颜色 ${index}`,
      attributes: { 颜色: `颜色 ${index}` }, priceCny: null, weight: null })) };
  const children = ids.map((sourceSkuId, index) => {
    const child = structuredClone(base);
    child.id = `candidate:synthetic-${index}`;
    child.siblingSourceV1 = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
      supplierSkuId: sourceSkuId, parentCardBinding: parentCardBinding(parent.lifecycleV11.skuPackage) };
    child.sourceCapture = { ...structuredClone(parent.sourceCapture), selectedSkuIds: [],
      skuChoices: [structuredClone(parent.sourceCapture.skuChoices[index])] };
    child.packagingCostRmb = 1.5;
    return child;
  });
  const document = initialBusinessStateDocument({ now: confirmedAt });
  document.candidates = [parent, ...children];
  document.evidencePacks = evidencePacks();
  for (const pack of document.evidencePacks.filter(item => ['commission', 'schema'].includes(item.kind))) pack.scope.category = category;
  document.rules.ozonDandanshu = currentCostRule(children[0]);
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'batch-a', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: confirmedAt });
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    shared: { salesReview: { snapshotId: base.salesSnapshotsV11[0].snapshotId,
      comparability: 'comparable', validityStatus: 'current', confidence: 'limited' },
    targetSalePriceRub: 900, unitDomesticFreight: 2, otherPurchaseCosts: 0,
    packagingCostRmb: 1.5,
    route: 'guoo-economy-small', confirmExactSkuSupply: true, confirmSalesReview: true,
    minimumOrderQuantity: 1, quantityOneEvidenceSourceNote: '合成测试：两种颜色都按一件起订核对',
    dimensionsCm: { length: 12, width: 12, height: 7 } },
    members: children.map((child, index) => ({ candidateId: child.id,
      candidateRevision: child.dataRevision, sourceSkuId: child.siblingSourceV1.supplierSkuId, unitProductPrice: 15.3 + index,
      weightKg: 0.4, merchantSku: `SYNTHETIC-VEST-${index}`, stock: 20 + index,
      targetSalePriceRub: null })) };
  return { repository, actor, input, parent, children };
}

test('one owner submission computes distinct formal B and C1 records in one transaction', async () => {
  const { repository, actor, input, parent } = await fixture();
  const result = await commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => confirmedAt, guooFilePath });
  assert.equal(result.members.length, 2);
  assert.equal(new Set(result.members.map(member => member.c1HandoffId)).size, 2);
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.candidates[0], parent);
  assert.equal(saved.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.businessPhase === 'C1'), true);
  assert.equal(saved.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.productionAuthorization === null), true);
  assert.deepEqual(saved.candidates.slice(1).map(child => child.lifecycleV11.productionCommercialDraftV1.stock), [20, 21]);
  assert.equal(result.platformWrites, 0);
});

test('a stale member, duplicate submission or cost gap saves no partial lifecycle', async () => {
  for (const mutate of [
    input => { input.members[1].candidateId = input.members[0].candidateId; },
    input => { input.shared.minimumOrderQuantity = 2; },
    input => { input.parentRevision += 1; },
    input => { input.members[1].candidateRevision += 1; }
  ]) {
    const { repository, actor, input } = await fixture();
    mutate(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
      input, serverClock: () => confirmedAt, guooFilePath }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
  const { repository, actor, input } = await fixture();
  await repository.transact(document => {
    document.candidates[2].sourceCapture.skuChoices[0].priceCny = 99;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => confirmedAt, guooFilePath }), /REAL_A_CONFIRMATION_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

async function reuseFixture(options) {
  const f=await fixture(options);
  await f.repository.transact(document=>{
    const parent=document.candidates[0];
    parent.sourceCapture.priceRanges=[{minimumQuantity:1,priceCny:18,source:'synthetic:one-piece-quote'}];
    parent.supplierDraftV1={offerId:parent.sourceCapture.offerId,goodsPriceRmb:18,domesticShippingRmb:2,allInPurchaseRmb:20,packedWeightKg:0.4};
    parent.skuUniformSupplyV1=buildOwnerSkuUniformSupplyRecord({candidate:parent,declaredAt:confirmedAt});
    parent.lifecycleV11.skuPackage.selectedSupplySnapshot={snapshotId:'synthetic:original-color-cost',ownerSupplyConfirmation:{status:'confirmed'},
      supplierOption:{offerId:parent.sourceCapture.offerId},supplierSku:{supplierSkuId:'6222816678021',attributes:{quantityOneEvidence:{captureId:parent.sourceCapture.captureId},purchaseCostComponents:{unitProductPrice:18,unitDomesticFreight:2,otherPurchaseCosts:0,actualPurchaseCost:20,currency:'CNY'}}}};
    for(const child of document.candidates.slice(1))delete child.targetPlatform;
    return {changed:true,document,result:null};
  });
  f.input.shared.reusePriorSupply=true;
  for(const member of f.input.members)member.unitProductPrice=18;
  return f;
}

test('one confirmation with no extra items creates independent A/B/C1 from captured quotes and fills only successfully confirmed legacy platforms',async()=>{
  const f=await reuseFixture(),before=await f.repository.readSnapshot();
  const result=await commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath});
  assert.equal(result.members.length,2);assert.equal(result.platformWrites,0);
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates[0],before.candidates[0]);
  for(const child of saved.candidates.slice(1)){
    assert.equal(child.targetPlatform,'ozon');assert.equal(child.lifecycleV11.skuPackage.businessPhase,'C1');
    const reuse=child.lifecycleV11.aSiblingSupplyReuseV1;
    assert.equal(reuse.costDecision,'reuse_confirmed_cost_no_additions');assert.equal(reuse.otherPurchaseCosts,0);
    assert.equal(reuse.costSourceRef,'synthetic:original-color-cost');
    const evidence=child.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.quantityOneEvidence;
    assert.equal(evidence.supplierSkuId,child.siblingSourceV1.supplierSkuId);assert.match(evidence.sourceNote,/synthetic:one-piece-quote/);
    assert.equal(child.lifecycleV11.skuPackage.productionAuthorization,null);
  }
});

test('missing offer MOQ, explicit platform conflict or invalid B leaves legacy fields and all lifecycles unchanged',async()=>{
  for(const change of [document=>{document.candidates[0].sourceCapture.priceRanges=[];},
    document=>{document.candidates[1].targetPlatform=null;},
    document=>{document.candidates[1].sourceCapture.skuChoices[0].priceCny=99;}
  ]){
    const f=await reuseFixture();await f.repository.transact(document=>{change(document);return {changed:true,document,result:null};});
    const before=await f.repository.readSnapshot();await assert.rejects(()=>commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath}));
    assert.deepEqual(await f.repository.readSnapshot(),before);
  }
});

test('an explicit extra-cost revision is counted once in the new child confirmation and preserves original costs',async()=>{
  const f=await reuseFixture(),before=await f.repository.readSnapshot();f.input.shared.otherPurchaseCosts=3;
  await commitSiblingBatchABAndC1({...f,runtimeMode:'local_development',serverClock:()=>confirmedAt,guooFilePath});
  const saved=await f.repository.readSnapshot();assert.deepEqual(saved.candidates[0],before.candidates[0]);
  for(const child of saved.candidates.slice(1)){
    const cost=child.lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.attributes.purchaseCostComponents;
    assert.equal(cost.otherPurchaseCosts,3);assert.equal(cost.actualPurchaseCost,23);
    assert.equal(child.lifecycleV11.aSiblingSupplyReuseV1.costDecision,'owner_explicit_cost_revision');
  }
});

test('batch A resolves the accepted parent category for legacy children without a saved context', async () => {
  const f = await reuseFixture();
  await f.repository.transact(document => {
    for (const child of document.candidates.slice(1)) delete child.lifecycleEvidenceContextV11;
    for (const pack of document.evidencePacks) if (pack.kind === 'schema') pack.scope.ruleVersion = 'ozon-current';
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot();
  await commitSiblingBatchABAndC1({ ...f, runtimeMode: 'local_development', serverClock: () => confirmedAt, guooFilePath });
  const saved = await f.repository.readSnapshot();
  assert.deepEqual(saved.candidates[0], before.candidates[0]);
  for (const child of saved.candidates.slice(1)) {
    assert.equal(child.lifecycleEvidenceContextV11.category, category);
    assert.equal(child.lifecycleV11.skuPackage.businessPhase, 'C1');
    assert.equal(child.lifecycleV11.skuPackage.productionAuthorization, null);
  }
});

test('the shared category resolver rejects crossed stores, family identities and changed parent bindings', async () => {
  const changes = [
    document => { document.candidates[1].storeRef.platformStoreId = 'different-store'; },
    document => { document.candidates[1].siblingSourceV1.parentCandidateId = 'other-parent'; },
    document => { document.candidates[1].siblingSourceV1.parentRevision = -1; },
    document => { document.candidates[1].siblingSourceV1.parentCardBinding.typeId += 1; },
    document => { document.candidates[0].lifecycleV11.skuPackage.g1Identity.candidateId = 'other-parent'; },
    document => { document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution.attempt.request.productImport.body.items[0].attributes[0].values[0].value = 'CHANGED'; },
    document => { document.candidates[1].lifecycleEvidenceContextV11.category = 'different-category'; }
  ];
  for (const change of changes) {
    const f = await fixture(), document = await f.repository.readSnapshot();
    change(document);
    const before = structuredClone(document);
    assert.throws(() => resolveSiblingBatchEvidenceCandidate({ document, parent: document.candidates[0],
      child: document.candidates[1], route: f.input.shared.route, packagingCostRmb: 1.5,
      submission: { supplierConfirmation: { weightKg: 0.4 } }, guooFilePath }), /SIBLING_/);
    assert.deepEqual(document, before);
  }
});

async function evidencePreparationFixture(options) {
  const f = await reuseFixture(options), document = await f.repository.readSnapshot();
  const parent = document.candidates[0], children = document.candidates.slice(1);
  for (const child of children) delete child.lifecycleEvidenceContextV11;
  document.evidencePacks = document.evidencePacks.filter(pack => pack.kind !== 'commission');
  document.evidencePacks.find(pack => pack.kind === 'schema').scope.ruleVersion = 'ozon-current';
  const defaults = { goods: '18', freight: '2', other: '0', packaging: '1.5', weight: '0.4', price: '900',
    length: '12', width: '12', height: '7', route: f.input.shared.route };
  const catalog = { catalogId: 'synthetic-sibling-preparation', version: 1, offerId: parent.sourceCapture.offerId,
    platform: 'ozon', supplierSkuIds: children.map(child => child.siblingSourceV1.supplierSkuId),
    excludedSupplierSkuIds: [parent.lifecycleV11.skuPackage.supplierSkuId], defaults, assets: [] };
  const values = { page: 0, supplyReviewed: false, shared: structuredClone(defaults), members: children.map((child, index) => ({
    candidateId: child.id, sourceSkuId: child.siblingSourceV1.supplierSkuId,
    colorRu: `synthetic-color-${index}`, platformColors: [], merchantSku: `SYNTHETIC-${index}`,
    order: [], hero: null, overrides: {} })) };
  document.runtime.siblingPreparationDrafts = [{ parentCandidateId: parent.id, sourceRevision: parent.dataRevision,
    draftRevision: 1, catalogId: catalog.catalogId, catalogVersion: catalog.version, values,
    memberRevisions: children.map(child => ({ candidateId: child.id, revision: child.dataRevision })) }];
  return { document, catalog, input: { parentCandidateId: parent.id, parentRevision: parent.dataRevision, draftRevision: 1 },
    guooFilePath, plannedAt: confirmedAt };
}

function officialPack(request, overrides = {}) {
  return { id: `commission:synthetic:${request.candidateId}:${request.candidateRevision}`, kind: 'commission', status: 'active',
    scope: structuredClone(request.scope), sourceType: 'ozon_official_commission_table',
    sourceRef: `ozon-official-commission:2026-08-01:sha256:${'b'.repeat(64)}:le1500`,
    checkedAt: confirmedAt, expiresAt: '2026-08-19T02:00:00.000Z', commissionCatalogRef: {
      effectiveFrom: '2026-08-01', fileSha256: 'b'.repeat(64), sourceUrl: 'https://docs.ozon.ru/synthetic-commission.xlsx',
      priceTier: 'le1500', matchedRow: { typeRu: 'synthetic-type', typeZh: '合成类型', mpCategoryZh: '合成类目' } },
    evidenceData: { commissionRate: 0.14, commissionEvidenceMode: 'official_reference', estimateAuthorized: false,
      officialCommissionBinding: { schemaVersion: 'ozon-official-commission-binding-v1',
        candidateId: request.candidateId, candidateRevision: request.candidateRevision,
        priceRub: request.commissionReferenceScope.priceRub } }, ...overrides };
}

test('saved draft evidence inputs preserve unapproved A, current revisions and exact parent category', async () => {
  const f = await evidencePreparationFixture(), before = structuredClone(f.document);
  const prepared = prepareSiblingBatchEvidenceInputs(f);
  assert.equal(prepared.status, 'preparation_required');
  assert.equal(prepared.productionAuthorizationGranted, false);
  assert.equal(prepared.externalRequests, 0);
  for (const member of prepared.members) {
    assert.equal(member.candidate.lifecycleEvidenceContextV11.category, category);
    assert.equal(member.candidate.targetPlatform, 'ozon');
    assert.equal(member.candidate.dataRevision, member.candidateRevision);
    assert.equal(member.candidate.lifecycleV11, undefined);
    assert.equal(member.submission.supplierConfirmation.ownerSupplyConfirmed, false);
    assert.equal(member.submission.targetSalePriceRub, 900);
    assert.deepEqual(member.plan.actions.filter(action => action.action === 'prepare_once').map(action => action.kind), ['commission']);
  }
  assert.deepEqual(f.document, before);
});

test('stale saved sources fail before providers and unknown costs remain an explicit gap', async () => {
  for (const change of [
    f => { f.input.draftRevision += 1; },
    f => { f.document.candidates[1].dataRevision += 1; },
    f => { f.document.runtime.siblingPreparationDrafts[0].catalogVersion += 1; },
    f => { f.document.candidates[1].siblingSourceV1.parentCardBinding.model = 'changed'; },
    f => { f.catalog.supplierSkuIds[1] = f.catalog.supplierSkuIds[0]; },
    f => { f.document.candidates.push(structuredClone(f.document.candidates[0])); }
  ]) {
    const f = await evidencePreparationFixture(); change(f);
    const before = structuredClone(f.document);
    assert.throws(() => prepareSiblingBatchEvidenceInputs(f), /SIBLING_BATCH_EVIDENCE_/);
    assert.deepEqual(f.document, before);
  }
  const f = await evidencePreparationFixture();
  f.document.runtime.siblingPreparationDrafts[0].values.shared.other = '';
  const prepared = prepareSiblingBatchEvidenceInputs(f);
  assert.equal(prepared.status, 'blocked_input');
  assert.equal(prepared.members.every(member => member.missing.some(gap => gap.field === 'other')), true);
  let calls = 0;
  const run = await runSiblingBatchEvidencePreparation({ prepared, providers: { commission: () => { calls += 1; } } });
  assert.equal(run.status, 'blocked_input');
  assert.equal(calls, 0);
});

test('each member receives its own current official commission while shared evidence is reused without I/O', async () => {
  const f = await evidencePreparationFixture(), before = structuredClone(f.document);
  const prepared = prepareSiblingBatchEvidenceInputs(f), requests = [];
  const run = await runSiblingBatchEvidencePreparation({ prepared, clock: () => new Date(confirmedAt),
    providers: { commission: async request => { requests.push(request); return officialPack(request); },
      schema: () => { throw new Error('Unexpected schema read'); },
      exchange_rate: () => { throw new Error('Unexpected exchange read'); },
      logistics_tariff: () => { throw new Error('Unexpected logistics read'); } } });
  assert.equal(run.status, 'completed', JSON.stringify(run.failure));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => [request.candidateId, request.candidateRevision]),
    prepared.members.map(member => [member.candidateId, member.candidateRevision]));
  assert.equal(run.evidencePacksToCommit.length, 2);
  assert.equal(new Set(run.evidencePacksToCommit.map(pack => pack.id)).size, 2);
  assert.equal(run.members.every(member => member.finalReadiness.ready), true);
  assert.equal(run.platformWrites, 0);
  assert.equal(run.productionAuthorizationGranted, false);
  assert.deepEqual(f.document, before);
});

test('wrong official commission identity stops the batch once without creating an A result', async () => {
  const f = await evidencePreparationFixture(), prepared = prepareSiblingBatchEvidenceInputs(f);
  let calls = 0;
  const run = await runSiblingBatchEvidencePreparation({ prepared, clock: () => new Date(confirmedAt),
    providers: { commission: async request => { calls += 1; const pack = officialPack(request);
      pack.evidenceData.officialCommissionBinding.candidateRevision += 1; return pack; } } });
  assert.equal(run.status, 'failed');
  assert.equal(run.failure.layer, 'final_readiness');
  assert.equal(calls, 1);
  assert.equal(run.evidencePacksToCommit.length, 0);
  assert.equal(f.document.candidates.slice(1).every(child => child.lifecycleV11 === undefined), true);
});

test('same evidence ID with different member content is rejected instead of overwriting a receipt', async () => {
  const f = await evidencePreparationFixture(), prepared = prepareSiblingBatchEvidenceInputs(f);
  await assert.rejects(() => runSiblingBatchEvidencePreparation({ prepared, clock: () => new Date(confirmedAt),
    providers: { commission: async request => officialPack(request, { id: 'commission:synthetic-collision' }) } }),
  /SIBLING_BATCH_EVIDENCE_PACK_ID_CONFLICT/);
});

test('a changed saved price at the same candidate revision explicitly invalidates only its old price reading', async () => {
  const f = await evidencePreparationFixture();
  const initial = prepareSiblingBatchEvidenceInputs(f);
  const initialRun = await runSiblingBatchEvidencePreparation({ prepared: initial,
    clock: () => new Date(confirmedAt), providers: { commission: async request => officialPack(request) } });
  assert.equal(initialRun.status, 'completed');
  f.document.evidencePacks.push(...structuredClone(initialRun.evidencePacksToCommit));
  const beforeEdit = prepareSiblingBatchEvidenceInputs(f);
  assert.equal(beforeEdit.status, 'ready_from_reuse');
  const originalRevisions = f.document.candidates.map(candidate => candidate.dataRevision);
  f.document.runtime.siblingPreparationDrafts[0].values.members[0].overrides.price = '1600';
  const beforeRun = structuredClone(f.document);
  const prepared = prepareSiblingBatchEvidenceInputs(f), requests = [];
  assert.equal(prepared.status, 'preparation_required');
  assert.equal(prepared.members[0].plan.actions.find(action => action.kind === 'commission').action, 'prepare_once');
  assert.deepEqual(prepared.members[0].excludedEvidence, [{
    evidencePackId: initialRun.evidencePacksToCommit[0].id, reason: 'official_commission_price_changed',
    candidateId: prepared.members[0].candidateId, candidateRevision: prepared.members[0].candidateRevision,
    previousPriceRub: 900, targetSalePriceRub: 1600
  }]);
  assert.equal(prepared.members[1].status, 'ready_from_reuse');
  const run = await runSiblingBatchEvidencePreparation({ prepared, clock: () => new Date(confirmedAt),
    providers: { commission: async request => {
      requests.push(request);
      const pack = officialPack(request, { id: `commission:synthetic:new-price:${request.candidateId}` });
      pack.commissionCatalogRef.priceTier = '1500_5000';
      pack.sourceRef = pack.sourceRef.replace(/le1500$/, '1500_5000');
      return pack;
    } } });
  assert.equal(run.status, 'completed', JSON.stringify(run.failure));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].commissionReferenceScope.priceRub, 1600);
  assert.equal(run.evidencePacksToCommit[0].evidenceData.officialCommissionBinding.priceRub, 1600);
  assert.deepEqual(f.document.candidates.map(candidate => candidate.dataRevision), originalRevisions);
  assert.deepEqual(f.document, beforeRun);
});

test('a new official fee reading with a different price is rejected before any other member is prepared', async () => {
  const f = await evidencePreparationFixture(), prepared = prepareSiblingBatchEvidenceInputs(f);
  let calls = 0;
  const run = await runSiblingBatchEvidencePreparation({ prepared, clock: () => new Date(confirmedAt),
    providers: { commission: async request => { calls += 1; const pack = officialPack(request);
      pack.evidenceData.officialCommissionBinding.priceRub += 1; return pack; } } });
  assert.equal(run.status, 'failed');
  assert.equal(run.failure.reason, 'SIBLING_BATCH_EVIDENCE_PREPARED_COMMISSION_PRICE_MISMATCH');
  assert.equal(calls, 1);
  assert.deepEqual(run.evidencePacksToCommit, []);
  assert.equal(run.platformWrites, 0);
  assert.equal(run.productionAuthorizationGranted, false);
});

test('batch A cannot use an old official fee reading after its current submitted price changes', async () => {
  const f = await reuseFixture();
  await f.repository.transact(document => {
    const scope = structuredClone(document.evidencePacks.find(pack => pack.kind === 'commission').scope);
    document.evidencePacks = document.evidencePacks.filter(pack => pack.kind !== 'commission');
    document.evidencePacks.push(...document.candidates.slice(1).map(child => officialPack({ scope,
      candidateId: child.id, candidateRevision: child.dataRevision, commissionReferenceScope: { priceRub: 900 } })));
    return { changed: true, document, result: null };
  });
  f.input.shared.targetSalePriceRub = 1600;
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchABAndC1({ ...f, runtimeMode: 'local_development',
    serverClock: () => confirmedAt, guooFilePath }));
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

const localCommissionVersion = { fileSha256: 'b'.repeat(64), effectiveFrom: '2026-08-01', status: 'active' };

function localCommissionReading(query) {
  return { schemaVersion: 'ozon-commission-reference-read-v1', platform: 'ozon', sellerRegion: 'CN',
    salesScheme: 'rfbs', priceRub: query.scope.priceRub, priceTier: 'le1500', commissionRate: 0.14,
    matchedRows: [{ row: 42, typeRu: 'Одежда для животных', typeZh: '宠物服装', typeEn: 'Pet clothing',
      category3Zh: '猫咪用品', mpCategoryZh: '宠物用品', brand: 'All' }],
    source: { sourceUrl: 'https://docs.ozon.ru/synthetic-commission.xlsx', sourcePage: 'Full ChinaHK',
      effectiveFrom: localCommissionVersion.effectiveFrom, fileSha256: localCommissionVersion.fileSha256,
      fileLastModified: '2026-07-30T10:00:00.000Z', downloadedAt: '2026-08-02T09:00:00.000Z',
      catalogSchemaVersion: 'ozon-official-commission-reference-v1' },
    versionState: structuredClone(localCommissionVersion), checkedAt: confirmedAt, gaps: [] };
}

async function localEvidenceFixture() {
  const f = await evidencePreparationFixture({ memberCount: 3 });
  for (const child of f.document.candidates.slice(1)) {
    child.salesSnapshotsV11[0].categoryPath = '宠物用品 > 猫咪用品 > 宠物服装';
  }
  const schema = f.document.evidencePacks.find(pack => pack.kind === 'schema');
  schema.evidenceData.descriptionCategoryId = 17028966;
  schema.evidenceData.typeId = 96063;
  return { ...f, repository: createMemoryBusinessStateRepository(f.document), runtimeMode: 'local_development',
    actor: createActorContext({ userId: 'synthetic-owner', sessionId: 'batch-local-evidence', actorType: 'human',
      roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: confirmedAt }),
    ozonCommissionReference: { catalogPath: '/synthetic/ozon-commission.json', sellerRegion: 'CN',
      versionState: structuredClone(localCommissionVersion) }, serverClock: () => confirmedAt };
}

test('concurrent local preparation commits one receipt and three independent active commissions without changing candidates', async () => {
  const f = await localEvidenceFixture(), before = await f.repository.readSnapshot();
  const firstReads = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  const readOzonCommissionReferenceImpl = async query => {
    reads += 1;
    if (reads === 2) firstReads.resolve();
    await release.promise;
    return localCommissionReading(query);
  };
  const operations = [prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl }),
    prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl })];
  const completion = Promise.all(operations);
  await Promise.race([firstReads.promise, completion]);
  release.resolve();
  const results = await completion;
  assert.deepEqual(results.map(result => result.result).sort(), ['already_prepared', 'prepared']);
  assert.equal(reads, 6);
  const saved = await f.repository.readSnapshot();
  const commissions = saved.evidencePacks.filter(pack => pack.kind === 'commission' && pack.status === 'active');
  assert.equal(commissions.length, 3);
  assert.equal(new Set(commissions.map(pack => pack.id)).size, 3);
  assert.deepEqual(commissions.map(pack => [pack.evidenceData.officialCommissionBinding.candidateId,
    pack.evidenceData.officialCommissionBinding.candidateRevision, pack.evidenceData.officialCommissionBinding.priceRub]),
  before.candidates.slice(1).map(child => [child.id, child.dataRevision, 900]));
  assert.equal(saved.runtime.siblingLocalEvidencePreparations.length, 1);
  assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].productionAuthorizationGranted, false);
  assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].externalRequests, 0);
  assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].platformWrites, 0);
  assert.deepEqual(saved.candidates, before.candidates);
  const repeated = await prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl });
  assert.equal(repeated.result, 'already_prepared');
  assert.equal(reads, 6);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
});

test('any local fee read failure persists a safe attempt while leaving candidates and all evidence uncommitted', async () => {
  for (const failedRead of [1, 2, 3]) {
    const f = await localEvidenceFixture(), before = await f.repository.readSnapshot();
    const privateMarker = 'SYNTHETIC_SECRET_DO_NOT_PERSIST';
    let reads = 0;
    const result = await prepareSiblingBatchLocalEvidence({ ...f,
      readOzonCommissionReferenceImpl: async query => {
        reads += 1;
        if (reads === failedRead) throw Object.assign(new Error(privateMarker), { code: privateMarker });
        return localCommissionReading(query);
      } });
    assert.equal(result.result, 'failed');
    assert.equal(result.failure.layer, 'provider:commission');
    assert.equal(result.failure.code, 'LOCAL_COMMISSION_READ_FAILED');
    assert.equal(Object.hasOwn(result.failure, 'reason'), false);
    assert.equal(result.failure.candidateId, before.candidates[failedRead].id);
    assert.equal(reads, failedRead);
    const saved = await f.repository.readSnapshot(), receipts = saved.runtime.siblingLocalEvidencePreparations;
    assert.equal(JSON.stringify(saved.candidates), JSON.stringify(before.candidates));
    assert.equal(JSON.stringify(saved.evidencePacks), JSON.stringify(before.evidencePacks));
    const withoutReceipt = structuredClone(saved);
    delete withoutReceipt.runtime.siblingLocalEvidencePreparations;
    assert.deepEqual(withoutReceipt, before);
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0], result.receipt);
    assert.equal(receipts[0].schemaVersion, 'sibling-local-evidence-preparation-v2');
    assert.equal(receipts[0].status, 'failed');
    assert.equal(receipts[0].attemptedAt, confirmedAt);
    assert.equal(receipts[0].attemptedBy, f.actor.userId);
    assert.equal(receipts[0].parentCandidateId, f.input.parentCandidateId);
    assert.equal(receipts[0].parentRevision, f.input.parentRevision);
    assert.equal(receipts[0].draftRevision, f.input.draftRevision);
    assert.deepEqual(receipts[0].members, before.candidates.slice(1).map(child => ({
      candidateId: child.id, candidateRevision: child.dataRevision,
      sourceSkuId: child.siblingSourceV1.supplierSkuId, priceRub: 900 })));
    assert.deepEqual(receipts[0].evidencePackIds, []);
    assert.equal(receipts[0].externalRequests, 0);
    assert.equal(receipts[0].platformWrites, 0);
    assert.equal(receipts[0].productionAuthorizationGranted, false);
    assert.equal(JSON.stringify({ saved, result }).includes(privateMarker), false);
    const restored = createMemoryBusinessStateRepository(JSON.parse(JSON.stringify(saved)));
    const restoredDocument = await restored.readSnapshot();
    const view = siblingBatchEvidencePreparationView(prepareSiblingBatchEvidenceInputs({ ...f, document: restoredDocument }), restoredDocument);
    assert.deepEqual(view.failure, result.failure);
    assert.deepEqual(view.lastAttempt, result.lastAttempt);
    assert.equal(view.ready, false);
    assert.deepEqual(await restored.readSnapshot(), saved);
  }
});

test('concurrent failed local reads retain both attempts and a later successful preparation clears the current failure', async () => {
  const f = await localEvidenceFixture(), before = await f.repository.readSnapshot();
  const bothReading = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  const readOzonCommissionReferenceImpl = async () => {
    reads += 1;
    if (reads === 2) bothReading.resolve();
    await release.promise;
    throw Object.assign(new Error('Synthetic table missing'), { code: 'CATALOG_UNREADABLE' });
  };
  const completion = Promise.all([prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl }),
    prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl })]);
  await Promise.race([bothReading.promise, completion]);
  release.resolve();
  assert.deepEqual((await completion).map(result => result.result), ['failed', 'failed']);
  const failed = await f.repository.readSnapshot();
  assert.equal(failed.runtime.siblingLocalEvidencePreparations.length, 2);
  assert.equal(failed.runtime.siblingLocalEvidencePreparations.every(receipt => receipt.status === 'failed'), true);
  assert.deepEqual(failed.candidates, before.candidates);
  assert.deepEqual(failed.evidencePacks, before.evidencePacks);
  const result = await prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: localCommissionReading });
  assert.equal(result.result, 'prepared');
  assert.equal(result.failure, null);
  assert.equal(result.lastAttempt.status, 'completed');
  const saved = await f.repository.readSnapshot();
  const view = siblingBatchEvidencePreparationView(prepareSiblingBatchEvidenceInputs({ ...f, document: saved }), saved);
  assert.equal(saved.runtime.siblingLocalEvidencePreparations.length, 3);
  assert.deepEqual(saved.runtime.siblingLocalEvidencePreparations.slice(0, 2), failed.runtime.siblingLocalEvidencePreparations);
  assert.equal(saved.evidencePacks.filter(pack => pack.kind === 'commission' && pack.status === 'active').length, 3);
  assert.equal(view.ready, true);
  assert.equal(view.failure, null);
  assert.equal(view.lastAttempt.status, 'completed');
  assert.deepEqual(saved.candidates, before.candidates);
});

test('a newly created JSON repository restores the persisted failure without another read or business change', async t => {
  const f = await localEvidenceFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'sibling-local-evidence-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'synthetic-state.json');
  await writeFile(filePath, JSON.stringify(f.document));
  let reads = 0;
  const result = await prepareSiblingBatchLocalEvidence({ ...f,
    repository: createJsonBusinessStateRepository({ filePath }), readOzonCommissionReferenceImpl: async () => {
      reads += 1;
      throw Object.assign(new Error('Synthetic table missing'), { code: 'CATALOG_UNREADABLE' });
    } });
  assert.equal(result.result, 'failed');
  const persistedBytes = await readFile(filePath, 'utf8');
  const restored = createJsonBusinessStateRepository({ filePath });
  const document = await restored.readSnapshot();
  const view = siblingBatchEvidencePreparationView(prepareSiblingBatchEvidenceInputs({ ...f, document }), document);
  assert.equal(reads, 1);
  assert.equal(view.ready, false);
  assert.deepEqual(view.failure, result.failure);
  assert.deepEqual(view.lastAttempt, result.lastAttempt);
  assert.equal(JSON.stringify(document.candidates), JSON.stringify(f.document.candidates));
  assert.equal(JSON.stringify(document.evidencePacks), JSON.stringify(f.document.evidencePacks));
  assert.equal(await readFile(filePath, 'utf8'), persistedBytes);
});

test('a late concurrent failure cannot hide evidence already committed by a successful preparation', async () => {
  const f = await localEvidenceFixture(), before = await f.repository.readSnapshot();
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  const failedOperation = prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: async () => {
    reading.resolve(); await release.promise;
    throw Object.assign(new Error('Synthetic table missing'), { code: 'CATALOG_UNREADABLE' });
  } });
  await Promise.race([reading.promise, failedOperation]);
  const succeeded = await prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: localCommissionReading });
  assert.equal(succeeded.result, 'prepared');
  const successfulState = await f.repository.readSnapshot();
  release.resolve();
  assert.equal((await failedOperation).result, 'failed');
  const saved = await f.repository.readSnapshot();
  const view = siblingBatchEvidencePreparationView(prepareSiblingBatchEvidenceInputs({ ...f, document: saved }), saved);
  assert.deepEqual(saved.runtime.siblingLocalEvidencePreparations.map(receipt => receipt.status), ['completed', 'failed']);
  assert.equal(view.lastAttempt.status, 'failed');
  assert.equal(view.ready, true);
  assert.equal(view.failure, null);
  assert.deepEqual(saved.candidates, before.candidates);
  assert.deepEqual(saved.evidencePacks, successfulState.evidencePacks);
});

test('failure history survives edits during reading but is shown only for exact current revisions and price', async () => {
  const changes = [
    { name: 'same revision price', mutate: (document) => { document.runtime.siblingPreparationDrafts[0].values.shared.price = '1600'; } },
    { name: 'draft revision', mutate: (document, input) => {
      document.runtime.siblingPreparationDrafts[0].draftRevision += 1;
      input.draftRevision += 1;
    } },
    { name: 'parent revision', mutate: (document, input) => {
      document.candidates[0].dataRevision += 1;
      document.runtime.siblingPreparationDrafts[0].sourceRevision += 1;
      input.parentRevision += 1;
    } },
    { name: 'member revision', mutate: document => {
      document.candidates[1].dataRevision += 1;
      document.runtime.siblingPreparationDrafts[0].memberRevisions[0].revision += 1;
    } }
  ];
  for (const change of changes) {
    const f = await localEvidenceFixture(), originalInput = structuredClone(f.input);
    const reading = Promise.withResolvers(), release = Promise.withResolvers();
    const operation = prepareSiblingBatchLocalEvidence({ ...f, input: originalInput, readOzonCommissionReferenceImpl: async () => {
      reading.resolve(); await release.promise;
      throw Object.assign(new Error('Synthetic table missing'), { code: 'CATALOG_UNREADABLE' });
    } });
    await Promise.race([reading.promise, operation]);
    await f.repository.transact(document => {
      change.mutate(document, f.input);
      return { changed: true, document, result: null };
    });
    const changed = await f.repository.readSnapshot();
    release.resolve();
    const result = await operation;
    assert.equal(result.result, 'failed', change.name);
    const saved = await f.repository.readSnapshot();
    assert.deepEqual(saved.candidates, changed.candidates, change.name);
    assert.deepEqual(saved.evidencePacks, changed.evidencePacks, change.name);
    assert.equal(saved.runtime.siblingLocalEvidencePreparations.length, 1);
    assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].parentRevision, originalInput.parentRevision);
    assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].draftRevision, originalInput.draftRevision);
    assert.equal(saved.runtime.siblingLocalEvidencePreparations[0].members[0].priceRub, 900);
    const prepared = prepareSiblingBatchEvidenceInputs({ ...f, document: saved });
    const view = siblingBatchEvidencePreparationView(prepared, saved);
    assert.equal(view.ready, false, change.name);
    assert.equal(view.failure, null, change.name);
    assert.equal(view.lastAttempt, null, change.name);
  }
});

test('receipt history remains bounded and reaching capacity fails before a local read', async () => {
  const f = await localEvidenceFixture();
  await prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: async () => {
    throw Object.assign(new Error('Synthetic table missing'), { code: 'CATALOG_UNREADABLE' });
  } });
  await f.repository.transact(document => {
    const receipt = document.runtime.siblingLocalEvidencePreparations[0];
    document.runtime.siblingLocalEvidencePreparations = Array.from({ length: 1000 }, () => structuredClone(receipt));
    return { changed: true, document, result: null };
  });
  const before = await f.repository.readSnapshot();
  let reads = 0;
  await assert.rejects(() => prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: query => {
    reads += 1; return localCommissionReading(query);
  } }), /SIBLING_BATCH_EVIDENCE_RECEIPT_CAPACITY/);
  assert.equal(reads, 0);
  assert.deepEqual(await f.repository.readSnapshot(), before);
});

test('the preparation view still reads legacy successful receipts without changing them', async () => {
  const f = await localEvidenceFixture();
  await prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: localCommissionReading });
  const document = await f.repository.readSnapshot();
  const receipt = document.runtime.siblingLocalEvidencePreparations[0];
  receipt.schemaVersion = 'sibling-local-evidence-preparation-v1';
  delete receipt.status;
  delete receipt.attemptedAt;
  delete receipt.attemptedBy;
  delete receipt.failure;
  const before = structuredClone(document);
  const view = siblingBatchEvidencePreparationView(prepareSiblingBatchEvidenceInputs({ ...f, document }), document);
  assert.equal(view.ready, true);
  assert.equal(view.failure, null);
  assert.equal(view.lastAttempt.status, 'completed');
  assert.equal(view.lastAttempt.attemptedAt, confirmedAt);
  assert.deepEqual(view.lastAttempt.evidencePackIds, receipt.evidencePackIds);
  assert.deepEqual(document, before);
});

test('draft, revision, cost and schema changes during local reading reject the entire evidence commit', async () => {
  const changes = [
    { name: 'draft values', mutate: document => { document.runtime.siblingPreparationDrafts[0].values.shared.price = '1600'; } },
    { name: 'draft revision', mutate: document => { document.runtime.siblingPreparationDrafts[0].draftRevision += 1; } },
    { name: 'parent revision', mutate: document => { document.candidates[0].dataRevision += 1; } },
    { name: 'child revision', mutate: document => { document.candidates[1].dataRevision += 1; } },
    { name: 'cost policy', mutate: document => { document.rules.ozonDandanshu.costPolicySnapshot.items.labelRmb.value += 1; } },
    { name: 'schema', mutate: document => { document.evidencePacks.find(pack => pack.kind === 'schema').evidenceData.schemaRevision = 'synthetic-changed'; } }
  ];
  for (const change of changes) {
    const f = await localEvidenceFixture();
    const reading = Promise.withResolvers(), release = Promise.withResolvers();
    let reads = 0;
    const operation = prepareSiblingBatchLocalEvidence({ ...f, readOzonCommissionReferenceImpl: async query => {
      reads += 1;
      if (reads === 1) { reading.resolve(); await release.promise; }
      return localCommissionReading(query);
    } });
    await Promise.race([reading.promise, operation.then(() => { throw new Error('Synthetic reader was not invoked'); })]);
    await f.repository.transact(document => {
      change.mutate(document);
      return { changed: true, document, result: null };
    });
    const changed = await f.repository.readSnapshot();
    const rejection = assert.rejects(operation, /SIBLING_BATCH_EVIDENCE_/, change.name);
    release.resolve();
    await rejection;
    assert.deepEqual(await f.repository.readSnapshot(), changed, change.name);
  }
});

test('colours created before the family rule are still judged and saved on the parent frozen snapshot', async () => {
  const f = await fixture();
  let older, newer;
  await f.repository.transact(document => {
    const [parent, ...children] = document.candidates;
    older = structuredClone(parent.salesSnapshotsV11[0]);
    newer = { ...structuredClone(older), snapshotId: 'sales:synthetic-newer-copy', currentPrice: 475,
      collectedAt: new Date(Date.parse(older.collectedAt) + 86_400_000).toISOString() };
    parent.salesSnapshotsV11 = [older, newer];
    parent.lifecycleV11.opportunityPackage = { salesSnapshots: [structuredClone(older)] };
    parent.lifecycleV11.skuPackage.inheritedSalesSnapshotRefs = [older.snapshotId];
    for (const child of children) {
      child.salesSnapshotsV11 = [structuredClone(older), structuredClone(newer)];
      child.siblingSourceV1.salesSnapshotId = newer.snapshotId; // what creation used to record: the newest copy
    }
    return { changed: true, document, result: null };
  });
  const run = input => commitSiblingBatchABAndC1({ ...f, input, runtimeMode: 'local_development', serverClock: () => confirmedAt, guooFilePath });
  const before = await f.repository.readSnapshot();
  await assert.rejects(() => run({ ...f.input, shared: { ...f.input.shared,
    salesReview: { ...f.input.shared.salesReview, snapshotId: newer.snapshotId } } }), /REAL_A_CONFIRMATION_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), before);

  await run(f.input);
  for (const child of (await f.repository.readSnapshot()).candidates.slice(1)) {
    assert.equal(child.siblingSourceV1.salesSnapshotId, older.snapshotId);
    assert.deepEqual(child.lifecycleV11.opportunityPackage.salesSnapshots.map(snapshot => snapshot.snapshotId), [older.snapshotId]);
  }
});

// 张大帅交接时指出的那条：有一个颜色利润没过线时，整批回滚，连没过线的那份结论也没存。现在整批照旧不推进，
// 但没过线的颜色把这次的利润结论记在自己身上（只追加，修订号加一），过线的颜色一点不动。
test('a colour that fails B keeps its failed profit result while the batch stays unsaved', async () => {
  const { repository, actor, input, parent, children } = await fixture();
  const quote = input.members[1].unitProductPrice;
  input.members[1].unitProductPrice = 800;
  const result = await commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor, input,
    serverClock: () => confirmedAt, guooFilePath });
  assert.equal(result.status, 'b_not_passed');
  assert.deepEqual(result.members.map(member => member.candidateId), [children[1].id]);
  assert.equal(result.passedMembers, 1);
  assert.equal(result.platformWrites, 0);
  const saved = await repository.readSnapshot();
  const [savedParent, passed, failed] = ['candidate:synthetic-parent', children[0].id, children[1].id]
    .map(id => saved.candidates.find(item => item.id === id));
  assert.deepEqual(savedParent, parent);
  assert.deepEqual(passed, children[0]);
  assert.equal(failed.lifecycleV11, children[1].lifecycleV11);
  assert.equal(failed.dataRevision, children[1].dataRevision + 1);
  assert.equal(result.members[0].resultRevision, failed.dataRevision);
  assert.equal(failed.siblingBatchBAttemptsV1.length, 1);
  const [attempt] = failed.siblingBatchBAttemptsV1;
  assert.equal(attempt.parentCandidateId, parent.id);
  assert.equal(attempt.sourceRevision, children[1].dataRevision);
  assert.notEqual(attempt.result, 'passed');
  assert.equal(attempt.profitModel.result, attempt.result);
  assert.equal(attempt.platformWrites, 0);

  // 改回能过线的货价，用新的修订号整批再交一次：两个颜色都推进，失败记录留着。
  input.members[1].unitProductPrice = quote;
  input.members[1].candidateRevision = failed.dataRevision;
  const retried = await commitSiblingBatchABAndC1({ repository, runtimeMode: 'local_development', actor, input,
    serverClock: () => confirmedAt, guooFilePath });
  assert.equal(retried.status, 'c1_inputs_ready');
  const after = (await repository.readSnapshot()).candidates.find(item => item.id === children[1].id);
  assert.equal(after.lifecycleV11.status, 'b_passed_auto_c1');
  assert.equal(after.siblingBatchBAttemptsV1.length, 1);
});

test('a tester cannot confirm batch supply and a malformed failure history cannot be replaced', async () => {
  const f = await fixture();
  const before = await f.repository.readSnapshot();
  await assert.rejects(commitSiblingBatchABAndC1({ ...f, actor: { ...f.actor, roles: ['operator'] },
    runtimeMode: 'local_development', serverClock: () => confirmedAt, guooFilePath }),
  { code: 'RUNTIME_OPERATION_FORBIDDEN' });
  assert.deepEqual(await f.repository.readSnapshot(), before);

  await f.repository.transact(document => {
    document.candidates[2].siblingBatchBAttemptsV1 = 'damaged-history';
    return { changed: true, document, result: null };
  });
  const malformed = await f.repository.readSnapshot();
  f.input.members[1].unitProductPrice = 800;
  await assert.rejects(commitSiblingBatchABAndC1({ ...f, runtimeMode: 'local_development',
    serverClock: () => confirmedAt, guooFilePath }), /SIBLING_BATCH_A_B_HISTORY_INVALID/);
  assert.deepEqual(await f.repository.readSnapshot(), malformed);
});
