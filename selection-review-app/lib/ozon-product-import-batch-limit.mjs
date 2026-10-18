import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isCompleteStoreRef } from './store-binding.mjs';

const fields = ['schemaVersion','evidenceRef','sourceUrl','operationId','endpoint','sourceStatement',
  'itemsConstraint','maxItemsPerRequest','observedAt','validUntil'];
const sourceUrl = 'https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3';
const observedAt = '2026-09-28T00:40:19.000Z';
const validUntil = '2026-10-05T00:40:19.000Z';
const evidenceUrl = new URL('../docs/contracts/ozon-product-import-batch-limit-20260928.json',import.meta.url);
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const time = value => typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
export const OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF = 'official:ozon-product-import-batch-limit:20261018';
export const OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_VERSION = 'ozon-product-import-batch-limit-fact-v1';
export const OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_VERSION = 'ozon-product-import-batch-limit-use-v1';
const currentObservedAt = '2026-10-18T13:14:14.542Z';
const factUrl = new URL('../docs/contracts/ozon-product-import-batch-limit-20261018.json', import.meta.url);
const factFields = [...fields.filter(field => field !== 'validUntil'), 'officialValidityPeriodPublished'];
const memberFields = ['candidateId', 'skuPackageId', 'offerId', 'sourceRevision', 'resultRevision',
  'authorizationId', 'authorizationFingerprint'];
const useFields = ['schemaVersion', 'evidenceRef', 'decision', 'batchId', 'storeRef', 'members',
  'confirmedBy', 'confirmedAt', 'importJobId'];

/** One versioned public per-request limit. It is neither an account method grant nor a daily quota. */
export function assertOzonProductImportBatchLimitEvidence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value,field)) ||
      value.schemaVersion !== 'ozon-product-import-batch-limit-evidence-v1' ||
      value.evidenceRef !== 'official:ozon-product-import-batch-limit:20260928' ||
      value.sourceUrl !== sourceUrl || value.operationId !== 'ProductAPI_ImportProductsV3' ||
      value.endpoint !== '/v3/product/import' ||
      value.sourceStatement !== 'В одном запросе можно передать до 100 товаров.' ||
      value.itemsConstraint !== 'items Array of objects <= 100 items' ||
      value.maxItemsPerRequest !== 100 || !iso(value.observedAt) || !iso(value.validUntil) ||
      value.observedAt !== observedAt || value.validUntil !== validUntil) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_EVIDENCE_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

/** Reads only the checked-in public fact; no account request or external network access. */
export async function loadOzonProductImportBatchLimitEvidence() {
  const data = JSON.parse(await readFile(evidenceUrl,'utf8'));
  return assertOzonProductImportBatchLimitEvidence(data);
}

/** A current public observation has no invented expiry and grants no production permission. */
export function assertOzonProductImportBatchLimitFact(value) {
  if (!closed(value, factFields) || value.schemaVersion !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_VERSION ||
      value.evidenceRef !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF || value.sourceUrl !== sourceUrl ||
      value.operationId !== 'ProductAPI_ImportProductsV3' || value.endpoint !== '/v3/product/import' ||
      value.sourceStatement !== 'В одном запросе можно передать до 100 товаров. Каждый товар — это отдельный элемент в массиве items.' ||
      value.itemsConstraint !== 'items Array of objects <= 100 items' || value.maxItemsPerRequest !== 100 ||
      value.observedAt !== currentObservedAt || value.officialValidityPeriodPublished !== false) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

export async function loadOzonProductImportBatchLimitFact() {
  return assertOzonProductImportBatchLimitFact(JSON.parse(await readFile(factUrl, 'utf8')));
}

export function assertOzonProductImportBatchLimitUseInput(input) {
  if (!closed(input, ['schemaVersion', 'evidenceRef', 'decision']) ||
      input.schemaVersion !== 'ozon-product-import-batch-limit-use-input-v1' ||
      input.evidenceRef !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF || input.decision !== 'use_for_this_batch_once') {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_INPUT_INVALID');
  }
  return input;
}

function projectUse(batch) {
  if (!batch || !Array.isArray(batch.members)) throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_CONTEXT_INVALID');
  return { schemaVersion: OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_VERSION,
    evidenceRef: OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF, decision: 'use_for_this_batch_once',
    batchId: batch.batchId, storeRef: structuredClone(batch.storeRef),
    members: batch.members.map(member => Object.fromEntries(memberFields.map(field => [field, member[field]]))),
    confirmedBy: batch.ownerActorId, confirmedAt: batch.confirmedAt, importJobId: `d-batch-import:${batch.batchId}` };
}

/** One use means one persisted import job for this immutable batch, not one preflight read. */
export function assertOzonProductImportBatchLimitUse(value, { batch = null, checkedAt = null } = {}) {
  if (!closed(value, useFields) || value.schemaVersion !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_VERSION ||
      value.evidenceRef !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF || value.decision !== 'use_for_this_batch_once' ||
      !ref(value.batchId) || value.importJobId !== `d-batch-import:${value.batchId}` ||
      !isCompleteStoreRef(value.storeRef, value.storeRef?.stableStoreId) || !ref(value.confirmedBy) ||
      !iso(value.confirmedAt) || Date.parse(value.confirmedAt) < Date.parse(currentObservedAt) ||
      !Array.isArray(value.members) || value.members.length === 0 || value.members.some(member =>
        !closed(member, memberFields) || memberFields.filter(field => !field.endsWith('Revision')).some(field => !ref(member[field])) ||
        !Number.isSafeInteger(member.sourceRevision) || member.sourceRevision < 1 ||
        !Number.isSafeInteger(member.resultRevision) || !/^[a-f0-9]{64}$/.test(member.authorizationFingerprint) ||
        member.resultRevision !== member.sourceRevision + 1) ||
      ['candidateId', 'skuPackageId', 'offerId', 'authorizationId'].some(field =>
        new Set(value.members.map(member => member[field])).size !== value.members.length)) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_INVALID');
  }
  if (batch !== null && (batch.schemaVersion !== 'd-batch-production-authorization-v3' ||
      !isDeepStrictEqual(value, projectUse(batch)))) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_SCOPE_MISMATCH');
  }
  if (checkedAt !== null && (!iso(checkedAt) || Date.parse(checkedAt) < Date.parse(value.confirmedAt))) {
    throw new Error('OZON_PRODUCT_IMPORT_BATCH_LIMIT_USE_NOT_CURRENT');
  }
  return value;
}

export function createOzonProductImportBatchLimitUse({ batch, input }) {
  assertOzonProductImportBatchLimitUseInput(input);
  return Object.freeze(assertOzonProductImportBatchLimitUse(projectUse(batch), { batch }));
}

/** Shared send gate: legacy expiring evidence or an explicitly frozen batch use, never an implicit fallback. */
export function assertOzonBatchImportLimitCapability(productImport, { batch = null, checkedAt } = {}) {
  const limit = productImport?.maxItemsPerRequest;
  if (productImport?.status !== 'verified' || !ref(productImport.evidenceRef) ||
      productImport.endpoint !== '/v3/product/import' || !ref(productImport.limitEvidenceRef) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !time(productImport.limitObservedAt) || !time(checkedAt)) {
    throw new Error('OZON_BATCH_LIMIT_EVIDENCE_REQUIRED');
  }
  if (Object.hasOwn(productImport, 'limitUse')) {
    assertOzonProductImportBatchLimitUse(productImport.limitUse, { batch, checkedAt });
    if (limit !== 100 || productImport.limitEvidenceRef !== OZON_PRODUCT_IMPORT_BATCH_LIMIT_FACT_REF ||
        productImport.limitObservedAt !== currentObservedAt || Object.hasOwn(productImport, 'validUntil')) {
      throw new Error('OZON_BATCH_LIMIT_EVIDENCE_REQUIRED');
    }
  } else if (batch?.schemaVersion === 'd-batch-production-authorization-v3' ||
      !time(productImport.validUntil) || Date.parse(checkedAt) < Date.parse(productImport.limitObservedAt) ||
      Date.parse(checkedAt) >= Date.parse(productImport.validUntil)) {
    throw new Error('OZON_BATCH_LIMIT_EVIDENCE_REQUIRED');
  }
  return productImport;
}
