import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProjectSourceMarketFit, resolveLifecycleBCostPolicy, GLOBAL_PRICING_POLICY_VERSION } from '../lib/global-pricing-policy.mjs';
import { SYNTHETIC_STORE_REF } from './fixtures/store-binding-fixture.mjs';
const asOf = '2026-09-09T00:00:00.000Z';
const context = { platform: 'ozon', store: 'dandanshu', storeRef: SYNTHETIC_STORE_REF, salesScheme: 'rfbs' };
const names = ['labelRmb', 'fixedOtherRmb', 'advertisingRate', 'returnReserveRate', 'damageReserveRate', 'withdrawalFeeRate', 'acquiringRate', 'taxRate', 'otherRate'];
function snapshot() {
  return { schemaVersion: 'b-cost-policy-snapshot-v1', policyId: 'synthetic-policy', policyVersion: 'synthetic-v1',
    scope: structuredClone(context), effectiveFrom: null, effectiveTo: null, policyEvidenceRef: 'fixture:approved-policy',
    items: Object.fromEntries(names.map(key => [key, { status: 'not_applicable', value: null,
      basis: key === 'labelRmb' ? 'per_order_cny' : key === 'fixedOtherRmb' ? 'per_unit_cny' : 'target_price_cny_rate',
      evidenceRef: `fixture:${key}`, includedIn: null }])) };
}
const input = { marketReferencePriceCny: 100, actualPurchaseCostCny: 10, packagingCostCny: 1,
  internationalFreightPerOrderCny: 5, fixedOtherCostCny: 0, commissionRate: 0.1, advertisingRate: 0,
  returnOperationsRate: 0, targetMarginRate: 0.15, minimumUnitProfitCny: 20, priceIncrementCny: 1 };
const resolve = s => resolveLifecycleBCostPolicy({ snapshot: s, context, asOf });
function code(expected) { return error => error.code === expected; }

test('9项有依据不适用解析零，输入不变且返回冻结', () => {
  const s = snapshot(), before = JSON.stringify(s), result = resolve(s);
  for (const key of names) assert.equal(result[key], 0);
  assert.equal(result.policyId, s.policyId);
  assert.equal(result.policyVersion, s.policyVersion);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(s), before);
});

test('逐项缺失未知和已含费用不能被GLOBAL或零值补齐', () => {
  for (const key of names) {
    const missing = snapshot(); delete missing.items[key];
    assert.throws(() => resolve(missing), code('B_COST_POLICY_INVALID'));
    const unknown = snapshot(); unknown.items[key].status = 'unknown';
    assert.throws(() => resolve(unknown), code('B_COST_POLICY_UNKNOWN'));
    const included = snapshot(); included.items[key].status = 'included_in_settlement'; included.items[key].includedIn = 'commission';
    assert.throws(() => resolve(included), code('B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS'));
    for (const value of [null, -1, Infinity, '0', ...(key.endsWith('Rate') ? [1] : [])]) {
      const bad = snapshot(); Object.assign(bad.items[key], { status: 'applicable', value });
      assert.throws(() => resolve(bad), code('B_COST_POLICY_ITEM_INVALID'));
    }
  }
});

test('闭字段来源和计价基准严格验证', () => {
  for (const mutate of [s => { s.extra = true; }, s => { s.scope.extra = true; }, s => { s.items.extra = {}; },
    s => { s.policyEvidenceRef = ''; }]) {
    const s = snapshot(); mutate(s); assert.throws(() => resolve(s), code('B_COST_POLICY_INVALID'));
  }
  for (const mutate of [i => { i.extra = true; }, i => { i.evidenceRef = ''; }, i => { i.basis = 'per_unit_cny'; },
    i => { i.value = 0; }, i => { i.includedIn = 'commission'; }]) {
    const s = snapshot(); mutate(s.items.labelRmb); assert.throws(() => resolve(s), code('B_COST_POLICY_ITEM_INVALID'));
  }
});

test('范围时效及失效边界不默认授权', () => {
  const wrong = snapshot(); wrong.scope.storeRef.platformStoreId = 'other';
  assert.throws(() => resolve(wrong), code('B_COST_POLICY_SCOPE_MISMATCH'));
  const mode = snapshot(); mode.scope.salesScheme = 'fbs';
  assert.throws(() => resolve(mode), code('B_COST_POLICY_SCOPE_MISMATCH'));
  const expired = snapshot(); expired.effectiveTo = asOf;
  assert.throws(() => resolve(expired), code('B_COST_POLICY_EXPIRED'));
  const future = snapshot(); future.effectiveFrom = '2026-09-10T00:00:00.000Z';
  assert.throws(() => resolve(future), code('B_COST_POLICY_NOT_EFFECTIVE'));
  const reversed = snapshot(); reversed.effectiveFrom = asOf; reversed.effectiveTo = asOf;
  assert.throws(() => resolve(reversed), code('B_COST_POLICY_TIME_INVALID'));
  const invalid = snapshot(); invalid.effectiveFrom = '2026-02-30T00:00:00.000Z';
  assert.throws(() => resolve(invalid), code('B_COST_POLICY_TIME_INVALID'));
});

test('历史核心数值保持，新显式费用沿唯一公式计算', () => {
  const legacy = calculateProjectSourceMarketFit(input);
  assert.equal(legacy.pricingPolicyVersion, GLOBAL_PRICING_POLICY_VERSION);
  assert.equal(legacy.evaluatedAtMarketPrice.unitProfitCny, 65.5);
  assert.equal(legacy.totalVariableRate, 0.17);
  const s = snapshot();
  for (const key of names) Object.assign(s.items[key], { status: 'applicable', value: key === 'labelRmb' ? 2 : key === 'fixedOtherRmb' ? 3 : 0.01 });
  const policy = resolve(s);
  const result = calculateProjectSourceMarketFit({ ...input, fixedOtherCostCny: 3, advertisingRate: 0.01,
    returnOperationsRate: 0.01, resolvedCostPolicy: policy });
  assert.equal(result.pricingPolicyVersion, s.policyVersion);
  assert.equal(result.totalVariableRate, 0.17);
  assert.equal(result.orderFixedCostCny, 21);
  assert.equal(result.evaluatedAtMarketPrice.unitProfitCny, 62);
  assert.equal(result.variableRates.tax, 0.01);
  assert.equal(result.variableRates.acquiring, 0.01);
  assert.equal(result.variableRates.other, 0.01);
  assert.throws(() => calculateProjectSourceMarketFit({ ...input, resolvedCostPolicy: policy }), code('B_COST_POLICY_RESOLVED_CONFLICT'));
  assert.throws(() => calculateProjectSourceMarketFit({ ...input, resolvedCostPolicy: {} }), code('B_COST_POLICY_RESOLVED_CONFLICT'));
  const zero = calculateProjectSourceMarketFit({ ...input, resolvedCostPolicy: resolve(snapshot()) });
  assert.equal(zero.totalVariableRate, 0.1);
  assert.equal(zero.evaluatedAtMarketPrice.unitProfitCny, 74);
});
