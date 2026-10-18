import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOzonProductImportBatchLimitEvidence,
  loadOzonProductImportBatchLimitEvidence, loadOzonProductImportBatchLimitFact,
  assertOzonProductImportBatchLimitFact, createOzonProductImportBatchLimitUse,
  assertOzonProductImportBatchLimitUse, assertOzonBatchImportLimitCapability } from '../lib/ozon-product-import-batch-limit.mjs';

test('versioned official import limit is one request of 100 items, not an account quota',async()=>{
  const evidence=await loadOzonProductImportBatchLimitEvidence();
  assert.equal(evidence.sourceUrl,'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3');
  assert.equal(evidence.maxItemsPerRequest,100);
  assert.equal(evidence.endpoint,'/v3/product/import');
  assert.equal(evidence.validUntil,'2026-10-05T00:40:19.000Z');
  assert.equal(Object.hasOwn(evidence,'dailyRemaining'),false);
  assert.equal(Object.isFrozen(evidence),true);
  assert.deepEqual(assertOzonProductImportBatchLimitEvidence(evidence),evidence);
  for(const patch of [
    {maxItemsPerRequest:101}, {maxItemsPerRequest:99},
    {sourceUrl:'https://example.test/claim'}, {operationId:'OtherOperation'},
    {sourceStatement:'up to 1000'}, {itemsConstraint:'items <= 1000'},
    {evidenceRef:'official:ozon-product-import-batch-limit:other'},
    {validUntil:'2026-10-06T00:40:19.000Z'},
    {observedAt:'2026-09-29T00:40:19.000Z'},
    {dailyRemaining:100}
  ]){
    assert.throws(()=>assertOzonProductImportBatchLimitEvidence({...evidence,...patch}),
      /OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID/);
  }
});

const at = '2026-10-18T13:15:00.000Z';
const input = { schemaVersion:'ozon-product-import-batch-limit-use-input-v1',
  evidenceRef:'official:ozon-product-import-batch-limit:20261018', decision:'use_for_this_batch_once' };
function batchFixture() {
  return { schemaVersion:'d-batch-production-authorization-v3', batchId:'d-batch:limit-test',
    storeRef:{stableStoreId:'miska',platformStoreId:'synthetic-miska',mappingVersion:'synthetic-v1'},
    ownerActorId:'synthetic-owner', confirmedAt:at,
    members:[{candidateId:'candidate:one',skuPackageId:'sku:one',offerId:'ONE',sourceRevision:2,resultRevision:3,
      authorizationId:'pa:one',authorizationFingerprint:'a'.repeat(64)}] };
}

test('current official limit is a bounded public fact without a fabricated validity window', async () => {
  const fact = await loadOzonProductImportBatchLimitFact();
  assert.equal(fact.maxItemsPerRequest,100);
  assert.equal(fact.officialValidityPeriodPublished,false);
  assert.equal(Object.hasOwn(fact,'validUntil'),false);
  assert.deepEqual(assertOzonProductImportBatchLimitFact(fact),fact);
  for (const patch of [{validUntil:'2099-01-01T00:00:00.000Z'}, {maxItemsPerRequest:101},
    {observedAt:at}, {officialValidityPeriodPublished:true}, {sourceUrl:'https://example.test/fact'}]) {
    assert.throws(() => assertOzonProductImportBatchLimitFact({...fact,...patch}), /LIMIT_FACT_INVALID/);
  }
  assert.throws(() => assertOzonProductImportBatchLimitEvidence(fact), /LIMIT_EVIDENCE_INVALID/);
});

test('one batch adoption binds store, members, revisions, PA and the unique import job without consuming preflight reads', async () => {
  const fact = await loadOzonProductImportBatchLimitFact(), batch = batchFixture();
  const use = createOzonProductImportBatchLimitUse({batch,input});
  batch.importLimitUse=use;
  assert.equal(use.importJobId,`d-batch-import:${batch.batchId}`);
  assert.deepEqual(use.members,batch.members);
  const capability={status:'verified',endpoint:'/v3/product/import',evidenceRef:'synthetic:method-permission',
    maxItemsPerRequest:fact.maxItemsPerRequest,limitEvidenceRef:fact.evidenceRef,
    limitObservedAt:fact.observedAt,limitUse:use};
  const before=structuredClone(batch);
  for(let round=0;round<3;round++) {
    assert.equal(assertOzonBatchImportLimitCapability(capability,{batch,checkedAt:at}),capability);
  }
  assert.deepEqual(batch,before);
  for(const change of [b=>{b.batchId='d-batch:other';}, b=>{b.storeRef.stableStoreId='dandanshu';},
    b=>{b.members[0].resultRevision++;}, b=>{b.members[0].authorizationFingerprint='b'.repeat(64);},
    b=>{b.ownerActorId='other-owner';}]) {
    const changed=structuredClone(batch);change(changed);
    assert.throws(()=>assertOzonProductImportBatchLimitUse(use,{batch:changed}),/LIMIT_USE_SCOPE_MISMATCH/);
  }
  assert.throws(()=>assertOzonBatchImportLimitCapability({...capability,validUntil:null},{batch,checkedAt:at}),/LIMIT_EVIDENCE_REQUIRED/);
  assert.throws(()=>assertOzonBatchImportLimitCapability({...capability,limitUse:null},{batch,checkedAt:at}),/LIMIT_USE_INVALID/);
  assert.throws(()=>assertOzonBatchImportLimitCapability(capability,{batch:{...batch,schemaVersion:'d-batch-production-authorization-v2'},checkedAt:at}),/LIMIT_USE_SCOPE_MISMATCH/);
  assert.throws(()=>assertOzonProductImportBatchLimitUse(use,{checkedAt:'2026-10-18T13:14:00.000Z'}),/LIMIT_USE_NOT_CURRENT/);
  assert.throws(()=>createOzonProductImportBatchLimitUse({batch:{...batch,confirmedAt:'2026-10-18T13:14:00.000Z'},input}),/LIMIT_USE_INVALID/);
  assert.throws(()=>createOzonProductImportBatchLimitUse({batch,input:{...input,decision:'automatic'}}),/LIMIT_USE_INPUT_INVALID/);
});

test('a new batch cannot inherit a legacy still-current import limit or an expired legacy fallback', async () => {
  const legacy=await loadOzonProductImportBatchLimitEvidence();
  const capability={status:'verified',endpoint:'/v3/product/import',evidenceRef:'synthetic:method-permission',
    maxItemsPerRequest:legacy.maxItemsPerRequest,limitEvidenceRef:legacy.evidenceRef,
    limitObservedAt:legacy.observedAt,validUntil:legacy.validUntil};
  assert.equal(assertOzonBatchImportLimitCapability(capability,{checkedAt:legacy.observedAt}),capability);
  assert.throws(()=>assertOzonBatchImportLimitCapability(capability,{checkedAt:legacy.validUntil}),/LIMIT_EVIDENCE_REQUIRED/);
  assert.throws(()=>assertOzonBatchImportLimitCapability(capability,{batch:batchFixture(),checkedAt:legacy.observedAt}),/LIMIT_EVIDENCE_REQUIRED/);
});
