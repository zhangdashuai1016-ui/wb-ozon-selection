export const MINIMUM_PROFIT_MARGIN = 0.15;
export const MINIMUM_UNIT_PROFIT_RMB = 20;
export const CURRENT_PROFIT_THRESHOLD_VERSION = "profit-threshold-v1.2-15pct-or-20cny";
export const LEGACY_PROFIT_THRESHOLD_VERSION = "profit-threshold-v1.1-25pct-20cny";

export const PROFIT_THRESHOLD_POLICIES = Object.freeze({
  [CURRENT_PROFIT_THRESHOLD_VERSION]: Object.freeze({ minimumProfitMargin: MINIMUM_PROFIT_MARGIN, minimumUnitProfitRmb: MINIMUM_UNIT_PROFIT_RMB, logic: "any" }),
  [LEGACY_PROFIT_THRESHOLD_VERSION]: Object.freeze({ minimumProfitMargin: 0.25, minimumUnitProfitRmb: 20, logic: "all" })
});

export function validateProfitThresholds(model) {
  const policy = PROFIT_THRESHOLD_POLICIES[model.thresholdVersion];
  const errors = [];
  if (!policy) errors.push({ path: "thresholdVersion", message: "必须使用已发布的利润门槛版本" });
  if (!policy || Object.entries(policy).some(([key, value]) => model.thresholds?.[key] !== value)) {
    errors.push({ path: "thresholds", message: "利润门槛参数必须与thresholdVersion完全一致" });
  }
  return errors;
}
