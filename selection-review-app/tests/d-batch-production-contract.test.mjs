import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDBatchPostImportScope, supportedBatchVersion, supportsPostImportBatch } from '../lib/d-batch-production-contract.mjs';

const offers=['ONE','TWO'];
const legacy={schemaVersion:'d-batch-post-import-scope-v1',inventoryAction:'write_authorized_stock',eReadbackOfferIds:offers};
const current={...legacy,schemaVersion:'d-batch-post-import-scope-v2',inSaleList:{
  schemaVersion:'ozon-in-sale-list-authorization-v1',decision:'read_store_in_sale_list_for_batch',
  officialEvidenceRef:'official:ozon-in-sale-list:20261018',
  policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}};

test('old batch scopes remain exact and cannot acquire a store-wide read through version mixing',()=>{
  assert.equal(supportedBatchVersion('d-batch-production-authorization-v1'),true);
  assert.equal(supportsPostImportBatch('d-batch-production-authorization-v1'),false);
  assert.equal(supportedBatchVersion('d-batch-production-authorization-v4'),false);
  assert.equal(assertDBatchPostImportScope(legacy,offers,'d-batch-production-authorization-v2'),legacy);
  assert.equal(assertDBatchPostImportScope(current,offers,'d-batch-production-authorization-v3'),current);
  for(const [scope,version] of [[current,'d-batch-production-authorization-v2'],[legacy,'d-batch-production-authorization-v3'],
    [{...current,extra:true},'d-batch-production-authorization-v3']]) {
    assert.throws(()=>assertDBatchPostImportScope(scope,offers,version),/POST_IMPORT_SCOPE_INVALID/);
  }
  assert.throws(()=>assertDBatchPostImportScope(current,[...offers].reverse(),'d-batch-production-authorization-v3'),/POST_IMPORT_SCOPE_INVALID/);
  for(const patch of [{maxPages:4},{pageSize:999},{requestTimeoutMs:31000},{durationMs:91000},{extra:true}]) {
    assert.throws(()=>assertDBatchPostImportScope({...current,inSaleList:{...current.inSaleList,
      policy:{...current.inSaleList.policy,...patch}}},offers,'d-batch-production-authorization-v3'),/IN_SALE_LIST_AUTHORIZATION_INVALID/);
  }
});
