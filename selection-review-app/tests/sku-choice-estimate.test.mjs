import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';
import { resolveLifecycleBProfitRule } from '../lib/lifecycle-b-evidence-runtime.mjs';
import { DEFAULT_RULES } from '../lib/workflow.mjs';
import { buildSupplierDraftEstimate } from '../lib/supplier-draft.mjs';
import { buildSkuChoiceTable, capturedSkuWeightKg, skuChoiceColumns, skuChoiceLabel } from '../lib/sku-choice-estimate.mjs';

// The project's own saved GUOO table, the store's own cost policy, and the two official rates declared by this test.
// Nothing here is a stand-in: the freight comes out of the real rows, which is the whole point of the two baselines.
const catalog = await readGuooTariffCatalog({});
const tariffRows = catalog.rows.map(row => ({ ...row, ruleVersion: catalog.ruleVersion }));
const storeRule = resolveLifecycleBProfitRule({ targetStore: 'miska' }, DEFAULT_RULES);
const fx = { rubPerCny: 12.5637, rateDate: '2026-09-12', sourceRef: 'cbr-xml-daily:R01375:2026-09-12' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic', gaps: [] };
const assumptions = { packagingRmbDefault: 3 };
const inputs = { tariffRuleVersion: catalog.ruleVersion };

/** The owner's own 找货 declaration: target price, domestic freight and packing size. The weight here is never used per row. */
const draft = Object.freeze({
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-13T01:00:00.000Z',
  sourceUrl: 'https://detail.1688.com/offer/943009939489.html', sourceUrlType: 'detail', offerId: '943009939489',
  goodsPriceRmb: 20.5, domesticShippingRmb: 3.5, allInPurchaseRmb: 24,
  packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 },
  targetSalePriceRub: 1600, note: null, provenance: 'owner_declared'
});

const sku = (id, colour, size, priceCny, stock, weightKg) => ({
  sourceSkuId: id,
  propPath: `1627207:${id}`,
  attributes: { 规格: `${colour}>${size}`, 颜色: colour, 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price',
  stock, stockSource: 'tradeModel.skuMap.canBookCount',
  inStock: stock > 0,
  weight: weightKg === null ? null : { value: weightKg, unit: 'kg' },
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight',
  imageUrl: null
});

const XL = sku('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 494, 0.103);
const XXXXXXXXL = sku('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 468, 0.24);
const NO_WEIGHT = sku('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, 479, null);

const table = (choices, extra = {}) => buildSkuChoiceTable({
  choices, draft, storeRule, fx, commission, tariffRows, assumptions, inputs,
  builtAt: '2026-09-13T01:00:01.000Z', ...extra
});

test('每个规格按它自己的重量算运费和利润：两条线上同款输入的校验基准必须对得上', () => {
  const built = table([XL, XXXXXXXXL]);
  const [best, worst] = built.rows;
  // 目标售价 1600 ₽、汇率 12.5637、佣金 14%、国内运费 ¥3.5、包装 ¥3、贴标 ¥1.5、预留 12%、25×22×2.5cm。
  assert.equal(best.sourceSkuId, 'sku-xl-yellow');
  assert.equal(best.weightKg, 0.103);
  assert.equal(best.chargeableKg, 0.103);
  assert.equal(best.route, 'GUOO Economy Extra Small');
  assert.equal(best.freightRmb, 6.26);
  assert.equal(best.allInPurchaseRmb, 24);
  assert.equal(best.unitProfitRmb, 59.47);
  assert.equal(best.marginRate, 0.467);

  assert.equal(worst.sourceSkuId, 'sku-8xl-yellow');
  assert.equal(worst.weightKg, 0.24);
  assert.equal(worst.chargeableKg, 0.24);
  assert.equal(worst.freightRmb, 10.11);
  assert.equal(worst.allInPurchaseRmb, 45);
  assert.equal(worst.unitProfitRmb, 34.62);
  assert.equal(worst.marginRate, 0.2718);

  assert.equal(built.best.sourceSkuId, 'sku-xl-yellow');
  assert.equal(built.worst.sourceSkuId, 'sku-8xl-yellow');
  assert.equal(built.profitDropRate, 0.4179);
  assert.equal(built.pricedCount, 2);
  assert.equal(built.total, 2);
});

test('同一套引擎、同一批输入：规格表的钱和找货估算的钱逐分相同', () => {
  // The 找货 estimate priced for exactly the 8XL parcel must produce exactly the 8XL row of the table.
  const sameParcel = { ...draft, goodsPriceRmb: 41.5, allInPurchaseRmb: 45, packedWeightKg: 0.24 };
  const estimate = buildSupplierDraftEstimate({ draft: sameParcel, storeRule, fx, commission, tariffRows,
    assumptions, estimatedAt: '2026-09-13T01:00:01.000Z', inputs });
  const row = table([XXXXXXXXL]).rows[0];
  assert.equal(estimate.estimate.freight.chosen.route, row.route);
  assert.equal(estimate.estimate.freight.chosen.freightRmb, row.freightRmb);
  assert.equal(estimate.profitAtDeclaredPurchase.unitProfitRmb, row.unitProfitRmb);
  assert.equal(estimate.profitAtDeclaredPurchase.marginRate, row.marginRate);
  assert.equal(estimate.profitAtDeclaredPurchase.passes, row.passes);
});

test('页面没给重量的规格只标待补：不借别的规格的重量，也不拿主人填的打包重量顶替', () => {
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  const pending = built.rows.at(-1);
  assert.equal(pending.sourceSkuId, 'sku-8xl-beige');
  assert.equal(pending.status, 'weight_missing');
  assert.deepEqual(pending.missing, ['规格重量']);
  assert.equal(pending.weightKg, null);
  assert.equal(pending.chargeableKg, null);
  assert.equal(pending.route, null);
  assert.equal(pending.freightRmb, null);
  assert.equal(pending.unitProfitRmb, null);
  assert.equal(pending.marginRate, null);
  assert.equal(pending.allInPurchaseRmb, null);
  // Its captured facts survive: the owner can still see and still pick it.
  assert.equal(pending.priceCny, 41.5);
  assert.equal(pending.stock, 479);
  assert.equal(built.weightMissingCount, 1);
  assert.equal(built.pricedCount, 2);
  // The same size with a declared weight is priced, so nothing was copied across.
  assert.equal(built.rows.find(row => row.sourceSkuId === 'sku-8xl-yellow').freightRmb, 10.11);
});

test('按单件利润从高到低排序，算不出来的排在最后并保持采到的顺序', () => {
  const middle = sku('sku-5xl', '黑色', '5XL（背长55cm）', 32.5, 471, 0.163);
  const alsoPending = sku('sku-xl-beige', '米色', 'XL（背长35cm）', 20.5, 489, null);
  const built = table([XXXXXXXXL, alsoPending, XL, NO_WEIGHT, middle]);
  assert.deepEqual(built.rows.map(row => row.sourceSkuId),
    ['sku-xl-yellow', 'sku-5xl', 'sku-8xl-yellow', 'sku-xl-beige', 'sku-8xl-beige']);
  assert.deepEqual(built.rows.map(row => row.unitProfitRmb), [59.47, 45.78, 34.62, null, null]);
});

test('规格列从采到的属性里推出来：会变的属性才当列，合并标签让位给拆开的颜色和尺码', () => {
  // Colour and size both differ across these three, so both earn a column and the combined 规格 label steps aside.
  assert.deepEqual(skuChoiceColumns([XL, XXXXXXXXL, NO_WEIGHT]), ['颜色', '尺码']);
  // Only the size differs → only the size is a column.
  assert.deepEqual(skuChoiceColumns([XL, XXXXXXXXL]), ['尺码']);
  // Only the colour differs → only the colour is a column.
  assert.deepEqual(skuChoiceColumns([XL, sku('b', '米色', 'XL（背长35cm）', 20.5, 10, 0.103)]), ['颜色']);
  // Nothing differs → the offer still names itself with its first declared attribute.
  assert.deepEqual(skuChoiceColumns([XL]), ['规格']);
  assert.deepEqual(skuChoiceColumns([{ sourceSkuId: 'x', attributes: {} }]), []);
  assert.deepEqual(skuChoiceColumns(null), []);
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  assert.deepEqual(built.columns, ['颜色', '尺码']);
  assert.deepEqual(built.rows[0].values, ['黄色', 'XL（背长35cm）']);
  assert.equal(built.rows[0].label, '黄色 · XL（背长35cm）');
  assert.equal(skuChoiceLabel({ sourceSkuId: 'only-id', values: [], attributes: {}, propPath: null }), 'only-id');
});

test('重量只认页面按公斤给出的正数，别的一律当没给', () => {
  assert.equal(capturedSkuWeightKg({ weight: { value: 0.103, unit: 'kg' } }), 0.103);
  assert.equal(capturedSkuWeightKg({ weight: 0.24 }), 0.24);
  assert.equal(capturedSkuWeightKg({ weight: { value: 103, unit: 'g' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: { value: 0, unit: 'kg' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: { value: -1, unit: 'kg' } }), null);
  assert.equal(capturedSkuWeightKg({ weight: '0.103' }), null);
  assert.equal(capturedSkuWeightKg({}), null);
  assert.equal(capturedSkuWeightKg(null), null);
});

test('数字来源那一栏全部取自本次解析的输入，没有一处写死', () => {
  const built = table([XL, XXXXXXXXL, NO_WEIGHT]);
  assert.deepEqual(built.sources, {
    targetSalePriceRub: 1600,
    rubPerCny: 12.5637,
    fxRateDate: '2026-09-12',
    fxSourceRef: 'cbr-xml-daily:R01375:2026-09-12',
    commissionRate: 0.14,
    commissionTier: '1500_5000',
    commissionSourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic',
    routes: ['GUOO Economy Extra Small'],
    tariffRuleVersion: 'guoo-2026-08-19',
    domesticShippingRmb: 3.5,
    packagingRmbDefault: 3,
    labelCostRmb: 1.5,
    reserveParts: { advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02 },
    reserveRate: 0.12,
    dimensionsCm: { length: 25, width: 22, height: 2.5 }
  });
  assert.equal(built.schemaVersion, 'sku-choice-table-v1');
  assert.equal(built.builtAt, '2026-09-13T01:00:01.000Z');
});

test('缺官方输入时整张表留空，不产生任何猜出来的运费或利润', () => {
  const noFx = table([XL, XXXXXXXXL], { fx: null });
  assert.deepEqual(noFx.rows.map(row => row.status), ['not_priced', 'not_priced']);
  assert.deepEqual(noFx.rows.map(row => row.unitProfitRmb), [null, null]);
  assert.ok(noFx.rows[0].missing.includes('汇率'));
  assert.equal(noFx.best, null);
  assert.equal(noFx.worst, null);
  assert.equal(noFx.profitDropRate, null);
  assert.equal(noFx.sources.rubPerCny, null);
  const noTariff = table([XL], { tariffRows: [] });
  assert.equal(noTariff.rows[0].status, 'not_priced');
  assert.equal(noTariff.rows[0].freightRmb, null);
  assert.deepEqual(noTariff.sources.routes, []);
});

test('页面没给直接价格的规格同样只标待补，勾选状态只认这次采到的规格', () => {
  const noPrice = { ...sku('sku-no-price', '黑色', '3XL', 0, 12, 0.133), priceCny: null, priceSource: null };
  const built = table([XL, noPrice], { selectedSkuIds: ['sku-xl-yellow', 'sku-xl-yellow', 'sku-not-here'] });
  const row = built.rows.find(item => item.sourceSkuId === 'sku-no-price');
  assert.equal(row.status, 'price_missing');
  assert.deepEqual(row.missing, ['货价']);
  assert.equal(row.priceCny, null);
  assert.equal(row.unitProfitRmb, null);
  assert.deepEqual(built.selectedSkuIds, ['sku-xl-yellow']);
});

test('没有找货声明就没有表', () => {
  assert.throws(() => buildSkuChoiceTable({ choices: [XL], draft: null, storeRule, fx, commission, tariffRows, assumptions }),
    /SKU_CHOICE_TABLE_DRAFT_REQUIRED/);
});
