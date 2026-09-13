import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuooTariffCatalog } from '../lib/guoo-tariff-reader.mjs';
import { resolveLifecycleBProfitRule } from '../lib/lifecycle-b-evidence-runtime.mjs';
import { DEFAULT_RULES } from '../lib/workflow.mjs';
import { buildSkuChoiceTable } from '../lib/sku-choice-estimate.mjs';
import { buildDiscoveryMarketSalesSnapshot } from '../lib/discovery-market-snapshot.mjs';
import { buildRealAConfirmationCard, validateRealAConfirmationSubmission } from '../lib/real-a-confirmation-card.mjs';
import {
  PROFIT_STEP_SCHEMA_VERSION, benchmarkAttributeMatch, buildProfitStepReview, groupQueuedSpecifications,
  pagePriceDelta, profitStepGaps, profitStepSubmission, quantityOneEvidenceNote, specificationBreakdown,
  specificationVerdicts
} from '../lib/profit-step-review.mjs';

/**
 * 算利润 checked against the project's own saved GUOO table, the store's own cost policy and the official rate ladder.
 * Everything the owner would see and everything this step would submit is derived here from those same records, and
 * the finished submission is then run through the server's own A confirmation validator — so a payload this step
 * assembles cannot pass the test while the real route would reject it.
 */
const catalog = await readGuooTariffCatalog({});
const tariffRows = catalog.rows.map(row => ({ ...row, ruleVersion: catalog.ruleVersion }));
const storeRule = resolveLifecycleBProfitRule({ targetStore: 'miska' }, DEFAULT_RULES);
const fx = { rubPerCny: 12.5637, rateDate: '2026-09-12', sourceRef: 'cbr-xml-daily:R01375:2026-09-12' };
const commission = { rate: 0.14, tier: '1500_5000', sourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic', gaps: [] };
const assumptions = { packagingRmbDefault: 3 };
const OFFER_URL = 'https://detail.1688.com/offer/943009939489.html';
const STORE_REF = Object.freeze({ stableStoreId: 'miska', platformStoreId: 'synthetic-seller', mappingVersion: 'synthetic-stores-v1' });

const draft = Object.freeze({
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-13T01:00:00.000Z',
  sourceUrl: OFFER_URL, sourceUrlType: 'detail', offerId: '943009939489',
  goodsPriceRmb: 20.5, domesticShippingRmb: 3.5, allInPurchaseRmb: 24,
  packedWeightKg: 0.2, dimensionsCm: { length: 25, width: 22, height: 2.5 },
  targetSalePriceRub: 1600, note: null, provenance: 'owner_declared'
});

const sku = (id, colour, size, priceCny, weightKg) => ({
  sourceSkuId: id, propPath: `1627207:${id}`,
  attributes: { 规格: `${colour}>${size}`, 颜色: colour, 尺码: size },
  priceCny, priceSource: 'tradeModel.skuMap.price',
  stock: 400, stockSource: 'tradeModel.skuMap.canBookCount', inStock: true,
  weight: weightKg === null ? null : { value: weightKg, unit: 'kg' },
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight',
  imageUrl: null
});

// 目标售价 1600 ₽ · 汇率 12.5637 · 佣金 14% · 预留 12% · 国内运费 ¥3.5 · 包装 ¥3 · 贴标 ¥1.5。
// 成交收入 ¥127.35，0.24 公斤这一档运费 ¥10.11，所以 8XL 那几个的利润 = 79.62 − 到手。
const XL_YELLOW = sku('sku-xl-yellow', '黄色', 'XL', 20.5, 0.103);
const XL_BLACK = sku('sku-xl-black', '黑色', 'XL', 20.5, 0.103);
const EIGHT_YELLOW = sku('sku-8xl-yellow', '黄色', '8XL', 41.5, 0.24);
const EIGHT_BLACK = sku('sku-8xl-black', '黑色', '8XL', 41.5, 0.24);
const MARGIN_ONLY = sku('sku-8xl-margin-only', '米色', '8XL', 56.6, 0.24); // 利润 ¥19.52 · 利润率 15.33% → 按利润率过线
const BELOW_LINE = sku('sku-8xl-below', '藏青色', '8XL', 60, 0.24); // 利润 ¥16.12 · 利润率 12.66% → 两条都不到
const NO_WEIGHT = sku('sku-8xl-no-weight', '灰色', '8XL', 41.5, null);

const ALL_SKUS = [XL_YELLOW, XL_BLACK, EIGHT_YELLOW, EIGHT_BLACK, MARGIN_ONLY, BELOW_LINE, NO_WEIGHT];

const marketProduct = {
  productId: '3605840795', platform: 'ozon', productUrl: 'https://www.ozon.ru/product/3605840795',
  title: 'Водонепроницаемый дождевик для собак, светоотражающий -8XL',
  imageUrl: 'https://images.example.test/synthetic-raincoat.png', price: 1457, salesCount: 21, revenue: 30434,
  categoryPath: { cnTitlePath: '宠物用品 > 宠物服装和靴子 > 宠物服装' }, reviewCount: 94, reviewRating: 4.9,
  providerRecordRef: 'seerfar:category_detail:synthetic#product-13'
};
const snapshot = buildDiscoveryMarketSalesSnapshot({
  product: marketProduct,
  receipt: { receiptId: 'a-discovery-receipt:synthetic:0:0', completedAt: '2026-09-11T02:54:12.318Z' }
});

const capture = (extra = {}) => ({
  captureId: 'SCJ-synthetic-profit-step', status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
  jobId: 'SCJ-synthetic-profit-step', jobStatus: 'completed', attempt: 1,
  originalSourceUrl: OFFER_URL, sourceUrl: OFFER_URL, offerId: '943009939489',
  observedAt: '2026-09-13T06:07:25.352Z', collectionMethod: 'chrome_extension_structured_page_v1',
  priceRanges: [{ minimumQuantity: 1, priceCny: 20.5, source: 'tradeModel.offerPriceModel.currentPrices' }],
  pageFields: { unitProductPriceCny: null, unitProductPriceSource: null, unitDomesticFreightCny: null, unitDomesticFreightSource: null },
  skuChoices: ALL_SKUS.map(item => structuredClone(item)),
  selectedSkuIds: ALL_SKUS.map(item => item.sourceSkuId),
  ...extra
});

const candidateOf = (captureState = capture(), extra = {}) => ({
  id: 'candidate:synthetic-profit-step', dataRevision: 7, targetStore: 'miska', targetPlatform: 'ozon',
  storeRef: structuredClone(STORE_REF), productName: 'Explicitly synthetic dog raincoat',
  workflowStatus: 'needs_user_data', sourceUrl: OFFER_URL,
  purchasePriceRmb: 24, domesticShippingRmb: 3.5, packedWeightKg: 0.2,
  dimensionsCm: { length: 25, width: 22, height: 2.5 },
  salesSnapshotsV11: [structuredClone(snapshot)], supplierDraftV1: structuredClone(draft),
  sourceCapture: captureState, ...extra
});

const tableOf = (captureState, extra = {}) => buildSkuChoiceTable({
  choices: captureState.skuChoices, draft, storeRule, fx, commission, tariffRows, assumptions,
  marketProduct, selectedSkuIds: captureState.selectedSkuIds,
  builtAt: '2026-09-13T01:00:01.000Z', inputs: { tariffRuleVersion: catalog.ruleVersion }, ...extra
});

// The rate ladder exactly as the official table hands it over — three bands, with the edges the table itself carries.
const COMMISSION_TIERS = Object.freeze({ tiers: [
  { tier: 'le1500', rate: 0.12, minRub: 0, maxRub: 1500 },
  { tier: '1500_5000', rate: 0.14, minRub: 1500.01, maxRub: 5000 },
  { tier: 'gt5000', rate: 0.15, minRub: 5000.01, maxRub: null }
] });

function reviewOf({ captureState = capture(), candidateExtra = {}, draftInput = draft, commissionTiers = COMMISSION_TIERS } = {}) {
  const candidate = candidateOf(captureState, candidateExtra);
  const table = tableOf(captureState);
  const estimate = { estimate: { costPolicy: { ...storeRule, thresholdPolicy: storeRule.thresholdPolicy ?? 'either' }, fx } };
  return buildProfitStepReview({
    candidate, draft: draftInput, table, estimate,
    card: buildRealAConfirmationCard(candidate), commissionTiers, builtAt: '2026-09-13T01:00:02.000Z'
  });
}

test('这一套一起核线：不过线的规格被自动排除，并说出它差在哪', () => {
  const review = reviewOf();
  assert.equal(review.schemaVersion, PROFIT_STEP_SCHEMA_VERSION);
  assert.equal(review.total, 7);
  assert.equal(review.passCount, 5);
  assert.equal(review.excludedCount, 2);
  // 门槛取自本店成本政策，不是页面里写死的数字。
  assert.equal(review.threshold.minimumUnitProfitRmb, storeRule.minimumUnitProfitRmb);
  assert.equal(review.threshold.targetMarginRate, storeRule.targetMarginRate);
  assert.equal(review.threshold.thresholdPolicy, 'either');

  const ids = review.excluded.map(item => item.sourceSkuId).sort();
  assert.deepEqual(ids, ['sku-8xl-below', 'sku-8xl-no-weight']);

  const below = review.excluded.find(item => item.sourceSkuId === 'sku-8xl-below');
  assert.equal(below.kind, 'below_threshold');
  assert.equal(below.unitProfitRmb, 16.12);
  assert.equal(below.marginRate, 0.1266);
  // 差多少也说出来：¥20 − ¥16.12 和 15% − 12.66%。
  assert.equal(below.unitProfitShortRmb, 3.88);
  assert.equal(below.marginShortRate, 0.0234);

  const unpriced = review.excluded.find(item => item.sourceSkuId === 'sku-8xl-no-weight');
  assert.equal(unpriced.kind, 'not_priced');
  assert.deepEqual(unpriced.missing, ['规格重量']);
  assert.equal(unpriced.unitProfitRmb, null);

  // 过线的那 5 个才进区间，被排除的两个不许把区间拉下来。
  assert.deepEqual(review.unitProfitRange, { low: 19.52, high: 59.47 });
  assert.equal(review.marginRange.low, 0.1533);
  assert.ok(review.specifications.every(item => item.sourceSkuId !== 'sku-8xl-below'));
});

test('先达者算过：只到利润率那一条的规格照样过线', () => {
  const verdicts = specificationVerdicts({
    rows: [{ sourceSkuId: 'a', label: 'A', unitProfitRmb: 19.52, marginRate: 0.1533, passes: true },
      { sourceSkuId: 'b', label: 'B', unitProfitRmb: 16.12, marginRate: 0.1266, passes: false }],
    policy: { minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either' }
  });
  assert.equal(verdicts.passCount, 1);
  assert.equal(verdicts.excluded[0].sourceSkuId, 'b');
  assert.equal(verdicts.excluded[0].unitProfitShortRmb, 3.88);
});

test('对标标题里写着哪个规格就先上哪个；XL 不会被 8XL 里的那两个字母骗过去', () => {
  const rows = [{ attributes: { 尺码: 'XL', 颜色: '黄色' } }, { attributes: { 尺码: '8XL', 颜色: '黑色' } }];
  const match = benchmarkAttributeMatch(rows, 'Водонепроницаемый дождевик для собак, светоотражающий -8XL');
  assert.deepEqual(match, { attributeKey: '尺码', value: '8XL' });
  // 标题里一个规格都没写，就不猜。
  assert.equal(benchmarkAttributeMatch(rows, 'Дождевик для собак'), null);
  // 同一个属性有两个值都对得上，也不猜。
  assert.equal(benchmarkAttributeMatch(rows, 'дождевик XL и 8XL'), null);

  const review = reviewOf();
  assert.equal(review.benchmark.matchedAttributeKey, '尺码');
  assert.equal(review.benchmark.matchedValue, '8XL');
  assert.equal(review.benchmark.sameAttributeCount, 3);
  assert.equal(review.benchmark.productNumber, '3605840795');
  assert.equal(review.benchmark.collectedOn, '2026-09-11');
  // 建议出来的那一个必须是同规格里的，且真的过了线。
  const suggested = review.specifications.find(item => item.sourceSkuId === review.suggestedSkuId);
  assert.equal(suggested.attributes['尺码'], '8XL');
  assert.equal(suggested.isSuggested, true);
});

test('按页面价算，并把它和「找货」里填的货价的差额标出来；相等时没有这句话', () => {
  const review = reviewOf();
  const eight = review.specifications.find(item => item.sourceSkuId === 'sku-8xl-yellow');
  // 找货填的是 ¥20.50，这个规格页面上自己的价是 ¥41.50。
  assert.deepEqual(eight.priceDelta, { pageRmb: 41.5, declaredRmb: 20.5, deltaRmb: 21 });
  assert.equal(eight.unitProductPrice, 41.5);
  assert.equal(eight.actualPurchaseCost, 45);

  // XL 的页面价正好等于找货填的货价，就没有差额可说。
  const xl = review.specifications.find(item => item.sourceSkuId === 'sku-xl-yellow');
  assert.equal(xl.priceDelta, null);
  assert.equal(pagePriceDelta({ row: { priceCny: 20.5 }, draft }), null);
  assert.deepEqual(pagePriceDelta({ row: { priceCny: 20.2 }, draft }), { pageRmb: 20.2, declaredRmb: 20.5, deltaRmb: -0.3 });
  assert.equal(pagePriceDelta({ row: { priceCny: null }, draft }), null);
});

test('算式摊开的每一项都对得上引擎自己算出来的那个利润', () => {
  const review = reviewOf();
  const eight = review.specifications.find(item => item.sourceSkuId === 'sku-8xl-yellow');
  const parts = eight.breakdown;
  assert.equal(parts.revenueCny, 127.35);
  assert.equal(parts.commissionRate, 0.14);
  assert.equal(parts.freightRmb, 10.11);
  assert.equal(parts.packagingRmb, 3);
  assert.equal(parts.labelCostRmb, 1.5);
  assert.equal(parts.allInPurchaseRmb, 45);
  assert.equal(parts.unitProfitRmb, eight.unitProfitRmb);
  // 三次分位取整，分项最多比引擎一次算出来的利润高两分钱；再多就说明这不是同一条算式了。
  assert.ok(parts.roundingRmb >= 0 && parts.roundingRmb <= 0.02, `分项对不上：${parts.roundingRmb}`);
  const sum = parts.revenueCny - parts.commissionRmb - parts.storeReserveRmb - parts.freightRmb -
    parts.packagingRmb - parts.labelCostRmb - parts.otherFixedRmb - parts.allInPurchaseRmb;
  assert.equal(Math.round((sum - parts.unitProfitRmb) * 100) / 100, parts.roundingRmb);
  // 每一个过线的规格都要对得上，不能只有这一个碰巧对上。
  for (const item of review.specifications) {
    assert.ok(item.breakdown.roundingRmb >= 0 && item.breakdown.roundingRmb <= 0.02,
      `${item.label} 的分项对不上：${item.breakdown.roundingRmb}`);
  }
  // 算不出利润的规格没有算式，也不许拿别的规格的顶上。
  assert.equal(specificationBreakdown({ row: { revenueCny: null }, packagingRmb: 3, labelCostRmb: 1.5 }), null);
});

test('排队表复用既有的保本价与达标最低售价，档位分界线取自官方表', () => {
  const review = reviewOf();
  // 货价与重量都一样的规格合成一行；两个 XL 和两个 8XL 各合一行，米色 8XL 自己一行。
  assert.equal(review.queue.length, 3);
  const eight = review.queue.find(row => row.sourceSkuIds.includes('sku-8xl-yellow'));
  assert.equal(eight.count, 2);
  assert.deepEqual(eight.sourceSkuIds.sort(), ['sku-8xl-black', 'sku-8xl-yellow']);
  assert.equal(eight.priceCny, 41.5);
  assert.equal(eight.freightRmb, 10.11);
  assert.ok(eight.breakEvenRub > 0 && eight.thresholdRub > eight.breakEvenRub);
  // 每个尺码有自己的下探空间：小号的保本价必须低于大号的。
  const xl = review.queue.find(row => row.sourceSkuIds.includes('sku-xl-yellow'));
  assert.ok(xl.breakEvenRub < eight.breakEvenRub);
  assert.ok(xl.thresholdRub < eight.thresholdRub);

  assert.equal(review.commission.current.rate, 0.14);
  assert.equal(review.commission.current.minRub, 1500.01);
  assert.equal(review.commission.next.rate, 0.15);
  // 分界线是官方表里的数，不是页面写死的 1500 / 5000。
  assert.deepEqual(review.commission.bands.map(band => band.maxRub), [1500, 5000, null]);

  // 官方档位表拿不到时，保本价和达标价留空，不许用别的费率凑一个出来。
  const blank = reviewOf({ commissionTiers: { tiers: [] } });
  assert.ok(blank.queue.every(row => row.breakEvenRub === null && row.thresholdRub === null));
  assert.equal(blank.commission.current, null);
});

test('分组只在货价和重量都一样时才合行', () => {
  const rows = [
    { sourceSkuId: 'a', label: 'XL · 黄色', values: ['XL', '黄色'], priceCny: 20.5, weightKg: 0.103 },
    { sourceSkuId: 'b', label: 'XL · 黑色', values: ['XL', '黑色'], priceCny: 20.5, weightKg: 0.103 },
    { sourceSkuId: 'c', label: 'XL · 迷彩', values: ['XL', '迷彩'], priceCny: 22.5, weightKg: 0.103 }
  ];
  const groups = groupQueuedSpecifications(rows, ['尺码', '颜色']);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].label, 'XL · 黄色 / 黑色');
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].label, 'XL · 迷彩');
});

test('提交的那一份由已保存的记录组装齐，并且服务端自己的校验能通过', () => {
  const captureState = capture();
  const candidate = candidateOf(captureState);
  const card = buildRealAConfirmationCard(candidate);
  const review = buildProfitStepReview({
    candidate, draft, table: tableOf(captureState),
    estimate: { estimate: { costPolicy: { ...storeRule }, fx } },
    card, commissionTiers: COMMISSION_TIERS, builtAt: '2026-09-13T01:00:02.000Z'
  });
  assert.deepEqual(profitStepGaps(review, 'sku-8xl-yellow'), []);

  const payload = profitStepSubmission(review, 'sku-8xl-yellow',
    { comparabilityConfirmed: true, supplyConfirmed: true });
  // 身份、店铺、快照、链接、采集回执、页面价、国内运费、包装尺寸——全部来自已保存的记录。
  assert.equal(payload.dataRevision, candidate.dataRevision);
  assert.equal(payload.sourceCandidateId, candidate.id);
  assert.equal(payload.sourceDataRevision, candidate.dataRevision);
  assert.equal(payload.targetPlatform, 'ozon');
  assert.deepEqual(payload.storeRef, STORE_REF);
  assert.equal(payload.decision, 'confirm');
  assert.equal(payload.targetSalePriceRub, draft.targetSalePriceRub);
  assert.equal(payload.salesReview.snapshotId, snapshot.snapshotId);
  assert.equal(payload.supplierConfirmation.captureId, captureState.captureId);
  assert.equal(payload.supplierConfirmation.productUrl, OFFER_URL);
  assert.equal(payload.supplierConfirmation.supplierSkuId, 'sku-8xl-yellow');
  assert.equal(payload.supplierConfirmation.variantKey,
    card.supplierCapture.skuChoices.find(item => item.sourceSkuId === 'sku-8xl-yellow').variantKey);
  assert.equal(payload.supplierConfirmation.unitProductPrice, 41.5);
  assert.equal(payload.supplierConfirmation.unitDomesticFreight, draft.domesticShippingRmb);
  assert.equal(payload.supplierConfirmation.otherPurchaseCosts, 0);
  assert.equal(payload.supplierConfirmation.actualPurchaseCost, 45);
  assert.equal(payload.supplierConfirmation.weightKg, 0.24);
  assert.deepEqual(payload.supplierConfirmation.dimensionsCm, draft.dimensionsCm);
  assert.equal(payload.supplierConfirmation.minimumOrderQuantity, 1);
  // 两个勾选变成的三件事：可比、快照仍然有效、精确同款。
  assert.equal(payload.salesReview.comparability, 'comparable');
  assert.equal(payload.salesReview.validityStatus, 'current');
  assert.equal(payload.supplierConfirmation.matchType, 'exact_match');
  assert.equal(payload.supplierConfirmation.ownerSupplyConfirmed, true);
  // 「一件可买」那句话说的是采集记录里真实的那条报价，不是软件替主人编的。
  assert.match(payload.supplierConfirmation.quantityOneEvidenceSourceNote, /起订量是 1 件/u);
  assert.match(payload.supplierConfirmation.quantityOneEvidenceSourceNote, /tradeModel\.offerPriceModel\.currentPrices/u);

  const validation = validateRealAConfirmationSubmission(card, payload);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test('两个判断少一个就不提交', () => {
  const review = reviewOf();
  assert.equal(profitStepSubmission(review, 'sku-8xl-yellow', { comparabilityConfirmed: true, supplyConfirmed: false }), null);
  assert.equal(profitStepSubmission(review, 'sku-8xl-yellow', { comparabilityConfirmed: false, supplyConfirmed: true }), null);
  assert.equal(profitStepSubmission(review, 'sku-8xl-yellow', {}), null);
});

test('资料缺一样就不许提交，缺的是什么如实列出来', () => {
  // 采集里没有「一件起订」的报价：不许软件替主人写那句核对说明。
  const noRanges = capture({ priceRanges: [{ minimumQuantity: 2, priceCny: 20.5, source: 'tradeModel.offerPriceModel.currentPrices' }] });
  const withoutEvidence = reviewOf({ captureState: noRanges });
  const gaps = profitStepGaps(withoutEvidence, 'sku-8xl-yellow');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].field, 'quantityOneEvidenceSourceNote');
  assert.equal(profitStepSubmission(withoutEvidence, 'sku-8xl-yellow',
    { comparabilityConfirmed: true, supplyConfirmed: true }), null);
  assert.equal(quantityOneEvidenceNote({ capture: noRanges, sku: EIGHT_YELLOW, label: '8XL · 黄色' }), null);

  // 找货里没填国内运费：整件商品都不能确认，且到手价不许自己凑。
  const noFreight = reviewOf({ draftInput: { ...draft, domesticShippingRmb: null } });
  assert.ok(noFreight.baseGaps.some(item => item.field === 'unitDomesticFreight'));
  assert.equal(noFreight.submissionBase, null);
  assert.equal(noFreight.specifications[0].actualPurchaseCost, null);
  assert.equal(profitStepSubmission(noFreight, 'sku-8xl-yellow',
    { comparabilityConfirmed: true, supplyConfirmed: true }), null);

  // 包装尺寸缺一边也一样。
  const noHeight = reviewOf({ draftInput: { ...draft, dimensionsCm: { length: 25, width: 22, height: null } } });
  assert.ok(noHeight.baseGaps.some(item => item.field === 'dimensionsCm.height'));
  assert.equal(profitStepSubmission(noHeight, 'sku-8xl-yellow',
    { comparabilityConfirmed: true, supplyConfirmed: true }), null);

  // 还没指定先上哪一个，也不能提交。
  const review = reviewOf();
  assert.deepEqual(profitStepGaps(review, ''), [{ field: 'supplierSkuId', label: '先上哪一个', why: '先在上面指定一个变体先上架。' }]);
  assert.equal(profitStepSubmission(review, '', { comparabilityConfirmed: true, supplyConfirmed: true }), null);
});

test('还没选定规格、或者已经确认过的商品，都没有这一步', () => {
  const unchosen = capture({ selectedSkuIds: [] });
  assert.equal(reviewOf({ captureState: unchosen }), null);
  // 已经确认过一次的商品不能再看到这张确认表：采集记录仍旧停在「等你选规格」，但这一步已经过去了。
  assert.equal(reviewOf({ candidateExtra: { lifecycleV11: { aConfirmationReceipt: { decision: 'confirm' } } } }), null);
  assert.equal(reviewOf({ candidateExtra: { lifecycleV11: { skuPackage: { businessPhase: 'B' } } } }), null);
});
