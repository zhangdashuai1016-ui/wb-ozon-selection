export const PRODUCT_LIFECYCLE_SCHEMA_VERSION = "product-lifecycle-v1.1";
export const MINIMUM_PROFIT_MARGIN = 0.25;
export const MINIMUM_UNIT_PROFIT_RMB = 20;

export const ENTITY_TYPES = Object.freeze({
  OPPORTUNITY: "OpportunityPackage",
  SKU: "SkuLifecyclePackage"
});

export const BUSINESS_PHASES = Object.freeze({
  OPPORTUNITY: ["A", "closed", "unknown"],
  SKU: ["B", "C1", "C2", "D", "E", "closed", "unknown"]
});

export const BUSINESS_RESULTS = Object.freeze([
  "pending",
  "passed",
  "rejected",
  "manual_review",
  "unknown"
]);

export const TECHNICAL_STATUSES = Object.freeze([
  "not_started",
  "queued",
  "running",
  "completed",
  "data_acquisition_failed",
  "system_error",
  "permission_required",
  "stopped",
  "unknown"
]);

export const OWNER_ACTIONS = Object.freeze([
  "none",
  "confirm_direction",
  "confirm_supplier_option",
  "provide_supply_data",
  "review_business_exception",
  "review_compliance_risk",
  "confirm_c1_plan",
  "provide_final_assets",
  "confirm_final_assets",
  "authorize_production",
  "decide_readback_failure",
  "unknown"
]);

export const SUPPLIER_SEARCH_STATUSES = Object.freeze([
  "not_started",
  "running",
  "completed",
  "stopped",
  "unknown"
]);

export const SUPPLIER_SEARCH_STOP_REASONS = Object.freeze([
  "enough_qualified_options",
  "max_search_rounds",
  "max_supplier_options",
  "max_consecutive_no_evidence_rounds",
  "technical_failure",
  "owner_stop",
  "scope_completed"
]);

export const READBACK_STATUSES = Object.freeze([
  "not_started",
  "running",
  "completed",
  "stopped"
]);

export const READBACK_STOP_REASONS = Object.freeze([
  "max_automatic_attempts",
  "max_consecutive_same_failure",
  "technical_failure",
  "permission_required",
  "owner_stop"
]);

const TECHNICAL_FAILURES = new Set([
  "data_acquisition_failed",
  "system_error",
  "permission_required",
  "stopped"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isUnknown(value) {
  return value === "unknown";
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIsoDateTime(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "必须是对象");
    return false;
  }
  return true;
}

function requireString(value, path, errors) {
  if (!isNonEmptyString(value)) push(errors, path, "必须是非空字符串");
}

function requireEnum(value, values, path, errors) {
  if (!values.includes(value)) push(errors, path, `必须是以下值之一：${values.join(", ")}`);
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) push(errors, path, "必须是数组");
}

function validateCommon(pkg, entityType, phases, errors) {
  if (!requireObject(pkg, "$", errors)) return;
  if (pkg.schemaVersion !== PRODUCT_LIFECYCLE_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `必须是${PRODUCT_LIFECYCLE_SCHEMA_VERSION}`);
  }
  if (pkg.entityType !== entityType) push(errors, "entityType", `必须是${entityType}`);
  requireString(pkg.parentOpportunityId, "parentOpportunityId", errors);
  if (!isNonNegativeInteger(pkg.dataRevision)) push(errors, "dataRevision", "必须是非负整数");
  requireEnum(pkg.businessPhase, phases, "businessPhase", errors);
  requireEnum(pkg.businessResult, BUSINESS_RESULTS, "businessResult", errors);
  requireEnum(pkg.technicalStatus, TECHNICAL_STATUSES, "technicalStatus", errors);
  requireEnum(pkg.ownerAction, OWNER_ACTIONS, "ownerAction", errors);

  if (requireObject(pkg.audit, "audit", errors)) {
    if (!isIsoDateTime(pkg.audit.createdAt)) push(errors, "audit.createdAt", "必须是有效时间");
    if (!isIsoDateTime(pkg.audit.updatedAt)) push(errors, "audit.updatedAt", "必须是有效时间");
    requireArray(pkg.audit.history, "audit.history", errors);
  }
}

function validateSupplierSearch(search, errors) {
  if (!requireObject(search, "supplierSearch", errors)) return;
  requireEnum(search.status, SUPPLIER_SEARCH_STATUSES, "supplierSearch.status", errors);

  if (requireObject(search.limits, "supplierSearch.limits", errors)) {
    for (const key of ["maxSearchRounds", "maxSupplierOptions", "maxConsecutiveNoEvidenceRounds"]) {
      if (!isPositiveInteger(search.limits[key]) && !isUnknown(search.limits[key])) {
        push(errors, `supplierSearch.limits.${key}`, "必须是有限的正整数");
      }
    }
  }

  for (const key of ["searchRounds", "supplierOptionsFound", "consecutiveNoEvidenceRounds"]) {
    if (!isNonNegativeInteger(search[key]) && !isUnknown(search[key])) {
      push(errors, `supplierSearch.${key}`, "必须是非负整数或unknown");
    }
  }
  if (!isNullableString(search.stopReason)) push(errors, "supplierSearch.stopReason", "必须是字符串或null");
  if (!isNullableString(search.stoppedAt)) push(errors, "supplierSearch.stoppedAt", "必须是时间字符串或null");

  const limits = search.limits || {};
  if (search.status === "running") {
    for (const key of ["maxSearchRounds", "maxSupplierOptions", "maxConsecutiveNoEvidenceRounds"]) {
      if (!isPositiveInteger(limits[key])) push(errors, `supplierSearch.limits.${key}`, "开始搜索前必须确定有限上限");
    }
    for (const key of ["searchRounds", "supplierOptionsFound", "consecutiveNoEvidenceRounds"]) {
      if (!isNonNegativeInteger(search[key])) push(errors, `supplierSearch.${key}`, "运行时必须是非负整数");
    }
    const reached =
      search.searchRounds >= limits.maxSearchRounds ||
      search.supplierOptionsFound >= limits.maxSupplierOptions ||
      search.consecutiveNoEvidenceRounds >= limits.maxConsecutiveNoEvidenceRounds;
    if (reached) push(errors, "supplierSearch.status", "达到停止条件后不得继续运行");
  }
  if (["completed", "stopped"].includes(search.status)) {
    requireEnum(search.stopReason, SUPPLIER_SEARCH_STOP_REASONS, "supplierSearch.stopReason", errors);
    if (!isIsoDateTime(search.stoppedAt)) push(errors, "supplierSearch.stoppedAt", "停止后必须记录有效时间");
  }
}

function parseProfitVersion(value) {
  const match = /^profit-v([1-9]\d*)$/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

function validateProfitModels(pkg, errors) {
  if (!Array.isArray(pkg.profitModels)) {
    push(errors, "profitModels", "必须是数组");
    return;
  }

  const seen = new Set();
  let previousVersion = 0;
  pkg.profitModels.forEach((model, index) => {
    const path = `profitModels[${index}]`;
    if (!requireObject(model, path, errors)) return;
    const numericVersion = parseProfitVersion(model.profitModelVersion);
    if (numericVersion === null) push(errors, `${path}.profitModelVersion`, "必须使用profit-vN格式");
    if (seen.has(model.profitModelVersion)) push(errors, `${path}.profitModelVersion`, "版本不得重复或覆盖");
    if (numericVersion !== null && numericVersion <= previousVersion) {
      push(errors, `${path}.profitModelVersion`, "利润版本必须严格递增");
    }
    seen.add(model.profitModelVersion);
    if (numericVersion !== null) previousVersion = numericVersion;
    if (!isIsoDateTime(model.calculatedAt)) push(errors, `${path}.calculatedAt`, "必须是有效时间");
    requireArray(model.inputSnapshotRefs, `${path}.inputSnapshotRefs`, errors);
    for (const key of ["recommendedSalePriceCny", "unitProfitRmb", "profitMargin"] ) {
      if (!Number.isFinite(model[key])) push(errors, `${path}.${key}`, "必须是有限数字");
    }
    requireEnum(model.result, BUSINESS_RESULTS, `${path}.result`, errors);
    if (Number.isFinite(model.recommendedSalePriceCny) && model.recommendedSalePriceCny <= 0) {
      push(errors, `${path}.recommendedSalePriceCny`, "建议成交价必须大于0");
    }
    if (Number.isFinite(model.recommendedSalePriceCny) && Number.isFinite(model.unitProfitRmb) && Number.isFinite(model.profitMargin)) {
      const expectedMargin = model.unitProfitRmb / model.recommendedSalePriceCny;
      if (Math.abs(model.profitMargin - expectedMargin) > 0.0001) {
        push(errors, `${path}.profitMargin`, "必须等于单件利润除以建议成交价人民币");
      }
      const thresholdPassed =
        model.unitProfitRmb >= MINIMUM_UNIT_PROFIT_RMB &&
        model.profitMargin >= MINIMUM_PROFIT_MARGIN;
      if (model.result === "passed" && !thresholdPassed) {
        push(errors, `${path}.result`, "通过必须同时满足利润率25%和单件利润20元");
      }
      if (model.result === "rejected" && thresholdPassed) {
        push(errors, `${path}.result`, "达到统一利润门槛时不得标记为淘汰");
      }
    }
  });

  if (pkg.activeProfitModelVersion !== null && !seen.has(pkg.activeProfitModelVersion)) {
    push(errors, "activeProfitModelVersion", "必须指向已保留的利润版本");
  }
}

function validateReadbackPolicy(policy, errors) {
  if (!requireObject(policy, "readbackPolicy", errors)) return;
  requireEnum(policy.status, READBACK_STATUSES, "readbackPolicy.status", errors);
  for (const key of ["maxAutomaticAttempts", "maxConsecutiveSameFailure"]) {
    if (!isPositiveInteger(policy[key])) push(errors, `readbackPolicy.${key}`, "必须是有限的正整数");
  }
  for (const key of ["automaticAttempts", "consecutiveSameFailureCount"]) {
    if (!isNonNegativeInteger(policy[key])) push(errors, `readbackPolicy.${key}`, "必须是非负整数");
  }
  if (!isNullableString(policy.lastFailureLayer)) push(errors, "readbackPolicy.lastFailureLayer", "必须是字符串或null");
  if (!isNullableString(policy.stopReason)) push(errors, "readbackPolicy.stopReason", "必须是字符串或null");
  if (!isNullableString(policy.stoppedAt)) push(errors, "readbackPolicy.stoppedAt", "必须是时间字符串或null");

  if (policy.automaticAttempts > policy.maxAutomaticAttempts) {
    push(errors, "readbackPolicy.automaticAttempts", "不得超过自动回读上限");
  }
  if (policy.consecutiveSameFailureCount > policy.maxConsecutiveSameFailure) {
    push(errors, "readbackPolicy.consecutiveSameFailureCount", "不得超过同层连续失败上限");
  }
  const reached =
    policy.automaticAttempts >= policy.maxAutomaticAttempts ||
    policy.consecutiveSameFailureCount >= policy.maxConsecutiveSameFailure;
  if (policy.status === "running" && reached) {
    push(errors, "readbackPolicy.status", "达到回读停止条件后不得继续自动回读");
  }
  if (policy.status === "stopped") {
    requireEnum(policy.stopReason, READBACK_STOP_REASONS, "readbackPolicy.stopReason", errors);
    if (!isIsoDateTime(policy.stoppedAt)) push(errors, "readbackPolicy.stoppedAt", "停止后必须记录有效时间");
  }
}

function validateC2AssetLifecycleGate(value, errors) {
  if (!isObject(value)) return;
  if (value.schemaVersion !== "c2-asset-lifecycle-v1.1") {
    push(errors, "c2FinalAssets.schemaVersion", "必须使用c2-asset-lifecycle-v1.1");
  }
  if (!["awaiting_final_uploads", "completed"].includes(value.status)) {
    push(errors, "c2FinalAssets.status", "素材状态无效");
  }
  if (!isObject(value.assets)) {
    push(errors, "c2FinalAssets.assets", "必须存在三个素材区域");
  } else {
    for (const region of ["collected", "aiDrafts", "finalUploads"]) {
      if (!Array.isArray(value.assets[region])) push(errors, `c2FinalAssets.assets.${region}`, "必须是数组");
    }
  }
  if (!isObject(value.dReadPolicy) ||
      value.dReadPolicy.onlyAllowedArea !== "assets.finalUploads" ||
      value.dReadPolicy.collectedAllowed !== false ||
      value.dReadPolicy.aiDraftsAllowed !== false ||
      value.dReadPolicy.ownerConfirmationRequired !== true) {
    push(errors, "c2FinalAssets.dReadPolicy", "D只能读取主人确认的assets.finalUploads");
  }
  if (value.platformUploads !== 0) push(errors, "c2FinalAssets.platformUploads", "C2基础设施不得产生平台上传");
  if (value.productionStarted !== false) push(errors, "c2FinalAssets.productionStarted", "C2基础设施不得开始D生产");
  if (value.status === "completed") {
    const confirmation = value.ownerFinalUploadConfirmation;
    if (!isObject(confirmation) || confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner") {
      push(errors, "c2FinalAssets.ownerFinalUploadConfirmation", "完成C2必须有主人确认");
    }
    if (!Array.isArray(value.assets?.finalUploads) || value.assets.finalUploads.length === 0) {
      push(errors, "c2FinalAssets.assets.finalUploads", "完成C2必须有最终上传素材");
    } else if (value.assets.finalUploads.some((asset) => !isObject(asset) || asset.ownerConfirmed !== true || asset.productionEligible !== true)) {
      push(errors, "c2FinalAssets.assets.finalUploads", "最终上传素材必须逐项由主人确认");
    }
  }
}

function validateProductionAuthorizationGate(value, pkg, errors) {
  if (!isObject(value)) return;
  if (value.schemaVersion !== "production-authorization-v1.1") push(errors, "productionAuthorization.schemaVersion", "必须使用production-authorization-v1.1");
  if (value.status !== "confirmed" || value.confirmedBy !== "owner") push(errors, "productionAuthorization.status", "必须由主人确认");
  if (!isNonNegativeInteger(value.authorizedDataRevision)) push(errors, "productionAuthorization.authorizedDataRevision", "必须锁定数据修订号");
  if (!isObject(value.lockedScope)) {
    push(errors, "productionAuthorization.lockedScope", "必须存在锁定范围");
  } else {
    if (value.lockedScope.platform !== pkg.targetPlatform) push(errors, "productionAuthorization.lockedScope.platform", "平台与SKU生命周期不一致");
    if (value.lockedScope.store !== pkg.targetStore) push(errors, "productionAuthorization.lockedScope.store", "店铺与SKU生命周期不一致");
    if (value.lockedScope.skuPackageId !== pkg.skuPackageId) push(errors, "productionAuthorization.lockedScope.skuPackageId", "SKU生命周期ID不一致");
    if (value.lockedScope.supplierSkuId !== pkg.supplierSkuId) push(errors, "productionAuthorization.lockedScope.supplierSkuId", "供应SKU不得替换");
    if (value.lockedScope.stock !== 100) push(errors, "productionAuthorization.lockedScope.stock", "新品库存必须为100");
    if (!Array.isArray(value.lockedScope.finalUploads) || value.lockedScope.finalUploads.length === 0) push(errors, "productionAuthorization.lockedScope.finalUploads", "必须锁定最终素材");
  }
  if (value.scopeExpansionAllowed !== false || value.fieldMutationAllowed !== false || value.skuReplacementAllowed !== false || value.assetReplacementAllowed !== false) {
    push(errors, "productionAuthorization", "授权不得允许扩大、改字段、换SKU或换素材");
  }
  if (value.readPolicy !== "authorization_snapshot_only") push(errors, "productionAuthorization.readPolicy", "D只能读取授权快照");
  if (value.productionExecuted !== false || value.platformWrites !== 0) push(errors, "productionAuthorization.productionExecuted", "第12阶段不得执行D或平台写入");
}

export function validateOpportunityPackage(pkg) {
  const errors = [];
  validateCommon(pkg, ENTITY_TYPES.OPPORTUNITY, BUSINESS_PHASES.OPPORTUNITY, errors);
  if (!isObject(pkg)) return { valid: false, errors };
  requireString(pkg.directionName, "directionName", errors);
  requireString(pkg.targetPlatform, "targetPlatform", errors);
  requireString(pkg.targetStore, "targetStore", errors);
  requireArray(pkg.salesSnapshots, "salesSnapshots", errors);
  requireArray(pkg.supplierOptions, "supplierOptions", errors);
  if (!isNullableString(pkg.recommendedSupplierOptionId)) {
    push(errors, "recommendedSupplierOptionId", "必须是字符串或null");
  }
  if (!isNullableString(pkg.confirmedSupplierOptionId)) {
    push(errors, "confirmedSupplierOptionId", "必须是字符串或null");
  }
  validateSupplierSearch(pkg.supplierSearch, errors);
  return { valid: errors.length === 0, errors };
}

export function validateSkuLifecyclePackage(pkg) {
  const errors = [];
  validateCommon(pkg, ENTITY_TYPES.SKU, BUSINESS_PHASES.SKU, errors);
  if (!isObject(pkg)) return { valid: false, errors };
  for (const [key, label] of [
    ["skuPackageId", "SKU生命周期ID"],
    ["supplierOptionId", "已确认供应方案ID"],
    ["supplierSkuId", "供应商SKU ID"],
    ["variantKey", "变体标识"],
    ["targetPlatform", "目标平台"],
    ["targetStore", "目标店铺"]
  ]) {
    if (!isNonEmptyString(pkg[key])) push(errors, key, `${label}必须是非空字符串`);
  }
  requireArray(pkg.inheritedSalesSnapshotRefs, "inheritedSalesSnapshotRefs", errors);
  if (!isObject(pkg.selectedSupplySnapshot)) push(errors, "selectedSupplySnapshot", "必须保存已确认供应快照");
  if (!isObject(pkg.skuFacts)) push(errors, "skuFacts", "必须是对象");
  if (!isObject(pkg.c1ProductPlan) && pkg.c1ProductPlan !== null) push(errors, "c1ProductPlan", "必须是对象或null");
  if (!isObject(pkg.c2FinalAssets) && pkg.c2FinalAssets !== null) push(errors, "c2FinalAssets", "必须是对象或null");
  if (isObject(pkg.c2FinalAssets)) validateC2AssetLifecycleGate(pkg.c2FinalAssets, errors);
  if (!isObject(pkg.productionAuthorization) && pkg.productionAuthorization !== null) {
    push(errors, "productionAuthorization", "必须是对象或null");
  }
  if (isObject(pkg.productionAuthorization)) validateProductionAuthorizationGate(pkg.productionAuthorization, pkg, errors);
  if (!isObject(pkg.productionConfirmationCard) && pkg.productionConfirmationCard !== null && pkg.productionConfirmationCard !== undefined) {
    push(errors, "productionConfirmationCard", "必须是对象或null");
  }
  if (isObject(pkg.productionConfirmationCard)) {
    if (pkg.productionConfirmationCard.status === "awaiting_owner_business_confirmation") {
      if (pkg.businessPhase !== "C2") push(errors, "businessPhase", "等待主人确认商品方案时必须停留在C2");
      if (pkg.productionAuthorization !== null) push(errors, "productionAuthorization", "商品方案确认前不得生成生产授权");
    }
    if (pkg.productionConfirmationCard.status === "owner_business_approved" && !isObject(pkg.productionAuthorization)) {
      push(errors, "productionAuthorization", "主人通过商品方案后必须存在对应授权对象");
    }
  }
  if (!isObject(pkg.productionRecord) && pkg.productionRecord !== null) push(errors, "productionRecord", "必须是对象或null");
  if (!isObject(pkg.externalListingRecord) && pkg.externalListingRecord !== null) push(errors, "externalListingRecord", "必须是对象或null");
  if (!isObject(pkg.eVerificationRecord) && pkg.eVerificationRecord !== null) push(errors, "eVerificationRecord", "必须是对象或null");
  if (isObject(pkg.productionRecord) && isObject(pkg.externalListingRecord)) {
    push(errors, "externalListingRecord", "ProductionRecord与ExternalListingRecord互斥，禁止把外部发现冒充系统创建");
  }
  validateProfitModels(pkg, errors);
  validateReadbackPolicy(pkg.readbackPolicy, errors);
  requireArray(pkg.readbackHistory, "readbackHistory", errors);
  if (["D", "E"].includes(pkg.businessPhase)) {
    if (!["completed", "seo_draft_ready"].includes(pkg.c1ProductPlan?.status)) push(errors, "c1ProductPlan.status", "进入D/E前C1必须完成事实核验和SEO草稿");
    if (pkg.c2FinalAssets?.status !== "completed") push(errors, "c2FinalAssets.status", "进入D/E前C2必须完成");
    if (pkg.productionAuthorization?.status !== "confirmed") {
      push(errors, "productionAuthorization.status", "进入D/E前必须取得精确生产授权");
    }
  }
  if (pkg.businessPhase === "E" && !isObject(pkg.productionRecord) && !isObject(pkg.externalListingRecord)) {
    push(errors, "productionRecord", "进入E前必须存在ProductionRecord或ExternalListingRecord");
  }
  if (isObject(pkg.eVerificationRecord)) {
    if (pkg.businessPhase !== "E") push(errors, "businessPhase", "完成E验证后业务阶段必须为E");
    if (pkg.eVerificationRecord.outcome === "listed_verified" && !isObject(pkg.productionRecord)) {
      push(errors, "productionRecord", "listed_verified必须来自ProductionRecord");
    }
    if (pkg.eVerificationRecord.outcome === "externally_verified" && !isObject(pkg.externalListingRecord)) {
      push(errors, "externalListingRecord", "externally_verified必须来自ExternalListingRecord");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLifecyclePackage(pkg) {
  if (pkg?.entityType === ENTITY_TYPES.OPPORTUNITY) return validateOpportunityPackage(pkg);
  if (pkg?.entityType === ENTITY_TYPES.SKU) return validateSkuLifecyclePackage(pkg);
  return { valid: false, errors: [{ path: "entityType", message: "未知的数据包类型" }] };
}

export function assertValidLifecyclePackage(pkg) {
  const result = validateLifecyclePackage(pkg);
  if (!result.valid) {
    const detail = result.errors.map((item) => `${item.path}: ${item.message}`).join("；");
    throw new Error(`商品生命周期数据校验失败：${detail}`);
  }
  return pkg;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateLifecycleTransition(previous, next) {
  const errors = [...validateLifecyclePackage(next).errors];
  if (!isObject(previous) || !isObject(next)) {
    return { valid: false, errors: [...errors, { path: "$", message: "前后数据包都必须存在" }] };
  }
  if (previous.entityType !== next.entityType) push(errors, "entityType", "生命周期内不得更换数据包类型");
  if (previous.parentOpportunityId !== next.parentOpportunityId) push(errors, "parentOpportunityId", "不得更换所属商品方向");
  if (previous.skuPackageId !== next.skuPackageId) push(errors, "skuPackageId", "不得更换SKU生命周期ID");
  if (next.dataRevision !== previous.dataRevision + 1) push(errors, "dataRevision", "必须在原修订号上加1");

  if (TECHNICAL_FAILURES.has(next.technicalStatus)) {
    if (previous.businessPhase !== next.businessPhase) push(errors, "businessPhase", "技术失败不得改变业务阶段");
    if (previous.businessResult !== next.businessResult) push(errors, "businessResult", "技术失败不得改变业务结果");
  }

  if (previous.entityType === ENTITY_TYPES.SKU) {
    const previousModels = Array.isArray(previous.profitModels) ? previous.profitModels : [];
    const nextModels = Array.isArray(next.profitModels) ? next.profitModels : [];
    if (nextModels.length < previousModels.length) {
      push(errors, "profitModels", "历史利润版本不得删除");
    } else if (!sameJson(previousModels, nextModels.slice(0, previousModels.length))) {
      push(errors, "profitModels", "历史利润版本不得覆盖或改写");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function appendProfitModelVersion(pkg, model) {
  assertValidLifecyclePackage(pkg);
  if (pkg.entityType !== ENTITY_TYPES.SKU) throw new Error("只有SKU生命周期包可以追加利润版本");
  const nextNumber = pkg.profitModels.length
    ? parseProfitVersion(pkg.profitModels[pkg.profitModels.length - 1].profitModelVersion) + 1
    : 1;
  if (model.profitModelVersion !== `profit-v${nextNumber}`) {
    throw new Error(`新的利润版本必须是profit-v${nextNumber}`);
  }
  const next = structuredClone(pkg);
  next.profitModels.push(structuredClone(model));
  next.activeProfitModelVersion = model.profitModelVersion;
  next.dataRevision += 1;
  next.audit.updatedAt = model.calculatedAt;
  assertValidLifecyclePackage(next);
  return next;
}

export function supplierSearchStopReason(search) {
  if (!isObject(search?.limits)) return "invalid_limits";
  if (search.searchRounds >= search.limits.maxSearchRounds) return "max_search_rounds";
  if (search.supplierOptionsFound >= search.limits.maxSupplierOptions) return "max_supplier_options";
  if (search.consecutiveNoEvidenceRounds >= search.limits.maxConsecutiveNoEvidenceRounds) {
    return "max_consecutive_no_evidence_rounds";
  }
  return null;
}

export function readbackStopReason(policy) {
  if (!isObject(policy)) return "invalid_policy";
  if (policy.automaticAttempts >= policy.maxAutomaticAttempts) return "max_automatic_attempts";
  if (policy.consecutiveSameFailureCount >= policy.maxConsecutiveSameFailure) {
    return "max_consecutive_same_failure";
  }
  return null;
}
