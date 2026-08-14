export const TIME_ZONE = "Asia/Shanghai";

export const WORKFLOW_STATUSES = [
  "awaiting_user_direction",
  "codex_processing",
  "needs_user_data",
  "listing_preparation",
  "ready_to_list",
  "listed",
  "eliminated"
];

export const DEFAULT_PACKAGING_COST_RMB = 1.5;
export const PURCHASE_CEILING_SCOPE = "purchase_plus_domestic_shipping";
export const DEFAULT_AUTOMATION_CONCURRENCY_LIMIT = 3;
export const NO_PROGRESS_TIMEOUT_MINUTES = 15;
export const PROFIT_POLICY_VERSION = "profit-25pct-and-20cny-promotion-v2";

export const PROMOTION_DISCOUNT_SCENARIOS = Object.freeze({
  low: Object.freeze({ key: "low", label: "促销20%", rate: 0.2 }),
  base: Object.freeze({ key: "base", label: "促销25%", rate: 0.25 }),
  high: Object.freeze({ key: "high", label: "促销30%", rate: 0.3 })
});

export const DEFAULT_RULES = {
  selectionFlow: {
    mode: "user_input_first",
    automationStart: "candidate_entry_event_only",
    stages: [
      "A_direction_screening",
      "B_exact_sku_profit_review",
      "C_procurement_and_listing_preflight",
      "ready_to_list_or_stopped"
    ],
    stageBoundaries: {
      A: {
        label: "方向初筛",
        checks: ["target_platform_market", "cross_border_share_gte_40_percent", "market_size_and_trend", "positive_purchase_space_from_price_and_logistics"],
        sourceSkuMatchRequired: false,
        ipOrBrandRiskDisposition: "needs_control_confirmation_not_auto_elimination"
      },
      B: {
        label: "具体SKU利润核算",
        inputs: ["confirmedSupplierSku", "actualPurchaseCost", "packedWeightKg", "dimensionsCm"],
        sourcePageIsPrerequisite: false,
        supplierConfirmationRequired: true
      },
      C: {
        label: "采购/上架前来源与合规核验",
        checks: ["confirmed_source_snapshot_inherited", "rights_and_ip", "compliance", "powered_and_battery", "platform_schema", "seo_draft"],
        mismatchDisposition: "block_this_sku_procurement_or_listing_without_eliminating_the_direction",
        unresolvedRiskDisposition: "block_ready_to_list_until_control_confirmation_and_rights_review"
      }
    },
    profitInputs: ["productName", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"],
    sourcePageIsProfitPrerequisite: false,
    sourcePagePurpose: "A阶段完成精确1688链接、供应SKU、货价、国内运费、实际采购成本、重量和尺寸采集并由主人确认；B和C只继承冻结证据，不重新寻找供应商",
    unresolvedFeePolicy: "evidence_gap_to_control_not_silent_processing",
    codexCandidateNegativeCeiling: "auto_eliminate_only_when_market_commission_logistics_and_reserves_are_verified",
    technicalFailurePolicy: "one_attempt_then_stop_until_user_retry",
    retryPolicy: "no_automatic_or_background_retry_without_control_instruction",
    antiIdleRun: {
      runningRequiredFields: ["runId", "startedAt", "currentStep", "lastProgressAt"],
      substantiveProgressTypes: ["step_change", "new_evidence", "explicit_block"],
      noProgressTimeoutMinutes: NO_PROGRESS_TIMEOUT_MINUTES,
      technicalFailureDisposition: "blocked_manual_hold_after_one_evidence_bearing_failure",
      duplicateAttemptScope: "one_attempt_per_candidate_round_evidence_layer_and_target",
      unchangedHealthOrQueueNotification: "silent",
      completionWithoutProgress: "blocked_no_continuous_dispatch",
      resumePolicy: "user_comment_and_single_retry_only",
      alertPolicy: "one_deduplicated_control_alert"
    },
    note: "A阶段形成销售快照并完成精确供应链接、供应SKU、采购成本、重量尺寸采集和主人确认；B只读取冻结数据包核算利润；B通过后自动进入C1，由上架任务完成合规、Schema和SEO，不再要求主人点击开始上架准备。"
  },
  ozonDandanshu: profitRule("蛋蛋鼠"),
  ozonMiska: profitRule("Miska"),
  wbCrossListing: profitRule("WB"),
  dailyTargets: {
    combinedProfitPassed: 10,
    targetMode: "three_store_combined",
    dandanshu: 10,
    miska: 10,
    maximumCodexAdditionsPerStore: 30,
    automationWindow: "08:00-22:00 Asia/Shanghai",
    cadence: "control_explicit_only",
    automaticAuditEnabled: false
  },
  listingPreparation: {
    defaultNewStock: 100,
    batchEnabled: false,
    startPolicy: "auto_c1_after_b_passed",
    productionPolicy: "separate_exact_confirmation"
  },
  evidenceReuse: {
    enabled: true,
    requiredScopeKeys: ["platform", "store", "category", "salesScheme", "route", "ruleVersion"],
    reusableKinds: ["commission", "exchange_rate", "logistics_tariff", "schema", "electrical_rule"],
    skuSpecificKinds: ["packed_measurements", "battery_profile", "source_sku", "material", "brand_ip"]
  },
  purchaseInput: {
    scope: "all_in_including_domestic_shipping",
    domesticShippingRmb: 0,
    note: "用户填写的采购价固定为货价加国内运费的到手总成本；不得拆分或再次询问国内运费。"
  },
  selectionDirections: {
    dandanshu: {
      evergreen: 4,
      halloween: 3,
      christmas: 3,
      activeMethod: "seerfar_market_first_then_source",
      marketEntry: "seasonal_and_trend_are_entry_points_only",
      minimumCrossBorderShare: 0.4,
      requireCurrentCommission: true,
      requireFeasiblePackedLogistics: true,
      requirePositivePurchaseSpaceBeforeSourceSearch: true,
      nonPositivePurchaseSpaceDisposition: "do_not_send_to_user_confirmation",
      sourceSearchScope: "only_inside_positive_profit_directions",
      finalInputs: ["purchasePriceRmb_all_in", "packedWeightKg", "dimensionsCm"],
      automaticRetryEnabled: false
    },
    miska: {
      homeLifestyleAndRetroGift: 10,
      automaticAdditionEnabled: false,
      activeFrom: "2026-08-04",
      activeThrough: "2026-08-11",
      reviewMode: "user_submissions_only",
      pauseReason: "未来一周Miska只审核用户主动提交品，不主动扩散或自动新增方向。",
      userSampleReviewThreshold: 5,
      thresholdMetric: "user_submitted_ready_to_list_count",
      sampleDeduplication: "same_product_color_or_size_variants_count_as_one_structural_sample",
      expansionEvidenceRequirement: "at_least_one_testable_common_economic_structure",
      expansionProposalLimit: 3,
      expansionProposalOutput: "one_commonality_hypothesis_and_up_to_three_seerfar_validation_directions",
      expansionRequiresControlConfirmation: true,
      supplierPageBlocksProfit: false,
      evidenceGapDisposition: "report_to_control",
      automaticRetryEnabled: false
    },
    note: "蛋蛋鼠按Seerfar市场优先法建立正利润方向后再找SKU；Miska未来一周只审用户提交品，至少5个完整、独立、利润通过并进入待上架的结构样本且能归纳可检验共同经济结构后，才向总控提交1份共同点假设和最多3条Seerfar验证方向；未经确认不得新增。"
  }
};

function profitRule(storeName) {
  return {
    storeName,
    pricingPolicyVersion: PROFIT_POLICY_VERSION,
    minimumUnitProfitRmb: 20,
    targetMarginRate: 0.25,
    thresholdPolicy: "both",
    priceRoundRmb: 1,
    advertisingReserveRate: 0,
    promotionDiscountScenarios: PROMOTION_DISCOUNT_SCENARIOS,
    decisionPromotionScenario: "base",
    returnOpsReserveRate: 0.05,
    damageLossReserveRate: 0.05,
    labelCostRmb: 1.5,
    note: "默认自然流量，广告成本为0；20%/25%/30%仅是促销折扣空间。若市场价是折后成交价，利润从该成交价计算，建议标价=折后成交价÷(1−促销率)，绝不再扣促销率。采购到手总价（已含国内运费）、包材、国际物流、佣金、退货运营、破损丢失和贴标必须完整计入。"
  };
}

function promotionEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return ["low", "base", "high"].map((key) => value[key]).filter(Boolean);
}

function thresholdPassedValues(unitProfitRmb, marginRate, rule) {
  return (
    Number(unitProfitRmb) >= rule.minimumUnitProfitRmb &&
    Number(marginRate) >= rule.targetMarginRate
  );
}

function profitThresholdPassed(profit, rule) {
  if (profit.status !== "verified" || profit.inputsComplete !== true) return false;
  return thresholdPassedValues(profit.unitProfitRmb, profit.marginRate, rule);
}

function directionalProfitThresholdPassed(profit, rule) {
  if (!profit || profit.inputsComplete !== true) return false;
  const status = String(profit.directionalStatus || profit.status || "");
  if (!(status === "passed" || status === "directional" || status === "verified")) return false;
  return thresholdPassedValues(profit.unitProfitRmb, profit.marginRate, rule);
}

export function promotionPricingGate(profit, rule) {
  const expected = Object.values(rule.promotionDiscountScenarios || PROMOTION_DISCOUNT_SCENARIOS);
  const actual = promotionEntries(profit?.promotionPricing);
  const blockers = [];
  if (profit?.pricingPolicyVersion !== rule.pricingPolicyVersion) {
    blockers.push("利润测算没有使用当前促销标价规则版本");
  }
  for (const definition of expected) {
    const scenario = actual.find((item) => item?.key === definition.key);
    if (!scenario) {
      blockers.push(`缺${definition.label}建议标价`);
      continue;
    }
    if (Math.abs(Number(scenario.promotionDiscountRate) - Number(definition.rate)) > 1e-9) {
      blockers.push(`${definition.label}折扣率记录不一致`);
    }
    if (!Number.isFinite(Number(scenario.targetTransactionPriceRmb))) blockers.push(`${definition.label}缺目标折后成交价`);
    if (!Number.isFinite(Number(scenario.suggestedListPriceRmb))) blockers.push(`${definition.label}缺建议标价`);
  }
  return {
    passed: blockers.length === 0,
    blockers
  };
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function storeProfitRule(candidate, rules = DEFAULT_RULES) {
  if (candidate.targetStore === "miska") return rules.ozonMiska;
  if (candidate.targetStore === "wb") return rules.wbCrossListing;
  return rules.ozonDandanshu;
}

function roundDownCurrency(value) {
  return Math.floor((Number(value) + 1e-9) * 100) / 100;
}

function promotionPriceSuggestions(transactionPriceRmb, rule) {
  return Object.values(rule.promotionDiscountScenarios || PROMOTION_DISCOUNT_SCENARIOS).map((definition) => ({
    key: definition.key,
    label: definition.label,
    promotionDiscountRate: Number(definition.rate),
    targetTransactionPriceRmb: Number(transactionPriceRmb),
    suggestedListPriceRmb: Number((Number(transactionPriceRmb) / (1 - Number(definition.rate))).toFixed(2))
  }));
}

function currentProfitResult({ sellerRevenueRmb, commissionRate, nonPurchaseFixedRmb, purchaseAllInRmb, rule }) {
  const reserveRate =
    commissionRate +
    Number(rule.advertisingReserveRate || 0) +
    Number(rule.returnOpsReserveRate) +
    Number(rule.damageLossReserveRate);
  const profitLimitedCeilingRmb = roundDownCurrency(
    sellerRevenueRmb * (1 - reserveRate) - nonPurchaseFixedRmb - Number(rule.minimumUnitProfitRmb)
  );
  const marginLimitedCeilingRmb = roundDownCurrency(
    sellerRevenueRmb * (1 - reserveRate - Number(rule.targetMarginRate)) - nonPurchaseFixedRmb
  );
  const maximumAllInPurchaseRmb = roundDownCurrency(
    Math.min(profitLimitedCeilingRmb, marginLimitedCeilingRmb)
  );
  const hasPurchase = Number.isFinite(purchaseAllInRmb) && purchaseAllInRmb >= 0;
  const unitProfitRmb = hasPurchase
    ? roundDownCurrency(sellerRevenueRmb * (1 - reserveRate) - nonPurchaseFixedRmb - purchaseAllInRmb)
    : null;
  const marginRate = hasPurchase && sellerRevenueRmb > 0
    ? Number((unitProfitRmb / sellerRevenueRmb).toFixed(4))
    : null;
  return {
    reserveRate,
    profitLimitedCeilingRmb,
    marginLimitedCeilingRmb,
    maximumAllInPurchaseRmb,
    unitProfitRmb,
    marginRate,
    thresholdPassed: hasPurchase
      ? thresholdPassedValues(unitProfitRmb, marginRate, rule)
      : null
  };
}

export function purchaseCeilingSummary(candidate, rules = DEFAULT_RULES) {
  const raw = candidate.purchaseCeiling || {};
  const rule = storeProfitRule(candidate, rules);
  const status = raw.status === "unverified" ? "unavailable" : raw.status;
  const missing = [];
  const sellerRevenueRmb = Number(raw.sellerRevenueRmb ?? raw.marketReferencePriceRmb);
  const commissionRate = Number(raw.commissionRate);
  const internationalLogisticsRmb = Number(raw.internationalLogisticsRmb);
  const packagingRmb = Number(raw.packagingRmb ?? DEFAULT_PACKAGING_COST_RMB);
  const labelRmb = Number(raw.labelRmb ?? rule.labelCostRmb);
  const purchaseInput = candidate.purchasePriceRmb;
  const purchaseAllInRmb =
    purchaseInput === null || purchaseInput === undefined || purchaseInput === ""
      ? Number.NaN
      : Number(purchaseInput);

  const verified = status === "verified";
  const estimated = status === "estimated";

  if (!(sellerRevenueRmb > 0)) {
    missing.push(estimated ? "Ozon方向参考售价" : "当前可追溯的卖家收入");
  } else if (verified && (raw.sellerRevenueSourceType !== "real" || !raw.sellerRevenueSourceUrl)) {
    missing.push("当前可追溯的卖家收入");
  }
  if (!(commissionRate >= 0 && commissionRate < 1)) {
    missing.push(estimated ? "方向佣金参考值" : "当前真实类目佣金");
  } else if (verified && (raw.commissionSourceType !== "real" || !raw.commissionSourceUrl)) {
    missing.push("当前真实类目佣金");
  }
  if (!(internationalLogisticsRmb >= 0)) {
    missing.push(estimated ? "按Ozon页规格估算的GUOO运费" : "最终包装对应的真实国际运费");
  } else if (verified && (raw.logisticsSourceType !== "real" || !raw.logisticsSource)) {
    missing.push("最终包装对应的真实国际运费");
  }
  if (!(packagingRmb >= 0)) missing.push("包材成本");
  if (!(labelRmb >= 0)) missing.push("贴标成本");
  if (raw.scope && raw.scope !== PURCHASE_CEILING_SCOPE) {
    missing.push("采购上限口径（采购价含国内邮费）");
  }
  if (!raw.checkedAt) missing.push("反算查询时间");

  const currentPolicy = raw.pricingPolicyVersion === rule.pricingPolicyVersion;
  if (["verified", "estimated"].includes(status) && !currentPolicy) {
    return {
      ...raw,
      status: "unavailable",
      scope: PURCHASE_CEILING_SCOPE,
      maximumAllInPurchaseRmb: null,
      policyUpdatePending: true,
      missing: ["旧利润模型曾把20%–30%促销空间当成本二次扣除，必须按折后成交价重新计算"],
      thresholdPolicy: rule.thresholdPolicy
    };
  }

  const explicitMissing = Array.isArray(raw.missing)
    ? raw.missing.map(String).filter(Boolean)
    : [];
  if (!["verified", "estimated"].includes(status) || missing.length) {
    return {
      ...raw,
      status: "unavailable",
      scope: PURCHASE_CEILING_SCOPE,
      maximumAllInPurchaseRmb: null,
      missing: [...new Set([...explicitMissing, ...missing])],
      thresholdPolicy: rule.thresholdPolicy
    };
  }

  const nonPurchaseFixedRmb = packagingRmb + internationalLogisticsRmb + labelRmb;
  const result = currentProfitResult({
    sellerRevenueRmb,
    commissionRate,
    nonPurchaseFixedRmb,
    purchaseAllInRmb,
    rule
  });
  const promotionPricing = promotionPriceSuggestions(sellerRevenueRmb, rule);

  return {
    ...raw,
    status,
    scope: PURCHASE_CEILING_SCOPE,
    sellerRevenueRmb,
    commissionRate,
    internationalLogisticsRmb,
    packagingRmb,
    labelRmb,
    pricingPolicyVersion: rule.pricingPolicyVersion,
    policyUpdatePending: false,
    advertisingReserveRate: 0,
    promotionPricing,
    decisionPromotionScenario: rule.decisionPromotionScenario,
    reserveRate: result.reserveRate,
    nonPurchaseFixedRmb,
    profitLimitedCeilingRmb: result.profitLimitedCeilingRmb,
    marginLimitedCeilingRmb: result.marginLimitedCeilingRmb,
    maximumAllInPurchaseRmb: result.maximumAllInPurchaseRmb,
    unitProfitRmb: result.unitProfitRmb,
    marginRate: result.marginRate,
    thresholdPolicy: rule.thresholdPolicy,
    missing: [],
    estimateOnly: estimated
  };
}

export function codexAutoEliminationGate(candidate, rules = DEFAULT_RULES) {
  if (candidate?.source !== "codex") {
    return { shouldEliminate: false, eligible: false, reason: "仅对Codex自找候选适用" };
  }
  const ceiling = purchaseCeilingSummary(candidate, rules);
  const evidenceComplete =
    ceiling.status === "verified" &&
    ceiling.sellerRevenueSourceType === "real" &&
    ceiling.commissionSourceType === "real" &&
    ceiling.logisticsSourceType === "real" &&
    Boolean(ceiling.sellerRevenueSourceUrl) &&
    Boolean(ceiling.commissionSourceUrl) &&
    Boolean(ceiling.logisticsSource);
  const maximum = Number(ceiling.maximumAllInPurchaseRmb);
  const eligible = evidenceComplete && Number.isFinite(maximum);
  const shouldEliminate = eligible && maximum <= 0;
  const formula = eligible
    ? `最大采购到手价=min(折后成交收入×(1−佣金−退货−破损)−GUOO−包材−贴标−20, 折后成交收入×(1−佣金−退货−破损−25%)−GUOO−包材−贴标)=${maximum.toFixed(2)}元；两项门槛必须同时满足，促销率只用于反推标价`
    : "市场/佣金/物流或费用证据尚未全部验证，暂不执行负上限淘汰";
  return {
    eligible,
    shouldEliminate,
    maximumAllInPurchaseRmb: eligible ? maximum : null,
    formula,
    reason: shouldEliminate
      ? `已验证目标平台市场、佣金、物流和预留费用，最大采购到手价≤0（${maximum.toFixed(2)}元），即使采购价为0也未达利润门槛`
      : ""
  };
}

export function businessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const valueOf = (type) => parts.find((part) => part.type === type)?.value;
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
}

export function validateListingRecord(input = {}, options = {}) {
  const platform = String(input.platform || "").trim().toLowerCase();
  if (!["ozon", "wb"].includes(platform)) {
    throw new Error("请选择已上架平台（Ozon或WB）");
  }
  const store = String(input.store || "").trim().toLowerCase();
  if (store && !["dandanshu", "miska", "wb"].includes(store)) {
    throw new Error("请选择有效店铺");
  }
  const productId = String(input.productId || "").trim();
  const merchantSku = String(input.merchantSku || "").trim();
  const productUrl = String(input.productUrl || "").trim();
  if (!productId && !productUrl && options.allowMissingIdentity !== true) throw new Error("请填写商品ID或链接");
  if (productUrl && !/^https?:\/\//i.test(productUrl)) {
    throw new Error("商品链接必须是http或https链接");
  }
  const confirmedAt = String(input.confirmedAt || "").trim();
  if (!confirmedAt || Number.isNaN(new Date(confirmedAt).getTime())) {
    throw new Error("请填写有效的确认时间");
  }
  return {
    platform,
    store,
    productId,
    merchantSku,
    productUrl,
    confirmedAt,
    moderationStatus: String(input.moderationStatus || "").trim(),
    saleStatus: String(input.saleStatus || "").trim(),
    method: "manual_fallback"
  };
}

export function validateListingReadback(input = {}, at = new Date()) {
  const platform = String(input.platform || "").trim().toLowerCase();
  if (!["ozon", "wb"].includes(platform)) {
    throw new Error("自动回写必须指定Ozon或WB平台");
  }
  const store = String(input.store || "").trim().toLowerCase();
  if (!["dandanshu", "miska", "wb"].includes(store)) {
    throw new Error("自动回写必须指定实际店铺");
  }
  const productId = String(input.productId || "").trim();
  if (!productId) throw new Error("自动回写必须包含平台商品ID");
  const merchantSku = String(input.merchantSku || "").trim();
  if (!merchantSku) throw new Error("自动回写必须包含商家货号");
  const productUrl = String(input.productUrl || "").trim();
  if (productUrl && !/^https?:\/\//i.test(productUrl)) {
    throw new Error("前台链接必须是http或https链接");
  }
  const moderationStatus = String(input.moderationStatus || "").trim();
  if (!moderationStatus) throw new Error("自动回写必须包含当前审核状态");
  const saleStatus = String(input.saleStatus || "").trim();
  if (!saleStatus) throw new Error("自动回写必须包含当前销售状态");

  const readback = input.readback || {};
  if (readback.sourceType !== "real" || !["seller_api", "seller_portal"].includes(readback.source)) {
    throw new Error("自动回写必须来自Seller API或卖家后台的真实回读");
  }
  const checkedAt = String(readback.checkedAt || "").trim();
  const checkedTime = new Date(checkedAt).getTime();
  const nowTime = new Date(at).getTime();
  if (!checkedAt || Number.isNaN(checkedTime)) {
    throw new Error("自动回写必须包含有效查询时间");
  }
  if (checkedTime > nowTime + 5 * 60_000) {
    throw new Error("自动回写查询时间不能晚于当前时间");
  }
  if (nowTime - checkedTime > 24 * 60 * 60_000) {
    throw new Error("自动回写证据已超过24小时，请重新回读");
  }
  const evidenceRef = String(readback.evidenceRef || "").trim();
  if (!evidenceRef) throw new Error("自动回写必须保存可追溯的回读依据");
  const confirmedAt = String(input.confirmedAt || checkedAt).trim();
  if (Number.isNaN(new Date(confirmedAt).getTime())) {
    throw new Error("自动回写必须包含有效确认时间");
  }

  return {
    platform,
    store,
    productId,
    merchantSku,
    productUrl,
    confirmedAt,
    moderationStatus,
    saleStatus,
    method: "automatic_readback",
    readback: {
      sourceType: "real",
      source: readback.source,
      checkedAt,
      evidenceRef
    }
  };
}

export function isActualProcessingRun(processing = {}) {
  return (
    processing.state === "running" &&
    Boolean(String(processing.runId || "").trim()) &&
    Boolean(String(processing.startedAt || "").trim()) &&
    Boolean(String(processing.currentStep || "").trim()) &&
    Boolean(String(processing.lastProgressAt || "").trim()) &&
    Number.isFinite(new Date(processing.startedAt).getTime()) &&
    Number.isFinite(new Date(processing.lastProgressAt).getTime())
  );
}

function normalizedAttemptTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|spm$|fromkv$|source$|amug_)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

export function processingAttemptKey({ candidateId, runId, evidenceLayer, target } = {}) {
  const parts = [candidateId, runId, evidenceLayer, normalizedAttemptTarget(target)].map((value) =>
    String(value || "").trim()
  );
  if (parts.some((value) => !value)) throw new Error("浏览器尝试必须提供候选、runId、证据层和目标");
  return parts.join("|");
}

export function registerProcessingAttempt(processing = {}, attempt = {}, at = new Date().toISOString()) {
  if (!isActualProcessingRun(processing)) throw new Error("只有真实运行中的任务才能登记读取尝试");
  if (String(attempt.runId || "").trim() !== String(processing.runId || "").trim()) {
    throw new Error("读取尝试runId与当前任务不一致");
  }
  const key = processingAttemptKey(attempt);
  const attemptLedger = Array.isArray(processing.attemptLedger) ? processing.attemptLedger : [];
  if (attemptLedger.some((item) => item.attemptKey === key)) {
    throw new Error("同一候选、同一证据层和目标本轮已尝试，禁止重复浏览器抓取");
  }
  return {
    ...processing,
    attemptLedger: [
      ...attemptLedger,
      {
        attemptKey: key,
        evidenceLayer: String(attempt.evidenceLayer).trim(),
        target: normalizedAttemptTarget(attempt.target),
        path: String(attempt.path || "").trim(),
        attemptedAt: new Date(at).toISOString()
      }
    ]
  };
}

export function recordProcessingProgress(processing = {}, progress = {}, at = new Date().toISOString()) {
  if (!isActualProcessingRun(processing)) throw new Error("只有真实运行中的任务才能记录实质进展");
  if (String(progress.runId || "").trim() !== String(processing.runId || "").trim()) {
    throw new Error("进展runId与当前任务不一致");
  }
  const progressType = String(progress.progressType || "").trim();
  const currentStep = String(progress.currentStep || "").trim();
  const evidenceRef = String(progress.evidenceRef || "").trim();
  if (!currentStep) throw new Error("实质进展必须写明当前执行步骤");
  if (!["step_change", "new_evidence"].includes(progressType)) {
    throw new Error("实质进展类型只能是步骤变化或新证据");
  }
  if (progressType === "step_change" && currentStep === String(processing.currentStep || "").trim()) {
    throw new Error("执行步骤没有实质变化");
  }
  if (progressType === "new_evidence" && !evidenceRef) {
    throw new Error("新证据进展必须提供证据引用");
  }
  const progressEvents = Array.isArray(processing.progressEvents) ? processing.progressEvents : [];
  if (
    progressType === "new_evidence" &&
    progressEvents.some((item) => item.progressType === "new_evidence" && item.evidenceRef === evidenceRef)
  ) {
    throw new Error("相同证据已记录，不能作为新的实质进展");
  }
  const progressedAt = new Date(at).toISOString();
  return {
    ...processing,
    currentStep,
    lastProgressAt: progressedAt,
    progressEvents: [
      ...progressEvents,
      {
        progressType,
        currentStep,
        evidenceRef,
        progressedAt
      }
    ]
  };
}

export function stopNoProgressRuns(
  candidates,
  at = new Date(),
  timeoutMinutes = NO_PROGRESS_TIMEOUT_MINUTES
) {
  const alerts = [];
  const nowTime = new Date(at).getTime();
  const cutoff = nowTime - timeoutMinutes * 60_000;
  for (const candidate of candidates) {
    const processing = candidate?.processing || {};
    if (candidate?.workflowStatus !== "codex_processing" || processing.state !== "running") continue;
    const actualRunning = isActualProcessingRun(processing);
    const progressTime = new Date(processing.lastProgressAt || 0).getTime();
    const shouldStop = !actualRunning || !Number.isFinite(progressTime) || progressTime <= cutoff;
    if (!shouldStop) continue;
    const stoppedRunId = String(processing.runId || "").trim() || "missing-run-id";
    const dedupeKey = `no-progress|${candidate.id}|${stoppedRunId}`;
    const stoppedAt = new Date(at).toISOString();
    candidate.processing = {
      ...processing,
      state: "blocked",
      runId: null,
      startedAt: null,
      currentStep: "已停止：等待主人建议",
      lastRunId: stoppedRunId,
      manualHold: true,
      dispatchState: "blocked",
      deferredUntil: null,
      deferredRunId: null,
      blockReason: actualRunning
        ? `${timeoutMinutes}分钟没有实质进展，系统已停止本轮任务`
        : "运行字段不完整，系统已停止异常任务",
      userAction: "请在UI写明执行建议，再只重试当前SKU一次",
      stoppedAt,
      stopReason: actualRunning ? "no_substantive_progress" : "invalid_running_state",
      controlAlertKey: dedupeKey
    };
    alerts.push({
      id: dedupeKey,
      dedupeKey,
      candidateId: candidate.id,
      runId: stoppedRunId,
      type: actualRunning ? "no_substantive_progress" : "invalid_running_state",
      message: candidate.processing.blockReason,
      createdAt: stoppedAt,
      acknowledgedAt: null
    });
  }
  return alerts;
}

export function processingStatusSummary(candidate, at = new Date(), queueInfo = {}) {
  const processing = candidate?.processing || {};
  const state = processing.state || "idle";
  const manualHold = processing.manualHold === true;
  const actualRunning = isActualProcessingRun(processing);
  const labels = {
    running: "运行中 · 有实际任务",
    queued: "排队等待领取",
    deferred: "已停止 · 等待主人建议",
    blocked: "已停止 · 等待固定选择",
    idle: "无人运行"
  };
  let key = manualHold || state === "deferred" ? "blocked" : state;
  if (state === "running" && !actualRunning) key = "state_anomaly";
  if (!Object.hasOwn(labels, state) && state !== "running") key = "idle";

  const startedAt = processing.startedAt ? new Date(processing.startedAt) : null;
  const staleRunning =
    actualRunning &&
    startedAt &&
    !Number.isNaN(startedAt.getTime()) &&
    new Date(at).getTime() - new Date(processing.lastProgressAt).getTime() > NO_PROGRESS_TIMEOUT_MINUTES * 60_000;
  if (staleRunning) key = "stalled";

  const label = staleRunning
    ? "运行超时 · 无法确认仍在运行"
    : manualHold
      ? labels.blocked
    : key === "state_anomaly"
      ? "状态异常 · 当前无人运行"
      : labels[state] || labels.idle;

  return {
    key,
    label,
    actualRunning,
    classification: key,
    lastAttemptAt: processing.lastAttemptAt || processing.startedAt || null,
    reason: processing.blockReason || processing.lastError || "",
    userAction: processing.userAction || "",
    attemptsToday: Number(processing.attemptsToday || 0),
    deferredUntil: processing.deferredUntil || null,
    recoveryOptions: Array.isArray(processing.recoveryOptions) ? processing.recoveryOptions : [],
    queuePosition: queueInfo.queuePosition ?? null,
    tasksAhead: queueInfo.tasksAhead ?? null,
    estimatedStart: queueInfo.estimatedStart || "",
    dispatchRequestedAt: processing.dispatchRequestedAt || null,
    dispatchTrigger: processing.dispatchTrigger || "",
    currentStep: processing.currentStep || "",
    lastProgressAt: processing.lastProgressAt || null
  };
}

/**
 * Make persisted dispatch fields internally consistent without claiming work.
 * This is intentionally a manual-hold migration: a later automation run must
 * receive an explicit control instruction before it can claim these candidates.
 */
export function normalizeDispatchStates(candidates, at = new Date()) {
  const changed = [];
  const nowTime = new Date(at).getTime();
  for (const candidate of candidates) {
    if (candidate?.workflowStatus !== "codex_processing") continue;
    const previous = candidate.processing || {};
    const hasRunId = Boolean(String(previous.runId || "").trim());
    const deferredDue =
      previous.deferredUntil &&
      Number.isFinite(new Date(previous.deferredUntil).getTime()) &&
      new Date(previous.deferredUntil).getTime() <= nowTime;
    const queuedDeferred =
      previous.state === "queued" &&
      (previous.dispatchState === "deferred" || Boolean(previous.deferredUntil && deferredDue)) &&
      !hasRunId;
    const queuedClaimedOrphan = previous.state === "queued" && previous.dispatchState === "claimed" && !hasRunId;
    const expiredDeferred = previous.state === "deferred" && deferredDue && !hasRunId;
    if (!queuedDeferred && !queuedClaimedOrphan && !expiredDeferred) continue;

    const from = `${previous.state || "idle"}/${previous.dispatchState || "none"}`;
    const next = {
      ...previous,
      runId: null,
      startedAt: null,
      claimRevision: null,
      deferredRunId: null,
      deferredUntil: null,
      manualHold: true,
      normalizedAt: new Date(at).toISOString(),
      normalizedFrom: from
    };

    if (expiredDeferred || queuedDeferred) {
      next.state = "blocked";
      next.dispatchState = "blocked";
      next.userAction = previous.userAction || "请让总控明确是否重新开始该SKU；恢复前不再自动重试";
      next.recoveryOptions = Array.isArray(previous.recoveryOptions) && previous.recoveryOptions.length
        ? previous.recoveryOptions
        : [
            "总控明确允许重新开始该SKU并指定一次恢复路径",
            "用户补充一次可读的精确链接/选中SKU参数证据"
          ];
    } else {
      next.state = "queued";
      next.dispatchState = "normalized";
      next.userAction = previous.userAction || "请让总控明确是否领取；当前没有实际任务在运行";
      next.recoveryOptions = Array.isArray(previous.recoveryOptions) ? previous.recoveryOptions : [];
    }
    candidate.processing = next;
    changed.push({ candidateId: candidate.id, from, to: `${next.state}/${next.dispatchState}` });
  }
  return changed;
}

export function queueUserDispatch(previous = {}, at = new Date().toISOString(), trigger = "user_update") {
  if (previous.manualHold === true) {
    return {
      ...previous,
      state: "blocked",
      runId: null,
      startedAt: null,
      dispatchState: "blocked",
      dispatchRequestedAt: at,
      dispatchTrigger: trigger,
      manualHold: true,
      deferredUntil: null,
      deferredRunId: null
    };
  }
  return {
    state: "queued",
    runId: null,
    startedAt: null,
    claimRevision: null,
    attempts: Number(previous.attempts || 0),
    attemptsToday: Number(previous.attemptsToday || 0),
    lastAttemptAt: previous.lastAttemptAt || null,
    lastError: null,
    blockReason: null,
    userAction: "",
    readAttempts: [],
    deferredUntil: null,
    deferredRunId: null,
    lastAttemptRevision: previous.lastAttemptRevision ?? null,
    lastAttemptBusinessDate: previous.lastAttemptBusinessDate || null,
    dispatchState: "requested",
    dispatchPriority: "user",
    dispatchRequestedAt: at,
    dispatchTrigger: trigger,
    manualHold: false,
    normalizedAt: null,
    normalizedFrom: null
  };
}

function hasUnansweredComment(candidate) {
  return (candidate.comments || []).some(
    (comment) => comment.actor === "user" && comment.requiresResponse === true && comment.status !== "responded"
  );
}

export function claimEligible(candidate, at = new Date()) {
  const processing = candidate.processing || {};
  if (processing.manualHold === true) return false;
  if (processing.dispatchState === "requested") return true;
  if (Number(processing.attempts || 0) === 0 || hasUnansweredComment(candidate)) return true;
  const lastRevision = Number(processing.lastAttemptRevision ?? candidate.dataRevision);
  if (Number(candidate.dataRevision) > lastRevision) return true;
  const lastDate = processing.lastAttemptBusinessDate || businessDate(candidate.updatedAt || candidate.createdAt);
  return lastDate !== businessDate(at) && processing.state === "queued";
}

function dispatchPriority(candidate) {
  if (candidate.processing?.dispatchState === "requested") {
    return requiredInputFields(candidate).length ? 1 : 0;
  }
  if (candidate.source === "user") return 2;
  return 3;
}

export function sortDispatchQueue(candidates, at = new Date()) {
  return candidates
    .filter(
      (candidate) =>
        candidate.workflowStatus === "codex_processing" &&
        candidate.processing?.state === "queued" &&
        claimEligible(candidate, at)
    )
    .sort((a, b) => {
      const priorityDifference = dispatchPriority(a) - dispatchPriority(b);
      if (priorityDifference) return priorityDifference;
      const aRequested = a.processing?.dispatchRequestedAt || a.updatedAt || a.createdAt || 0;
      const bRequested = b.processing?.dispatchRequestedAt || b.updatedAt || b.createdAt || 0;
      return new Date(aRequested).getTime() - new Date(bRequested).getTime();
    });
}

export function dispatchQueueSummary(
  candidates,
  at = new Date(),
  concurrencyLimit = DEFAULT_AUTOMATION_CONCURRENCY_LIMIT
) {
  const processingCandidates = candidates.filter(
    (candidate) => candidate.workflowStatus === "codex_processing"
  );
  const runningIds = candidates
    .filter(
      (candidate) =>
        candidate.workflowStatus === "codex_processing" &&
        candidate.processing?.state === "running" &&
        isActualProcessingRun(candidate.processing)
    )
    .sort((a, b) => {
      const timeDifference = new Date(a.processing.startedAt).getTime() - new Date(b.processing.startedAt).getTime();
      return timeDifference || a.id.localeCompare(b.id);
    })
    .map((candidate) => candidate.id);
  const queued = sortDispatchQueue(candidates, at);
  const processingCounts = {
    running: processingCandidates.filter(
      (candidate) => isActualProcessingRun(candidate.processing)
    ).length,
    queued: processingCandidates.filter(
      (candidate) => candidate.processing?.state === "queued" && candidate.processing?.manualHold !== true
    ).length,
    deferred: processingCandidates.filter((candidate) => candidate.processing?.state === "deferred").length,
    blocked: processingCandidates.filter(
      (candidate) => candidate.processing?.manualHold === true || candidate.processing?.state === "blocked"
    ).length,
    stopped: processingCandidates.filter(
      (candidate) => candidate.processing?.manualHold === true || ["blocked", "deferred"].includes(candidate.processing?.state)
    ).length,
    stateAnomaly: processingCandidates.filter(
      (candidate) => candidate.processing?.state === "running" && !isActualProcessingRun(candidate.processing)
    ).length
  };
  const positions = {};
  queued.forEach((candidate, index) => {
    const queuePosition = index + 1;
    const tasksAhead = Math.max(0, runningIds.length + index - Math.max(0, concurrencyLimit - 1));
    positions[candidate.id] = {
      queuePosition,
      tasksAhead,
      estimatedStart:
        tasksAhead === 0
          ? "立即开始（等待领取）"
          : tasksAhead === 1
            ? "当前任务完成后立即开始"
            : `前面还有${tasksAhead}条，完成后立即开始`
    };
  });
  return {
    concurrencyLimit,
    runningIds,
    queuedIds: queued.map((candidate) => candidate.id),
    positions,
    processingCounts
  };
}

export function technicalFailureDisposition({
  attemptsToday = 0,
  readAttempts = [],
  explicitSafetyBlock = false,
  repairAttempted = true
} = {}) {
  const failedAttempts = (Array.isArray(readAttempts) ? readAttempts : []).filter(
    (item) => item?.status === "failed" && String(item?.path || "").trim()
  );
  if (!failedAttempts.length) {
    throw new Error("技术阻塞必须提供一次真实失败证据");
  }
  return {
    // One evidence-bearing failure ends this round. There is no deferred
    // background retry; only an explicit control decision can start a new run.
    action: "block",
    attemptsToday: Number(attemptsToday),
    readAttempts: failedAttempts,
    recoveryOptions: [
      "主人在UI选择是否只重试当前阶段一次"
    ]
  };
}

export function requiredInputFields(candidate) {
  const missing = [];
  const productName = String(candidate.productName || "").trim();
  const sourceSku = String(candidate.codexReview?.sourceSku?.sku || "").trim();
  const genericName = /^(用户添加的待识别商品|Codex新增候选|待确认方向)$/i.test(productName);
  if ((!productName || genericName) && !sourceSku)
    missing.push({ field: "productName", label: "明确目标SKU/款式" });
  if (isBlank(candidate.purchasePriceRmb))
    missing.push({ field: "purchasePriceRmb", label: "采购到手总价（含国内运费）" });
  if (!(Number(candidate.packedWeightKg) > 0))
    missing.push({ field: "packedWeightKg", label: "真实打包重量" });
  const dimensions = candidate.dimensionsCm || {};
  if (
    !(Number(dimensions.length) > 0) ||
    !(Number(dimensions.width) > 0) ||
    !(Number(dimensions.height) > 0)
  ) {
    missing.push({ field: "dimensionsCm", label: "包装长宽高" });
  }
  return missing;
}

export function profitInputStatus(candidate) {
  const missing = requiredInputFields(candidate);
  return {
    ready: missing.length === 0,
    missing,
    fields: ["productName", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"],
    sourcePageRequired: false,
    sourcePagePurpose: "A阶段确认精确供应链接、SKU、价格、国内运费、采购成本、重量和尺寸；B只读取冻结证据"
  };
}

export function filterUserNeededFields(candidate, requested = []) {
  const dimensions = candidate.dimensionsCm || {};
  const sourceUrl = String(candidate.sourceUrl || "").trim();
  const alreadyProvided = {
    productName:
      Boolean(String(candidate.productName || "").trim()) &&
      !/^(用户添加的待识别商品|Codex新增候选|待确认方向)$/i.test(String(candidate.productName || "").trim()),
    productUrl: Boolean(String(candidate.productUrl || "").trim()),
    sourceUrl:
      /^https?:\/\/(?:detail\.1688\.com\/offer\/\d+|detail\.tmall\.com|item\.taobao\.com|mobile\.yangkeduo\.com)/i.test(sourceUrl),
    purchasePriceRmb: Number(candidate.purchasePriceRmb) > 0,
    packedWeightKg: Number(candidate.packedWeightKg) > 0,
    dimensionsCm:
      Number(dimensions.length) > 0 &&
      Number(dimensions.width) > 0 &&
      Number(dimensions.height) > 0,
    powered: [true, false].includes(candidate.powered)
  };
  return [...new Set(Array.isArray(requested) ? requested : [])].filter(
    (field) => field === "notes" || alreadyProvided[field] !== true
  );
}

export function approvalGate(candidate, rules = DEFAULT_RULES) {
  const review = candidate.codexReview || {};
  const profit = review.profitCalculation || {};
  const dimensions = candidate.dimensionsCm || {};
  const rule = storeProfitRule(candidate, rules);
  const marketPassed = Number(review.marketEvidence?.comparableCount || 0) > 0;
  const electricalScope = candidate.targetStore === "wb" ? "WB/CEL" : "Ozon/GUOO";
  const electrical = electricalGate(candidate.powered, review.electricalAssessment, electricalScope);
  const autoElimination = codexAutoEliminationGate(candidate, rules);
  const promotionGate = profit?.pricingPolicyVersion
    ? promotionPricingGate(profit, rule)
    : null;
  const checks = [
    [electrical.passed, electrical.blocker],
    [candidate.complianceStatus === "clear", "合规资料不清楚"],
    [candidate.authorizationStatus === "clear", "授权状态不清楚"],
    [marketPassed, "尚未取得任何可追溯的当前市场样本"],
    [
      Number(candidate.packedWeightKg) > 0 &&
        Number(dimensions.length) > 0 &&
        Number(dimensions.width) > 0 &&
        Number(dimensions.height) > 0,
      "缺真实包装重量或尺寸"
    ],
    [
      profitThresholdPassed(profit, rule),
      `完整利润复算必须同时满足单件利润≥${rule.minimumUnitProfitRmb}元且利润率≥${Math.round(rule.targetMarginRate * 100)}%`
    ],
    [review.commission?.sourceType === "real", "佣金不是当前真实类目和销售方案数据"],
    [review.logistics?.sourceType === "real", "物流线路或运费不是当前真实规格数据"],
    [review.sourceConsistency?.status === "verified", "1688精确货源与目标SKU尚未核验一致"]
  ];
  const profitInputs = profitInputStatus(candidate);
  const directionalProfit = {
    status: profitInputs.ready
      ? directionalProfitThresholdPassed(profit, rule) ? "passed" : "pending_or_not_passed"
      : "missing_user_inputs",
    passed: profitInputs.ready && directionalProfitThresholdPassed(profit, rule),
    inputsReady: profitInputs.ready,
    missing: profitInputs.missing.map((item) => item.label),
    sourcePageRequired: false,
    sourcePagePurpose: "A阶段供应方案确认；B不得重新访问供应平台"
  };
  const blockers = checks.filter(([passed]) => !passed).map(([, reason]) => reason);
  if (autoElimination.shouldEliminate) blockers.push(autoElimination.reason);
  return {
    passed: blockers.length === 0,
    blockers,
    autoElimination,
    promotionPricing: promotionGate
      ? {
          policyVersion: rule.pricingPolicyVersion,
          complete: promotionGate.passed,
          blockers: promotionGate.blockers
        }
      : {
          policyVersion: "legacy-profit-model",
          complete: false,
          blockers: ["旧利润模型需按折后成交价重算；促销只反推标价"]
        },
    profitDirection: directionalProfit,
    readinessStatus: checks.every(([passed]) => passed) ? "ready_to_list" : "not_ready_to_list",
    sourceConsistencyStatus:
      review.sourceConsistency?.status === "verified"
        ? "verified"
        : review.sourceConsistency?.status === "mismatch"
          ? "mismatch_blocks_this_sku_only"
          : "pending_before_procurement_or_listing"
  };
}

export function profitReviewGate(candidate, rules = DEFAULT_RULES) {
  const review = candidate.codexReview || {};
  const profit = review.profitCalculation || {};
  const rule = storeProfitRule(candidate, rules);
  const input = profitInputStatus(candidate);
  const promotionGate = profit?.pricingPolicyVersion
    ? promotionPricingGate(profit, rule)
    : { passed: false, blockers: ["利润尚未使用当前促销标价规则"] };
  const commissionExact = review.commission?.sourceType === "real";
  const commissionEstimated =
    ["estimated", "user_accepted_estimate"].includes(review.commission?.sourceType) &&
    (
      review.commission?.estimateAuthorized === true ||
      review.commission?.estimated === true && Boolean(review.commission?.acceptedBy) ||
      candidate.acceptedEstimatedCommission === true
    );
  const checks = [
    [input.ready, `缺B阶段输入：${input.missing.map((item) => item.label).join("、")}`],
    [Number(review.marketEvidence?.comparableCount || 0) > 0, "尚未取得任何可追溯的当前市场样本"],
    [Boolean(review.marketEvidence?.checkedAt), "市场证据缺取得时间"],
    [commissionExact || commissionEstimated, "佣金既不是当前真实证据，也没有该SKU的估算授权"],
    [review.logistics?.sourceType === "real", "物流线路或运费不是当前真实包装数据"],
    [directionalProfitThresholdPassed(profit, rule), `B阶段利润必须同时满足单件利润≥${rule.minimumUnitProfitRmb}元且利润率≥${Math.round(rule.targetMarginRate * 100)}%`],
    [promotionGate.passed, promotionGate.blockers.join("；")]
  ];
  const blockers = checks.filter(([passed]) => !passed).map(([, reason]) => reason).filter(Boolean);
  return {
    passed: blockers.length === 0,
    blockers,
    commissionMode: commissionExact ? "exact" : commissionEstimated ? "estimated" : "missing",
    exactSourceRequired: true,
    exactSourceStage: "A_owner_confirmed_before_B"
  };
}

export function selectionStage(candidate, rules = DEFAULT_RULES) {
  const profitInputs = profitInputStatus(candidate);
  const gate = approvalGate(candidate, rules);
  const bGate = profitReviewGate(candidate, rules);
  if (gate.autoElimination?.shouldEliminate && candidate.workflowStatus !== "eliminated") {
    return {
      stage: "auto_eliminate_ready",
      label: "证据充分 · 应自动淘汰",
      profitDirection: gate.profitDirection,
      sourceConsistency: gate.sourceConsistencyStatus,
      sourcePageBlocksProfit: false,
      nextAction: gate.autoElimination.reason,
      autoElimination: gate.autoElimination
    };
  }
  const profit = gate.profitDirection;
  const sourceConsistency = gate.sourceConsistencyStatus;
  let stage = "pool_intake";
  if (profitInputs.ready) stage = bGate.passed ? "profit_passed_source_pending" : "profit_review";
  if (sourceConsistency === "mismatch_blocks_this_sku_only" && bGate.passed) stage = "profit_passed_source_mismatch";
  if (candidate.workflowStatus === "listing_preparation") stage = "listing_preparation";
  if (candidate.workflowStatus === "ready_to_list") {
    stage = candidate.listingPreparation?.status === "prepared" && candidate.cCompletedAt
      ? "ready_to_list"
      : "legacy_ready_pending_c";
  }
  if (candidate.workflowStatus === "eliminated") stage = "eliminated";
  return {
    stage,
    label: {
      pool_intake: "选品池待核算",
      profit_review: "待做利润核算",
      profit_passed_source_pending: "利润通过 · 来源待复核",
      profit_passed_source_mismatch: "利润通过 · 当前SKU不一致",
      listing_preparation: "待上架准备",
      auto_eliminate_ready: "证据充分 · 应自动淘汰",
      ready_to_list: "可采购/可上架",
      legacy_ready_pending_c: "历史待上架 · 需补做C阶段",
      eliminated: "已淘汰"
    }[stage],
    profitDirection: profit,
    sourceConsistency,
    sourcePageBlocksProfit: false,
    nextAction: stage === "profit_passed_source_mismatch"
      ? "阻止当前SKU采购/上架；重新核对精确货源与目标SKU。方向初筛结论不因此淘汰"
      : stage === "profit_passed_source_pending"
      ? "B阶段通过后自动进入C1；上架任务继承A/B冻结数据，不再要求主人点击开始"
      : stage === "profit_review"
        ? profit.inputsReady
          ? bGate.blockers[0] || "取得当前平台市场、佣金、物流与汇率证据后完成B阶段利润核算"
          : "先补齐采购到手总价、真实打包重量和包装尺寸"
        : stage === "legacy_ready_pending_c"
          ? "旧记录缺少当前C阶段完成证据；只保留为历史兼容状态，不恢复旧的人工启动门禁"
          : ""
  };
}

export function wbMarketEvidenceGate(assessment) {
  const market = assessment?.marketEvidence || {};
  const profit = assessment?.profitCalculation || {};
  const sharedChecks = [
    [market.sourceType === "real", "WB市场证据不是本轮真实查询"],
    [Boolean(market.searchUrl), "缺WB同款搜索链接"],
    [Boolean(market.checkedAt), "缺WB同款查询时间"]
  ];

  if (market.exactMatchStatus === "found") {
    const competitors = Array.isArray(market.competitors) ? market.competitors : [];
    const prices = competitors.map((item) => Number(item?.priceRub));
    const calculatedMedian = median(prices);
    const checks = [
      ...sharedChecks,
      [Number(market.exactMatchCount) > 0 && competitors.length > 0, "未保存WB同款竞品"],
      [
        competitors.every((item) => Boolean(item?.url) && Number(item?.priceRub) > 0),
        "WB同款竞品缺链接或买家可见价格"
      ],
      [
        Number.isFinite(calculatedMedian) && Math.abs(Number(market.medianPriceRub) - calculatedMedian) <= 1,
        "WB同款中位价与竞品价格不一致"
      ],
      [profit.priceBasis === "wb_exact_match_median", "WB利润没有按同款中位价计算"],
      [
        Number(profit.targetPriceRub) > 0 &&
          Math.abs(Number(profit.targetPriceRub) - Number(market.medianPriceRub)) <= 1,
        "WB利润售价不是同款竞品中位价"
      ]
    ];
    return {
      passed: checks.every(([passed]) => passed),
      branch: "exact_match_found",
      blockers: checks.filter(([passed]) => !passed).map(([, reason]) => reason)
    };
  }

  if (market.exactMatchStatus === "not_found") {
    const checks = [
      ...sharedChecks,
      [Number(market.exactMatchCount) === 0, "WB无同款结论没有明确记录0个同款"],
      [Boolean(market.searchQuery), "缺WB无同款查询词"],
      [profit.priceBasis === "wb_cost_based_suggested", "WB无同款时没有按完整成本给建议售价"],
      [Number(profit.recommendedPriceRub) > 0, "缺WB建议售价"],
      [
        Number(profit.targetPriceRub) > 0 &&
          Math.abs(Number(profit.targetPriceRub) - Number(profit.recommendedPriceRub)) <= 1,
        "WB利润复算售价与建议售价不一致"
      ],
      [Number(profit.targetPriceRmb) > 0, "缺WB建议售价对应的卖家收入"]
    ];
    return {
      passed: checks.every(([passed]) => passed),
      branch: "no_exact_match",
      blockers: checks.filter(([passed]) => !passed).map(([, reason]) => reason)
    };
  }

  return {
    passed: false,
    branch: "unverified",
    blockers: ["尚未真实确认WB有同款或无同款；网络、反爬、429不能当作无同款"]
  };
}

export function wbAssessmentGate(assessment, candidate, rules = DEFAULT_RULES) {
  const profit = assessment?.profitCalculation || {};
  const rule = rules.wbCrossListing;
  const electrical = electricalGate(candidate.powered, assessment?.electricalAssessment, "WB/CEL");
  const market = wbMarketEvidenceGate(assessment);
  const checks = [
    [electrical.passed, electrical.blocker],
    [candidate.complianceStatus === "clear", "WB合规资料不清楚"],
    [candidate.authorizationStatus === "clear", "WB授权状态不清楚"],
    [market.passed, market.blockers.join("；")],
    [assessment?.commission?.sourceType === "real", "WB佣金不是当前真实类目数据"],
    [assessment?.logistics?.sourceType === "real", "WB物流不是当前真实线路数据"],
    [
      profitThresholdPassed(profit, rule),
      "WB完整利润复算必须同时满足单件利润≥20元且利润率≥25%"
    ]
  ];
  return {
    passed: checks.every(([passed]) => passed),
    blockers: checks.filter(([passed]) => !passed).map(([, reason]) => reason)
  };
}

export function wbAssessmentDecisionGate(assessment, candidate, rules = DEFAULT_RULES) {
  if (assessment?.status === "suitable") return wbAssessmentGate(assessment, candidate, rules);
  if (assessment?.status !== "notSuitable") {
    return { passed: false, blockers: ["WB判断必须是suitable或notSuitable"] };
  }

  const market = wbMarketEvidenceGate(assessment);
  const profit = assessment?.profitCalculation || {};
  const rule = rules.wbCrossListing;
  const electrical = electricalGate(candidate.powered, assessment?.electricalAssessment, "WB/CEL");
  const checks = [
    [electrical.passed, electrical.blocker],
    [candidate.complianceStatus === "clear", "WB合规资料不清楚"],
    [candidate.authorizationStatus === "clear", "WB授权状态不清楚"],
    [market.passed, market.blockers.join("；")],
    [market.branch === "exact_match_found", "WB确认无同款时应默认可上架，不能判为不适合"],
    [assessment?.commission?.sourceType === "real", "WB佣金不是当前真实类目数据"],
    [assessment?.logistics?.sourceType === "real", "WB物流不是当前真实线路数据"],
    [profit.status === "verified" && profit.inputsComplete === true, "WB完整利润复算未完成"],
    [!profitThresholdPassed(profit, rule), "WB同款中位价下利润已通过，不得判为不适合"],
    [Boolean(assessment?.reason?.trim()), "WB不适合必须写明详细原因"]
  ];
  return {
    passed: checks.every(([passed]) => passed),
    blockers: checks.filter(([passed]) => !passed).map(([, reason]) => reason)
  };
}

export function electricalGate(powered, assessment, scope = "平台/线路") {
  if (powered === false) return { passed: true, blocker: "" };
  if (powered !== true) {
    return { passed: false, blocker: "是否带电尚未确认" };
  }
  const passed =
    assessment?.status === "verified_allowed" &&
    assessment?.sourceType === "real" &&
    assessment?.platformAllowed === true &&
    assessment?.logisticsAllowed === true &&
    Boolean(assessment?.platformSourceUrl) &&
    Boolean(assessment?.logisticsSource) &&
    Boolean(assessment?.checkedAt);
  return {
    passed,
    blocker: passed ? "" : `带电商品尚未完成当前${scope}允许性核验`
  };
}

export function dailySummary(candidates, rules = DEFAULT_RULES, date = businessDate()) {
  const targets = rules.dailyTargets;
  const queueCounts = Object.fromEntries(WORKFLOW_STATUSES.map((status) => [status, 0]));
  for (const candidate of candidates) {
    if (queueCounts[candidate.workflowStatus] !== undefined) queueCounts[candidate.workflowStatus] += 1;
  }
  const stores = {};
  for (const store of ["dandanshu", "miska", "wb"]) {
    const target = Number(targets[store] || 10);
    const ready = candidates.filter(
      (candidate) =>
        candidate.targetStore === store &&
        ["ready_to_list", "listed"].includes(candidate.workflowStatus) &&
        candidate.readyAt &&
        businessDate(candidate.readyAt) === date
    ).length;
    const activePotential = candidates.filter(
      (candidate) =>
        candidate.targetStore === store &&
        ["awaiting_user_direction", "codex_processing", "listing_preparation"].includes(candidate.workflowStatus)
    ).length;
    const codexAddedToday = candidates.filter(
      (candidate) =>
        candidate.targetStore === store &&
        candidate.source === "codex" &&
        candidate.selectionDate === date
    ).length;
    const userSubmittedToday = candidates.filter(
      (candidate) =>
        candidate.targetStore === store &&
        candidate.source === "user" &&
        candidate.selectionDate === date
    ).length;
    const totalSelectedToday = userSubmittedToday + codexAddedToday;
    const deficit = Math.max(0, target - ready);
    const directionRule = rules.selectionDirections?.[store] || {};
    const automaticAdditionEnabled = directionRule.automaticAdditionEnabled !== false;
    stores[store] = {
      target,
      ready,
      deficit,
      activePotential,
      userSubmittedToday,
      codexAddedToday,
      totalSelectedToday,
      remainingCodexAdditionCapacity: Math.max(
        0,
        Number(targets.maximumCodexAdditionsPerStore || 30) - codexAddedToday
      ),
      suggestedNewCandidates: automaticAdditionEnabled
        ? Math.max(0, target - totalSelectedToday)
        : 0,
      automaticAdditionEnabled,
      automaticAdditionPauseReason: automaticAdditionEnabled
        ? ""
        : String(directionRule.pauseReason || "该店铺已暂停自动新增候选"),
      userSampleReviewThreshold: Number(directionRule.userSampleReviewThreshold || 0)
    };
  }
  const bPassed = candidates.filter((candidate) => {
    const at = candidate.bPassedAt || candidate.reviewedAt;
    return at && businessDate(at) === date && ["listing_preparation", "ready_to_list", "listed"].includes(candidate.workflowStatus);
  });
  const cCompleted = candidates.filter((candidate) => {
    const at = candidate.cCompletedAt || candidate.readyAt;
    return at && businessDate(at) === date && ["ready_to_list", "listed"].includes(candidate.workflowStatus);
  });
  const estimated = bPassed.filter((candidate) => candidate.codexReview?.commission?.sourceType === "estimated").length;
  const target = Number(targets.combinedProfitPassed || 10);
  return {
    businessDate: date,
    queueCounts,
    stores,
    combined: {
      target,
      profitPassed: bPassed.length,
      exactProfitPassed: bPassed.length - estimated,
      estimatedProfitPassed: estimated,
      cCompleted: cCompleted.length,
      readyToList: candidates.filter((candidate) =>
        candidate.workflowStatus === "ready_to_list" &&
        candidate.listingPreparation?.status === "prepared" &&
        Boolean(candidate.cCompletedAt)
      ).length,
      legacyReadyPendingC: candidates.filter((candidate) =>
        candidate.workflowStatus === "ready_to_list" &&
        !(candidate.listingPreparation?.status === "prepared" && candidate.cCompletedAt)
      ).length,
      remaining: Math.max(0, target - bPassed.length)
    }
  };
}

export function recentAvoidanceFeedback(candidates, limit = 30) {
  const feedback = [];
  for (const candidate of candidates) {
    if (candidate.userEvaluation?.decision === "reject" && candidate.userEvaluation.reason?.trim()) {
      feedback.push({
        candidateId: candidate.id,
        productName: candidate.productName,
        targetStore: candidate.targetStore,
        group: candidate.group,
        message: candidate.userEvaluation.reason.trim(),
        source: "user_rejection",
        at: candidate.userEvaluation.at || candidate.updatedAt
      });
    }
    for (const comment of candidate.comments || []) {
      if (
        comment.actor === "user" &&
        comment.category === "elimination_feedback" &&
        comment.message?.trim()
      ) {
        feedback.push({
          candidateId: candidate.id,
          productName: candidate.productName,
          targetStore: candidate.targetStore,
          group: candidate.group,
          message: comment.message.trim(),
          source: "elimination_feedback",
          at: comment.at
        });
      }
    }
  }
  return feedback
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, Math.max(0, limit));
}

export function recoverStaleProcessing(candidates, at = new Date(), timeoutMinutes = NO_PROGRESS_TIMEOUT_MINUTES) {
  return stopNoProgressRuns(candidates, at, timeoutMinutes).map((alert) => alert.candidateId);
}

export function isBlank(value) {
  return value === null || value === undefined || value === "";
}
