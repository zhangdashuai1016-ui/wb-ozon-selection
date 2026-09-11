/**
 * A-stage estimate for a discovered market product (owner decisions 2026-09-10): the code computes every number from
 * evidenced inputs (official commission, official FX, GUOO tariff rows, the store's cost policy); nothing is guessed.
 * Oversize (volumetric weight above actual) is an informational flag only. A negative purchase ceiling means the
 * product is excluded from the owner's selectable pool; that exclusion is the caller's job, this module only reports.
 */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonNegative = value => finite(value) && value >= 0;
const fail = (code, detail = '') => { throw new Error(`A_DISCOVERY_ESTIMATE_${code}${detail ? `: ${detail}` : ''}`); };
/** Same rounding as workflow.mjs roundDownCurrency: floor to cents (negative values floor away from zero). */
export function roundDownCents(value) { return Math.floor(value * 100 + 1e-9) / 100; }
const VOLUME_DIVISOR_CM3_PER_KG = 12000;

/** "0.001-2KG" / "2.001-30KG\n收抛" → {minKg, maxKg}; unknown text → null (row cannot be judged). */
export function parseWeightLimitKg(text) {
  if (typeof text !== 'string') return null;
  const match = text.replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)KG/i);
  if (!match) return null;
  const minKg = Number(match[1]), maxKg = Number(match[2]);
  return minKg <= maxKg ? { minKg, maxKg } : null;
}

/** "三边之和不超150CM，单边最大尺寸不超60CM" / "…不超310CM，单边最大尺寸不超150*80*80CM" → {sumMaxCm, sideMaxCm[] (sorted descending)}. */
export function parseSizeLimitCm(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, '');
  const sum = flat.match(/三边之和不超(\d+(?:\.\d+)?)CM/i);
  const side = flat.match(/单边最大尺寸不超(\d+(?:\.\d+)?(?:\*\d+(?:\.\d+)?){0,2})CM/i);
  if (!sum && !side) return null;
  const sides = side ? side[1].split('*').map(Number) : null;
  return { sumMaxCm: sum ? Number(sum[1]) : null,
    sideMaxCm: sides === null ? null : (sides.length === 1 ? [sides[0], sides[0], sides[0]] : sides).sort((a, b) => b - a) };
}

function packageFacts(product) {
  const actualKg = nonNegative(product.weightGrams) ? product.weightGrams / 1000 : null;
  let sidesCm = null;
  if (typeof product.dimensionMm === 'string' && /^\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?$/.test(product.dimensionMm.trim())) {
    sidesCm = product.dimensionMm.trim().split(/[x×]/).map(value => Number(value) / 10).sort((a, b) => b - a);
    if (sidesCm.some(value => !(value > 0))) sidesCm = null;
  }
  const volumetricKg = sidesCm ? sidesCm[0] * sidesCm[1] * sidesCm[2] / VOLUME_DIVISOR_CM3_PER_KG : null;
  return { actualKg, sidesCm, volumetricKg };
}

function evaluateRoute(row, facts) {
  const tariff = row?.evidenceData;
  if (!isObject(tariff) || !nonNegative(tariff.perKgRmb) || !nonNegative(tariff.perParcelRmb)) return { route: row?.route ?? null, feasible: false, reason: 'tariff_row_invalid' };
  const weight = parseWeightLimitKg(tariff.weightLimit), size = parseSizeLimitCm(tariff.sizeLimit ?? row.sizeLimit);
  if (!weight || !size) return { route: row.route, feasible: false, reason: 'limits_unparsed' };
  const volumetric = tariff.chargeableWeightRule === 'max_actual_volume';
  if (facts.actualKg === null && !volumetric) return { route: row.route, feasible: false, reason: 'actual_weight_missing' };
  if (facts.sidesCm === null) return { route: row.route, feasible: false, reason: 'dimensions_missing' };
  const minimum = nonNegative(tariff.minimumChargeableWeightKg) ? tariff.minimumChargeableWeightKg : 0;
  const divisor = volumetric && nonNegative(tariff.volumeDivisorCm3PerKg) && tariff.volumeDivisorCm3PerKg > 0 ? tariff.volumeDivisorCm3PerKg : VOLUME_DIVISOR_CM3_PER_KG;
  const volumetricKg = volumetric ? facts.sidesCm[0] * facts.sidesCm[1] * facts.sidesCm[2] / divisor : null;
  const weightForLimit = facts.actualKg ?? volumetricKg;
  if (weightForLimit < weight.minKg || weightForLimit > weight.maxKg) return { route: row.route, feasible: false, reason: 'weight_outside_limit' };
  const sum = facts.sidesCm[0] + facts.sidesCm[1] + facts.sidesCm[2];
  if (size.sumMaxCm !== null && sum > size.sumMaxCm) return { route: row.route, feasible: false, reason: 'size_sum_outside_limit' };
  if (size.sideMaxCm !== null && facts.sidesCm.some((side, index) => side > size.sideMaxCm[index])) return { route: row.route, feasible: false, reason: 'side_outside_limit' };
  const chargeableKg = Math.max(facts.actualKg ?? 0, volumetricKg ?? 0, minimum);
  return { route: row.route, feasible: true, reason: null, chargeableWeightRule: tariff.chargeableWeightRule, chargeableKg: Math.round(chargeableKg * 1000) / 1000,
    volumetricKg: volumetricKg === null ? null : Math.round(volumetricKg * 1000) / 1000, freightRmb: roundDownCents(chargeableKg * tariff.perKgRmb + tariff.perParcelRmb),
    perKgRmb: tariff.perKgRmb, perParcelRmb: tariff.perParcelRmb, ruleVersion: row.ruleVersion ?? null, actualWeightMissing: facts.actualKg === null };
}

/** Cost policy values exactly as the store rule carries them (see workflow.mjs profitRule / currentProfitResult). */
export function costPolicyFromStoreRule(storeRule) {
  if (!isObject(storeRule)) fail('STORE_RULE_INVALID');
  const numbers = ['advertisingReserveRate', 'returnOpsReserveRate', 'damageLossReserveRate', 'withdrawalFeeRate', 'labelCostRmb', 'fixedOtherRmb', 'minimumUnitProfitRmb', 'targetMarginRate'];
  const policy = {};
  for (const key of numbers) {
    const value = Number(storeRule[key] ?? 0);
    if (!nonNegative(value)) fail('STORE_RULE_INVALID', key);
    policy[key] = value;
  }
  policy.thresholdPolicy = storeRule.thresholdPolicy === 'both' ? 'both' : 'either';
  policy.pricingPolicyVersion = typeof storeRule.pricingPolicyVersion === 'string' ? storeRule.pricingPolicyVersion : null;
  return policy;
}

export function estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows, assumptions }) {
  if (!isObject(product) || !finite(product.price) || product.price <= 0) fail('PRODUCT_INVALID');
  if (!isObject(assumptions) || !nonNegative(assumptions.packagingRmbDefault)) fail('ASSUMPTIONS_INVALID', 'packagingRmbDefault');
  if (!Array.isArray(tariffRows)) fail('TARIFF_ROWS_INVALID');
  const policy = costPolicyFromStoreRule(storeRule);
  const missing = [];
  const fxSource = isObject(fx) && finite(fx.rubPerCny) && fx.rubPerCny > 0 ? { rubPerCny: fx.rubPerCny, rateDate: fx.rateDate ?? null, sourceRef: fx.sourceRef ?? null } : null;
  if (!fxSource) missing.push('汇率');
  const commissionSource = { rate: isObject(commission) && finite(commission.rate) && commission.rate >= 0 && commission.rate < 1 ? commission.rate : null,
    tier: commission?.tier ?? null, sourceRef: commission?.sourceRef ?? null, gaps: Array.isArray(commission?.gaps) ? structuredClone(commission.gaps) : [] };
  if (commissionSource.rate === null) missing.push('官方佣金');
  const facts = packageFacts(product);
  const routes = tariffRows.map(row => evaluateRoute(row, facts));
  const feasibleRoutes = routes.filter(route => route.feasible).sort((a, b) => a.freightRmb - b.freightRmb);
  const chosen = feasibleRoutes[0] ?? null;
  const freight = { status: facts.actualKg === null && facts.sidesCm === null ? 'unknown_dimensions' : chosen ? 'quoted' : 'no_feasible_route',
    actualKg: facts.actualKg, sidesCm: facts.sidesCm, volumetricKg: facts.volumetricKg === null ? null : Math.round(facts.volumetricKg * 1000) / 1000,
    oversize: facts.actualKg !== null && facts.volumetricKg !== null && facts.volumetricKg > facts.actualKg,
    chosen, feasibleRoutes, rejectedRoutes: routes.filter(route => !route.feasible).map(route => ({ route: route.route, reason: route.reason })),
    noFeasibleRoute: chosen === null && facts.sidesCm !== null };
  if (freight.status === 'unknown_dimensions') missing.push('包装尺寸重量');
  else if (freight.status === 'no_feasible_route') missing.push('可行物流线路');
  const revenueCny = fxSource ? roundDownCents(product.price / fxSource.rubPerCny) : null;
  let ceiling = null;
  if (missing.length === 0) {
    const reserveRate = commissionSource.rate + policy.advertisingReserveRate + policy.returnOpsReserveRate + policy.damageLossReserveRate + policy.withdrawalFeeRate;
    const fixed = chosen.freightRmb + assumptions.packagingRmbDefault + policy.labelCostRmb + policy.fixedOtherRmb;
    const profitLimited = roundDownCents(revenueCny * (1 - reserveRate) - fixed - policy.minimumUnitProfitRmb);
    const marginLimited = roundDownCents(revenueCny * (1 - reserveRate - policy.targetMarginRate) - fixed);
    const maximumAllInPurchaseRmb = roundDownCents(policy.thresholdPolicy === 'both' ? Math.min(profitLimited, marginLimited) : Math.max(profitLimited, marginLimited));
    const midPurchase = maximumAllInPurchaseRmb > 0 ? roundDownCents(maximumAllInPurchaseRmb / 2) : 0;
    const unitProfitAtMid = roundDownCents(revenueCny * (1 - reserveRate) - fixed - midPurchase);
    ceiling = { reserveRate: Math.round(reserveRate * 10000) / 10000, nonPurchaseFixedRmb: roundDownCents(fixed), profitLimitedCeilingRmb: profitLimited, marginLimitedCeilingRmb: marginLimited,
      maximumAllInPurchaseRmb, midPurchaseRmb: midPurchase, unitProfitAtMidRmb: unitProfitAtMid, marginAtMid: revenueCny > 0 ? Math.round(unitProfitAtMid / revenueCny * 10000) / 10000 : null,
      freightShareOfRevenue: revenueCny > 0 ? Math.round(chosen.freightRmb / revenueCny * 10000) / 10000 : null };
  }
  const status = missing.length ? 'incomplete' : ceiling.maximumAllInPurchaseRmb <= 0 ? 'negative' : 'ok';
  return { schemaVersion: 'a-discovery-estimate-v1', productId: product.productId ?? null, priceRub: product.price, revenueCny, fx: fxSource,
    commission: commissionSource, costPolicy: policy, assumptions: { packagingRmbDefault: assumptions.packagingRmbDefault, assumed: true }, freight, ceiling, status, missing };
}

export function estimateOutcomeForPool(estimate) {
  if (!isObject(estimate)) fail('ESTIMATE_INVALID');
  return estimate.status === 'negative' ? 'excluded_negative' : estimate.status === 'ok' ? 'selectable' : 'needs_data';
}

export function describeEstimate(estimate) {
  if (!isObject(estimate)) fail('ESTIMATE_INVALID');
  const commission = estimate.commission.rate === null ? '佣金未知' : `佣金 ${Math.round(estimate.commission.rate * 100)}%`;
  if (estimate.status === 'incomplete') return `无法估算：缺${estimate.missing.join('、')} · ${commission}`;
  const chosen = estimate.freight.chosen;
  const freight = `${chosen.route} ${chosen.chargeableKg}kg 运费 ¥${chosen.freightRmb.toFixed(2)}${estimate.freight.oversize ? '（超抛）' : ''}`;
  if (estimate.status === 'negative') return `预估负利润，已排除 · ${freight} · ${commission}`;
  return `预估采购上限 ¥${estimate.ceiling.maximumAllInPurchaseRmb.toFixed(2)} · ${freight} · ${commission}`;
}
