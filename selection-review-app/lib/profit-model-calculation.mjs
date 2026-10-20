import { isDeepStrictEqual } from "node:util";
import { calculateProjectSourceMarketFit, resolveLifecycleBCostPolicy } from "./global-pricing-policy.mjs";
import { validateProfitThresholds } from "./profit-threshold-policy.mjs";

export const LEGACY_PROFIT_CALCULATION_VERSION = "profit-calculation-v1-unrounded";
export const FORMAL_COMMISSION_CALCULATION_VERSION = "profit-calculation-v2-formal-commission";
export const PROFIT_CALCULATION_VERSION = "profit-calculation-v3-cost-policy-snapshot";
export const OWNER_TARGET_PROFIT_CALCULATION_VERSION = "profit-calculation-v4-owner-target-price";
export const COST_POLICY_PROFIT_CALCULATION_VERSIONS = Object.freeze([PROFIT_CALCULATION_VERSION, OWNER_TARGET_PROFIT_CALCULATION_VERSION]);

export function validateOwnerTargetPrice(value) {
  const keys = ["amountRub", "candidateId", "sourceRevision", "evidenceRef", "confirmedAt"];
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    Number.isFinite(value.amountRub) && value.amountRub > 0 && Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 1 &&
    [value.candidateId, value.evidenceRef, value.confirmedAt].every(item => typeof item === "string" && item.trim().length > 0 && item !== "unknown") &&
    Number.isFinite(Date.parse(value.confirmedAt));
}

/** Match the price to the existing persisted A/final-review decision, not just to its copied model fields. */
export function validateOwnerTargetPriceSource(value, { opportunityPackage, candidateId, confirmationSource }) {
  if (!validateOwnerTargetPrice(value) || value.candidateId !== candidateId) return false;
  if (confirmationSource !== undefined && (confirmationSource === null || typeof confirmationSource !== "object" || Array.isArray(confirmationSource))) return false;
  const records = opportunityPackage?.audit?.history;
  if (!Array.isArray(records)) return false;
  if (records.some(record => record === null || typeof record !== "object" || Array.isArray(record))) return false;
  const matches = records.filter(record => record.ownerTargetPrice?.evidenceRef === value.evidenceRef);
  if (matches.length !== 1) return false;
  const record = matches[0];
  if (records.filter(item => Object.hasOwn(item, "ownerTargetPrice")).at(-1) !== record) return false;
  if (!isDeepStrictEqual(record.ownerTargetPrice, value) || record.at !== value.confirmedAt ||
      record.sourceCandidateId !== candidateId || record.sourceCandidateRevision !== value.sourceRevision) return false;
  if (record.event === "real_a_one_card_inputs_frozen") {
    if (value.evidenceRef !== `owner-a-confirmation:${candidateId}:${value.sourceRevision}`) return false;
    if (confirmationSource !== undefined) {
      const receipt = confirmationSource.aConfirmationReceipt;
      return receipt?.receiptId === `a-confirmation:${candidateId}:${value.sourceRevision}:confirm` &&
        receipt.decision === "confirm" && receipt.sourceCandidateRevision === value.sourceRevision && receipt.confirmedAt === value.confirmedAt;
    }
    return true;
  }
  if (record.event !== "final_pricing_owner_price_selected" || record.assessmentRef !== value.evidenceRef) return false;
  if (confirmationSource !== undefined) {
    const history = confirmationSource.finalPricingRevisionHistory;
    if (!Array.isArray(history)) return false;
    const matches = history.filter(entry => entry?.assessment?.assessmentId === value.evidenceRef);
    if (matches.length !== 1) return false;
    const assessment = matches[0].assessment;
    return assessment.status === "ready" && assessment.target?.candidateId === candidateId &&
      assessment.target.sourceRevision === value.sourceRevision && assessment.selectedPriceRub === value.amountRub && assessment.assessedAt === value.confirmedAt;
  }
  return true;
}

/** Validate the saved calculation against its frozen inputs, using the same pricing core. */
export function validateProfitCalculation(model) {
  const errors = validateProfitThresholds(model);
  if (errors.length) return errors;
  const calculation = model.calculation;
  if (!calculation || typeof calculation !== "object" || Array.isArray(calculation) ||
      ![LEGACY_PROFIT_CALCULATION_VERSION, FORMAL_COMMISSION_CALCULATION_VERSION, ...COST_POLICY_PROFIT_CALCULATION_VERSIONS].includes(calculation.version) ||
      Object.keys(calculation).some((key) => !["version", "recommendedSalePriceCny", "unitProfitRmb"].includes(key)) ||
      !Number.isFinite(calculation.recommendedSalePriceCny) || calculation.recommendedSalePriceCny <= 0 ||
      !Number.isFinite(calculation.unitProfitRmb)) {
    return [{ path: "calculation", message: "必须保存当前版本的未舍入售价和单件利润" }];
  }
  const fx = model.priceConversion?.rubPerCny;
  const components = model.otherCosts?.components;
  const ownerPriced = calculation.version === OWNER_TARGET_PROFIT_CALCULATION_VERSION;
  if (ownerPriced) {
    const inputs = model.priceInputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || Object.keys(inputs).length !== 2 ||
        !Object.hasOwn(inputs, "marketReferencePriceRub") || !Object.hasOwn(inputs, "ownerTargetPrice") ||
        !Number.isFinite(inputs.marketReferencePriceRub) || inputs.marketReferencePriceRub <= 0 ||
        !validateOwnerTargetPrice(inputs.ownerTargetPrice) || inputs.ownerTargetPrice.amountRub !== model.recommendedSalePriceRub ||
        Date.parse(inputs.ownerTargetPrice.confirmedAt) > Date.parse(model.calculatedAt)) {
      return [{ path: "priceInputs", message: "必须分别冻结真实市场参考价及同一主人决定的目标价、候选、修订、引用和时间" }];
    }
  } else if (Object.hasOwn(model, "priceInputs")) {
    return [{ path: "priceInputs", message: "主人目标价必须使用独立双价格计算版本，旧版本不得混入新价格输入" }];
  }
  if (!Number.isFinite(model.recommendedSalePriceRub) || model.recommendedSalePriceRub <= 0 ||
      !Number.isFinite(fx) || fx <= 0 || !components || model.thresholds?.logic !== "any") {
    return [{ path: "calculation", message: "缺少用于复核原始计算的价格、汇率、成本或门槛" }];
  }
  let pricing;
  let resolvedCostPolicy;
  try {
    if (COST_POLICY_PROFIT_CALCULATION_VERSIONS.includes(calculation.version)) {
      resolvedCostPolicy = resolveLifecycleBCostPolicy({ snapshot: model.otherCosts.costPolicySnapshot,
        context: model.otherCosts.costPolicyContext, asOf: model.calculatedAt });
      if (model.pricingPolicyVersion !== resolvedCostPolicy.policyVersion || Object.entries(resolvedCostPolicy).some(([key, value]) =>
          !["policyId", "policyVersion"].includes(key) && components[key] !== value)) {
        return [{ path: "otherCosts.costPolicySnapshot", message: "冻结成本数值或版本与政策不一致" }];
      }
    }
    pricing = calculateProjectSourceMarketFit({
      ...(resolvedCostPolicy ? { resolvedCostPolicy } : {}),
      marketReferencePriceCny: (ownerPriced ? model.priceInputs.marketReferencePriceRub : model.recommendedSalePriceRub) / fx,
      ...(ownerPriced ? { targetSalePriceCny: model.priceInputs.ownerTargetPrice.amountRub / fx } : {}),
      actualPurchaseCostCny: model.actualPurchaseCost?.amount,
      packagingCostCny: components.packagingRmb,
      internationalFreightPerOrderCny: model.internationalFreight?.amount,
      fixedOtherCostCny: components.fixedOtherRmb,
      commissionRate: model.commissionRate,
      advertisingRate: components.advertisingRate,
      returnOperationsRate: components.returnReserveRate,
      targetMarginRate: model.thresholds.minimumProfitMargin,
      minimumUnitProfitCny: model.thresholds.minimumUnitProfitRmb,
      priceIncrementCny: model.priceFloors?.priceIncrementCny,
      quantity: 1,
      marketSampleCount: model.marketSampleRefs?.length
    });
  } catch (error) {
    if (typeof error.code === "string" && error.code.startsWith("B_COST_POLICY_")) return [{ path: "otherCosts.costPolicySnapshot", message: error.code }];
    if (!/^PRICING_(?:INPUT_GAP|TARGET_IMPOSSIBLE):/.test(error.message)) throw error;
    return [{ path: "calculation", message: error.message }];
  }
  if (resolvedCostPolicy) {
    const price = model.recommendedSalePriceRub / fx;
    const variable = Object.entries(pricing.variableRates).filter(([key]) => key !== "commission").reduce((sum, [, value]) => sum + value, 0);
    const amount = Number((components.packagingRmb + resolvedCostPolicy.labelRmb + resolvedCostPolicy.fixedOtherRmb + price * variable).toFixed(2));
    const scope = { quantity: pricing.quantity, fixedCosts: pricing.fixedCosts, variableRates: pricing.variableRates,
      orderFixedCostCny: pricing.orderFixedCostCny, equivalentFixedCostPerUnitCny: pricing.equivalentFixedCostPerUnitCny,
      totalVariableRate: pricing.totalVariableRate, logisticsQuoteBasis: "per_order" };
    if (model.otherCosts.amount !== amount || model.sellerSettlementRevenue?.amount !== Number((price * (1 - model.commissionRate)).toFixed(2)) ||
        !isDeepStrictEqual(model.costScope, scope) || !isDeepStrictEqual(model.priceFloors, pricing.priceFloors)) {
      errors.push({ path: "costScope", message: "费用、结算及价格线必须与同一冻结计算核一致" });
    }
  }
  const result = ownerPriced ? pricing.evaluatedAtTargetPrice : pricing.evaluatedAtMarketPrice;
  const current = [FORMAL_COMMISSION_CALCULATION_VERSION, ...COST_POLICY_PROFIT_CALCULATION_VERSIONS].includes(calculation.version);
  // 只有主人授权的估算佣金算条件测算。`official_reference`（主人已保存的官方费表版本命中的费率）在
  // lib/profit-model.mjs 里和 `exact` 同级形成正式计算，这里必须认同一套，否则同一份记录建得出来却校验不过。
  const conditional = current && model.commissionMode === "estimated";
  if (current && (!["exact", "estimated", "official_reference"].includes(model.commissionMode) ||
      model.calculationType !== (conditional ? "conditional" : "formal") ||
      model.exactCommissionRequiredForFormalB !== conditional)) {
    errors.push({ path: "calculationType", message: "当前正式计算须有精确佣金或官方费表费率；估算只能保存条件测算和正式B证据缺口" });
  }
  const exactPrice = ownerPriced ? result.unroundedTargetSalePriceCny : result.unroundedMarketReferencePriceCny;
  const exactProfit = result.unroundedUnitProfitCny;
  const expected = {
    recommendedSalePriceCny: Number(exactPrice.toFixed(2)),
    unitProfitRmb: Number(exactProfit.toFixed(2)),
    profitMargin: Number((exactProfit / exactPrice).toFixed(4)),
    result: conditional ? "manual_review" : result.thresholdPassed ? "passed" : "rejected"
  };
  if (calculation.recommendedSalePriceCny !== exactPrice || calculation.unitProfitRmb !== exactProfit) {
    errors.push({ path: "calculation", message: "未舍入结果必须与冻结成本和汇率的计算一致" });
  }
  for (const [field, value] of Object.entries(expected)) {
    if (model[field] !== value) errors.push({ path: field, message: "必须与未舍入计算及其展示精度一致" });
  }
  if (ownerPriced && !isDeepStrictEqual(model.marketFit, pricing.marketFit)) {
    errors.push({ path: "marketFit", message: "市场参考价、余量和费率价格基础必须与冻结市场输入一致" });
  } else if (model.marketFit?.status !== pricing.marketFit.status) {
    errors.push({ path: "marketFit.status", message: "市场结论必须使用未舍入利润判定" });
  }
  return errors;
}
