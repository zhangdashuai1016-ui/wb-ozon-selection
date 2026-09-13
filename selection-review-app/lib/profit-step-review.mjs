import { pricingGuidance, roundDownCents } from './a-discovery-estimate.mjs';

/**
 * 算利润 — the step between 选定 and 文案素材.
 *
 * The owner's rule, stated 2026-09-13: he does not want the software to pick the one specification that earns most.
 * Every specification that clears the store's profit line is one he intends to sell. So this step does three things
 * and only these three: it checks the whole chosen set against the line at once, it lets him name the one variant
 * that goes up first to prove the listing route, and it leaves the rest queued to be added to that same Ozon card.
 *
 * Nothing here computes money. Every profit, freight and chargeable weight was worked out by `buildSkuChoiceTable`
 * on the server, from that specification's own captured price and its own captured weight; every break-even and
 * threshold price comes from `pricingGuidance`, the same inverse of the same formula the 找货 step already shows.
 * This module reads those records, groups them the way the owner reads them, and assembles the A confirmation the
 * existing route already validates. A fact the saved records do not hold is reported as a gap, never invented.
 */
export const PROFIT_STEP_SCHEMA_VERSION = 'profit-step-review-v1';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const textOf = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const cents = value => Math.round(value * 100) / 100;
const dayOf = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null);

/**
 * The size the benchmark product names in its own title, read from the specifications' own declared attributes.
 *
 * The comparison is only trustworthy when it is unambiguous: exactly one attribute must produce exactly one value
 * that appears in the title as a whole token. `XL` sits inside `8XL`, so a bare substring test would match both and
 * silently pick the wrong one; a value flanked by letters or digits is therefore not a match at all. Anything less
 * than one clear answer returns null, and the step asks the owner rather than guessing.
 */
export function benchmarkAttributeMatch(rows, title) {
  const text = textOf(title);
  if (text === null) return null;
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const [key, value] of Object.entries(isObject(row?.attributes) ? row.attributes : {})) {
      const declared = textOf(value);
      if (textOf(key) === null || declared === null) continue;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(declared);
    }
  }
  const hits = [];
  for (const [key, values] of byKey) {
    const matched = [...values].filter(value => new RegExp(
      `(?<![0-9A-Za-z])${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![0-9A-Za-z])`, 'iu').test(text));
    if (matched.length === 1) hits.push({ attributeKey: key, value: matched[0] });
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Which specifications clear the store's line, which fall short, and which the software could not price at all. */
export function specificationVerdicts({ rows, policy }) {
  const minimumUnitProfitRmb = finite(policy?.minimumUnitProfitRmb);
  const targetMarginRate = finite(policy?.targetMarginRate);
  const passing = [];
  const excluded = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.passes === true) { passing.push(row); continue; }
    if (finite(row?.unitProfitRmb) === null) {
      excluded.push({ sourceSkuId: row?.sourceSkuId ?? null, label: row?.label ?? null, kind: 'not_priced',
        missing: Array.isArray(row?.missing) && row.missing.length > 0 ? [...row.missing] : ['规格重量'],
        unitProfitRmb: null, marginRate: null, unitProfitShortRmb: null, marginShortRate: null });
      continue;
    }
    excluded.push({
      sourceSkuId: row.sourceSkuId, label: row.label, kind: 'below_threshold',
      missing: [], unitProfitRmb: row.unitProfitRmb, marginRate: finite(row.marginRate),
      unitProfitShortRmb: minimumUnitProfitRmb === null ? null : cents(minimumUnitProfitRmb - row.unitProfitRmb),
      marginShortRate: targetMarginRate === null || finite(row.marginRate) === null
        ? null : Math.round((targetMarginRate - row.marginRate) * 10000) / 10000
    });
  }
  const profits = passing.map(row => row.unitProfitRmb);
  const margins = passing.map(row => finite(row.marginRate)).filter(value => value !== null);
  return {
    passing, excluded,
    passCount: passing.length,
    excludedCount: excluded.length,
    unitProfitRange: profits.length === 0 ? null : { low: Math.min(...profits), high: Math.max(...profits) },
    marginRange: margins.length === 0 ? null : { low: Math.min(...margins), high: Math.max(...margins) }
  };
}

/**
 * What this one specification's profit is made of, taken apart into the deductions the owner asked to see.
 * Each part is one already-evidenced rate or amount applied to the row's own revenue; the last line is not
 * re-derived here but is the profit the engine itself produced, so the page can never show a bottom line the
 * saved record does not hold.
 *
 * `roundingRmb` is what taking it apart leaves over. The engine floors one expression to cents; this floors the two
 * rate-driven parts separately, so each of the three floors can drop up to a cent and the parts can read up to two
 * cents high against the engine's own profit. It is kept in the data rather than hidden, so a test can hold that
 * bound and the page can say plainly that the bottom line is the engine's number, not the column's sum.
 */
export function specificationBreakdown({ row, packagingRmb, labelCostRmb }) {
  const revenueCny = finite(row?.revenueCny);
  const commissionRate = finite(row?.commissionRate);
  const reserveRate = finite(row?.reserveRate);
  const freightRmb = finite(row?.freightRmb);
  const nonPurchaseFixedRmb = finite(row?.nonPurchaseFixedRmb);
  const allInPurchaseRmb = finite(row?.allInPurchaseRmb);
  const unitProfitRmb = finite(row?.unitProfitRmb);
  if ([revenueCny, commissionRate, reserveRate, freightRmb, nonPurchaseFixedRmb, allInPurchaseRmb, unitProfitRmb]
    .some(value => value === null)) return null;
  // Same floor-to-cents the engine itself uses, so a part shown here can never be a cent larger than the part the
  // profit was actually worked out with.
  const storeReserveRate = Math.round((reserveRate - commissionRate) * 10000) / 10000;
  const commissionRmb = roundDownCents(revenueCny * commissionRate);
  const storeReserveRmb = roundDownCents(revenueCny * storeReserveRate);
  const packaging = finite(packagingRmb) ?? 0;
  const label = finite(labelCostRmb) ?? 0;
  const otherFixedRmb = roundDownCents(nonPurchaseFixedRmb - freightRmb - packaging - label);
  return {
    revenueCny, commissionRate, commissionRmb, storeReserveRate, storeReserveRmb,
    freightRmb, packagingRmb: packaging, labelCostRmb: label,
    otherFixedRmb: otherFixedRmb === 0 ? 0 : otherFixedRmb,
    allInPurchaseRmb, unitProfitRmb, marginRate: finite(row.marginRate),
    roundingRmb: cents(revenueCny - commissionRmb - storeReserveRmb - freightRmb - packaging - label -
      otherFixedRmb - allInPurchaseRmb - unitProfitRmb)
  };
}

/**
 * Owner ruling 2026-09-13: the price this step charges is the page's own price for this specification, not the one
 * figure typed into 找货 — but the difference between them has to be said out loud, because 找货 priced one imagined
 * average parcel and this specification carries its own. Equal prices have no difference to report.
 */
export function pagePriceDelta({ row, draft }) {
  const pageRmb = finite(row?.priceCny);
  const declaredRmb = finite(draft?.goodsPriceRmb);
  if (pageRmb === null || declaredRmb === null) return null;
  const deltaRmb = cents(pageRmb - declaredRmb);
  return deltaRmb === 0 ? null : { pageRmb, declaredRmb, deltaRmb };
}

/**
 * Where the "one piece is buyable, at this price" check actually came from, written out of the capture's own saved
 * fields. The A confirmation refuses a browser capture without it, and it must never be a sentence the software made
 * up: no saved quantity-one price range, or no captured price for this specification, means no note and a gap.
 */
export function quantityOneEvidenceNote({ capture, sku, label }) {
  const ranges = Array.isArray(capture?.priceRanges) ? capture.priceRanges : [];
  const one = ranges.find(range => finite(range?.minimumQuantity) === 1);
  const priceCny = finite(sku?.priceCny);
  if (!one || priceCny === null) return null;
  const day = dayOf(capture?.observedAt);
  const offerId = textOf(capture?.offerId);
  const moqSource = textOf(one.source);
  const priceSource = textOf(sku?.priceSource);
  const name = textOf(label) ?? textOf(sku?.sourceSkuId) ?? '这个规格';
  return [
    `按${day === null ? '' : ` ${day} `}采到的 1688 页面`,
    offerId === null ? '' : `（商品 ${offerId}）`,
    `核对：页面报的起订量是 1 件`,
    moqSource === null ? '' : `（来源 ${moqSource}）`,
    `；${name} 这一个规格的单价 ¥${priceCny.toFixed(2)} 取自同一次采集`,
    priceSource === null ? '' : `（来源 ${priceSource}）`,
    '。'
  ].join('');
}

/**
 * The queue, collapsed to the rows the owner actually reads. Specifications that declared the same price and the same
 * weight produce the same freight, the same break-even and the same profit down to the cent, so listing them apart
 * would be 31 lines saying four things. Grouping is a fact about the captured numbers, never a rounding of them:
 * a specification whose price or weight differs by any amount keeps its own row.
 */
export function groupQueuedSpecifications(rows, columns) {
  const keys = Array.isArray(columns) ? columns : [];
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = `${row?.priceCny ?? 'x'}|${row?.weightKg ?? 'x'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(members => {
    const head = members[0];
    const values = keys.map((_, index) => [...new Set(members
      .map(row => textOf(Array.isArray(row.values) ? row.values[index] : null))
      .filter(value => value !== null))]);
    const label = values.filter(list => list.length > 0).map(list => list.join(' / ')).join(' · ');
    return {
      key: members.map(row => row.sourceSkuId).join('+'),
      sourceSkuIds: members.map(row => row.sourceSkuId),
      count: members.length,
      label: label === '' ? head.label : label,
      values,
      priceCny: head.priceCny, weightKg: head.weightKg, chargeableKg: head.chargeableKg,
      freightRmb: head.freightRmb, allInPurchaseRmb: head.allInPurchaseRmb,
      unitProfitRmb: head.unitProfitRmb, marginRate: head.marginRate,
      breakEvenRub: head.breakEvenRub ?? null, thresholdRub: head.thresholdRub ?? null,
      thresholdBasis: head.thresholdBasis ?? null
    };
  });
}

/** Every band of the official rate ladder, and where the current target price sits in it. */
function commissionBands(tiers, targetSalePriceRub) {
  const bands = (Array.isArray(tiers) ? tiers : [])
    .filter(tier => finite(tier?.rate) !== null && finite(tier?.minRub) !== null)
    .map(tier => ({ rate: tier.rate, minRub: tier.minRub, maxRub: finite(tier.maxRub), tier: textOf(tier.tier) }))
    .sort((left, right) => left.minRub - right.minRub);
  const price = finite(targetSalePriceRub);
  const index = price === null ? -1 : bands.findIndex(band =>
    price >= band.minRub && (band.maxRub === null || price <= band.maxRub));
  return { bands, current: index < 0 ? null : bands[index], next: index < 0 ? null : bands[index + 1] ?? null };
}

/** The cheapest price this one specification breaks even at, and the cheapest that clears the store's line. */
function specificationPrices({ row, fx, tiers, policy }) {
  const allInPurchaseRmb = finite(row?.allInPurchaseRmb);
  const nonPurchaseFixedRmb = finite(row?.nonPurchaseFixedRmb);
  if (allInPurchaseRmb === null || nonPurchaseFixedRmb === null || !isObject(policy) ||
      !Array.isArray(tiers) || tiers.length === 0) return { breakEvenRub: null, thresholdRub: null, thresholdBasis: null };
  const guidance = pricingGuidance({ fx, tiers, policy, costs: { allInPurchaseRmb, nonPurchaseFixedRmb } });
  return guidance.status !== 'ok'
    ? { breakEvenRub: null, thresholdRub: null, thresholdBasis: null }
    : {
      breakEvenRub: guidance.breakEven?.priceRub ?? null,
      thresholdRub: guidance.threshold?.priceRub ?? null,
      thresholdBasis: guidance.threshold?.basis ?? null
    };
}

const gap = (field, label, why) => ({ field, label, why });

/** The Ozon product number the benchmark snapshot is about, read from its own saved link. */
function ozonProductNumber(productUrl) {
  const match = String(productUrl ?? '').match(/\/product\/(?:[^/?#]*-)?(\d+)/u);
  return match ? match[1] : null;
}

/**
 * Everything 算利润 shows and everything it would submit, for one product.
 *
 * Returns null while the step is not open — no priced specification table, the owner has not chosen from it yet, or
 * the confirmation is already frozen. That last case matters: the capture keeps its "waiting on the owner" status
 * after a confirmation, so without this guard a product already running its profit calculation would be shown the
 * confirmation form a second time, with the card gone and every field reported as missing.
 */
export function buildProfitStepReview({
  candidate, draft, table, estimate = null, card = null, commissionTiers = null, builtAt = null
}) {
  if (!isObject(candidate) || !isObject(table) || !Array.isArray(table.rows) || table.rows.length === 0) return null;
  if (isObject(candidate.lifecycleV11?.aConfirmationReceipt) || isObject(candidate.lifecycleV11?.skuPackage)) return null;
  const chosenIds = (Array.isArray(table.selectedSkuIds) ? table.selectedSkuIds : []).map(String);
  if (chosenIds.length === 0) return null;
  const chosen = table.rows.filter(row => chosenIds.includes(String(row.sourceSkuId)));
  if (chosen.length === 0) return null;

  const policy = isObject(estimate?.estimate?.costPolicy) ? estimate.estimate.costPolicy : null;
  const fx = isObject(estimate?.estimate?.fx) ? estimate.estimate.fx : null;
  const tiers = Array.isArray(commissionTiers?.tiers) ? commissionTiers.tiers : [];
  const verdicts = specificationVerdicts({ rows: chosen, policy });
  const capture = isObject(candidate.sourceCapture) ? candidate.sourceCapture : null;
  const cardSkus = Array.isArray(card?.supplierCapture?.skuChoices) ? card.supplierCapture.skuChoices : [];
  const sales = isObject(card?.salesReview) ? card.salesReview : null;
  const targetSalePriceRub = finite(draft?.targetSalePriceRub);

  // 建议先上的那一个：对标商品标题里写着哪个规格，这一套里就先上同一个规格；判断不出来就不建议。
  const match = benchmarkAttributeMatch(verdicts.passing, sales?.title ?? null);
  const sameAttribute = match === null ? [] : verdicts.passing
    .filter(row => textOf(row.attributes?.[match.attributeKey]) === match.value);
  const suggested = sameAttribute[0] ?? null;

  const priced = verdicts.passing.map(row => ({ ...row, ...specificationPrices({ row, fx, tiers, policy }) }));
  const byId = new Map(priced.map(row => [String(row.sourceSkuId), row]));

  // 提交时每个规格都一样的那一半，全部来自已保存的记录。
  const productUrl = textOf(card?.supplierCapture?.sourceUrl);
  const captureId = textOf(card?.supplierCapture?.captureId);
  const dimensions = isObject(draft?.dimensionsCm) ? draft.dimensionsCm : {};
  const unitDomesticFreight = finite(draft?.domesticShippingRmb);
  const baseGaps = [];
  if (!isObject(card)) baseGaps.push(gap('card', '这件商品的确认资料', '服务端现在拿不出这件商品的确认资料，先回到上一步刷新一次。'));
  if (card !== null && card.storeBindingStatus !== 'bound') {
    baseGaps.push(gap('storeRef', '店铺', '这件商品还没有绑定到一个完整的店铺。'));
  }
  if (sales === null) baseGaps.push(gap('salesReview.snapshotId', '对标商品的快照', '还没有这件商品的对标 Ozon 商品快照。'));
  if (productUrl === null || captureId === null) {
    baseGaps.push(gap('supplierCapture', '1688 采集记录', '这一次的 1688 采集记录不完整，重新采集一次再来。'));
  }
  if (unitDomesticFreight === null) baseGaps.push(gap('unitDomesticFreight', '国内运费', '你在「找货」里还没有填国内运费，包邮请填 0。'));
  for (const [key, name] of [['length', '长'], ['width', '宽'], ['height', '高']]) {
    if (finite(dimensions[key]) === null || dimensions[key] <= 0) {
      baseGaps.push(gap(`dimensionsCm.${key}`, `包装${name}`, `你在「找货」里还没有填包装${name}。`));
    }
  }
  if (targetSalePriceRub === null || targetSalePriceRub <= 0) {
    baseGaps.push(gap('targetSalePriceRub', '目标成交价', '你在「找货」里还没有填目标成交价。'));
  }
  if (card?.blockedByException === true) {
    baseGaps.push(gap('exception', '未处理的异常', '这件商品还有一条没有解决的异常记录，处理完才能往下走。'));
  }

  const specifications = priced.map(row => {
    const id = String(row.sourceSkuId);
    const cardSku = cardSkus.find(sku => String(sku.sourceSkuId) === id) ?? null;
    const variantKey = textOf(cardSku?.variantKey);
    const unitProductPrice = finite(cardSku?.priceCny) ?? finite(row.priceCny);
    const weightKg = finite(row.weightKg);
    const note = quantityOneEvidenceNote({ capture, sku: cardSku ?? { priceCny: row.priceCny }, label: row.label });
    const gaps = [];
    if (cardSku === null || variantKey === null) gaps.push(gap('variantKey', '规格标识', '这一次的采集记录里没有这个规格的标识，重新采集一次再来。'));
    if (unitProductPrice === null || unitProductPrice <= 0) gaps.push(gap('unitProductPrice', '这个规格的货价', '这一次采集没有读到这个规格自己的价格。'));
    if (weightKg === null || weightKg <= 0) gaps.push(gap('weightKg', '这个规格的重量', '这一次采集没有读到这个规格自己的重量，运费和利润都算不出来。'));
    if (note === null) gaps.push(gap('quantityOneEvidenceSourceNote', '一件可买的凭据',
      '这一次采集没有读到「一件起订」的报价，软件不会替你写这句话；重新采集一次这个 1688 页面再来。'));
    return {
      sourceSkuId: id,
      label: row.label,
      values: Array.isArray(row.values) ? [...row.values] : [],
      attributes: isObject(row.attributes) ? { ...row.attributes } : {},
      priceCny: row.priceCny, weightKg, chargeableKg: row.chargeableKg, route: row.route,
      freightRmb: row.freightRmb, allInPurchaseRmb: row.allInPurchaseRmb,
      unitProfitRmb: row.unitProfitRmb, marginRate: row.marginRate,
      breakEvenRub: row.breakEvenRub, thresholdRub: row.thresholdRub, thresholdBasis: row.thresholdBasis,
      breakdown: specificationBreakdown({ row,
        packagingRmb: table.sources?.packagingRmbDefault, labelCostRmb: table.sources?.labelCostRmb }),
      priceDelta: pagePriceDelta({ row, draft }),
      variantKey,
      unitProductPrice,
      actualPurchaseCost: unitProductPrice === null || unitDomesticFreight === null
        ? null : cents(unitProductPrice + unitDomesticFreight),
      quantityOneEvidenceSourceNote: note,
      isSuggested: suggested !== null && String(suggested.sourceSkuId) === id,
      gaps
    };
  });

  return Object.freeze({
    schemaVersion: PROFIT_STEP_SCHEMA_VERSION,
    builtAt,
    candidateId: candidate.id,
    dataRevision: candidate.dataRevision,
    columns: Array.isArray(table.columns) ? [...table.columns] : [],
    total: chosen.length,
    passCount: verdicts.passCount,
    excludedCount: verdicts.excludedCount,
    unitProfitRange: verdicts.unitProfitRange,
    marginRange: verdicts.marginRange,
    excluded: verdicts.excluded,
    threshold: policy === null ? null : {
      minimumUnitProfitRmb: finite(policy.minimumUnitProfitRmb),
      targetMarginRate: finite(policy.targetMarginRate),
      thresholdPolicy: policy.thresholdPolicy === 'both' ? 'both' : 'either',
      policyVersion: textOf(policy.pricingPolicyVersion)
    },
    // 建议里为什么是这一个：对标标题里写着的那个规格。同规格有几个颜色就说几个，颜色由主人自己定。
    benchmark: sales === null ? null : {
      productNumber: ozonProductNumber(sales.productUrl),
      productUrl: sales.productUrl ?? null,
      title: sales.title ?? null,
      currentPrice: finite(sales.currentPrice),
      currency: textOf(sales.currency),
      collectedOn: dayOf(sales.collectedAt),
      snapshotId: sales.snapshotId ?? null,
      matchedAttributeKey: match?.attributeKey ?? null,
      matchedValue: match?.value ?? null,
      sameAttributeCount: sameAttribute.length
    },
    suggestedSkuId: suggested === null ? null : String(suggested.sourceSkuId),
    specifications,
    queue: groupQueuedSpecifications(priced, table.columns),
    commission: commissionBands(tiers, targetSalePriceRub),
    supply: {
      productUrl,
      offerId: textOf(capture?.offerId),
      observedOn: dayOf(capture?.observedAt),
      declaredGoodsPriceRmb: finite(draft?.goodsPriceRmb),
      unitDomesticFreight,
      // 找货里只填了货价和国内运费，到手就是这两项相加；这一步照这份声明报 0，不另外猜一笔钱出来。
      otherPurchaseCosts: unitDomesticFreight === null ? null : 0,
      dimensionsCm: { length: finite(dimensions.length), width: finite(dimensions.width), height: finite(dimensions.height) },
      targetSalePriceRub
    },
    submissionBase: baseGaps.length > 0 ? null : {
      dataRevision: candidate.dataRevision,
      sourceCandidateId: card.sourceCandidateId,
      sourceDataRevision: card.sourceDataRevision,
      targetPlatform: card.targetPlatform,
      storeRef: structuredClone(card.storeRef),
      targetSalePriceRub,
      snapshotId: sales.snapshotId,
      confidence: textOf(sales.confidence) ?? 'unknown',
      captureId,
      productUrl,
      unitDomesticFreight,
      otherPurchaseCosts: 0,
      dimensionsCm: { length: dimensions.length, width: dimensions.width, height: dimensions.height }
    },
    baseGaps: Object.freeze(baseGaps)
  });
}

/** Everything still missing before this one specification can be confirmed, in the owner's words. */
export function profitStepGaps(review, sourceSkuId) {
  if (!isObject(review)) return [gap('review', '这一步的资料', '这一步的资料还没有准备好。')];
  const spec = (review.specifications ?? []).find(item => item.sourceSkuId === String(sourceSkuId)) ?? null;
  const base = [...(review.baseGaps ?? [])];
  if (spec === null) return [...base, gap('supplierSkuId', '先上哪一个', '先在上面指定一个变体先上架。')];
  return [...base, ...spec.gaps];
}

/**
 * The A confirmation this step submits, assembled from the saved records plus the two judgments only the owner can
 * make. Everything else is already evidenced: the link, the capture, this specification's own page price and weight,
 * the domestic freight and the packing size he declared in 找货, and the benchmark snapshot the comparison is about.
 * A specification with any gap left produces nothing at all — an incomplete confirmation is not a confirmation.
 */
export function profitStepSubmission(review, sourceSkuId, { comparabilityConfirmed, supplyConfirmed } = {}) {
  if (comparabilityConfirmed !== true || supplyConfirmed !== true) return null;
  if (profitStepGaps(review, sourceSkuId).length > 0) return null;
  const base = review.submissionBase;
  const spec = review.specifications.find(item => item.sourceSkuId === String(sourceSkuId));
  return {
    dataRevision: base.dataRevision,
    sourceCandidateId: base.sourceCandidateId,
    sourceDataRevision: base.sourceDataRevision,
    targetPlatform: base.targetPlatform,
    storeRef: structuredClone(base.storeRef),
    decision: 'confirm',
    targetSalePriceRub: base.targetSalePriceRub,
    salesReview: {
      snapshotId: base.snapshotId,
      comparability: 'comparable',
      validityStatus: 'current',
      confidence: base.confidence
    },
    supplierConfirmation: {
      captureId: base.captureId,
      productUrl: base.productUrl,
      supplierSkuId: spec.sourceSkuId,
      variantKey: spec.variantKey,
      matchType: 'exact_match',
      minimumOrderQuantity: 1,
      quantityOneEvidenceSourceNote: spec.quantityOneEvidenceSourceNote,
      unitProductPrice: spec.unitProductPrice,
      unitDomesticFreight: base.unitDomesticFreight,
      otherPurchaseCosts: base.otherPurchaseCosts,
      actualPurchaseCost: spec.actualPurchaseCost,
      weightKg: spec.weightKg,
      dimensionsCm: { ...base.dimensionsCm },
      ownerSupplyConfirmed: true
    }
  };
}
