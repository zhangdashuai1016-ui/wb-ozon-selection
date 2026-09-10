import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

export const LINKFOX_DISCOVERY_CONTRACT_VERSION = 'linkfox-discovery-93a1dbf-v1';
export const LINKFOX_DISCOVERY_GATEWAY = 'https://tool-gateway.linkfox.com';
export const LINKFOX_DISCOVERY_METHODS = Object.freeze(['ozon_market_search', 'supplier_search']);
export const LINKFOX_DISCOVERY_COSTS = Object.freeze({ unit: 'linkfox_credits', ozon_market_search: 12,
  supplier_search: 9, failureCharge: 'unknown', emptyCharge: 'unknown' });
const endpoints = Object.freeze({ ozon_market_search: '/seerfar/ozon/productReportSearch', supplier_search: '/dld/productSearch' });
const codes = new Set(['INPUT_INVALID', 'RESPONSE_INVALID', 'RESPONSE_LIMIT', 'IDENTITY_INVALID', 'AUTHENTICATION_REQUIRED',
  'BILLING_FAILED', 'RATE_LIMITED', 'PROVIDER_FAILED', 'BINDING_INVALID', 'CREDENTIAL_MISSING', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_READ_FAILED', 'NETWORK_FAILED', 'TIMEOUT', 'ALREADY_ATTEMPTED']);
export class LinkfoxDiscoveryError extends Error {
  constructor(code) {
    if (!codes.has(code)) throw new TypeError('LINKFOX_DISCOVERY_ERROR_CODE_INVALID');
    super(`LINKFOX_DISCOVERY_${code}`); this.name = 'LinkfoxDiscoveryError'; this.code = code;
  }
}
const check = (condition, code = 'RESPONSE_INVALID') => { if (!condition) throw new LinkfoxDiscoveryError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const positiveInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function closed(value, fields) {
  check(object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), 'INPUT_INVALID');
}
/** A bounded discovery request, not paid authorization or an A-stage conclusion. */
export function buildLinkfoxDiscoveryRequest(input) {
  closed(input, ['requestId', 'method', 'keywords', 'pageSize']);
  check(isCanonicalFrozenRef(input.requestId) && LINKFOX_DISCOVERY_METHODS.includes(input.method), 'INPUT_INVALID');
  const supplier = input.method === 'supplier_search';
  check(Array.isArray(input.keywords) && input.keywords.length >= 1 && input.keywords.length <= (supplier ? 1 : 2) &&
    input.keywords.every(value => text(value, supplier ? 50 : 100) && value === value.trim()) && new Set(input.keywords).size === input.keywords.length &&
    positiveInteger(input.pageSize) && input.pageSize <= (supplier ? 10 : 20) && (!supplier || input.pageSize === 10), 'INPUT_INVALID');
  if (supplier) check(/\p{Script=Han}/u.test(input.keywords[0]), 'INPUT_INVALID');
  assertSafeRuntimeRecord(input);
  const body = supplier ? { keyWord: input.keywords[0], pageIndex: 1, pageSize: input.pageSize, cycle: '30',
    searchType: 1, sortField: 'orderCount30d', sortType: 'desc' }
    : { keywords: [...input.keywords], page: { page: 1, pageSize: input.pageSize, orders: [{ field: 'revenue', direction: 'DESC' }] } };
  return { schemaVersion: 'linkfox-discovery-request-v1', provider: 'linkfox', contractVersion: LINKFOX_DISCOVERY_CONTRACT_VERSION,
    ...structuredClone(input), endpoint: endpoints[input.method], body };
}
export function assertLinkfoxDiscoveryRequest(request) {
  check(object(request), 'INPUT_INVALID');
  const expected = buildLinkfoxDiscoveryRequest(Object.fromEntries(['requestId', 'method', 'keywords', 'pageSize'].map(key => [key, request[key]])));
  check(isDeepStrictEqual(request, expected), 'INPUT_INVALID');
  return expected;
}
function productUrl(value, id, supplier) {
  check(text(value, 2048), 'IDENTITY_INVALID');
  let url;
  try { url = new URL(value); } catch (error) { if (error instanceof TypeError) throw new LinkfoxDiscoveryError('IDENTITY_INVALID'); throw error; }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash, 'IDENTITY_INVALID');
  if (supplier) {
    check(url.hostname === 'detail.1688.com' && url.pathname === `/offer/${id}.html`, 'IDENTITY_INVALID');
    return `https://detail.1688.com/offer/${id}.html`;
  }
  check(['ozon.ru', 'www.ozon.ru'].includes(url.hostname) && url.pathname.startsWith('/product/') &&
    url.pathname.match(/(?:\/|[-])(\d+)\/?$/)?.[1] === id, 'IDENTITY_INVALID');
  return `https://www.ozon.ru/product/${id}/`;
}
function optionalCount(row, field) {
  if (!Object.hasOwn(row, field) || row[field] === null) return 'unknown';
  check(nonnegativeInteger(row[field])); return row[field];
}
function normalizeRow(row, supplier) {
  check(object(row));
  const rawId = supplier ? row.offerId : row.sku;
  check(supplier ? typeof rawId === 'string' && /^[1-9][0-9]{0,19}$/.test(rawId) : positiveInteger(rawId), 'IDENTITY_INVALID');
  const id = String(rawId);
  if (!supplier && Object.hasOwn(row, 'productId')) check(row.productId === rawId, 'IDENTITY_INVALID');
  check(text(row.title, 1000));
  check(typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0);
  check(supplier ? typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) : row.currency === '₽');
  const url = productUrl(supplier ? row.asinUrl : row.productUrl, id, supplier);
  if (!supplier && Object.hasOwn(row, 'productPageUrl')) check(productUrl(row.productPageUrl, id, false) === url, 'IDENTITY_INVALID');
  if (Object.hasOwn(row, 'sourceType')) check(row.sourceType === (supplier ? '1688' : 'ozon'));
  return { productId: id, productUrl: url, title: row.title, price: row.price, currency: supplier ? row.currency : 'RUB',
    salesCount: optionalCount(row, supplier ? 'salesQuantity' : 'sales'),
    minimumOrderQuantity: supplier ? optionalCount(row, 'quantityBegin') : 'unknown',
    sellerIdentity: 'unknown', exactSkuMatch: 'unknown' };
}
/** Provider documents define data, not current SKU facts; malformed nonempty data can never become true_empty. */
export function normalizeLinkfoxDiscoveryResponse({ request, httpStatus, response, observedAt }) {
  request = assertLinkfoxDiscoveryRequest(request);
  check(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599);
  if (httpStatus === 401) throw new LinkfoxDiscoveryError('AUTHENTICATION_REQUIRED');
  if (httpStatus === 402) throw new LinkfoxDiscoveryError('BILLING_FAILED');
  if (httpStatus === 429) throw new LinkfoxDiscoveryError('RATE_LIMITED');
  if (httpStatus !== 200) throw new LinkfoxDiscoveryError('PROVIDER_FAILED');
  check(object(response));
  // Supplier prose and error example disagree on spelling; accept only a documented explicit success,
  // and reject inconsistent aliases instead of interpreting a products array as success.
  const status = Object.hasOwn(response, 'errcode') ? response.errcode : response.errorCode;
  check(Number.isSafeInteger(status));
  if (Object.hasOwn(response, 'errcode') && Object.hasOwn(response, 'errorCode')) check(response.errcode === response.errorCode);
  if (status !== 200) throw new LinkfoxDiscoveryError(({ 401: 'AUTHENTICATION_REQUIRED', 402: 'BILLING_FAILED', 1003: 'RATE_LIMITED' })[status] ?? 'PROVIDER_FAILED');
  const supplier = request.method === 'supplier_search';
  if (!supplier) check(response.code === '200');
  check(nonnegativeInteger(response.total));
  const rows = supplier ? response.products : response.products ?? response.data;
  check(Array.isArray(rows)); check(rows.length <= request.pageSize, 'RESPONSE_LIMIT');
  if (!supplier && Object.hasOwn(response, 'products') && Object.hasOwn(response, 'data')) check(isDeepStrictEqual(response.products, response.data));
  check(response.total >= rows.length && (rows.length > 0 || response.total === 0));
  check(text(observedAt, 32) && !Number.isNaN(Date.parse(observedAt)));
  const products = rows.map(row => normalizeRow(row, supplier));
  check(new Set(products.map(row => row.productId)).size === products.length, 'IDENTITY_INVALID');
  const result = { schemaVersion: 'linkfox-discovery-result-v1', provider: 'linkfox', contractVersion: LINKFOX_DISCOVERY_CONTRACT_VERSION,
    requestId: request.requestId, method: request.method, observedAt, sourceUpdatedAt: 'unknown',
    status: products.length ? 'candidates_found' : 'true_empty', total: response.total, hasMore: response.total > products.length,
    products, accounting: { unit: 'linkfox_credits', actualCharge: 'unknown' }, businessEffect: 'discovery_evidence_only' };
  assertSafeRuntimeRecord(result); return result;
}

/** Validate only the normalized persistence contract, never a raw provider response. */
export function assertLinkfoxDiscoveryResult(result, input) {
  const request = buildLinkfoxDiscoveryRequest(input);
  closed(result, ['schemaVersion','provider','contractVersion','requestId','method','observedAt','sourceUpdatedAt','status','total','hasMore','products','accounting','businessEffect']);
  check(result.schemaVersion === 'linkfox-discovery-result-v1' && result.provider === 'linkfox' && result.contractVersion === LINKFOX_DISCOVERY_CONTRACT_VERSION &&
    result.requestId === request.requestId && result.method === request.method && result.sourceUpdatedAt === 'unknown' &&
    result.businessEffect === 'discovery_evidence_only' && text(result.observedAt,32) && Number.isFinite(Date.parse(result.observedAt)));
  check(Array.isArray(result.products) && result.products.length <= request.pageSize && nonnegativeInteger(result.total) && result.total >= result.products.length &&
    result.hasMore === (result.total > result.products.length) && (result.products.length > 0 || result.total === 0) &&
    result.status === (result.products.length ? 'candidates_found' : 'true_empty'));
  closed(result.accounting,['unit','actualCharge']); check(result.accounting.unit === 'linkfox_credits' && result.accounting.actualCharge === 'unknown');
  for (const row of result.products) {
    closed(row,['productId','productUrl','title','price','currency','salesCount','minimumOrderQuantity','sellerIdentity','exactSkuMatch']);
    check(typeof row.productId === 'string' && /^[1-9][0-9]{0,19}$/.test(row.productId), 'IDENTITY_INVALID');
    if (request.method === 'ozon_market_search') check(BigInt(row.productId) <= BigInt(Number.MAX_SAFE_INTEGER), 'IDENTITY_INVALID');
    check(productUrl(row.productUrl,row.productId,request.method === 'supplier_search') === row.productUrl, 'IDENTITY_INVALID');
    check(text(row.title,1000) && typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 &&
      (request.method === 'supplier_search' ? /^[A-Z]{3}$/.test(row.currency) : row.currency === 'RUB') &&
      [row.salesCount,row.minimumOrderQuantity].every(value => value === 'unknown' || nonnegativeInteger(value)) &&
      row.sellerIdentity === 'unknown' && row.exactSkuMatch === 'unknown');
  }
  check(new Set(result.products.map(row=>row.productId)).size === result.products.length,'IDENTITY_INVALID');
  assertSafeRuntimeRecord(result); return structuredClone(result);
}
