import {
  assertValidLifecyclePackage,
  validateLifecycleTransition
} from "./product-lifecycle-schema.mjs";
import { assertValidC1ProductPlan } from "./c1-product-plan.mjs";

export const C2_ASSET_LIFECYCLE_VERSION = "c2-asset-lifecycle-v1.1";
export const COLLECTED_ASSET_PLATFORMS = Object.freeze(["ozon", "wb", "1688", "pinduoduo"]);
export const ASSET_MEDIA_TYPES = Object.freeze(["image", "video"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
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

function push(errors, path, message) {
  errors.push({ path, message });
}

function validateBaseAsset(asset, path, errors) {
  if (!isObject(asset)) {
    push(errors, path, "必须是对象");
    return false;
  }
  if (!nonEmptyString(asset.assetId)) push(errors, `${path}.assetId`, "必须是非空字符串");
  if (!ASSET_MEDIA_TYPES.includes(asset.mediaType)) push(errors, `${path}.mediaType`, "必须是image或video");
  if (!nonEmptyString(asset.assetRef)) push(errors, `${path}.assetRef`, "必须是非空引用");
  if (!isoDateTime(asset.addedAt)) push(errors, `${path}.addedAt`, "必须是有效时间");
  return true;
}

function validateAssetRegions(assets, errors) {
  if (!isObject(assets)) {
    push(errors, "assets", "必须是对象");
    return;
  }
  for (const region of ["collected", "aiDrafts", "finalUploads"]) {
    if (!Array.isArray(assets[region])) push(errors, `assets.${region}`, "必须是数组");
  }
  if (!["collected", "aiDrafts", "finalUploads"].every((region) => Array.isArray(assets[region]))) return;

  const ids = new Map();
  assets.collected.forEach((asset, index) => {
    const path = `assets.collected[${index}]`;
    validateBaseAsset(asset, path, errors);
    if (!COLLECTED_ASSET_PLATFORMS.includes(asset.sourcePlatform)) push(errors, `${path}.sourcePlatform`, "来源平台无效");
    if (!nonEmptyString(asset.sourceEvidenceRef)) push(errors, `${path}.sourceEvidenceRef`, "必须保留采集证据");
    if (asset.lifecycleArea !== "collected") push(errors, `${path}.lifecycleArea`, "必须是collected");
    if (asset.usagePolicy !== "analysis_reference_only") push(errors, `${path}.usagePolicy`, "采集素材只能用于分析参考");
    if (asset.productionEligible !== false) push(errors, `${path}.productionEligible`, "采集素材禁止进入D");
    ids.set(asset.assetId, "collected");
  });
  assets.aiDrafts.forEach((asset, index) => {
    const path = `assets.aiDrafts[${index}]`;
    validateBaseAsset(asset, path, errors);
    if (asset.lifecycleArea !== "aiDrafts") push(errors, `${path}.lifecycleArea`, "必须是aiDrafts");
    if (asset.sourceType !== "ai_generated_draft") push(errors, `${path}.sourceType`, "AI区只接受AI草稿");
    if (asset.productionEligible !== false) push(errors, `${path}.productionEligible`, "AI草稿不能自动进入D");
    if (ids.has(asset.assetId)) push(errors, `${path}.assetId`, "素材ID不得跨区域重复");
    ids.set(asset.assetId, "aiDrafts");
  });
  assets.finalUploads.forEach((asset, index) => {
    const path = `assets.finalUploads[${index}]`;
    validateBaseAsset(asset, path, errors);
    if (asset.lifecycleArea !== "finalUploads") push(errors, `${path}.lifecycleArea`, "必须是finalUploads");
    if (asset.sourceType !== "owner_provided_final_upload") push(errors, `${path}.sourceType`, "最终素材必须由主人提供并确认");
    if (asset.ownerConfirmed !== true) push(errors, `${path}.ownerConfirmed`, "最终素材必须由主人确认");
    if (asset.productionEligible !== true) push(errors, `${path}.productionEligible`, "确认后的最终素材才可成为未来D输入");
    if (ids.has(asset.assetId)) push(errors, `${path}.assetId`, "素材ID不得跨区域重复");
    ids.set(asset.assetId, "finalUploads");
  });
}

export function validateC2AssetLifecycle(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (value.schemaVersion !== C2_ASSET_LIFECYCLE_VERSION) push(errors, "schemaVersion", `必须是${C2_ASSET_LIFECYCLE_VERSION}`);
  if (!nonEmptyString(value.assetPackageId)) push(errors, "assetPackageId", "必须是非空字符串");
  if (!["awaiting_final_uploads", "completed"].includes(value.status)) push(errors, "status", "状态无效");
  if (!isoDateTime(value.createdAt) || !isoDateTime(value.updatedAt)) push(errors, "createdAt", "必须保存有效时间");
  validateAssetRegions(value.assets, errors);
  if (!isObject(value.dReadPolicy)) {
    push(errors, "dReadPolicy", "必须是对象");
  } else {
    if (value.dReadPolicy.onlyAllowedArea !== "assets.finalUploads") push(errors, "dReadPolicy.onlyAllowedArea", "D只能读取assets.finalUploads");
    if (value.dReadPolicy.collectedAllowed !== false) push(errors, "dReadPolicy.collectedAllowed", "collected禁止进入D");
    if (value.dReadPolicy.aiDraftsAllowed !== false) push(errors, "dReadPolicy.aiDraftsAllowed", "aiDrafts禁止自动进入D");
    if (value.dReadPolicy.ownerConfirmationRequired !== true) push(errors, "dReadPolicy.ownerConfirmationRequired", "必须要求主人确认");
  }
  if (value.status === "awaiting_final_uploads") {
    if (value.ownerFinalUploadConfirmation !== null) push(errors, "ownerFinalUploadConfirmation", "等待阶段必须为null");
    if (Array.isArray(value.assets?.finalUploads) && value.assets.finalUploads.length !== 0) push(errors, "assets.finalUploads", "未确认前必须为空");
  }
  if (value.status === "completed") {
    const confirmation = value.ownerFinalUploadConfirmation;
    if (!isObject(confirmation) || confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner" || !isoDateTime(confirmation.confirmedAt)) {
      push(errors, "ownerFinalUploadConfirmation", "完成C2必须有主人确认记录");
    }
    if (!Array.isArray(value.assets?.finalUploads) || value.assets.finalUploads.length === 0) push(errors, "assets.finalUploads", "完成C2必须有最终上传素材");
    const finalIds = (value.assets?.finalUploads || []).map((asset) => asset.assetId);
    if (!Array.isArray(confirmation?.approvedAssetIds) || !sameJson(confirmation.approvedAssetIds, finalIds)) {
      push(errors, "ownerFinalUploadConfirmation.approvedAssetIds", "确认清单必须与最终上传素材完全一致且顺序一致");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidC2AssetLifecycle(value) {
  const result = validateC2AssetLifecycle(value);
  if (!result.valid) throw new Error(`C2素材包校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return value;
}

function normalizeCollectedAsset(asset, addedAt) {
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    sourcePlatform: asset.sourcePlatform,
    sourceEvidenceRef: asset.sourceEvidenceRef,
    addedAt: asset.addedAt || addedAt,
    lifecycleArea: "collected",
    usagePolicy: "analysis_reference_only",
    productionEligible: false
  };
}

export function createC2AssetLifecycle({ skuPackage, collectedAssets = [], createdAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertValidC1ProductPlan(skuPackage.c1ProductPlan);
  if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan.status !== "seo_draft_ready") {
    throw new Error("C2_ASSET_GATE_REJECTED: C1 SEO草稿尚未准备完成");
  }
  if (skuPackage.c2FinalAssets !== null) throw new Error("C2_ASSET_GATE_REJECTED: C2素材包已经存在");
  if (!isoDateTime(createdAt)) throw new Error("C2_ASSET_INPUT_GAP: 创建时间无效");
  if (!Array.isArray(collectedAssets)) throw new Error("C2_ASSET_INPUT_GAP: collectedAssets必须是数组");

  const lifecycle = {
    schemaVersion: C2_ASSET_LIFECYCLE_VERSION,
    assetPackageId: `c2-assets:${skuPackage.skuPackageId}`,
    status: "awaiting_final_uploads",
    createdAt,
    updatedAt: createdAt,
    assets: {
      collected: collectedAssets.map((asset) => normalizeCollectedAsset(asset, createdAt)),
      aiDrafts: [],
      finalUploads: []
    },
    ownerFinalUploadConfirmation: null,
    dReadPolicy: {
      onlyAllowedArea: "assets.finalUploads",
      collectedAllowed: false,
      aiDraftsAllowed: false,
      ownerConfirmationRequired: true
    },
    generationIntegrations: {
      xiaohouzi: "not_connected",
      otherAiTools: "not_connected"
    },
    platformUploads: 0,
    productionStarted: false
  };
  assertValidC2AssetLifecycle(lifecycle);

  const c1Before = structuredClone(skuPackage.c1ProductPlan);
  const profitBefore = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.c2FinalAssets = lifecycle;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "provide_final_assets";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "c2_asset_lifecycle_created",
    at: createdAt,
    collectedCount: lifecycle.assets.collected.length,
    aiDraftCount: 0,
    finalUploadCount: 0,
    xiaohouziConnected: false,
    platformUploads: 0,
    productionStarted: false
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C2素材生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(c1Before, next.c1ProductPlan) || !sameJson(profitBefore, next.profitModels)) {
    throw new Error("C2_ASSET_PROTECTED_DATA_CHANGED: 商品事实、SEO草稿或利润被改写");
  }
  return deepFreeze({ flowVersion: "c2-asset-lifecycle-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

export function addAiDraftAssets({ skuPackage, aiDraftAssets, addedAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") throw new Error("C2_ASSET_GATE_REJECTED: 已完成的素材包不能追加AI草稿");
  if (!Array.isArray(aiDraftAssets) || !isoDateTime(addedAt)) throw new Error("C2_ASSET_INPUT_GAP: AI草稿输入无效");
  const next = structuredClone(skuPackage);
  next.c2FinalAssets.assets.aiDrafts.push(...aiDraftAssets.map((asset) => ({
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    sourceType: "ai_generated_draft",
    generatorRef: asset.generatorRef,
    addedAt: asset.addedAt || addedAt,
    lifecycleArea: "aiDrafts",
    productionEligible: false
  })));
  next.c2FinalAssets.updatedAt = addedAt;
  next.dataRevision += 1;
  next.audit.updatedAt = addedAt;
  next.audit.history.push({ event: "c2_ai_drafts_added_without_promotion", at: addedAt, count: aiDraftAssets.length, finalUploadsChanged: false });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error("C2素材生命周期转换失败");
  return deepFreeze({ flowVersion: "c2-ai-draft-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

export function confirmFinalUploads({ skuPackage, finalUploadAssets, ownerDecision, confirmedAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") throw new Error("C2_ASSET_GATE_REJECTED: 最终素材已经确认");
  if (!Array.isArray(finalUploadAssets) || finalUploadAssets.length === 0) throw new Error("C2_ASSET_INPUT_GAP: 必须提供最终上传素材");
  if (!isObject(ownerDecision) || ownerDecision.status !== "confirmed" || ownerDecision.confirmedBy !== "owner") {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: finalUploads必须由主人明确确认");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("C2_ASSET_INPUT_GAP: 确认时间无效");
  if (finalUploadAssets.some((asset) => asset.sourceType !== "owner_provided_final_upload")) {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: AI草稿或采集素材不能自动成为finalUploads");
  }
  const approvedAssetIds = finalUploadAssets.map((asset) => asset.assetId);
  if (!sameJson(ownerDecision.approvedAssetIds, approvedAssetIds)) {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: 主人确认清单必须与最终素材及顺序完全一致");
  }

  const next = structuredClone(skuPackage);
  next.c2FinalAssets.assets.finalUploads = finalUploadAssets.map((asset) => ({
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    fileName: asset.fileName || null,
    sha256: asset.sha256 || null,
    byteSize: Number.isFinite(asset.byteSize) ? asset.byteSize : null,
    width: Number.isFinite(asset.width) ? asset.width : null,
    height: Number.isFinite(asset.height) ? asset.height : null,
    order: Number.isInteger(asset.order) ? asset.order : null,
    role: asset.role || null,
    sourceType: "owner_provided_final_upload",
    addedAt: asset.addedAt || confirmedAt,
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true
  }));
  next.c2FinalAssets.ownerFinalUploadConfirmation = {
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt,
    approvedAssetIds,
    confirmationNote: ownerDecision.confirmationNote || null
  };
  next.c2FinalAssets.status = "completed";
  next.c2FinalAssets.updatedAt = confirmedAt;
  next.dataRevision += 1;
  next.businessResult = "passed";
  next.technicalStatus = "completed";
  next.ownerAction = "confirm_c1_plan";
  next.audit.updatedAt = confirmedAt;
  next.audit.history.push({
    event: "c2_final_uploads_owner_confirmed",
    at: confirmedAt,
    approvedAssetIds,
    collectedPromoted: false,
    aiDraftsPromoted: false,
    platformUploads: 0,
    productionStarted: false
  });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C2素材生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return deepFreeze({ flowVersion: "c2-final-upload-confirmation-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

/** 未来D素材入口：这里只生成素材清单，不执行D，也不代表生产授权。 */
export function selectConfirmedFinalUploadsForProduction(c2AssetLifecycle) {
  assertValidC2AssetLifecycle(c2AssetLifecycle);
  if (c2AssetLifecycle.status !== "completed" || c2AssetLifecycle.ownerFinalUploadConfirmation?.status !== "confirmed") {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: 未经主人确认不得生成未来D素材清单");
  }
  return deepFreeze({
    sourceArea: "assets.finalUploads",
    ownerConfirmation: structuredClone(c2AssetLifecycle.ownerFinalUploadConfirmation),
    assets: structuredClone(c2AssetLifecycle.assets.finalUploads),
    collectedIncluded: false,
    aiDraftsIncluded: false,
    productionExecuted: false
  });
}
