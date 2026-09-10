import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkfoxDiscoveryRequest, normalizeLinkfoxDiscoveryResponse, LinkfoxDiscoveryError } from '../lib/linkfox-discovery-api.mjs';
const at = '2026-09-08T12:00:00.000Z';
const input = method => ({ requestId: 'request:synthetic:discovery', method, keywords: [method === 'supplier_search' ? '桌面收纳' : 'органайзер для стола'], pageSize: method === 'supplier_search' ? 10 : 20 });
const marketRow = () => ({ sku: 2107989735, productId: 2107989735, title: 'Synthetic desktop organizer',
  productUrl: 'https://www.ozon.ru/product/2107989735', currency: '₽', price: 297, sales: 8 });
const response = () => ({ code: '200', errcode: 200, total: 1, products: [marketRow()] });
const normalize = value => normalizeLinkfoxDiscoveryResponse({ request: buildLinkfoxDiscoveryRequest(input('ozon_market_search')),
  httpStatus: 200, response: value, observedAt: at });
const rejects = (fn, code) => assert.throws(fn, error => error instanceof LinkfoxDiscoveryError && error.code === code);

test('documented keyword requests use one page with no required category and enforce local limits', () => {
  const market = buildLinkfoxDiscoveryRequest(input('ozon_market_search'));
  assert.deepEqual(market.body, { keywords: ['органайзер для стола'], page: { page: 1, pageSize: 20, orders: [{ field: 'revenue', direction: 'DESC' }] } });
  assert.deepEqual(buildLinkfoxDiscoveryRequest(input('supplier_search')).body, { keyWord: '桌面收纳', pageIndex: 1,
    pageSize: 10, cycle: '30', searchType: 1, sortField: 'orderCount30d', sortType: 'desc' });
  for (const change of [{ pageSize: 21 }, { keywords: [] }, { keywords: ['one', 'two', 'three'] }, { extra: true }]) {
    rejects(() => buildLinkfoxDiscoveryRequest({ ...input('ozon_market_search'), ...change }), 'INPUT_INVALID');
  }
  rejects(() => buildLinkfoxDiscoveryRequest({ ...input('supplier_search'), keywords: ['english only'] }), 'INPUT_INVALID');
});
test('strict market observations preserve unknown facts and do not treat costToken as credits', () => {
  const value = response(); value.costToken = 16000; value.total = 30;
  const result = normalize(value);
  assert.equal(result.status, 'candidates_found'); assert.equal(result.hasMore, true);
  assert.equal(result.products[0].productId, '2107989735'); assert.equal(result.products[0].currency, 'RUB');
  assert.equal(result.products[0].sellerIdentity, 'unknown'); assert.equal(result.products[0].exactSkuMatch, 'unknown');
  assert.equal(result.accounting.actualCharge, 'unknown'); assert.equal(result.sourceUpdatedAt, 'unknown');
  assert.equal(Object.hasOwn(result, 'costToken'), false);
});
test('only explicit successful empty response is true_empty; malformed rows never disappear', () => {
  assert.equal(normalize({ code: '200', errcode: 200, total: 0, products: [] }).status, 'true_empty');
  for (const value of [{ total: 0, products: [] }, { code: '200', errcode: 200, total: 1, products: [] },
    { code: '200', errcode: 200, total: 1, products: [null] }, { ...response(), errorCode: 402 },
    { ...response(), errcode: null, errorCode: 200 }, { ...response(), data: [] }]) rejects(() => normalize(value), 'RESPONSE_INVALID');
  rejects(() => normalize({ ...response(), total: 21, products: Array.from({ length: 21 }, marketRow) }), 'RESPONSE_LIMIT');
});
test('unsafe or coerced identifiers, wrong URL and duplicate identity are rejected', () => {
  for (const id of [true, '2107989735', 9007199254740992]) {
    const value = response(); value.products[0].sku = id; value.products[0].productId = id;
    rejects(() => normalize(value), 'IDENTITY_INVALID');
  }
  for (const url of ['https://www.ozon.ru/product/1234567', 'https://127.0.0.1/product/2107989735', 'https://www.ozon.ru/product/2107989735?token=bad']) {
    const value = response(); value.products[0].productUrl = url; rejects(() => normalize(value), 'IDENTITY_INVALID');
  }
  rejects(() => normalize({ ...response(), total: 2, products: [marketRow(), marketRow()] }), 'IDENTITY_INVALID');
  const value = response(); value.products[0].price = true; rejects(() => normalize(value), 'RESPONSE_INVALID');
});
test('supplier search returns offer candidates only and accepts only documented explicit status', () => {
  const result = normalizeLinkfoxDiscoveryResponse({ request: buildLinkfoxDiscoveryRequest(input('supplier_search')), httpStatus: 200,
    observedAt: at, response: { errcode: 200, total: 1, products: [{ offerId: '876240928352',
      asinUrl: 'https://detail.1688.com/offer/876240928352.html', title: '合成收纳', currency: 'CNY', price: 5, quantityBegin: 1 }] } });
  assert.equal(result.products[0].minimumOrderQuantity, 1); assert.equal(result.products[0].salesCount, 'unknown');
  assert.equal(result.businessEffect, 'discovery_evidence_only');
});
test('provider authentication, billing and rate failures have precise known types', () => {
  for (const [errcode, code] of [[401, 'AUTHENTICATION_REQUIRED'], [402, 'BILLING_FAILED'], [1003, 'RATE_LIMITED'], [999, 'PROVIDER_FAILED']]) {
    rejects(() => normalize({ errcode, errmsg: 'not retained' }), code);
  }
});
