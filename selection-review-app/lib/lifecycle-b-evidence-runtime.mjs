import { validateLifecycleEvidenceData } from "./lifecycle-b-input-bundle.mjs";
import {
  GLOBAL_DAMAGE_LOSS_RESERVE_RATE,
  GLOBAL_LABEL_FEE_PER_ORDER_CNY,
  GLOBAL_PRICING_POLICY_VERSION,
  GLOBAL_WITHDRAWAL_FEE_RATE,
} from "./global-pricing-policy.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function normalizedScope(scope = {}) {
  return Object.fromEntries(Object.entries(scope)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => [String(key), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function scopeKey(kind, scope) {
  return `${kind}|${JSON.stringify(normalizedScope(scope))}`;
}

function summaryFor(pack) {
  if (pack.kind === "commission") return "当前店铺、类目和销售模式佣金及项目成本规则";
  if (pack.kind === "logistics_tariff") return "当前GUOO精确线路资费";
  if (pack.kind === "exchange_rate") return "当前俄罗斯央行RUB/CNY官方汇率";
  if (pack.kind === "schema") return "当前店铺与类目平台必填Schema";
  return "当前B阶段证据";
}

export function buildLifecycleBExplicitOtherCosts(candidate, profitRule) {
  const policy = {
    packagingRmb: candidate?.packagingCostRmb,
    labelRmb: GLOBAL_LABEL_FEE_PER_ORDER_CNY,
    fixedOtherRmb: profitRule?.fixedOtherRmb,
    advertisingRate: profitRule?.advertisingReserveRate,
    returnReserveRate: profitRule?.returnOpsReserveRate,
    damageReserveRate: GLOBAL_DAMAGE_LOSS_RESERVE_RATE,
    withdrawalFeeRate: GLOBAL_WITHDRAWAL_FEE_RATE,
    targetMarginRate: profitRule?.targetMarginRate,
    minimumUnitProfitRmb: profitRule?.minimumUnitProfitRmb,
    priceIncrementCny: profitRule?.priceRoundRmb,
    thresholdLogic: profitRule?.thresholdPolicy === "both" ? "all" : "any",
    pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION,
  };
  const fixed = ["packagingRmb", "labelRmb", "fixedOtherRmb"];
  const rates = ["advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "targetMarginRate"];
  if (fixed.some((key) => !finiteNonNegative(policy[key])) ||
      rates.some((key) => !finiteNonNegative(policy[key]) || policy[key] >= 1) ||
      !finiteNonNegative(policy.minimumUnitProfitRmb) ||
      !Number.isFinite(policy.priceIncrementCny) || policy.priceIncrementCny <= 0 ||
      policy.thresholdLogic !== "any") {
    throw new Error("B_EVIDENCE_COST_POLICY_INCOMPLETE: 包材与其他成本必须来自当前商品和项目配置");
  }
  return Object.freeze({ ...policy });
}

export function commitLifecycleBEvidencePacks(data, packs, { createdAt, createdBy = "system_read_only" } = {}) {
  if (!isObject(data) || !Array.isArray(data.evidencePacks) || !Array.isArray(packs)) {
    throw new Error("B_EVIDENCE_COMMIT_INVALID_INPUT");
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error("B_EVIDENCE_COMMIT_INVALID_TIME");

  const prepared = packs.map((pack) => {
    if (!isObject(pack) || !pack.id || !pack.kind || pack.status !== "active" ||
        !isObject(pack.scope) || !pack.sourceType || !pack.sourceRef ||
        !pack.checkedAt || !pack.expiresAt) {
      throw new Error("B_EVIDENCE_COMMIT_INVALID_PACK");
    }
    if (/token|cookie|password|secret|authorization/i.test(JSON.stringify({
      sourceType: pack.sourceType,
      sourceRef: pack.sourceRef,
    }))) {
      throw new Error("B_EVIDENCE_COMMIT_SECRET_REJECTED");
    }
    const validation = validateLifecycleEvidenceData(pack.kind, pack.evidenceData);
    if (!validation.valid) {
      throw new Error(`B_EVIDENCE_COMMIT_INVALID_DATA: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
    }
    const scope = normalizedScope(pack.scope);
    return {
      ...structuredClone(pack),
      scope,
      scopeKey: scopeKey(pack.kind, scope),
      summary: summaryFor(pack),
      ruleVersion: String(scope.ruleVersion || pack.providerVersion || "").trim(),
      createdAt,
      createdBy,
    };
  });

  const next = structuredClone(data.evidencePacks);
  for (const pack of prepared) {
    const duplicate = next.find((existing) => existing.id === pack.id);
    if (duplicate) continue;
    for (const existing of next) {
      if (existing.status === "active" && existing.scopeKey === pack.scopeKey) existing.status = "superseded";
    }
    next.push(pack);
  }
  data.evidencePacks = next;
  return prepared.map((pack) => structuredClone(next.find((item) => item.id === pack.id) || pack));
}
