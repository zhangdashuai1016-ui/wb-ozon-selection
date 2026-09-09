import { isDeepStrictEqual } from "node:util";
import { normalizeEvidenceScope, evidenceScopeKey, evidenceScopeMatches } from "./lifecycle-evidence-scope.mjs";
import { validateLifecycleEvidenceData, isLifecycleEvidenceTraceValid, inspectCommissionCatalogValidity,
  normalizeCurrentCommissionCatalogs } from "./lifecycle-b-input-bundle.mjs";
import { resolveLifecycleBCostPolicy } from "./global-pricing-policy.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function summaryFor(pack) {
  if (pack.kind === "commission") return "当前店铺、类目和销售模式佣金";
  if (pack.kind === "logistics_tariff") return "当前GUOO精确线路资费";
  if (pack.kind === "exchange_rate") return "当前俄罗斯央行RUB/CNY官方汇率";
  if (pack.kind === "schema") return "当前店铺与类目平台必填Schema";
  return "当前B阶段证据";
}

export function resolveLifecycleBProfitRule(candidate, rules) {
  const key = { dandanshu: "ozonDandanshu", miska: "ozonMiska", wb: "wbCrossListing" }[candidate?.targetStore];
  if (!key || !isObject(rules) || !isObject(rules[key])) {
    throw Object.assign(new Error("B_EVIDENCE_COST_POLICY_INCOMPLETE: 当前店铺成本规则缺失"), { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
  }
  return rules[key];
}

export function buildLifecycleBExplicitOtherCosts(candidate, profitRule, { asOf = new Date().toISOString() } = {}) {
  const context = { platform: candidate?.targetStore === "wb" ? "wb" : "ozon", store: candidate?.targetStore,
    storeRef: candidate?.storeRef, salesScheme: candidate?.lifecycleEvidenceContextV11?.salesScheme };
  const resolved = resolveLifecycleBCostPolicy({ snapshot: profitRule?.costPolicySnapshot, context, asOf });
  const costs = Object.fromEntries(Object.entries(resolved).filter(([key]) => !["policyId", "policyVersion"].includes(key)));
  const policy = {
    ...costs,
    packagingRmb: candidate?.packagingCostRmb,
    targetMarginRate: profitRule?.targetMarginRate,
    minimumUnitProfitRmb: profitRule?.minimumUnitProfitRmb,
    priceIncrementCny: profitRule?.priceRoundRmb,
    thresholdLogic: profitRule?.thresholdPolicy === "either" ? "any" : null,
    pricingPolicyVersion: resolved.policyVersion,
    costPolicySnapshot: structuredClone(profitRule.costPolicySnapshot)
  };
  if (!finiteNonNegative(policy.packagingRmb) || !finiteNonNegative(policy.targetMarginRate) || policy.targetMarginRate >= 1 ||
      !finiteNonNegative(policy.minimumUnitProfitRmb) || !Number.isFinite(policy.priceIncrementCny) || policy.priceIncrementCny <= 0 ||
      policy.thresholdLogic !== "any") {
    throw Object.assign(new Error("B_EVIDENCE_COST_POLICY_INCOMPLETE: 包材与成本门槛必须来自当前商品和项目配置"), { code: "B_EVIDENCE_COST_POLICY_INCOMPLETE" });
  }
  return Object.freeze(policy);
}

const COST_ITEM_LABELS = Object.freeze({
  labelRmb: "贴标费", fixedOtherRmb: "其他固定费用", advertisingRate: "广告费用", returnReserveRate: "退货预留",
  damageReserveRate: "损耗预留", withdrawalFeeRate: "提现费", acquiringRate: "支付费用", taxRate: "税费", otherRate: "其他比例费用"
});

const COST_READINESS_MESSAGES = Object.freeze({
  B_EVIDENCE_COST_POLICY_INCOMPLETE: "当前店铺成本规则、商品包材费用或利润门槛不完整。",
  B_COST_POLICY_INVALID: "完整成本政策缺失或结构无效，需要明确政策版本与来源。",
  B_COST_POLICY_SCOPE_MISMATCH: "成本政策不适用于当前平台、店铺身份或销售模式。",
  B_COST_POLICY_TIME_INVALID: "成本政策有效时间配置无效。",
  B_COST_POLICY_NOT_EFFECTIVE: "成本政策尚未生效。",
  B_COST_POLICY_EXPIRED: "成本政策已经到期，需要当前有效政策。",
  B_COST_POLICY_ITEM_INVALID: "费用项目的数值、计费基数或来源不完整。",
  B_COST_POLICY_UNKNOWN: "必要费用仍为未知，尚未明确适用性或费用数值。",
  B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS: "已含结算的费用尚缺可验证的计费基数，不能免扣或重复扣除。",
  B_COST_POLICY_RESOLVED_CONFLICT: "成本政策与传入计算的费用数值不一致。",
  B_COST_POLICY_CHANGED: "准备期间成本政策已变化，需要按当前政策重新核对。"
});

/** Independent of provider-pack readiness; only known policy gaps become a view. */
export function inspectLifecycleBCostReadiness({ candidate, rules, asOf }) {
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf) ||
      !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) {
    throw new TypeError("B_COST_READINESS_TIME_INVALID: 必须提供明确有效的检查时间");
  }
  let profitRule;
  try {
    profitRule = resolveLifecycleBProfitRule(candidate, rules);
    buildLifecycleBExplicitOtherCosts(candidate, profitRule, { asOf });
    return { ready: true, missing: [], code: null };
  } catch (error) {
    if (!(error instanceof Error) || !Object.hasOwn(COST_READINESS_MESSAGES, error.code)) throw error;
    const snapshot = profitRule?.costPolicySnapshot;
    let missing = [];
    if (error.code === "B_COST_POLICY_INVALID" && (snapshot === null || snapshot === undefined)) {
      missing = ["完整成本政策未登记。"];
    } else if (isObject(snapshot?.items)) {
      for (const [key, label] of Object.entries(COST_ITEM_LABELS)) {
        const item = snapshot.items[key];
        if (error.code === "B_COST_POLICY_UNKNOWN" && item?.status === "unknown") missing.push(`${label}适用性或数值尚未核实。`);
        if (error.code === "B_COST_POLICY_UNSUPPORTED_SETTLEMENT_BASIS" && item?.status === "included_in_settlement") missing.push(`${label}声明已含结算，但计费基数尚未核实。`);
        if (error.code === "B_COST_POLICY_ITEM_INVALID" && (!isObject(item) ||
            (item.status === "applicable" && !finiteNonNegative(item.value)))) missing.push(`${label}缺少有效费用数值。`);
      }
    }
    return { ready: false, missing: missing.length ? missing : [COST_READINESS_MESSAGES[error.code]], code: error.code };
  }
}

/** Recheck prepared SKU costs against the current candidate and store rules. */
export function assertLifecycleBCostsCurrent({ candidate, rules, otherCosts, asOf }) {
  const currentCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf });
  if (!isDeepStrictEqual(currentCosts, otherCosts)) {
    throw Object.assign(new Error("B_COST_POLICY_CHANGED: 商品成本或店铺规则在本轮计算期间发生变化，结果未保存"), {
      code: "B_COST_POLICY_CHANGED"
    });
  }
  return currentCosts;
}

export function commitLifecycleBEvidencePacks(data, packs, { createdAt, createdBy = "system_read_only", currentCommissionCatalogs = [] } = {}) {
  if (!isObject(data) || !Array.isArray(data.evidencePacks) || !Array.isArray(packs)) {
    throw new Error("B_EVIDENCE_COMMIT_INVALID_INPUT");
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error("B_EVIDENCE_COMMIT_INVALID_TIME");
  const catalogs = normalizeCurrentCommissionCatalogs(currentCommissionCatalogs);

  const prepared = packs.map((pack) => {
    if (!isObject(pack) || !pack.id || !pack.kind || pack.status !== "active" ||
        !isObject(pack.scope) || !pack.sourceType || !pack.sourceRef ||
        !isLifecycleEvidenceTraceValid(pack)) {
      throw new Error("B_EVIDENCE_COMMIT_INVALID_PACK");
    }
    if (/token|cookie|password|secret|authorization/i.test(JSON.stringify({
      sourceType: pack.sourceType,
      sourceRef: pack.sourceRef,
      ...(Object.hasOwn(pack, 'commissionCatalogRef') ? { commissionCatalogRef: pack.commissionCatalogRef } : {}),
    }))) {
      throw new Error("B_EVIDENCE_COMMIT_SECRET_REJECTED");
    }
    const validation = validateLifecycleEvidenceData(pack.kind, pack.evidenceData);
    if (!validation.valid) {
      throw new Error(`B_EVIDENCE_COMMIT_INVALID_DATA: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
    }
    const validity = inspectCommissionCatalogValidity({ pack, currentCommissionCatalogs: catalogs, asOf: createdAt });
    if (!validity.available) throw new Error(`B_EVIDENCE_COMMIT_CATALOG_INVALID: ${validity.status}`);
    const scope = normalizeEvidenceScope(pack.kind, pack.scope);
    return {
      ...structuredClone(pack),
      scope,
      scopeKey: evidenceScopeKey(pack.kind, scope),
      summary: summaryFor(pack),
      ruleVersion: String(scope.ruleVersion || pack.providerVersion || "").trim(),
      createdAt,
      createdBy,
    };
  });

  const next = structuredClone(data.evidencePacks);
  for (const pack of prepared) {
    const duplicate = next.find((existing) => existing.id === pack.id);
    if (duplicate) {
      const same = ["kind", "scope", "sourceType", "sourceRef", "checkedAt", "expiresAt", "evidenceData", "commissionCatalogRef"].every(field => isDeepStrictEqual(duplicate[field], pack[field]));
      if (!same) throw new Error("B_EVIDENCE_COMMIT_ID_CONFLICT: 同一证据ID对应不同范围或内容");
      continue;
    }
    for (const existing of next) {
      if (existing.status === "active" && existing.kind === pack.kind && evidenceScopeMatches(pack.kind, existing.scope, pack.scope)) existing.status = "superseded";
    }
    next.push(pack);
  }
  data.evidencePacks = next;
  return prepared.map((pack) => structuredClone(next.find((item) => item.id === pack.id)));
}
