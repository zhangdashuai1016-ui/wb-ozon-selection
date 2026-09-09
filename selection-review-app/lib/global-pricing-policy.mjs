import { isCompleteStoreRef, sameStoreRef, STORE_PLATFORMS } from "./store-binding.mjs";

export const GLOBAL_PRICING_POLICY_VERSION = "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1";
export const GLOBAL_LABEL_FEE_PER_ORDER_CNY = 1.5;
export const GLOBAL_DAMAGE_LOSS_RESERVE_RATE = 0.05;
export const GLOBAL_WITHDRAWAL_FEE_RATE = 0.02;

const COST_FIELDS = Object.freeze(["labelRmb", "fixedOtherRmb", "advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "acquiringRate", "taxRate", "otherRate"]);
function costError(code) { throw Object.assign(new Error(code), { code }); }
function exactCostObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function costRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) && !["unknown", "null", "undefined"].includes(value.toLowerCase());
}
function costTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function costScope(value) {
  return value && STORE_PLATFORMS[value.store] === value.platform && isCompleteStoreRef(value.storeRef, value.store) &&
    costRef(value.salesScheme) && value.salesScheme === value.salesScheme.toLowerCase();
}
function validResolvedCosts(value) {
  return exactCostObject(value, [...COST_FIELDS, "policyId", "policyVersion"]) && costRef(value.policyId) && costRef(value.policyVersion) &&
    COST_FIELDS.every(key => Number.isFinite(value[key]) && value[key] >= 0 && (!key.endsWith("Rate") || value[key] < 1));
}

/** Resolve only evidenced, applicable costs; no global values fill missing policy inputs. */
export function resolveLifecycleBCostPolicy({ snapshot, context, asOf }) {
  if (!exactCostObject(snapshot, ["schemaVersion", "policyId", "policyVersion", "scope", "effectiveFrom", "effectiveTo", "policyEvidenceRef", "items"]) ||
      snapshot.schemaVersion !== "b-cost-policy-snapshot-v1" || !costRef(snapshot.policyId) || !costRef(snapshot.policyVersion) || !costRef(snapshot.policyEvidenceRef) ||
      !exactCostObject(snapshot.scope, ["platform", "store", "storeRef", "salesScheme"]) || !costScope(snapshot.scope) ||
      !exactCostObject(snapshot.items, COST_FIELDS)) costError("B_COST_POLICY_INVALID");
  if (!costScope(context) || ["platform", "store", "salesScheme"].some(key => snapshot.scope[key] !== context[key]) ||
      !sameStoreRef(snapshot.scope.storeRef, context.storeRef)) costError("B_COST_POLICY_SCOPE_MISMATCH");
  if (!costTime(asOf) || [snapshot.effectiveFrom, snapshot.effectiveTo].some(value => value !== null && !costTime(value)) ||
      (snapshot.effectiveFrom !== null && snapshot.effectiveTo !== null && Date.parse(snapshot.effectiveFrom) >= Date.parse(snapshot.effectiveTo))) costError("B_COST_POLICY_TIME_INVALID");
  if (snapshot.effectiveFrom !== null && Date.parse(snapshot.effectiveFrom) > Date.parse(asOf)) costError("B_COST_POLICY_NOT_EFFECTIVE");
  if (snapshot.effectiveTo !== null && Date.parse(snapshot.effectiveTo) <= Date.parse(asOf)) costError("B_COST_POLICY_EXPIRED");
  const resolved = { policyId: snapshot.policyId, policyVersion: snapshot.policyVersion };
  for (const key of COST_FIELDS) {
    const item = snapshot.items[key];
    const basis = key === "labelRmb" ? "per_order_cny" : key === "fixedOtherRmb" ? "per_unit_cny" : "target_price_cny_rate";
    if (!exactCostObject(item, ["status", "value", "basis", "evidenceRef", "includedIn"]) || item.basis !== basis || !costRef(item.evidenceRef) ||
        !["applicable", "not_applicable", "included_in_settlement", "unknown"].includes(item.status) ||
        (item.includedIn !== null && !costRef(item.includedIn))) costError("B_COST_POLICY_ITEM_INVALID");
    if (item.status === "included_in_settlement") costError("B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS");
    if (item.includedIn !== null) costError("B_COST_POLICY_ITEM_INVALID");
    if (item.status === "unknown") {
      if (item.value !== null) costError("B_COST_POLICY_ITEM_INVALID");
      costError("B_COST_POLICY_UNKNOWN");
    }
    if (item.status === "not_applicable") {
      if (item.value !== null) costError("B_COST_POLICY_ITEM_INVALID");
      resolved[key] = 0;
    } else {
      if (!Number.isFinite(item.value) || item.value < 0 || (key.endsWith("Rate") && item.value >= 1)) costError("B_COST_POLICY_ITEM_INVALID");
      resolved[key] = item.value;
    }
  }
  return Object.freeze(resolved);
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`PRICING_INPUT_GAP: ${label}必须是非负数字`);
  return value;
}

function rate(value, label) {
  finiteNonNegative(value, label);
  if (value >= 1) throw new Error(`PRICING_INPUT_GAP: ${label}必须小于100%`);
  return value;
}

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PRICING_INPUT_GAP: ${label}必须大于0`);
  return value;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundRate(value) {
  return Number(value.toFixed(4));
}

function roundUp(value, increment) {
  return roundMoney(Math.ceil((value - Number.EPSILON) / increment) * increment);
}

/**
 * 项目使用全局定价 Skill 的 source-market-fit 思路：先由成本反推价格线，
 * 再与 A 阶段冻结的市场目标价比较。项目利润门槛为 OR，不能套用 Skill
 * 默认的“两项同时满足”。
 */
export function calculateProjectSourceMarketFit({
  marketReferencePriceCny,
  actualPurchaseCostCny,
  packagingCostCny,
  internationalFreightPerOrderCny,
  fixedOtherCostCny,
  commissionRate,
  advertisingRate,
  returnOperationsRate,
  targetMarginRate,
  minimumUnitProfitCny,
  priceIncrementCny,
  quantity = 1,
  marketSampleCount = 0,
  resolvedCostPolicy,
}) {
  positive(marketReferencePriceCny, "A阶段市场目标成交价");
  positive(quantity, "定价数量");
  if (!Number.isInteger(quantity)) throw new Error("PRICING_INPUT_GAP: 定价数量必须是整数");
  const purchase = finiteNonNegative(actualPurchaseCostCny, "采购到手成本");
  const packaging = finiteNonNegative(packagingCostCny, "包材成本");
  const logistics = finiteNonNegative(internationalFreightPerOrderCny, "整单国际物流");
  const fixedOther = finiteNonNegative(fixedOtherCostCny, "其他固定成本");
  const commission = rate(commissionRate, "平台佣金率");
  const advertising = rate(advertisingRate, "广告成本率");
  const returns = rate(returnOperationsRate, "退货运营率");
  const targetMargin = rate(targetMarginRate, "目标利润率");
  const minimumProfit = finiteNonNegative(minimumUnitProfitCny, "最低单件利润");
  const increment = positive(priceIncrementCny, "售价步进");

  if (resolvedCostPolicy !== undefined && (!validResolvedCosts(resolvedCostPolicy) ||
      resolvedCostPolicy.fixedOtherRmb !== fixedOther || resolvedCostPolicy.advertisingRate !== advertising ||
      resolvedCostPolicy.returnReserveRate !== returns)) costError("B_COST_POLICY_RESOLVED_CONFLICT");
  const policy = resolvedCostPolicy;
  const fixedCosts = [
    { key: "purchase", amountCny: purchase, scope: "purchase", basis: "per_unit" },
    { key: "packaging", amountCny: packaging, scope: "packaging", basis: "per_unit" },
    { key: "international_logistics", amountCny: logistics, scope: "cross_border", basis: "per_order" },
    { key: "label", amountCny: policy ? policy.labelRmb : GLOBAL_LABEL_FEE_PER_ORDER_CNY, scope: "labeling", basis: "per_order" },
    { key: "fixed_other", amountCny: fixedOther, scope: "other_fixed", basis: "per_unit" },
  ];
  const orderFixedCostCny = fixedCosts.reduce((sum, item) =>
    sum + (item.basis === "per_unit" ? item.amountCny * quantity : item.amountCny), 0);
  const equivalentFixedCostPerUnitCny = orderFixedCostCny / quantity;
  const variableRates = {
    commission,
    acquiring: policy ? policy.acquiringRate : 0,
    tax: policy ? policy.taxRate : 0,
    advertising,
    returnOperations: returns,
    damageLoss: policy ? policy.damageReserveRate : GLOBAL_DAMAGE_LOSS_RESERVE_RATE,
    withdrawalFee: policy ? policy.withdrawalFeeRate : GLOBAL_WITHDRAWAL_FEE_RATE,
    other: policy ? policy.otherRate : 0,
  };
  const totalVariableRate = Object.values(variableRates).reduce((sum, value) => sum + value, 0);
  const netRate = 1 - totalVariableRate;
  const marginDenominator = netRate - targetMargin;
  if (netRate <= 0) throw new Error("PRICING_TARGET_IMPOSSIBLE: 费率合计已达到或超过100%");
  if (marginDenominator <= 0) throw new Error("PRICING_TARGET_IMPOSSIBLE: 当前费率下无法达到目标利润率");

  const breakEvenPriceCny = equivalentFixedCostPerUnitCny / netRate;
  const marginFloorCny = equivalentFixedCostPerUnitCny / marginDenominator;
  const minimumProfitFloorCny = (equivalentFixedCostPerUnitCny + minimumProfit) / netRate;
  const qualifyingFloorBeforeRoundingCny = Math.min(marginFloorCny, minimumProfitFloorCny);
  const qualifyingFloorCny = roundUp(qualifyingFloorBeforeRoundingCny, increment);
  const evaluatedUnitProfitCny = marketReferencePriceCny * netRate - equivalentFixedCostPerUnitCny;
  const evaluatedProfitMargin = evaluatedUnitProfitCny / marketReferencePriceCny;
  const thresholdPassed = evaluatedUnitProfitCny >= minimumProfit || evaluatedProfitMargin >= targetMargin;
  const marketHeadroomCny = marketReferencePriceCny - qualifyingFloorCny;
  const premiumRate = marketReferencePriceCny > 0 ? qualifyingFloorCny / marketReferencePriceCny - 1 : null;
  const marketFitStatus = thresholdPassed
    ? "fits_market"
    : premiumRate <= 0.1
      ? "above_market_needs_review"
      : premiumRate <= 0.2
        ? "market_conflict"
        : "severe_market_conflict";

  return Object.freeze({
    pricingPolicyVersion: policy ? policy.policyVersion : GLOBAL_PRICING_POLICY_VERSION,
    pricingMode: "source-market-fit",
    quantity,
    fixedCosts,
    variableRates,
    orderFixedCostCny: roundMoney(orderFixedCostCny),
    equivalentFixedCostPerUnitCny: roundMoney(equivalentFixedCostPerUnitCny),
    totalVariableRate: roundRate(totalVariableRate),
    priceFloors: {
      breakEvenPriceCny: roundMoney(breakEvenPriceCny),
      marginFloorCny: roundMoney(marginFloorCny),
      minimumProfitFloorCny: roundMoney(minimumProfitFloorCny),
      qualifyingFloorCny,
      qualifyingLogic: "any",
      priceIncrementCny: increment,
    },
    marketFit: {
      status: marketFitStatus,
      marketReferencePriceCny: roundMoney(marketReferencePriceCny),
      qualifyingFloorCny,
      headroomCny: roundMoney(marketHeadroomCny),
      floorPremiumRate: roundRate(premiumRate),
      marketSampleCount: Number.isInteger(marketSampleCount) && marketSampleCount >= 0 ? marketSampleCount : 0,
      preferredComparableCount: 5,
      comparableCountIsHardGate: false,
    },
    evaluatedAtMarketPrice: {
      unroundedMarketReferencePriceCny: marketReferencePriceCny,
      unroundedUnitProfitCny: evaluatedUnitProfitCny,
      unitProfitCny: roundMoney(evaluatedUnitProfitCny),
      profitMargin: roundRate(evaluatedProfitMargin),
      thresholdPassed,
    },
  });
}
