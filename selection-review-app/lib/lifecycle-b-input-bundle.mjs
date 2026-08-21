import { validateSalesSnapshot } from "./sales-snapshot.mjs";

export const LIFECYCLE_B_INPUT_BUNDLE_VERSION = "lifecycle-b-input-bundle-v1.1";

const REQUIRED_KINDS = Object.freeze([
  "commission",
  "logistics_tariff",
  "exchange_rate",
  "schema"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown";
}

function finite(value) {
  return Number.isFinite(value);
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function latestCategorySnapshot(candidate) {
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .filter((snapshot) => validateSalesSnapshot(snapshot).valid)
    .filter((snapshot) => snapshot.collectorMode === "real_page_read_only")
    .filter((snapshot) => nonEmptyString(snapshot?.categoryPath))
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0] || null;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundWeight(value) {
  return Number(value.toFixed(6));
}

function ceilToStep(value, step) {
  return roundWeight(Math.ceil((value - Number.EPSILON) / step) * step);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function error(path, message) {
  return { path, message };
}

function validateNonNegative(data, fields, errors) {
  for (const field of fields) {
    if (!finite(data[field]) || data[field] < 0) errors.push(error(field, "必须是非负数字"));
  }
}

function validateRate(data, field, errors) {
  if (!finite(data[field]) || data[field] < 0 || data[field] >= 1) {
    errors.push(error(field, "必须是0到1之间的数字"));
  }
}

export function validateLifecycleEvidenceData(kind, evidenceData) {
  const errors = [];
  if (!isObject(evidenceData)) {
    return { valid: false, errors: [error("evidenceData", "必须是结构化对象")] };
  }
  if (kind === "commission") {
    if (!finite(evidenceData.commissionRate) || evidenceData.commissionRate < 0 || evidenceData.commissionRate >= 1) {
      errors.push(error("commissionRate", "必须是0到1之间的数字"));
    }
    if (!isObject(evidenceData.otherCosts)) {
      errors.push(error("otherCosts", "必须明确列出其他成本"));
    } else {
      validateNonNegative(evidenceData.otherCosts, [
        "packagingRmb",
        "labelRmb",
        "fixedOtherRmb",
        "minimumUnitProfitRmb"
      ], errors);
      for (const field of ["advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "targetMarginRate"]) {
        validateRate(evidenceData.otherCosts, field, errors);
      }
      if (!finite(evidenceData.otherCosts.priceIncrementCny) || evidenceData.otherCosts.priceIncrementCny <= 0) {
        errors.push(error("priceIncrementCny", "必须是大于0的数字"));
      }
      if (evidenceData.otherCosts.thresholdLogic !== "any") errors.push(error("thresholdLogic", "当前项目必须使用any"));
      if (!nonEmptyString(evidenceData.otherCosts.pricingPolicyVersion)) errors.push(error("pricingPolicyVersion", "必须保存定价政策版本"));
    }
  } else if (kind === "exchange_rate") {
    if (!finite(evidenceData.rubPerCny) || evidenceData.rubPerCny <= 0) {
      errors.push(error("rubPerCny", "必须是大于0的数字"));
    }
  } else if (kind === "schema") {
    if (!nonEmptyString(evidenceData.schemaRevision)) errors.push(error("schemaRevision", "必须是已确认版本"));
    if (!Array.isArray(evidenceData.requiredFields)) {
      errors.push(error("requiredFields", "必须是数组"));
    } else {
      const seen = new Set();
      evidenceData.requiredFields.forEach((field, index) => {
        if (!isObject(field)) {
          errors.push(error(`requiredFields[${index}]`, "必须是对象"));
          return;
        }
        if (!nonEmptyString(field.fieldKey)) errors.push(error(`requiredFields[${index}].fieldKey`, "必须是非空字符串"));
        if (!nonEmptyString(field.label)) errors.push(error(`requiredFields[${index}].label`, "必须是非空字符串"));
        if (field.required !== true) errors.push(error(`requiredFields[${index}].required`, "这里只保存平台必填字段"));
        if (field.sourceAttributeKeys !== undefined && (
          !Array.isArray(field.sourceAttributeKeys) || field.sourceAttributeKeys.some((key) => !nonEmptyString(key))
        )) errors.push(error(`requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组"));
        if (seen.has(field.fieldKey)) errors.push(error(`requiredFields[${index}].fieldKey`, "字段不得重复"));
        seen.add(field.fieldKey);
      });
    }
  } else if (kind === "logistics_tariff") {
    if (!["actual_weight", "max_actual_volume"].includes(evidenceData.chargeableWeightRule)) {
      errors.push(error("chargeableWeightRule", "必须明确为actual_weight或max_actual_volume"));
    }
    validateNonNegative(evidenceData, ["perKgRmb", "perParcelRmb", "minimumChargeableWeightKg"], errors);
    const roundingRule = evidenceData.weightRoundingRule ||
      (finite(evidenceData.weightRoundingKg) && evidenceData.weightRoundingKg > 0 ? "step" : null);
    if (roundingRule === "none") {
      if (evidenceData.weightRoundingKg !== null) errors.push(error("weightRoundingKg", "不取整时必须为null"));
    } else if (roundingRule === "step") {
      if (!finite(evidenceData.weightRoundingKg) || evidenceData.weightRoundingKg <= 0) {
        errors.push(error("weightRoundingKg", "按步长取整时必须是大于0的数字"));
      }
    } else {
      errors.push(error("weightRoundingRule", "必须明确为none或step"));
    }
    if (evidenceData.chargeableWeightRule === "max_actual_volume" &&
        (!finite(evidenceData.volumeDivisorCm3PerKg) || evidenceData.volumeDivisorCm3PerKg <= 0)) {
      errors.push(error("volumeDivisorCm3PerKg", "体积重规则必须明确大于0的除数"));
    }
  } else {
    errors.push(error("kind", "该类型不属于B阶段系统证据"));
  }
  return { valid: errors.length === 0, errors };
}

export function resolveLifecycleEvidenceContext(candidate) {
  if (!isObject(candidate)) {
    return deepFreeze({ ready: false, values: null, fields: [], missing: ["候选商品身份"] });
  }
  const context = isObject(candidate?.lifecycleEvidenceContextV11)
    ? candidate.lifecycleEvidenceContextV11
    : {};
  const platform = candidate.targetStore === "wb" ? "wb" : "ozon";
  const explicitPlatform = nonEmptyString(context.platform) ? normalizedText(context.platform) : null;
  const explicitStore = nonEmptyString(context.store) ? normalizedText(context.store) : null;
  const targetStore = nonEmptyString(candidate.targetStore) ? normalizedText(candidate.targetStore) : null;
  const snapshot = latestCategorySnapshot(candidate);
  const explicitCategory = nonEmptyString(context.category) ? context.category : null;
  const definitions = [
    ["platform", "目标平台", platform, "candidate_target"],
    ["store", "目标店铺", candidate.targetStore, "candidate_target"],
    ["category", "当前类目", explicitCategory || snapshot?.categoryPath, explicitCategory ? "explicit_context" : snapshot ? `sales_snapshot:${snapshot.snapshotId}` : "missing"],
    ["salesScheme", "销售模式", context.salesScheme, nonEmptyString(context.salesScheme) ? "explicit_context" : "missing"],
    ["route", "物流线路", context.route, nonEmptyString(context.route) ? "explicit_context" : "missing"],
    ["logisticsRuleVersion", "物流资费版本", context.logisticsRuleVersion, nonEmptyString(context.logisticsRuleVersion) ? "explicit_context" : "missing"],
    ["exchangePair", "汇率币种对", context.exchangePair, nonEmptyString(context.exchangePair) ? "explicit_context" : "missing"],
    ["schemaRuleVersion", "Schema版本", context.schemaRuleVersion, nonEmptyString(context.schemaRuleVersion) ? "explicit_context" : "missing"]
  ];
  const fields = definitions.map(([key, label, value, source]) => ({
    key,
    label,
    value: nonEmptyString(value) ? String(value).trim() : null,
    normalizedValue: nonEmptyString(value) ? normalizedText(value) : null,
    source,
    status: nonEmptyString(value) ? "available" : "missing"
  }));
  const conflicts = new Set();
  if (explicitPlatform && explicitPlatform !== platform) conflicts.add("platform");
  if (explicitStore && explicitStore !== targetStore) conflicts.add("store");
  if (conflicts.size) {
    const conflictFields = fields.map((field) => conflicts.has(field.key)
      ? { ...field, status: "conflict", source: "explicit_context_conflict" }
      : field);
    return deepFreeze({
      ready: false,
      values: null,
      fields: conflictFields,
      missing: [...conflicts].map((key) => key === "platform" ? "目标平台适用范围冲突" : "目标店铺适用范围冲突")
    });
  }
  const values = Object.fromEntries(fields.map((field) => [field.key, field.normalizedValue]));
  const missing = fields.filter((field) => field.status === "missing").map((field) => field.label);
  return deepFreeze({
    ready: missing.length === 0,
    values: missing.length === 0 ? values : null,
    fields,
    missing
  });
}

function candidateContext(candidate) {
  const resolved = resolveLifecycleEvidenceContext(candidate);
  return resolved.ready ? resolved.values : null;
}

function packTraceable(pack) {
  return nonEmptyString(pack?.id) &&
    nonEmptyString(pack?.sourceType) &&
    nonEmptyString(pack?.sourceRef) &&
    isoDateTime(pack?.checkedAt) &&
    isoDateTime(pack?.expiresAt) &&
    Date.parse(pack.expiresAt) > Date.parse(pack.checkedAt);
}

function packCurrent(pack, asOfMs) {
  return pack.status === "active" &&
    packTraceable(pack) &&
    Date.parse(pack.checkedAt) <= asOfMs &&
    Date.parse(pack.expiresAt) > asOfMs;
}

function expectedScope(kind, context) {
  if (kind === "commission") return {
    platform: context.platform,
    store: context.store,
    category: context.category,
    salesScheme: context.salesScheme
  };
  if (kind === "logistics_tariff") return {
    route: context.route,
    ruleVersion: context.logisticsRuleVersion
  };
  if (kind === "exchange_rate") return { pair: context.exchangePair };
  if (kind === "schema") return {
    platform: context.platform,
    store: context.store,
    category: context.category,
    ruleVersion: context.schemaRuleVersion
  };
  return {};
}

function exactScope(pack, expected) {
  const scope = pack.scope || {};
  return Object.entries(expected).every(([key, value]) => normalizedText(scope[key]) === normalizedText(value));
}

function eligiblePack(pack, kind, context, asOfMs) {
  if (pack?.kind !== kind || !packCurrent(pack, asOfMs)) return false;
  if (!validateLifecycleEvidenceData(kind, pack.evidenceData).valid) return false;
  return exactScope(pack, expectedScope(kind, context));
}

function latestPack(packs, kind, context, asOfMs) {
  return packs
    .filter((pack) => eligiblePack(pack, kind, context, asOfMs))
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))[0] || null;
}

export function inspectLifecycleBInputReadiness({ candidate, evidencePacks = [], asOf }) {
  const checkedAt = isoDateTime(asOf) ? asOf : new Date().toISOString();
  const contextResolution = resolveLifecycleEvidenceContext(candidate);
  const context = contextResolution.ready ? contextResolution.values : null;
  const labels = {
    commission: "当前平台佣金与其他成本证据",
    logistics_tariff: "当前国际物流资费规则",
    exchange_rate: "当前汇率证据",
    schema: "当前平台Schema证据"
  };
  if (!context) {
    return deepFreeze({
      ready: false,
      contextReady: false,
      context: contextResolution,
      fields: REQUIRED_KINDS.map((kind) => ({
        key: kind,
        label: labels[kind],
        available: false,
        status: "waiting_context",
        evidencePackId: null,
        checkedAt: null,
        expiresAt: null,
        message: "先补齐上方证据适用范围"
      })),
      missing: contextResolution.missing.map((label) => `适用范围：${label}`),
      ownerMustProvide: false,
      checkedAt
    });
  }
  const fields = REQUIRED_KINDS.map((kind) => {
    const pack = latestPack(evidencePacks, kind, context, Date.parse(checkedAt));
    if (pack) return {
      key: kind,
      label: labels[kind],
      available: true,
      status: "current",
      evidencePackId: pack.id,
      checkedAt: pack.checkedAt,
      expiresAt: pack.expiresAt,
      sourceType: pack.sourceType,
      sourceRef: pack.sourceRef,
      scope: structuredClone(pack.scope),
      message: "当前适用证据已匹配"
    };
    const sameKind = evidencePacks
      .filter((item) => item?.kind === kind && item.status === "active")
      .sort((left, right) => Date.parse(right.checkedAt || 0) - Date.parse(left.checkedAt || 0));
    const exact = sameKind.find((item) => exactScope(item, expectedScope(kind, context)));
    let status = "missing";
    let message = "没有找到该类证据";
    if (exact && !isObject(exact.evidenceData)) {
      status = "metadata_only";
      message = "只有摘要，没有可计算的结构化数据";
    } else if (exact && !packTraceable(exact)) {
      status = "invalid";
      message = "证据来源或有效期不完整";
    } else if (exact && Date.parse(exact.expiresAt) <= Date.parse(checkedAt)) {
      status = "expired";
      message = "同范围证据已过期，需要系统刷新";
    } else if (exact && !validateLifecycleEvidenceData(kind, exact.evidenceData).valid) {
      status = "invalid";
      message = "结构化证据字段不完整或无效";
    } else if (sameKind.length) {
      status = "scope_mismatch";
      message = "存在同类证据，但平台、店铺、类目、模式、线路或版本不匹配";
    }
    return {
      key: kind,
      label: labels[kind],
      available: false,
      status,
      evidencePackId: exact?.id || null,
      checkedAt: exact?.checkedAt || null,
      expiresAt: exact?.expiresAt || null,
      scope: exact?.scope ? structuredClone(exact.scope) : null,
      message
    };
  });
  return deepFreeze({
    ready: fields.every((field) => field.available),
    contextReady: true,
    context: contextResolution,
    fields,
    missing: fields.filter((field) => !field.available).map((field) => field.label),
    ownerMustProvide: false,
    checkedAt
  });
}

function requirePackaging(normalizedSubmission) {
  const supplier = normalizedSubmission?.supplierConfirmation;
  const dimensions = supplier?.dimensionsCm;
  if (!isObject(supplier) || !finite(supplier.weightKg) || supplier.weightKg <= 0 ||
      !isObject(dimensions) || [dimensions.length, dimensions.width, dimensions.height].some((value) => !finite(value) || value <= 0)) {
    throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 缺少已确认的重量或尺寸，不能计算国际运费");
  }
  return {
    weightKg: supplier.weightKg,
    dimensionsCm: {
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height
    }
  };
}

function calculateFreight(pack, packaging) {
  const tariff = pack.evidenceData;
  const volumeWeightKg = tariff.chargeableWeightRule === "max_actual_volume"
    ? roundWeight(
      packaging.dimensionsCm.length * packaging.dimensionsCm.width * packaging.dimensionsCm.height /
      tariff.volumeDivisorCm3PerKg
    )
    : null;
  const baseWeight = tariff.chargeableWeightRule === "max_actual_volume"
    ? Math.max(packaging.weightKg, volumeWeightKg, tariff.minimumChargeableWeightKg)
    : Math.max(packaging.weightKg, tariff.minimumChargeableWeightKg);
  const chargeableWeightKg = tariff.weightRoundingRule === "none"
    ? roundWeight(baseWeight)
    : ceilToStep(baseWeight, tariff.weightRoundingKg);
  return {
    evidenceId: pack.id,
    route: pack.scope.route,
    ruleVersion: pack.scope.ruleVersion,
    actualWeightKg: packaging.weightKg,
    volumeWeightKg,
    chargeableWeightKg,
    amountRmb: roundMoney(chargeableWeightKg * tariff.perKgRmb + tariff.perParcelRmb),
    formula: "chargeableWeightKg × perKgRmb + perParcelRmb",
    tariff: structuredClone(tariff)
  };
}

export function createLifecycleBInputBundle({ candidate, evidencePacks = [], normalizedSubmission, createdAt }) {
  if (!isObject(candidate) || !candidate.id || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 候选身份或修订号无效");
  }
  if (!isoDateTime(createdAt)) throw new Error("REAL_A_SYSTEM_EVIDENCE_GAP: 证据冻结时间无效");
  const readiness = inspectLifecycleBInputReadiness({ candidate, evidencePacks, asOf: createdAt });
  if (!readiness.ready) throw new Error(`REAL_A_SYSTEM_EVIDENCE_GAP: ${readiness.missing.join("、")}`);
  const context = candidateContext(candidate);
  const packs = Object.fromEntries(REQUIRED_KINDS.map((kind) => [
    kind,
    latestPack(evidencePacks, kind, context, Date.parse(createdAt))
  ]));
  const packaging = requirePackaging(normalizedSubmission);
  const bundle = {
    bundleVersion: LIFECYCLE_B_INPUT_BUNDLE_VERSION,
    bundleId: `b-input-bundle:${candidate.id}:${candidate.dataRevision}`,
    sourceCandidateId: candidate.id,
    sourceCandidateRevision: candidate.dataRevision,
    createdAt,
    context: structuredClone(context),
    packagingSnapshot: packaging,
    sourcePackIds: REQUIRED_KINDS.map((kind) => packs[kind].id),
    platformFeeEvidence: {
      evidenceId: packs.commission.id,
      commissionRate: packs.commission.evidenceData.commissionRate,
      commissionEvidenceMode: packs.commission.evidenceData.commissionEvidenceMode || "exact",
      estimateAuthorized: packs.commission.evidenceData.estimateAuthorized === true,
      exactCommissionRequiredAtC: packs.commission.evidenceData.exactCommissionRequiredAtC === true,
      otherCosts: structuredClone(packs.commission.evidenceData.otherCosts)
    },
    logisticsEvidence: calculateFreight(packs.logistics_tariff, packaging),
    exchangeRateEvidence: {
      evidenceId: packs.exchange_rate.id,
      rubPerCny: packs.exchange_rate.evidenceData.rubPerCny
    },
    platformSchemaEvidence: {
      evidenceId: packs.schema.id,
      platform: context.platform,
      store: context.store,
      schemaRevision: packs.schema.evidenceData.schemaRevision,
      collectedAt: packs.schema.checkedAt,
      requiredFields: structuredClone(packs.schema.evidenceData.requiredFields)
    },
    browserSupplied: false,
    externalAccesses: []
  };
  assertValidLifecycleBInputBundle(bundle, { candidate, normalizedSubmission });
  return deepFreeze(bundle);
}

export function validateLifecycleBInputBundle(bundle, { candidate, normalizedSubmission } = {}) {
  const errors = [];
  if (!isObject(bundle)) return { valid: false, errors: [error("$", "必须是对象")] };
  if (bundle.bundleVersion !== LIFECYCLE_B_INPUT_BUNDLE_VERSION) errors.push(error("bundleVersion", "版本不正确"));
  if (!nonEmptyString(bundle.bundleId)) errors.push(error("bundleId", "必须存在"));
  if (!isoDateTime(bundle.createdAt)) errors.push(error("createdAt", "必须是有效时间"));
  if (!Array.isArray(bundle.sourcePackIds) || bundle.sourcePackIds.length !== 4 || new Set(bundle.sourcePackIds).size !== 4) {
    errors.push(error("sourcePackIds", "必须唯一引用四类证据包"));
  }
  if (bundle.browserSupplied !== false) errors.push(error("browserSupplied", "系统证据不得来自浏览器提交"));
  if (!Array.isArray(bundle.externalAccesses) || bundle.externalAccesses.length !== 0) errors.push(error("externalAccesses", "B冻结阶段不得访问外部平台"));
  for (const field of ["platformFeeEvidence", "logisticsEvidence", "exchangeRateEvidence", "platformSchemaEvidence", "packagingSnapshot", "context"]) {
    if (!isObject(bundle[field])) errors.push(error(field, "必须是对象"));
  }
  if (candidate) {
    if (bundle.sourceCandidateId !== candidate.id) errors.push(error("sourceCandidateId", "候选不一致"));
    if (bundle.sourceCandidateRevision !== candidate.dataRevision) errors.push(error("sourceCandidateRevision", "候选修订号不一致"));
  }
  if (normalizedSubmission && isObject(bundle.packagingSnapshot)) {
    const expected = requirePackaging(normalizedSubmission);
    if (JSON.stringify(bundle.packagingSnapshot) !== JSON.stringify(expected)) errors.push(error("packagingSnapshot", "重量尺寸与主人确认值不一致"));
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidLifecycleBInputBundle(bundle, context) {
  const result = validateLifecycleBInputBundle(bundle, context);
  if (!result.valid) {
    throw new Error(`REAL_A_SYSTEM_EVIDENCE_GAP: ${result.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
  }
  return bundle;
}
