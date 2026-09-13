import { estimateDiscoveredProduct } from './a-discovery-estimate.mjs';
import { profitAtPurchase, supplierDraftEstimateProduct } from './supplier-draft.mjs';

/**
 * 选规格 — what each captured specification of one 1688 offer is actually worth.
 *
 * The owner's 找货 declaration prices one imaginary average parcel. A real offer is 24 different parcels: the page
 * gives every specification its own price and its own shipping weight, so every specification has its own freight and
 * its own profit. This module works those out, one specification at a time.
 *
 * It computes nothing itself. Each row goes through exactly the engine and the inputs the 找货 estimate already uses
 * — `estimateDiscoveredProduct` with the official FX, the official commission, the saved GUOO rows, the store's cost
 * policy and the owner's own declared packing size, domestic freight and target price — and then through the single
 * `profitAtPurchase` formula. The only two things that change per row are the two facts the page itself declared:
 * that specification's goods price and that specification's weight.
 *
 * A specification whose weight the page never declared is left empty, never filled in from the owner's packed weight
 * or from a neighbouring specification: a borrowed weight would produce a freight and a profit that are simply not
 * about this specification.
 */
export const SKU_CHOICE_TABLE_SCHEMA_VERSION = 'sku-choice-table-v1';

/** A combined "黄色>XL" label is a worse column than the declared 颜色 and 尺码 it was built from. */
const COMBINED_ATTRIBUTE_KEY = '规格';
const MAX_SPECIFICATION_COLUMNS = 3;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * The kilograms this specification ships at, exactly as the capture kept them.
 * Anything else — no weight, a weight in another unit, a non-positive number — is "not declared", not a default.
 */
export function capturedSkuWeightKg(sku) {
  const weight = sku?.weight;
  if (finite(weight) && weight > 0) return weight;
  if (!isObject(weight) || String(weight.unit ?? '').trim().toLowerCase() !== 'kg') return null;
  return finite(weight.value) && weight.value > 0 ? weight.value : null;
}

/**
 * Which specification columns this offer actually has, read from the captured attributes themselves.
 * Columns that differ between specifications are the ones worth a column; when nothing differs the first declared
 * attribute still names what the owner is looking at.
 */
export function skuChoiceColumns(choices) {
  const keys = [];
  const distinct = new Map();
  for (const sku of Array.isArray(choices) ? choices : []) {
    for (const [key, value] of Object.entries(isObject(sku?.attributes) ? sku.attributes : {})) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      if (!distinct.has(key)) { keys.push(key); distinct.set(key, new Set()); }
      distinct.get(key).add(String(value));
    }
  }
  const varying = keys.filter(key => distinct.get(key).size > 1);
  const chosen = varying.length > 0 ? varying : keys.slice(0, 1);
  const specific = chosen.filter(key => key !== COMBINED_ATTRIBUTE_KEY);
  return (specific.length > 0 ? specific : chosen).slice(0, MAX_SPECIFICATION_COLUMNS);
}

/** How this one specification reads out loud, for a headline that has to name it. */
export function skuChoiceLabel(row) {
  const values = Array.isArray(row?.values) ? row.values.filter(value => typeof value === 'string' && value !== '') : [];
  if (values.length > 0) return values.join(' · ');
  const attributes = isObject(row?.attributes) ? Object.values(row.attributes).filter(value => typeof value === 'string' && value !== '') : [];
  if (attributes.length > 0) return attributes.join(' · ');
  return typeof row?.propPath === 'string' && row.propPath !== '' ? row.propPath : String(row?.sourceSkuId ?? '');
}

function priceOneSku({ sku, draft, weightKg, storeRule, fx, commission, tariffRows, assumptions, marketProduct }) {
  const priceCny = finite(sku?.priceCny) && sku.priceCny > 0 ? sku.priceCny : null;
  if (weightKg === null) return { status: 'weight_missing', missing: ['规格重量'], estimate: null, profit: null, allInPurchaseRmb: null };
  if (priceCny === null) return { status: 'price_missing', missing: ['货价'], estimate: null, profit: null, allInPurchaseRmb: null };
  // The owner's declared packing size, domestic freight and target price stay exactly as saved; only the weight and
  // the goods price come from this specification.
  const product = {
    ...supplierDraftEstimateProduct(draft, {
      productId: marketProduct?.productId ?? null,
      categoryPath: marketProduct?.categoryPath ?? null
    }),
    weightGrams: Number((weightKg * 1000).toFixed(3))
  };
  const estimate = estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows, assumptions });
  const allInPurchaseRmb = Math.round((priceCny + draft.domesticShippingRmb) * 100) / 100;
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb });
  return {
    status: profit === null ? 'not_priced' : 'ok',
    missing: profit === null ? [...estimate.missing] : [],
    estimate,
    profit,
    allInPurchaseRmb
  };
}

/**
 * The whole table, sorted the way the owner reads it: most profitable specification first.
 * Rows the software could not price keep their captured facts and sit at the end, marked, rather than being hidden
 * or filled in.
 */
export function buildSkuChoiceTable({
  choices, draft, storeRule, fx, commission, tariffRows, assumptions,
  marketProduct = null, selectedSkuIds = [], builtAt = null, inputs = {}
}) {
  if (!isObject(draft)) throw new TypeError('SKU_CHOICE_TABLE_DRAFT_REQUIRED');
  const list = (Array.isArray(choices) ? choices : []).filter(sku => isObject(sku) && typeof sku.sourceSkuId === 'string' && sku.sourceSkuId !== '');
  const columns = skuChoiceColumns(list);
  const selected = [...new Set((Array.isArray(selectedSkuIds) ? selectedSkuIds : []).map(String))]
    .filter(id => list.some(sku => sku.sourceSkuId === id));
  const rows = list.map((sku, index) => {
    const weightKg = capturedSkuWeightKg(sku);
    const priced = priceOneSku({ sku, draft, weightKg, storeRule, fx, commission, tariffRows, assumptions, marketProduct });
    const chosenRoute = priced.estimate?.freight?.chosen ?? null;
    const row = {
      order: index,
      sourceSkuId: sku.sourceSkuId,
      propPath: typeof sku.propPath === 'string' ? sku.propPath : null,
      attributes: isObject(sku.attributes) ? { ...sku.attributes } : {},
      values: columns.map(key => {
        const value = isObject(sku.attributes) ? sku.attributes[key] : undefined;
        return typeof value === 'string' ? value : finite(value) ? String(value) : null;
      }),
      imageUrl: typeof sku.imageUrl === 'string' ? sku.imageUrl : null,
      priceCny: finite(sku.priceCny) && sku.priceCny > 0 ? sku.priceCny : null,
      stock: Number.isSafeInteger(sku.stock) && sku.stock >= 0 ? sku.stock : null,
      inStock: typeof sku.inStock === 'boolean' ? sku.inStock : null,
      weightKg,
      weightSource: typeof sku.weightSource === 'string' && sku.weightSource !== '' ? sku.weightSource : null,
      chargeableKg: chosenRoute?.chargeableKg ?? null,
      route: chosenRoute?.route ?? null,
      freightRmb: chosenRoute?.freightRmb ?? null,
      allInPurchaseRmb: priced.allInPurchaseRmb,
      // 算利润 has to show this one specification's profit as a list of deductions, and it has to ask "what would this
      // specification break even at". Both need the parts the row's own estimate already worked out, so the row carries
      // them out rather than letting a second place re-derive them from a neighbouring specification's estimate.
      revenueCny: priced.estimate?.revenueCny ?? null,
      commissionRate: priced.estimate?.commission?.rate ?? null,
      reserveRate: priced.estimate?.ceiling?.reserveRate ?? null,
      nonPurchaseFixedRmb: priced.estimate?.ceiling?.nonPurchaseFixedRmb ?? null,
      unitProfitRmb: priced.profit?.unitProfitRmb ?? null,
      marginRate: priced.profit?.marginRate ?? null,
      passes: priced.profit?.passes ?? null,
      status: priced.status,
      missing: priced.missing
    };
    row.label = skuChoiceLabel(row);
    return row;
  });
  // Most profitable first. A row without a profit has no place in that order, so it keeps its captured order at the end.
  const sorted = [...rows].sort((left, right) => {
    if (left.unitProfitRmb === null && right.unitProfitRmb === null) return left.order - right.order;
    if (left.unitProfitRmb === null) return 1;
    if (right.unitProfitRmb === null) return -1;
    return right.unitProfitRmb - left.unitProfitRmb || left.order - right.order;
  });
  const priced = sorted.filter(row => row.unitProfitRmb !== null);
  const best = priced[0] ?? null;
  const worst = priced.length > 1 ? priced[priced.length - 1] : null;
  const routes = [...new Set(priced.map(row => row.route).filter(route => typeof route === 'string' && route !== ''))];
  return Object.freeze({
    schemaVersion: SKU_CHOICE_TABLE_SCHEMA_VERSION,
    builtAt,
    columns,
    rows: sorted,
    total: sorted.length,
    pricedCount: priced.length,
    weightMissingCount: sorted.filter(row => row.status === 'weight_missing').length,
    best,
    worst,
    // "选错规格少赚多少" in the table's own two numbers, never a phrase written into the page.
    profitDropRate: best === null || worst === null || !(best.unitProfitRmb > 0)
      ? null
      : Math.round((best.unitProfitRmb - worst.unitProfitRmb) / best.unitProfitRmb * 10000) / 10000,
    selectedSkuIds: selected,
    sources: skuChoiceSources({ draft, storeRule, fx, commission, routes, inputs, assumptions })
  });
}

/** Every number in the table, traced to the record it came from. Nothing here is written by the page. */
function skuChoiceSources({ draft, storeRule, fx, commission, routes, inputs, assumptions }) {
  const rate = key => (finite(storeRule?.[key]) ? storeRule[key] : 0);
  const reserveParts = {
    advertisingReserveRate: rate('advertisingReserveRate'),
    returnOpsReserveRate: rate('returnOpsReserveRate'),
    damageLossReserveRate: rate('damageLossReserveRate'),
    withdrawalFeeRate: rate('withdrawalFeeRate')
  };
  return Object.freeze({
    targetSalePriceRub: draft.targetSalePriceRub,
    rubPerCny: finite(fx?.rubPerCny) ? fx.rubPerCny : null,
    fxRateDate: typeof fx?.rateDate === 'string' ? fx.rateDate : null,
    fxSourceRef: typeof fx?.sourceRef === 'string' ? fx.sourceRef : null,
    commissionRate: finite(commission?.rate) ? commission.rate : null,
    commissionTier: typeof commission?.tier === 'string' ? commission.tier : null,
    commissionSourceRef: typeof commission?.sourceRef === 'string' ? commission.sourceRef : null,
    routes,
    tariffRuleVersion: typeof inputs?.tariffRuleVersion === 'string' ? inputs.tariffRuleVersion : null,
    domesticShippingRmb: draft.domesticShippingRmb,
    packagingRmbDefault: finite(assumptions?.packagingRmbDefault) ? assumptions.packagingRmbDefault : null,
    labelCostRmb: rate('labelCostRmb'),
    reserveParts,
    reserveRate: Math.round(Object.values(reserveParts).reduce((total, value) => total + value, 0) * 10000) / 10000,
    dimensionsCm: { ...draft.dimensionsCm }
  });
}
