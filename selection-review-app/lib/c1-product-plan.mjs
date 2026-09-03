import {
  assertValidLifecyclePackage,
  validateLifecycleTransition,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { assertValidProfitModel } from "./profit-model.mjs";

export const C1_PRODUCT_PLAN_SCHEMA_VERSION = "c1-product-plan-v1.1";
export const C1_FACT_VERIFICATION_VERSION = "c1-fact-verification-v1.1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validatePlatformSchemaEvidence(evidence) {
  const errors = [];
  if (!isObject(evidence)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  for (const field of ["evidenceId", "platform", "store", "schemaRevision"]) {
    if (!nonEmptyString(evidence[field]) || evidence[field] === "unknown") {
      push(errors, field, "必须是已确认的非空字符串");
    }
  }
  if (!isoDateTime(evidence.collectedAt)) push(errors, "collectedAt", "必须是有效时间");
  if (!Array.isArray(evidence.requiredFields)) {
    push(errors, "requiredFields", "必须是数组");
  } else {
    const seen = new Set();
    evidence.requiredFields.forEach((field, index) => {
      if (!isObject(field)) {
        push(errors, `requiredFields[${index}]`, "必须是对象");
        return;
      }
      if (!nonEmptyString(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "必须是非空字符串");
      if (!nonEmptyString(field.label)) push(errors, `requiredFields[${index}].label`, "必须是非空字符串");
      if (field.required !== true) push(errors, `requiredFields[${index}].required`, "这里只保存平台必填字段");
      if (field.sourceAttributeKeys !== undefined && (
        !Array.isArray(field.sourceAttributeKeys) ||
        field.sourceAttributeKeys.some((key) => !nonEmptyString(key))
      )) push(errors, `requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组");
      if (seen.has(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "字段不得重复");
      seen.add(field.fieldKey);
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateC1ProductPlan(plan) {
  const errors = [];
  if (!isObject(plan)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (plan.schemaVersion !== C1_PRODUCT_PLAN_SCHEMA_VERSION) push(errors, "schemaVersion", `必须是${C1_PRODUCT_PLAN_SCHEMA_VERSION}`);
  if (!nonEmptyString(plan.c1PlanId)) push(errors, "c1PlanId", "必须是非空字符串");
  if (!["inputs_ready", "facts_checked", "seo_draft_ready"].includes(plan.status)) {
    push(errors, "status", "必须是inputs_ready、facts_checked或seo_draft_ready");
  }
  if (!isoDateTime(plan.createdAt)) push(errors, "createdAt", "必须是有效时间");

  for (const section of ["inputRefs", "identity", "inputSnapshots"]) {
    if (!isObject(plan[section])) push(errors, section, "必须是对象");
  }
  if (isObject(plan.inputRefs)) {
    for (const field of ["salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"]) {
      if (!nonEmptyString(plan.inputRefs[field])) push(errors, `inputRefs.${field}`, "必须是非空字符串");
    }
  }
  if (isObject(plan.identity)) {
    for (const field of ["parentOpportunityId", "skuPackageId", "supplierOptionId", "supplierSkuId", "variantKey", "targetPlatform", "targetStore"]) {
      if (!nonEmptyString(plan.identity[field])) push(errors, `identity.${field}`, "必须是非空字符串");
    }
  }
  if (isObject(plan.inputSnapshots)) {
    for (const field of ["salesSnapshot", "confirmedSupplierSkuSnapshot", "profitModel", "platformSchemaRules"]) {
      if (!isObject(plan.inputSnapshots[field])) push(errors, `inputSnapshots.${field}`, "必须是对象");
    }
    if (isObject(plan.inputSnapshots.platformSchemaRules)) {
      const schemaValidation = validatePlatformSchemaEvidence(plan.inputSnapshots.platformSchemaRules);
      for (const error of schemaValidation.errors) push(errors, `inputSnapshots.platformSchemaRules.${error.path}`, error.message);
    }
  }
  if (!Array.isArray(plan.externalAccesses) || plan.externalAccesses.length !== 0) {
    push(errors, "externalAccesses", "C1数据进入不得访问Ozon、WB或1688");
  }
  if (plan.profitRecalculated !== false) push(errors, "profitRecalculated", "C1不得重新计算利润");
  if (plan.skuReplaced !== false) push(errors, "skuReplaced", "C1不得替换SKU");
  for (const field of ["finalSeo", "finalAttributes", "complianceDecision", "generatedAssets", "productionPayload"]) {
    if (plan[field] !== null) push(errors, field, "C1事实核验阶段必须保持null");
  }
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) {
    if (!isObject(plan[field]) && plan[field] !== null) push(errors, field, "必须是对象或null");
  }
  if (plan.status === "inputs_ready") {
    for (const field of [
      "exactSkuVerification",
      "productAttributes",
      "platformCategory",
      "schemaSnapshot",
      "batteryAssessment",
      "categoryRestrictions",
      "platformCompliance"
    ]) if (plan[field] !== null) push(errors, field, "输入就绪阶段必须保持null");
  }
  if (["facts_checked", "seo_draft_ready"].includes(plan.status)) {
    if (plan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION) {
      push(errors, "factVerificationVersion", `必须是${C1_FACT_VERIFICATION_VERSION}`);
    }
    if (!isoDateTime(plan.factsVerifiedAt)) push(errors, "factsVerifiedAt", "必须是有效时间");
    for (const field of [
      "exactSkuVerification",
      "productAttributes",
      "platformCategory",
      "schemaSnapshot",
      "batteryAssessment",
      "categoryRestrictions",
      "platformCompliance"
    ]) if (!isObject(plan[field])) push(errors, field, "事实核验完成后必须存在");
  }
  for (const field of ["seoTitleDraft", "descriptionDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
    if (!isObject(plan[field]) && plan[field] !== null) push(errors, field, "必须是对象或null");
  }
  if (!Array.isArray(plan.bulletPointsDraft) && plan.bulletPointsDraft !== null) {
    push(errors, "bulletPointsDraft", "必须是数组或null");
  }
  if (plan.status !== "seo_draft_ready") {
    for (const field of ["seoTitleDraft", "descriptionDraft", "bulletPointsDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
      if (plan[field] !== null) push(errors, field, "SEO草稿生成前必须保持null");
    }
  }
  if (plan.status === "seo_draft_ready") {
    for (const field of ["seoTitleDraft", "descriptionDraft", "searchKeywordsDraft", "seoEvidenceLayer"]) {
      if (!isObject(plan[field])) push(errors, field, "SEO草稿完成后必须存在");
    }
    if (!Array.isArray(plan.bulletPointsDraft)) push(errors, "bulletPointsDraft", "SEO草稿完成后必须存在");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidC1ProductPlan(plan) {
  const result = validateC1ProductPlan(plan);
  if (!result.valid) {
    throw new Error(`C1ProductPlan校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }
  return plan;
}

/**
 * 第8阶段只把四类已冻结上游输入装入C1，不联网、不算利润、不生成内容或素材。
 */
export function createC1ProductPlan({
  opportunityPackage,
  skuPackage,
  platformSchemaEvidence,
  createdAt
}) {
  if (!validateOpportunityPackage(opportunityPackage).valid) throw new Error("C1_INPUT_GAP: OpportunityPackage校验失败");
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "B") throw new Error("C1_GATE_REJECTED: 当前SKU不在B阶段");
  if (skuPackage.businessResult !== "passed" || skuPackage.technicalStatus !== "completed") {
    throw new Error("C1_GATE_REJECTED: B阶段未通过或未完成");
  }
  if (skuPackage.c1ProductPlan !== null) throw new Error("C1_GATE_REJECTED: C1ProductPlan已经存在");
  if (skuPackage.parentOpportunityId !== opportunityPackage.parentOpportunityId) {
    throw new Error("C1_INPUT_GAP: SKU与OpportunityPackage不属于同一商品方向");
  }
  if (skuPackage.targetPlatform !== opportunityPackage.targetPlatform || skuPackage.targetStore !== opportunityPackage.targetStore) {
    throw new Error("C1_INPUT_GAP: SKU目标平台或店铺与A阶段不一致");
  }
  if (!isoDateTime(createdAt)) throw new Error("C1_INPUT_GAP: 创建时间无效");

  const activeProfitModel = skuPackage.profitModels.find(
    (model) => model.profitModelVersion === skuPackage.activeProfitModelVersion
  );
  if (!activeProfitModel) throw new Error("C1_GATE_REJECTED: 缺少当前B利润模型");
  assertValidProfitModel(activeProfitModel);
  if (activeProfitModel.result !== "passed") {
    throw new Error("C1_GATE_REJECTED: 单件利润20元或利润率15%均未通过");
  }

  const [salesSnapshotId, selectedSupplySnapshotId] = activeProfitModel.inputSnapshotRefs;
  const salesSnapshot = opportunityPackage.salesSnapshots.find((item) => item.snapshotId === salesSnapshotId);
  if (!salesSnapshot || !skuPackage.inheritedSalesSnapshotRefs.includes(salesSnapshotId)) {
    throw new Error("C1_INPUT_GAP: 未找到B阶段实际使用且由A继承的销售快照");
  }
  const selectedSupplySnapshot = skuPackage.selectedSupplySnapshot;
  if (selectedSupplySnapshot?.snapshotId !== selectedSupplySnapshotId) {
    throw new Error("C1_INPUT_GAP: 当前供应快照与B利润模型引用不一致");
  }
  if (selectedSupplySnapshot.ownerSupplyConfirmation?.status !== "confirmed") {
    throw new Error("C1_INPUT_GAP: 供应方案未获主人确认");
  }
  const supplierSku = selectedSupplySnapshot.supplierSku;
  if (
    !isObject(supplierSku) ||
    supplierSku.supplierSkuId !== skuPackage.supplierSkuId ||
    supplierSku.variantKey !== skuPackage.variantKey
  ) {
    throw new Error("C1_INPUT_GAP: 已确认供应SKU身份不一致");
  }

  const schemaValidation = validatePlatformSchemaEvidence(platformSchemaEvidence);
  if (!schemaValidation.valid) throw new Error("C1_INPUT_GAP: 平台Schema证据校验失败");
  if (platformSchemaEvidence.platform !== skuPackage.targetPlatform || platformSchemaEvidence.store !== skuPackage.targetStore) {
    throw new Error("C1_INPUT_GAP: 平台Schema不适用于当前平台或店铺");
  }

  const plan = {
    schemaVersion: C1_PRODUCT_PLAN_SCHEMA_VERSION,
    c1PlanId: `c1:${skuPackage.skuPackageId}:${skuPackage.activeProfitModelVersion}`,
    status: "inputs_ready",
    createdAt,
    inputRefs: {
      salesSnapshotId,
      selectedSupplySnapshotId,
      profitModelVersion: activeProfitModel.profitModelVersion,
      platformSchemaEvidenceId: platformSchemaEvidence.evidenceId
    },
    identity: {
      parentOpportunityId: skuPackage.parentOpportunityId,
      skuPackageId: skuPackage.skuPackageId,
      supplierOptionId: skuPackage.supplierOptionId,
      supplierSkuId: skuPackage.supplierSkuId,
      variantKey: skuPackage.variantKey,
      targetPlatform: skuPackage.targetPlatform,
      targetStore: skuPackage.targetStore
    },
    inputSnapshots: {
      salesSnapshot: structuredClone(salesSnapshot),
      confirmedSupplierSkuSnapshot: {
        snapshotId: selectedSupplySnapshot.snapshotId,
        ownerSupplyConfirmation: structuredClone(selectedSupplySnapshot.ownerSupplyConfirmation),
        supplierOptionIdentity: {
          supplierOptionId: selectedSupplySnapshot.supplierOption?.supplierOptionId,
          sourcePlatform: selectedSupplySnapshot.supplierOption?.sourcePlatform,
          productUrl: selectedSupplySnapshot.supplierOption?.productUrl,
          offerId: selectedSupplySnapshot.supplierOption?.offerId,
          evidenceRef: selectedSupplySnapshot.supplierOption?.evidenceRef
        },
        supplierSku: structuredClone(supplierSku)
      },
      profitModel: structuredClone(activeProfitModel),
      platformSchemaRules: structuredClone(platformSchemaEvidence)
    },
    externalAccesses: [],
    profitRecalculated: false,
    skuReplaced: false,
    finalSeo: null,
    finalAttributes: null,
    complianceDecision: null,
    generatedAssets: null,
    productionPayload: null
    ,
    factVerificationVersion: null,
    factsVerifiedAt: null,
    exactSkuVerification: null,
    productAttributes: null,
    platformCategory: null,
    schemaSnapshot: null,
    batteryAssessment: null,
    categoryRestrictions: null,
    platformCompliance: null
    ,
    seoTitleDraft: null,
    descriptionDraft: null,
    bulletPointsDraft: null,
    searchKeywordsDraft: null,
    seoEvidenceLayer: null
  };
  assertValidC1ProductPlan(plan);

  const previousProfitModels = structuredClone(skuPackage.profitModels);
  const previousActiveProfitModelVersion = skuPackage.activeProfitModelVersion;
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.businessPhase = "C1";
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "c1_inputs_created_from_four_frozen_upstream_sources",
    at: createdAt,
    c1PlanId: plan.c1PlanId,
    inputRefs: structuredClone(plan.inputRefs),
    finalSeoGenerated: false,
    assetsGenerated: false,
    productionStarted: false
  });

  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) {
    throw new Error(`C1生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }
  if (!sameJson(previousProfitModels, next.profitModels) || next.activeProfitModelVersion !== previousActiveProfitModelVersion) {
    throw new Error("C1_PROTECTED_DATA_CHANGED: B利润结果被改写");
  }
  if (next.supplierSkuId !== skuPackage.supplierSkuId || next.variantKey !== skuPackage.variantKey) {
    throw new Error("C1_PROTECTED_DATA_CHANGED: 供应SKU被替换");
  }

  return deepFreeze({
    flowVersion: "c1-input-flow-v1.1",
    skuPackage: next,
    c1ProductPlan: next.c1ProductPlan
  });
}

function sourcedFact(value, sourceRefs, reason = null) {
  const known = value !== undefined && value !== null && value !== "" && value !== "unknown";
  return {
    value: known ? structuredClone(value) : "unknown",
    verificationStatus: known ? "confirmed" : "unknown",
    sourceRefs: [...new Set(sourceRefs.filter(nonEmptyString))],
    reason: known ? null : (reason || "not_present_in_frozen_inputs")
  };
}

function factPath(root, path) {
  return `${root}#/${path}`;
}

function validateSourcedFact(fact, path, errors) {
  if (!isObject(fact)) {
    push(errors, path, "必须是带来源的事实对象");
    return;
  }
  if (!["confirmed", "unknown"].includes(fact.verificationStatus)) push(errors, `${path}.verificationStatus`, "状态无效");
  if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0 || fact.sourceRefs.some((ref) => !nonEmptyString(ref))) {
    push(errors, `${path}.sourceRefs`, "每个事实必须至少有一个来源路径");
  }
  if (fact.verificationStatus === "unknown" && fact.value !== "unknown") push(errors, `${path}.value`, "无法确认时必须为unknown");
  if (fact.verificationStatus === "confirmed" && (fact.value === "unknown" || fact.value === null || fact.value === undefined)) {
    push(errors, `${path}.value`, "已确认事实必须有直接值");
  }
}

function validateFactCollection(value, path, errors) {
  if (isObject(value) && "verificationStatus" in value && "sourceRefs" in value) {
    validateSourcedFact(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateFactCollection(item, `${path}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["verificationVersion", "verifiedAt", "sourceRefs", "reason"].includes(key)) continue;
      validateFactCollection(child, `${path}.${key}`, errors);
    }
  }
}

export function validateC1FactVerification(plan) {
  const errors = [];
  const base = validateC1ProductPlan(plan);
  errors.push(...base.errors);
  if (!isObject(plan) || plan.status !== "facts_checked") return { valid: false, errors };
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) validateFactCollection(plan[field], field, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * 第9A阶段：只读取C1已冻结的四类输入，为每个事实保存值、状态和具体来源路径。
 */
export function verifyC1ProductFacts({ skuPackage, verifiedAt }) {
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan?.status !== "inputs_ready") {
    throw new Error("C1_FACT_GATE_REJECTED: 当前SKU不是待事实核验的C1输入包");
  }
  if (!isoDateTime(verifiedAt)) throw new Error("C1_FACT_INPUT_GAP: 核验时间无效");

  const plan = structuredClone(skuPackage.c1ProductPlan);
  assertValidC1ProductPlan(plan);
  const sales = plan.inputSnapshots.salesSnapshot;
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  const supplierSku = supply.supplierSku;
  const supplierOption = supply.supplierOptionIdentity;
  const profit = plan.inputSnapshots.profitModel;
  const schema = plan.inputSnapshots.platformSchemaRules;
  assertValidProfitModel(profit);
  const supplyRoot = plan.inputRefs.selectedSupplySnapshotId;
  const salesRoot = plan.inputRefs.salesSnapshotId;
  const schemaRoot = plan.inputRefs.platformSchemaEvidenceId;
  const profitRoot = plan.inputRefs.profitModelVersion;

  if (
    supplierSku.supplierSkuId !== plan.identity.supplierSkuId ||
    supplierSku.variantKey !== plan.identity.variantKey ||
    supply.ownerSupplyConfirmation?.supplierSkuId !== plan.identity.supplierSkuId ||
    supply.ownerSupplyConfirmation?.status !== "confirmed"
  ) throw new Error("C1_FACT_INPUT_GAP: 冻结供应SKU身份不一致");
  if (profit.profitModelVersion !== plan.inputRefs.profitModelVersion || profit.result !== "passed") {
    throw new Error("C1_FACT_INPUT_GAP: 冻结B利润结果不是当前通过版本");
  }

  const supplierAttributes = Object.entries(isObject(supplierSku.attributes) ? supplierSku.attributes : {})
    .filter(([key, value]) => nonEmptyString(key) && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ({
      fieldKey: key,
      fact: sourcedFact(value, [factPath(supplyRoot, `supplierSku/attributes/${key}`)])
    }));
  const attributeMap = new Map(supplierAttributes.map((item) => [item.fieldKey, item.fact]));
  const requiredPlatformFields = schema.requiredFields.map((field) => {
    const matchedKey = Array.isArray(field.sourceAttributeKeys)
      ? field.sourceAttributeKeys.find((key) => attributeMap.has(key))
      : null;
    return {
      fieldKey: field.fieldKey,
      label: field.label,
      fact: matchedKey
        ? structuredClone(attributeMap.get(matchedKey))
        : sourcedFact("unknown", [
          factPath(schemaRoot, `requiredFields/${field.fieldKey}`),
          factPath(supplyRoot, "supplierSku/attributes")
        ], "required_platform_field_not_present_in_frozen_supplier_attributes")
    };
  });
  const requiredUnknownCount = requiredPlatformFields.filter((item) => item.fact.verificationStatus === "unknown").length;

  const powerProfile = isObject(supplierSku.powerProfile) ? supplierSku.powerProfile : {};
  const powered = sourcedFact(powerProfile.powered, [factPath(supplyRoot, "supplierSku/powerProfile/powered")]);
  const containsBattery = sourcedFact(
    powerProfile.containsBattery ?? powerProfile.batteryIncluded,
    [factPath(supplyRoot, "supplierSku/powerProfile/containsBattery")]
  );
  const batteryType = sourcedFact(powerProfile.batteryType, [factPath(supplyRoot, "supplierSku/powerProfile/batteryType")]);
  const batteryCount = sourcedFact(powerProfile.batteryCount, [factPath(supplyRoot, "supplierSku/powerProfile/batteryCount")]);
  const batteryCapacity = sourcedFact(powerProfile.batteryCapacity, [factPath(supplyRoot, "supplierSku/powerProfile/batteryCapacity")]);
  const directBatteryKnown = containsBattery.verificationStatus === "confirmed";
  const batteryAssessmentValue = directBatteryKnown
    ? (containsBattery.value === false ? "no_battery" : "battery_present")
    : "unknown";

  plan.status = "facts_checked";
  plan.factVerificationVersion = C1_FACT_VERIFICATION_VERSION;
  plan.factsVerifiedAt = verifiedAt;
  plan.exactSkuVerification = {
    status: sourcedFact("verified", [supplyRoot]),
    verifiedAt,
    sourceRefs: [supplyRoot],
    supplierOptionId: sourcedFact(plan.identity.supplierOptionId, [factPath(supplyRoot, "ownerSupplyConfirmation/supplierOptionId")]),
    supplierSkuId: sourcedFact(plan.identity.supplierSkuId, [factPath(supplyRoot, "supplierSku/supplierSkuId")]),
    variantKey: sourcedFact(plan.identity.variantKey, [factPath(supplyRoot, "supplierSku/variantKey")]),
    sourcePlatform: sourcedFact(supplierOption?.sourcePlatform, [factPath(supplyRoot, "supplierOptionIdentity/sourcePlatform")]),
    offerId: sourcedFact(supplierOption?.offerId, [factPath(supplyRoot, "supplierOptionIdentity/offerId")]),
    productUrl: sourcedFact(supplierOption?.productUrl, [factPath(supplyRoot, "supplierOptionIdentity/productUrl")])
  };
  plan.productAttributes = {
    status: sourcedFact(
      requiredUnknownCount === 0 ? "all_required_fields_known" : "required_fields_incomplete",
      [factPath(schemaRoot, "requiredFields"), factPath(supplyRoot, "supplierSku/attributes")]
    ),
    supplierAttributes,
    material: sourcedFact(supplierSku.material, [factPath(supplyRoot, "supplierSku/material")]),
    weight: sourcedFact(supplierSku.weight, [factPath(supplyRoot, "supplierSku/weight")]),
    dimensions: sourcedFact(supplierSku.dimensions, [factPath(supplyRoot, "supplierSku/dimensions")]),
    requiredPlatformFields
  };
  plan.platformCategory = {
    status: sourcedFact(
      schema.descriptionCategoryId !== "unknown" && schema.typeId !== "unknown" ? "identified" : "incomplete",
      [factPath(schemaRoot, "descriptionCategoryId"), factPath(schemaRoot, "typeId")]
    ),
    platform: sourcedFact(plan.identity.targetPlatform, [factPath(schemaRoot, "platform")]),
    store: sourcedFact(plan.identity.targetStore, [factPath(schemaRoot, "store")]),
    categoryPath: sourcedFact(sales.categoryPath, [factPath(salesRoot, "categoryPath")]),
    categoryName: sourcedFact(schema.categoryName, [factPath(schemaRoot, "categoryName")]),
    descriptionCategoryId: sourcedFact(schema.descriptionCategoryId, [factPath(schemaRoot, "descriptionCategoryId")]),
    typeId: sourcedFact(schema.typeId, [factPath(schemaRoot, "typeId")])
  };
  plan.schemaSnapshot = {
    status: sourcedFact("frozen", [schemaRoot]),
    evidenceId: sourcedFact(schema.evidenceId, [factPath(schemaRoot, "evidenceId")]),
    schemaRevision: sourcedFact(schema.schemaRevision, [factPath(schemaRoot, "schemaRevision")]),
    requiredFields: sourcedFact(schema.requiredFields, [factPath(schemaRoot, "requiredFields")]),
    writeBindings: sourcedFact(schema.writeBindings, [factPath(schemaRoot, "writeBindings")], "schema_write_bindings_not_present_in_frozen_schema"),
    collectedAt: sourcedFact(schema.collectedAt, [factPath(schemaRoot, "collectedAt")])
  };
  plan.batteryAssessment = {
    status: sourcedFact(
      batteryAssessmentValue === "unknown" ? "unknown" : "fact_available",
      [factPath(supplyRoot, "supplierSku/powerProfile")]
    ),
    assessment: sourcedFact(batteryAssessmentValue, [
      factPath(supplyRoot, "supplierSku/powerProfile/containsBattery"),
      factPath(supplyRoot, "supplierSku/powerProfile/batteryIncluded")
    ], "battery_presence_not_present_in_frozen_inputs"),
    powered,
    containsBattery,
    batteryType,
    batteryCount,
    batteryCapacity
  };
  plan.categoryRestrictions = {
    status: sourcedFact(
      schema.categoryRestrictions === undefined || schema.categoryRestrictions === "unknown" ? "unknown" : "known",
      [factPath(schemaRoot, "categoryRestrictions")]
    ),
    restrictions: sourcedFact(schema.categoryRestrictions, [factPath(schemaRoot, "categoryRestrictions")], "category_restrictions_not_present_in_frozen_schema")
  };
  plan.platformCompliance = {
    status: sourcedFact(
      schema.platformCompliance === undefined || schema.platformCompliance === "unknown" ? "unknown" : "known",
      [factPath(schemaRoot, "platformCompliance"), factPath(profitRoot, "result")]
    ),
    assessment: sourcedFact(schema.platformCompliance, [factPath(schemaRoot, "platformCompliance")], "platform_compliance_not_present_in_frozen_schema"),
    profitGate: sourcedFact(profit.result, [factPath(profitRoot, "result")]),
    requiredFieldGapCount: sourcedFact(requiredUnknownCount, [
      factPath(schemaRoot, "requiredFields"),
      factPath(supplyRoot, "supplierSku/attributes")
    ])
  };

  const factsValidation = validateC1FactVerification(plan);
  if (!factsValidation.valid) {
    throw new Error(`C1事实核验校验失败：${factsValidation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }

  const profitModelsBefore = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.technicalStatus = "completed";
  next.audit.updatedAt = verifiedAt;
  next.audit.history.push({
    event: "c1_facts_checked_from_frozen_inputs_only",
    at: verifiedAt,
    factVerificationVersion: C1_FACT_VERIFICATION_VERSION,
    externalAccesses: [],
    seoGenerated: false,
    assetsGenerated: false,
    productionStarted: false
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C1事实核验生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(profitModelsBefore, next.profitModels) || next.activeProfitModelVersion !== skuPackage.activeProfitModelVersion) {
    throw new Error("C1_FACT_PROTECTED_DATA_CHANGED: B利润结果被改写");
  }
  if (next.supplierSkuId !== skuPackage.supplierSkuId || next.variantKey !== skuPackage.variantKey) {
    throw new Error("C1_FACT_PROTECTED_DATA_CHANGED: 供应SKU被替换");
  }
  return deepFreeze({
    flowVersion: "c1-fact-verification-flow-v1.1",
    skuPackage: next,
    c1ProductPlan: next.c1ProductPlan
  });
}
