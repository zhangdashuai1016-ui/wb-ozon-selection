import {
  assertValidLifecyclePackage,
  validateLifecycleTransition,
  validateOpportunityPackage
} from "./product-lifecycle-schema.mjs";
import { assertValidProfitModel } from "./profit-model.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertCanonicalFrozenRef, assertNoRawPersistenceKeys, assertNoProductionSecrets, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { C1_CURRENT_FACT_VERIFICATION_VERSION, C1SkuRightsReviewError, assertC1SkuRightsReviewEvidence, assertC1SkuRightsReviewRecord, projectC1SkuRightsReviewFacts } from "./c1-sku-rights-review.mjs";

export const C1_CANONICAL_CONTRACT_VERSION = "g1-c1-domain-contract-v1";
export const C1_PRODUCT_PLAN_SCHEMA_VERSION = "c1-product-plan-v1.1";
export const C1_FACT_VERIFICATION_VERSION = C1_CURRENT_FACT_VERIFICATION_VERSION;

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

const G1_IDENTITY_FIELDS = Object.freeze([
  "schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId",
  "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"
]);
const G1_STORE_REF_FIELDS = Object.freeze(["stableStoreId", "platformStoreId", "mappingVersion"]);
const G1_REQUIRED_SENTINELS = new Set(["unknown", "null", "undefined", "not_applicable"]);

function assertG1RequiredString(value, field) {
  if (!nonEmptyString(value) || G1_REQUIRED_SENTINELS.has(value.trim().toLowerCase())) {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${field}必须是已持久的非哨兵身份`);
  }
  assertCanonicalFrozenRef(value, field);
}

export function normalizeC1SourceIdentity(value, path = "skuPackage.g1Identity") {
  assertNoRawPersistenceKeys(value, path);
  assertNoProductionSecrets(value, path);
  if (!isObject(value) || !sameJson(Object.keys(value).sort(), [...G1_IDENTITY_FIELDS].sort()) ||
      value.schemaVersion !== "g1-identity-v1") {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}必须是完整g1-identity-v1`);
  }
  for (const field of ["candidateId", "skuPackageId", "platform", "supplierSkuId"]) {
    assertG1RequiredString(value[field], `${path}.${field}`);
  }
  if (!isObject(value.storeRef) ||
      !sameJson(Object.keys(value.storeRef).sort(), [...G1_STORE_REF_FIELDS].sort())) {
    throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}.storeRef必须是完整稳定店铺身份`);
  }
  for (const field of G1_STORE_REF_FIELDS) {
    assertG1RequiredString(value.storeRef[field], `${path}.storeRef.${field}`);
  }
  for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    if (value[field] !== "not_applicable") {
      throw new Error(`C1_G1_IDENTITY_REQUIRED: ${path}.${field}在C1/C2准备阶段必须明确为not_applicable`);
    }
  }
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    candidateId: value.candidateId,
    skuPackageId: value.skuPackageId,
    platform: value.platform,
    storeRef: {
      stableStoreId: value.storeRef.stableStoreId,
      platformStoreId: value.storeRef.platformStoreId,
      mappingVersion: value.storeRef.mappingVersion
    },
    supplierSkuId: value.supplierSkuId,
    merchantSku: value.merchantSku,
    warehouseRef: value.warehouseRef,
    credentialAlias: value.credentialAlias,
    platformProductId: value.platformProductId
  });
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
    for (const [index, field] of evidence.requiredFields.entries()) {
      if (!isObject(field)) {
        push(errors, `requiredFields[${index}]`, "必须是对象");
        continue;
      }
      if (!nonEmptyString(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "必须是非空字符串");
      if (!nonEmptyString(field.label)) push(errors, `requiredFields[${index}].label`, "必须是非空字符串");
      if (field.required !== true) push(errors, `requiredFields[${index}].required`, "这里只保存平台必填字段");
      if (field.sourceAttributeKeys !== undefined) {
        if (!Array.isArray(field.sourceAttributeKeys)) {
          push(errors, `requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组");
        } else {
          for (const key of field.sourceAttributeKeys) {
            if (!nonEmptyString(key)) {
              push(errors, `requiredFields[${index}].sourceAttributeKeys`, "必须是非空字符串数组");
              break;
            }
          }
        }
      }
      if (seen.has(field.fieldKey)) push(errors, `requiredFields[${index}].fieldKey`, "字段不得重复");
      seen.add(field.fieldKey);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateC1ProductPlan(plan) {
  const errors = [];
  if (!isObject(plan)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (plan.schemaVersion !== C1_PRODUCT_PLAN_SCHEMA_VERSION) push(errors, "schemaVersion", `必须是${C1_PRODUCT_PLAN_SCHEMA_VERSION}`);
  if (!nonEmptyString(plan.c1PlanId)) push(errors, "c1PlanId", "必须是非空字符串");
  if (Object.hasOwn(plan, "supersedes") && (!isObject(plan.supersedes) || Object.keys(plan.supersedes).length !== 2 ||
      !isCanonicalFrozenRef(plan.supersedes.c1PlanId) || !isCanonicalFrozenRef(plan.supersedes.historyRef) ||
      plan.supersedes.c1PlanId === plan.c1PlanId)) push(errors, "supersedes", "必须引用不同的历史C1计划及原子保存的历史结果");
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
    if (!["c1-fact-verification-v1.1", C1_FACT_VERIFICATION_VERSION].includes(plan.factVerificationVersion)) {
      push(errors, "factVerificationVersion", "必须是已发布的C1事实核验版本");
    }
    if (plan.factVerificationVersion === C1_FACT_VERIFICATION_VERSION &&
        (!isObject(plan.inputSnapshots) || !Object.hasOwn(plan.inputSnapshots, "skuRightsReview") || !isObject(plan.platformCompliance?.skuRightsReview))) {
      push(errors, "platformCompliance.skuRightsReview", "当前C1核验必须显式保存逐SKU权利证据或unknown");
    }
    if (plan.factVerificationVersion === C1_FACT_VERIFICATION_VERSION && isObject(plan.inputSnapshots) && Object.hasOwn(plan.inputSnapshots, "skuRightsReview")) {
      const review = plan.inputSnapshots.skuRightsReview;
      try {
        if (review !== null) {
          assertC1SkuRightsReviewEvidence({ review, plan, sourceIdentity: review?.sourceIdentity, observedAt: plan.factsVerifiedAt });
          const bound = review.sourceIdentity;
          if (bound.candidateId !== plan.frozenInputRefs?.candidateId || bound.skuPackageId !== plan.identity?.skuPackageId ||
              bound.platform !== plan.identity?.targetPlatform || bound.supplierSkuId !== plan.identity?.supplierSkuId ||
              !sameStoreRef(bound.storeRef, plan.inputSnapshots.platformSchemaRules?.storeRef)) {
            throw new C1SkuRightsReviewError("C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH");
          }
        }
        if (!sameJson(plan.platformCompliance?.skuRightsReview, projectC1SkuRightsReviewFacts(review, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`))) {
          throw new C1SkuRightsReviewError("C1_SKU_RIGHTS_REVIEW_PROJECTION_DRIFT");
        }
      } catch (error) {
        if (!(error instanceof C1SkuRightsReviewError)) throw error;
        push(errors, "platformCompliance.skuRightsReview", error.code);
      }
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
  if (plan.contractVersion === C1_CANONICAL_CONTRACT_VERSION) {
    if (!isObject(plan.revisionRefs) || !Number.isInteger(plan.revisionRefs.sourceRevision) ||
        plan.revisionRefs.sourceRevision < 0 || plan.revisionRefs.resultRevision !== plan.revisionRefs.sourceRevision + 1) {
      push(errors, "revisionRefs", "必须保存C1创建时实际source/result修订");
    }
    const frozen = plan.frozenInputRefs;
    if (!isObject(frozen) || frozen.sourceRevision !== plan.revisionRefs?.sourceRevision ||
        frozen.skuPackageId !== plan.identity?.skuPackageId || frozen.platform !== plan.identity?.targetPlatform ||
        frozen.storeRef !== plan.identity?.targetStore || frozen.salesSnapshotId !== plan.inputRefs?.salesSnapshotId ||
        frozen.selectedSupplySnapshotId !== plan.inputRefs?.selectedSupplySnapshotId ||
        frozen.profitModelVersion !== plan.inputRefs?.profitModelVersion ||
        frozen.schemaSnapshotRef !== plan.inputRefs?.platformSchemaEvidenceId ||
        plan.schemaSnapshotRef !== plan.inputRefs?.platformSchemaEvidenceId || !nonEmptyString(frozen.candidateId) ||
        frozen.ownerSupplyConfirmationRef !== `${plan.inputRefs?.selectedSupplySnapshotId}#ownerSupplyConfirmation`) {
      push(errors, "frozenInputRefs", "必须锁定当前C1的四类证据及主人供应确认");
    }
    if (!Array.isArray(plan.keywordEvidenceRefs) || !Array.isArray(plan.unknownManifest)) {
      push(errors, "canonical", "必须显式保存关键词引用与unknown清单");
    }
    if (plan.status === "inputs_ready" && (plan.mediaRequirements !== null || plan.draftOnlySeo !== null)) {
      push(errors, "canonical", "C1创建时不得冒充媒体已核验或provider已完成");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidC1ProductPlan(plan) {
  const result = validateC1ProductPlan(plan);
  if (!result.valid) {
    const canonicalError = result.errors.some(item => ["revisionRefs", "frozenInputRefs", "canonical"].includes(item.path));
    throw new Error(`${canonicalError ? "C1_CANONICAL_GATE_BLOCKED" : "C1ProductPlan校验失败"}：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  }
  return plan;
}

/**
 * 第8阶段只把四类已冻结上游输入装入C1，不联网、不算利润、不生成内容或素材。
 */
function buildC1InputPlan({ skuPackage, activeProfitModel, salesSnapshot, confirmedSupplierSkuSnapshot,
  platformSchemaEvidence, createdAt, c1PlanId }) {
  const sourceIdentity = normalizeC1SourceIdentity(skuPackage.g1Identity);
  const [salesSnapshotId, selectedSupplySnapshotId] = activeProfitModel.inputSnapshotRefs;
  const plan = {
    schemaVersion: C1_PRODUCT_PLAN_SCHEMA_VERSION,
    contractVersion: C1_CANONICAL_CONTRACT_VERSION,
    c1PlanId,
    status: "inputs_ready",
    createdAt,
    revisionRefs: { sourceRevision: skuPackage.dataRevision, resultRevision: skuPackage.dataRevision + 1 },
    frozenInputRefs: {
      candidateId: sourceIdentity.candidateId,
      skuPackageId: sourceIdentity.skuPackageId,
      platform: sourceIdentity.platform,
      storeRef: sourceIdentity.storeRef.stableStoreId,
      sourceRevision: skuPackage.dataRevision,
      salesSnapshotId,
      selectedSupplySnapshotId,
      ownerSupplyConfirmationRef: `${selectedSupplySnapshotId}#ownerSupplyConfirmation`,
      profitModelVersion: activeProfitModel.profitModelVersion,
      schemaSnapshotRef: platformSchemaEvidence.evidenceId
    },
    schemaSnapshotRef: platformSchemaEvidence.evidenceId,
    draftOnlySeo: null,
    keywordEvidenceRefs: [],
    mediaRequirements: null,
    unknownManifest: [],
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
      confirmedSupplierSkuSnapshot: structuredClone(confirmedSupplierSkuSnapshot),
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

  return plan;
}

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
  if (activeProfitModel.commissionMode !== "exact") {
    throw new Error("C1_GATE_REJECTED: 正式B必须先取得精确佣金，估算或历史利润记录不得进入C1");
  }
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
  const sourceIdentity = normalizeC1SourceIdentity(skuPackage.g1Identity);
  if (platformSchemaEvidence.storeRef !== undefined &&
      !sameStoreRef(platformSchemaEvidence.storeRef, sourceIdentity.storeRef)) {
    throw new Error("C1_SCHEMA_STORE_SCOPE_MISMATCH: 平台Schema必须绑定同一完整店铺身份");
  }

  const plan = buildC1InputPlan({ skuPackage, activeProfitModel, salesSnapshot, platformSchemaEvidence, createdAt,
    c1PlanId: `c1:${skuPackage.skuPackageId}:${skuPackage.activeProfitModelVersion}`,
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
  });

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

export function assertC1RightsReviewStage(skuPackage) {
  if (skuPackage?.businessPhase !== "C1" || ["c2FinalAssets", "productionConfirmationCard", "productionAuthorization", "dHandoff", "productionRecord", "externalListingRecord", "eVerificationRecord"]
    .some(field => skuPackage[field] !== null && skuPackage[field] !== undefined)) throw new C1SkuRightsReviewError("C1_RIGHTS_REPLACEMENT_NOT_ALLOWED");
}

/** A new C1 review retains B and its frozen inputs; it never simulates a B transition. */
export function replaceC1ProductPlanForRightsReview({ skuPackage, expectedC1PlanId, historyRef, createdAt }) {
  assertValidLifecyclePackage(skuPackage);
  const previous = skuPackage.c1ProductPlan;
  assertValidC1ProductPlan(previous);
  assertC1RightsReviewStage(skuPackage);
  if (previous.c1PlanId !== expectedC1PlanId) throw new C1SkuRightsReviewError("C1_RIGHTS_PLAN_CONFLICT");
  if (!isoDateTime(createdAt) || !isCanonicalFrozenRef(historyRef)) throw new C1SkuRightsReviewError("C1_RIGHTS_INPUT_INVALID");
  const snapshots = previous.inputSnapshots;
  const profit = skuPackage.profitModels.find(model => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  const supply = snapshots.confirmedSupplierSkuSnapshot;
  const source = normalizeC1SourceIdentity(skuPackage.g1Identity);
  if (!profit || !sameJson(profit, snapshots.profitModel) || profit.result !== "passed" || profit.commissionMode !== "exact" ||
      profit.inputSnapshotRefs[0] !== previous.inputRefs.salesSnapshotId || profit.inputSnapshotRefs[1] !== previous.inputRefs.selectedSupplySnapshotId ||
      snapshots.salesSnapshot.snapshotId !== previous.inputRefs.salesSnapshotId ||
      !skuPackage.inheritedSalesSnapshotRefs.includes(snapshots.salesSnapshot.snapshotId) ||
      supply.snapshotId !== skuPackage.selectedSupplySnapshot.snapshotId ||
      !sameJson(supply.supplierSku, skuPackage.selectedSupplySnapshot.supplierSku) ||
      !sameJson(supply.ownerSupplyConfirmation, skuPackage.selectedSupplySnapshot.ownerSupplyConfirmation) ||
      supply.supplierSku.supplierSkuId !== source.supplierSkuId || supply.supplierSku.variantKey !== skuPackage.variantKey ||
      supply.ownerSupplyConfirmation.status !== "confirmed" || supply.ownerSupplyConfirmation.supplierSkuId !== source.supplierSkuId ||
      snapshots.platformSchemaRules.evidenceId !== previous.inputRefs.platformSchemaEvidenceId ||
      snapshots.platformSchemaRules.platform !== source.platform || snapshots.platformSchemaRules.store !== skuPackage.targetStore ||
      !sameStoreRef(snapshots.platformSchemaRules.storeRef, source.storeRef)) throw new C1SkuRightsReviewError("C1_RIGHTS_SOURCE_EVIDENCE_INVALID");
  assertValidProfitModel(profit);
  const plan = buildC1InputPlan({ skuPackage, activeProfitModel: profit, salesSnapshot: snapshots.salesSnapshot,
    confirmedSupplierSkuSnapshot: supply, platformSchemaEvidence: snapshots.platformSchemaRules, createdAt,
    c1PlanId: `c1:${skuPackage.skuPackageId}:${skuPackage.activeProfitModelVersion}:review:${skuPackage.dataRevision + 1}` });
  plan.supersedes = { c1PlanId: previous.c1PlanId, historyRef };
  assertValidC1ProductPlan(plan);
  const next = structuredClone(skuPackage);
  delete next.c1RightsReviewRecord;
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "review_compliance_risk";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({ event: "c1_rights_review_plan_replaced", at: createdAt,
    c1PlanId: plan.c1PlanId, supersedes: structuredClone(plan.supersedes),
    sourceRevision: skuPackage.dataRevision, resultRevision: next.dataRevision, externalAccesses: [] });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new C1SkuRightsReviewError("C1_RIGHTS_REPLACEMENT_NOT_ALLOWED");
  return deepFreeze({ skuPackage: next, c1ProductPlan: plan });
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
export function normalizePlatformMediaSlot(slot, mediaType, index) {
  const path = `${mediaType}Slots[${index}]`;
  if (!isObject(slot) || !nonEmptyString(slot.slotId) || !nonEmptyString(slot.role)) {
    throw new Error(`C1_MEDIA_REQUIREMENTS_INVALID: ${path}缺少slotId或role`);
  }
  if (!Number.isInteger(slot.minCount) || slot.minCount < 0 ||
      !Number.isInteger(slot.maxCount) || slot.maxCount < slot.minCount || slot.maxCount < 1) {
    throw new Error(`C1_MEDIA_REQUIREMENTS_INVALID: ${path}数量边界无效`);
  }
  return {
    slotId: slot.slotId,
    mediaType,
    role: slot.role,
    minCount: slot.minCount,
    maxCount: slot.maxCount
  };
}


export const C1_UNKNOWN_CLASSIFICATION_VERSION = 'c1-schema-aware-unknown-v1';

/** Classification is derived from frozen schema and SKU facts, never from a client-provided exemption. */
export function collectC1UnknownManifest(plan) {
  const schema = plan.inputSnapshots?.platformSchemaRules;
  const schemaKnown = validatePlatformSchemaEvidence(schema).valid;
  const requiredKeys = new Set(schemaKnown ? schema.requiredFields.flatMap(field =>
    [field.fieldKey, ...(field.sourceAttributeKeys ?? [])]) : []);
  const necessarySupplierKeys = new Set(['weight','weightKg','dimensions','dimensionsCm','packedWeight','packaging',
    'powerProfile','powered','containsBattery','batteryIncluded','batteryType','batteryCount','batteryCapacity',
    'minimumOrderQuantity','unitProductPrice','unitDomesticFreight','otherPurchaseCosts','actualPurchaseCost',
    'purchaseCostComponents','quantityOneEvidence']);
  const rawPower = plan.inputSnapshots?.confirmedSupplierSkuSnapshot?.supplierSku?.powerProfile;
  const noBattery = isObject(rawPower) && (rawPower.containsBattery ?? rawPower.batteryIncluded) === false &&
    rawPower.containsBattery !== true && rawPower.batteryIncluded !== true &&
    plan.batteryAssessment?.containsBattery?.verificationStatus === 'confirmed' &&
    plan.batteryAssessment.containsBattery.value === false &&
    plan.batteryAssessment?.assessment?.verificationStatus === 'confirmed' &&
    plan.batteryAssessment.assessment.value === 'no_battery';
  const result = [];
  const visit = (value, path, attributeKey = null) => {
    if (isObject(value) && value.verificationStatus === "unknown") {
      let blockingScope = "required_field";
      if (schemaKnown && ((path === 'productAttributes.material' && !requiredKeys.has('material')) ||
          (/^productAttributes\.supplierAttributes\[/.test(path) && attributeKey !== null && !requiredKeys.has(attributeKey) && !necessarySupplierKeys.has(attributeKey))))
        blockingScope = 'informational';
      if (/^productAttributes\.requiredPlatformFields\[/.test(path) ||
          /^platformCategory\.(categoryId|descriptionCategoryId|typeId)$/.test(path) ||
          /^schemaSnapshot\.(schemaRevision|writeBindings)$/.test(path)) blockingScope = "required_field";
      if (/^(batteryAssessment|categoryRestrictions|platformCompliance)\./.test(path)) blockingScope = "compliance";
      const batteryDetail = path.match(/^batteryAssessment\.(batteryType|batteryCount|batteryCapacity)$/);
      if (schemaKnown && noBattery && batteryDetail && !requiredKeys.has(batteryDetail[1])) blockingScope = 'informational';
      result.push({ fieldPath: path, reason: value.reason, sourceRefs: [...new Set(value.sourceRefs)],
        blockingScope, blocksC2Handoff: blockingScope !== "informational" });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`, attributeKey));
    else if (isObject(value)) for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, nonEmptyString(value.fieldKey) ? value.fieldKey : attributeKey);
  };
  for (const field of ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
    "batteryAssessment", "categoryRestrictions", "platformCompliance"]) visit(plan[field], field);
  return result;
}

export function verifyC1ProductFacts({ skuPackage, skuRightsReview = null, verifiedAt }) {
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
  if (Object.hasOwn(plan.inputSnapshots, "skuRightsReview")) throw new Error("C1_SKU_RIGHTS_REVIEW_ALREADY_FROZEN");
  if (Object.hasOwn(skuPackage, "c1RightsReviewRecord")) {
    assertC1SkuRightsReviewRecord({ record: skuPackage.c1RightsReviewRecord, plan, sourceIdentity: normalizeC1SourceIdentity(skuPackage.g1Identity) });
    if (!sameJson(skuPackage.c1RightsReviewRecord.review, skuRightsReview)) throw new C1SkuRightsReviewError("C1_RIGHTS_RECORD_DECLARATION_MISMATCH");
  }
  if (skuRightsReview !== null) assertC1SkuRightsReviewEvidence({ review: skuRightsReview, plan,
    sourceIdentity: normalizeC1SourceIdentity(skuPackage.g1Identity), observedAt: verifiedAt });
  plan.inputSnapshots.skuRightsReview = structuredClone(skuRightsReview);

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
      fact: sourcedFact(value, [factPath(supplyRoot, "supplierSku/attributes")])
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
          factPath(schemaRoot, "requiredFields"),
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
      [schema.descriptionCategoryId, schema.typeId].every(value => nonEmptyString(value) && value !== "unknown") ? "identified" : "incomplete",
      [factPath(schemaRoot, "descriptionCategoryId"), factPath(schemaRoot, "typeId")]
    ),
    platform: sourcedFact(plan.identity.targetPlatform, [factPath(schemaRoot, "platform")]),
    store: sourcedFact(plan.identity.targetStore, [factPath(schemaRoot, "store")]),
    categoryPath: sourcedFact(sales.categoryPath, [factPath(salesRoot, "categoryPath")]),
    categoryId: sourcedFact(schema.categoryId, [factPath(schemaRoot, "categoryId")], "category_id_not_present_in_frozen_schema"),
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
    skuRightsReview: projectC1SkuRightsReviewFacts(skuRightsReview, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`),
    requiredFieldGapCount: sourcedFact(requiredUnknownCount, [
      factPath(schemaRoot, "requiredFields"),
      factPath(supplyRoot, "supplierSku/attributes")
    ])
  };

  if (plan.contractVersion === C1_CANONICAL_CONTRACT_VERSION) {
    const media = schema.mediaRequirements;
    const mediaReady = isObject(media) && media.schemaVersion === "c2-media-requirements-v1" &&
      media.evidenceRef === schema.evidenceId && nonEmptyString(media.evidenceVersion) &&
      media.platform === skuPackage.targetPlatform && media.targetStore === skuPackage.targetStore &&
      sameStoreRef(schema.storeRef, skuPackage.g1Identity.storeRef) &&
      sameStoreRef(media.storeRef, skuPackage.g1Identity.storeRef) &&
      media.categoryId === schema.categoryId && media.schemaRevision === schema.schemaRevision &&
      Array.isArray(media.imageSlots) && media.imageSlots.length > 0 && Array.isArray(media.videoSlots) &&
      ["required", "not_required"].includes(media.schemaVideoRequirement?.status);
    plan.mediaRequirements = {
      status: mediaReady ? "confirmed" : "unknown",
      schemaSnapshotRef: schema.evidenceId,
      sourceRefs: [schema.evidenceId],
      requiredSlots: mediaReady ? [
        ...media.imageSlots.map((slot, index) => normalizePlatformMediaSlot(slot, "image", index)),
        ...media.videoSlots.map((slot, index) => normalizePlatformMediaSlot(slot, "video", index))
      ].filter(slot => slot.minCount > 0).map(slot => ({ slotId: slot.slotId, mediaType: slot.mediaType, required: true })) : [],
      videoRequirement: mediaReady ? media.schemaVideoRequirement.status : "unknown",
      reason: mediaReady ? null : "platform_media_rules_or_scope_not_confirmed"
    };
    plan.unknownManifest = collectC1UnknownManifest(plan);
    if (!sameStoreRef(schema.storeRef, skuPackage.g1Identity.storeRef)) {
      plan.unknownManifest.push({ fieldPath: "schemaSnapshot.storeRef", reason: "full_store_scope_not_confirmed",
        sourceRefs: [schema.evidenceId], blockingScope: "required_field", blocksC2Handoff: true });
    }
    if (!mediaReady) {
      plan.unknownManifest.push({ fieldPath: "mediaRequirements", reason: plan.mediaRequirements.reason,
        sourceRefs: [schema.evidenceId], blockingScope: "media_slot", blocksC2Handoff: true });
    }
  }

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
