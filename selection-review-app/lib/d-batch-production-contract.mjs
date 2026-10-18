import { isDeepStrictEqual } from 'node:util';

export const D_BATCH_PRODUCTION_AUTHORIZATION_VERSION = 'd-batch-production-authorization-v3';
export const D_BATCH_LEGACY_AUTHORIZATION_VERSION = 'd-batch-production-authorization-v2';
export const D_BATCH_POST_IMPORT_SCOPE_VERSION = 'd-batch-post-import-scope-v2';
export const D_BATCH_LEGACY_POST_IMPORT_SCOPE_VERSION = 'd-batch-post-import-scope-v1';
const closed = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export const supportedBatchVersion = version => ['d-batch-production-authorization-v1',
  D_BATCH_LEGACY_AUTHORIZATION_VERSION, D_BATCH_PRODUCTION_AUTHORIZATION_VERSION].includes(version);
export const supportsPostImportBatch = version => [D_BATCH_LEGACY_AUTHORIZATION_VERSION,
  D_BATCH_PRODUCTION_AUTHORIZATION_VERSION].includes(version);

/** Only the explicitly confirmed v3 scope adds the bounded, store-wide IN_SALE read. */
export function assertDBatchPostImportScope(scope, offerIds, batchVersion) {
  const current = batchVersion === D_BATCH_PRODUCTION_AUTHORIZATION_VERSION;
  const fields = ['schemaVersion', 'inventoryAction', 'eReadbackOfferIds', ...(current ? ['inSaleList'] : [])];
  if (!supportsPostImportBatch(batchVersion) || !closed(scope, fields) ||
      scope.schemaVersion !== (current ? D_BATCH_POST_IMPORT_SCOPE_VERSION : D_BATCH_LEGACY_POST_IMPORT_SCOPE_VERSION) ||
      !['create_only', 'write_authorized_stock'].includes(scope.inventoryAction) ||
      !Array.isArray(offerIds) || offerIds.length === 0 ||
      offerIds.some(value => typeof value !== 'string' || value.trim().length === 0) ||
      new Set(offerIds).size !== offerIds.length ||
      !Array.isArray(scope.eReadbackOfferIds) || !isDeepStrictEqual(scope.eReadbackOfferIds, offerIds)) {
    throw new Error('D_BATCH_POST_IMPORT_SCOPE_INVALID');
  }
  if (current) {
    const list = scope.inSaleList;
    if (!closed(list, ['schemaVersion', 'decision', 'officialEvidenceRef', 'policy']) ||
        list.schemaVersion !== 'ozon-in-sale-list-authorization-v1' ||
        list.decision !== 'read_store_in_sale_list_for_batch' ||
        list.officialEvidenceRef !== 'official:ozon-in-sale-list:20261018' ||
        !isDeepStrictEqual(list.policy, { pageSize: 1000, maxPages: 3, requestTimeoutMs: 30000, durationMs: 90000 })) {
      throw new Error('D_BATCH_IN_SALE_LIST_AUTHORIZATION_INVALID');
    }
  }
  return scope;
}
