export const OZON_PRODUCTION_STRATEGY_VERSION = "ozon-production-strategy-v1.0";

const API_AUTOMATED_FIELDS = Object.freeze([
  "create_product",
  "title",
  "category",
  "attributes",
  "platform_write_price_cny",
  "dimensions",
  "weight",
  "validation_moderation",
  "independent_readback"
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRemoteAsset(asset) {
  return nonEmptyString(asset?.assetRef) && /^https:\/\//i.test(asset.assetRef);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Ozon新品生产的固定最短路径：商品字段和回读默认走Seller API。
 * 本机文件无法直接作为Ozon API图片URL时，只保留一次素材选择交接，禁止退回逐字段浏览器填表。
 */
export function createOzonProductionStrategy({ platform, finalUploads }) {
  if (String(platform).toLowerCase() !== "ozon") {
    throw new Error("OZON_PRODUCTION_STRATEGY_PLATFORM_REJECTED: 只支持Ozon");
  }
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    throw new Error("OZON_PRODUCTION_STRATEGY_ASSETS_REQUIRED: 缺少最终素材");
  }
  const remoteMediaReady = finalUploads.every(isRemoteAsset);
  return deepFreeze({
    schemaVersion: OZON_PRODUCTION_STRATEGY_VERSION,
    primaryPath: "seller_api",
    browserRole: remoteMediaReady ? "none" : "local_media_handoff_only",
    automatedFields: [...API_AUTOMATED_FIELDS],
    mediaMode: remoteMediaReady ? "seller_api_remote_urls" : "single_manual_local_file_selection",
    manualActionsRequired: remoteMediaReady ? 0 : 1,
    manualActionLabel: remoteMediaReady ? null : "一次选择已确认的本地最终素材",
    forbiddenBrowserActions: [
      "fill_title",
      "choose_category",
      "fill_attributes",
      "fill_price",
      "fill_dimensions",
      "fill_weight"
    ],
    priceFieldRule: "platform_write_price_cny_only",
    stopOnFailure: true,
    automaticRetry: false,
    nextSkuAutomaticStart: false
  });
}

export function validateOzonProductionStrategy(strategy) {
  const errors = [];
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return { valid: false, errors: ["必须是对象"] };
  if (strategy.schemaVersion !== OZON_PRODUCTION_STRATEGY_VERSION) errors.push("版本无效");
  if (strategy.primaryPath !== "seller_api") errors.push("主路径必须是Seller API");
  if (![0, 1].includes(strategy.manualActionsRequired)) errors.push("人工动作只能为0或1次");
  if (strategy.priceFieldRule !== "platform_write_price_cny_only") errors.push("价格字段规则无效");
  if (strategy.stopOnFailure !== true || strategy.automaticRetry !== false || strategy.nextSkuAutomaticStart !== false) errors.push("停止边界无效");
  if (!Array.isArray(strategy.forbiddenBrowserActions) || !strategy.forbiddenBrowserActions.includes("fill_price")) errors.push("浏览器价格写入必须禁止");
  return { valid: errors.length === 0, errors };
}
