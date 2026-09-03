import { createHash } from "node:crypto";

export const OZON_SELLER_API_DE_ADAPTER_VERSION = "ozon-seller-api-de-adapter-v1";
export const OZON_PRODUCT_IMPORT_ENDPOINT = "/v3/product/import";
export const OZON_PRODUCT_IMPORT_INFO_ENDPOINT = "/v1/product/import/info";
export const OZON_INVENTORY_WRITE_ENDPOINT = "/v2/products/stocks";

const READBACK_ENDPOINTS = Object.freeze({
  attributes: "/v4/product/info/attributes",
  info: "/v3/product/info/list",
  prices: "/v5/product/info/prices",
  stocks: "/v4/product/info/stocks",
  stateFailed: "/v3/product/list"
});
const BLOCKED_ASSET_HOSTS = Object.freeze(["tmpfiles.org"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveIntegerLike(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function gap(code, field, message) {
  return { code, field, message };
}

function verifiedEvidence(value) {
  return isObject(value) && value.status === "verified" && nonEmpty(value.protocolVersion) && nonEmpty(value.evidenceRef);
}

function normalizedHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
}

function blockedHost(host) {
  return BLOCKED_ASSET_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function normalizeStore(value) {
  return String(value || "").trim().toLowerCase();
}

export function inspectAdapterCapabilities({
  store,
  warehouseId,
  storeIdentity,
  productImport,
  assetTransport,
  inventoryWrite,
  independentReadback,
  inspectedAt
}) {
  const gaps = [];
  const normalizedStore = normalizeStore(store);
  if (!nonEmpty(normalizedStore)) gaps.push(gap("store_missing", "store", "缺少目标店铺"));
  if (!positiveIntegerLike(warehouseId)) gaps.push(gap("warehouse_missing", "warehouseId", "缺少当前店铺的准确仓库ID"));
  if (!nonEmpty(inspectedAt) || Number.isNaN(Date.parse(inspectedAt))) gaps.push(gap("inspection_time_invalid", "inspectedAt", "能力检查时间无效"));

  if (!isObject(storeIdentity) || storeIdentity.status !== "verified" ||
      normalizeStore(storeIdentity.expectedStore) !== normalizedStore ||
      normalizeStore(storeIdentity.observedStore) !== normalizedStore || !nonEmpty(storeIdentity.evidenceRef)) {
    gaps.push(gap("store_identity_not_verified", "storeIdentity", "店铺身份证据未与目标店铺一致"));
  }
  if (!verifiedEvidence(productImport) || productImport.endpoint !== OZON_PRODUCT_IMPORT_ENDPOINT ||
      productImport.statusEndpoint !== OZON_PRODUCT_IMPORT_INFO_ENDPOINT) {
    gaps.push(gap("product_import_not_verified", "productImport", "商品导入和任务回执协议未验证"));
  }
  const approvedHosts = Array.isArray(assetTransport?.approvedHosts)
    ? [...new Set(assetTransport.approvedHosts.map((host) => String(host).toLowerCase().replace(/\.$/u, "")))]
    : [];
  if (!verifiedEvidence(assetTransport) || assetTransport.mode !== "preapproved_stable_https" || approvedHosts.length === 0 ||
      approvedHosts.some((host) => blockedHost(host))) {
    gaps.push(gap("asset_transport_not_verified", "assetTransport", "缺少已批准的稳定HTTPS素材能力"));
  }
  if (!verifiedEvidence(inventoryWrite) || inventoryWrite.endpoint !== OZON_INVENTORY_WRITE_ENDPOINT ||
      String(inventoryWrite.warehouseId) !== String(warehouseId)) {
    gaps.push(gap("inventory_write_not_verified", "inventoryWrite", "库存协议或仓库证据未锁定"));
  }
  if (!verifiedEvidence(independentReadback) ||
      JSON.stringify(independentReadback.endpoints) !== JSON.stringify(READBACK_ENDPOINTS)) {
    gaps.push(gap("independent_readback_not_verified", "independentReadback", "完整独立回读协议未验证"));
  }

  const status = gaps.length === 0 ? "ready" : "not_ready";
  const capabilities = {
    status,
    platform: "ozon",
    store: normalizedStore,
    warehouseId: positiveIntegerLike(warehouseId) ? String(warehouseId) : null,
    adapterVersion: OZON_SELLER_API_DE_ADAPTER_VERSION,
    protocolVersion: "ozon-single-sku-d-e-v1",
    inspectedAt,
    evidenceRef: status === "ready" ? `ozon-adapter-capabilities:${digest({
      store: normalizedStore,
      warehouseId: String(warehouseId),
      storeIdentity,
      productImport,
      assetTransport,
      inventoryWrite,
      independentReadback
    })}` : null,
    storeIdentity: isObject(storeIdentity) ? structuredClone(storeIdentity) : null,
    productImport: {
      status: status === "ready" ? "verified" : (productImport?.status || "unknown"),
      endpoint: OZON_PRODUCT_IMPORT_ENDPOINT,
      statusEndpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT,
      protocolVersion: productImport?.protocolVersion || null,
      evidenceRef: productImport?.evidenceRef || null
    },
    assetTransport: {
      status: status === "ready" ? "verified" : (assetTransport?.status || "unknown"),
      mode: assetTransport?.mode || null,
      protocolVersion: assetTransport?.protocolVersion || null,
      evidenceRef: assetTransport?.evidenceRef || null,
      approvedHosts,
      resolvedAssets: structuredClone(assetTransport?.resolvedAssets || [])
    },
    inventoryWrite: {
      status: status === "ready" ? "verified" : (inventoryWrite?.status || "unknown"),
      endpoint: OZON_INVENTORY_WRITE_ENDPOINT,
      warehouseId: positiveIntegerLike(warehouseId) ? String(warehouseId) : null,
      protocolVersion: inventoryWrite?.protocolVersion || null,
      evidenceRef: inventoryWrite?.evidenceRef || null
    },
    independentReadback: {
      status: status === "ready" ? "verified" : (independentReadback?.status || "unknown"),
      endpoints: structuredClone(READBACK_ENDPOINTS),
      protocolVersion: independentReadback?.protocolVersion || null,
      evidenceRef: independentReadback?.evidenceRef || null
    },
    gaps
  };
  return freeze(capabilities);
}

export function resolveFinalUploads({ finalUploads, adapterCapabilities }) {
  const gaps = [];
  if (adapterCapabilities?.status !== "ready" || adapterCapabilities?.assetTransport?.status !== "verified") {
    gaps.push(gap("asset_transport_not_ready", "adapterCapabilities.assetTransport", "素材传输能力未验证"));
  }
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    gaps.push(gap("final_uploads_missing", "finalUploads", "缺少最终素材"));
  }
  const approvedHosts = new Set(adapterCapabilities?.assetTransport?.approvedHosts || []);
  const resolvedById = new Map((adapterCapabilities?.assetTransport?.resolvedAssets || []).map((item) => [item.assetId, item]));
  const seen = new Set();
  const resolvedAssets = (finalUploads || []).map((asset, index) => {
    const resolved = resolvedById.get(asset?.assetId);
    const host = normalizedHost(resolved?.platformAcceptedUrl);
    const expectedOrder = index + 1;
    if (!nonEmpty(asset?.assetId) || seen.has(asset.assetId)) {
      gaps.push(gap("final_asset_identity_invalid", `finalUploads.${index}`, "素材ID缺失或重复"));
    } else {
      seen.add(asset.assetId);
    }
    if (asset?.ownerConfirmed !== true || asset?.productionEligible !== true ||
        (asset?.lifecycleArea !== undefined && asset.lifecycleArea !== "finalUploads")) {
      gaps.push(gap("final_asset_not_confirmed", `finalUploads.${asset?.assetId || index}`, "只能使用主人确认的finalUploads"));
    }
    if (!resolved || resolved.authorizationStatus !== "approved" || resolved.stable !== true ||
        !nonEmpty(resolved.evidenceRef) || !host || blockedHost(host) || !approvedHosts.has(host)) {
      gaps.push(gap("platform_asset_url_not_approved", `finalUploads.${asset?.assetId || index}`, "素材没有能力证据认可的稳定HTTPS地址"));
    }
    if (resolved && (resolved.sha256 !== asset?.sha256 || resolved.order !== expectedOrder || asset?.order !== expectedOrder)) {
      gaps.push(gap("platform_asset_binding_mismatch", `finalUploads.${asset?.assetId || index}`, "素材哈希或顺序与确认清单不一致"));
    }
    return {
      assetId: asset?.assetId || "",
      sourceAssetRef: asset?.assetRef || null,
      platformAcceptedUrl: resolved?.platformAcceptedUrl || null,
      sha256: asset?.sha256 || null,
      order: expectedOrder,
      role: asset?.role || (index === 0 ? "main" : "detail"),
      evidenceRef: resolved?.evidenceRef || null,
      ownerConfirmed: true,
      productionEligible: true
    };
  });
  return freeze({
    status: gaps.length === 0 ? "ready" : "not_ready",
    resolvedAssets: gaps.length === 0 ? resolvedAssets : [],
    gaps
  });
}

function unknownOutcome(layer, reason, writeOccurred = true) {
  return freeze({
    status: "unknown_outcome",
    layer,
    reason,
    writeOccurred,
    retryAllowed: false
  });
}

function knownPrewriteRejection(message) {
  return freeze({
    status: "rejected_before_write",
    writeOccurred: false,
    code: "adapter_request_invalid",
    message,
    retryAllowed: false
  });
}

function validateExecutionRequest(request, capabilities) {
  if (!isObject(request) || request.platform !== "ozon" || normalizeStore(request.store) !== capabilities.store) return "平台或店铺与能力证据不一致";
  if (!nonEmpty(request.executionKey) || request.idempotencyKey !== request.executionKey) return "缺少唯一执行键";
  if (!nonEmpty(request.merchantSku) || request.supplierSkuId !== request.merchantSku) return "merchantSku与supplierSku未唯一锁定";
  if (request.stock !== 100 || request.inventoryWrite?.stock !== 100) return "新品库存必须锁定100";
  if (request.inventoryWrite?.endpoint !== OZON_INVENTORY_WRITE_ENDPOINT ||
      String(request.inventoryWrite?.warehouseId) !== capabilities.warehouseId) return "库存端点或仓库与能力证据不一致";
  if (request.productImport?.endpoint !== OZON_PRODUCT_IMPORT_ENDPOINT || request.productImport?.body?.items?.length !== 1) return "商品导入请求必须只包含一个SKU";
  if (String(request.productImport.body.items[0]?.offer_id || "") !== request.merchantSku) return "导入offer与锁定merchantSku不一致";
  return null;
}

function receipt(prefix, payload) {
  return `${prefix}:${digest(payload)}`;
}

function itemForOffer(items, offerId) {
  return Array.isArray(items) ? items.find((item) => String(item?.offer_id || "") === offerId) : null;
}

function productIdOf(item) {
  return String(item?.product_id ?? item?.id ?? "");
}

function mergeErrors(infoItem, stateFailedItem) {
  const errors = Array.isArray(infoItem?.errors) ? structuredClone(infoItem.errors) : [];
  if (stateFailedItem) {
    errors.push({
      source: "STATE_FAILED",
      offerId: String(stateFailedItem.offer_id || ""),
      productId: productIdOf(stateFailedItem),
      errors: structuredClone(stateFailedItem.errors || [])
    });
  }
  return errors;
}

function saleStatus(infoItem) {
  if (infoItem?.is_archived === true) return "archived";
  const value = String(infoItem?.statuses?.status_name || "").trim().toLowerCase();
  if (["продается", "selling", "on_sale"].includes(value)) return "on_sale";
  if (["active"].includes(value)) return "active";
  if (!value) return "unknown";
  return "not_for_sale";
}

function availableStock(stockItem) {
  const rows = stockItem?.stocks;
  if (!Array.isArray(rows)) return null;
  let total = 0;
  for (const row of rows) {
    const present = Number(row?.present);
    const reserved = Number(row?.reserved);
    if (!Number.isFinite(present) || !Number.isFinite(reserved)) return null;
    total += Math.max(present - reserved, 0);
  }
  return total;
}

function priceOf(priceItem) {
  const amount = Number(priceItem?.price?.price ?? priceItem?.price ?? NaN);
  const currency = String(priceItem?.price?.currency_code ?? priceItem?.currency_code ?? "");
  return Number.isFinite(amount) && amount > 0 && currency === "CNY" ? { amount, currency } : null;
}

function uniqueImageUrls(primaryImage, images) {
  const seen = new Set();
  const urls = [primaryImage, ...(Array.isArray(images) ? images : [])];
  return urls.flatMap((value) => {
    if (!nonEmpty(value)) return [];
    const url = value.trim();
    if (seen.has(url)) return [];
    seen.add(url);
    return [url];
  });
}

export function createStoreIsolatedOzonSellerApiDEAdapter({ requestJson, adapterCapabilities }) {
  if (typeof requestJson !== "function") throw new Error("OZON_DE_ADAPTER_TRANSPORT_REQUIRED: 缺少受控requestJson");
  if (!isObject(adapterCapabilities) || adapterCapabilities.status !== "ready" || adapterCapabilities.platform !== "ozon" ||
      !nonEmpty(adapterCapabilities.store) || !nonEmpty(adapterCapabilities.evidenceRef)) {
    throw new Error("OZON_DE_ADAPTER_CAPABILITIES_NOT_READY: 店铺隔离能力证据未就绪");
  }
  const capabilities = structuredClone(adapterCapabilities);

  async function call({ endpoint, body, write, executionKey }) {
    return requestJson(freeze({
      platform: "ozon",
      store: capabilities.store,
      method: "POST",
      endpoint,
      body: structuredClone(body),
      write,
      executionKey: executionKey || null
    }));
  }

  return freeze({
    adapterVersion: OZON_SELLER_API_DE_ADAPTER_VERSION,
    store: capabilities.store,
    capabilities,

    async executeSellerApi(request) {
      const invalid = validateExecutionRequest(request, capabilities);
      if (invalid) return knownPrewriteRejection(invalid);

      let importResponse;
      try {
        importResponse = await call({
          endpoint: OZON_PRODUCT_IMPORT_ENDPOINT,
          body: request.productImport.body,
          write: true,
          executionKey: request.executionKey
        });
      } catch (error) {
        return unknownOutcome("product_import_transport", error.message);
      }
      const taskId = String(importResponse?.result?.task_id || "");
      if (!nonEmpty(taskId)) return unknownOutcome("product_import_receipt", "task_id_missing");

      let taskResponse;
      try {
        taskResponse = await call({
          endpoint: OZON_PRODUCT_IMPORT_INFO_ENDPOINT,
          body: { task_id: taskId },
          write: false,
          executionKey: request.executionKey
        });
      } catch (error) {
        return unknownOutcome("product_import_readback_transport", error.message);
      }
      const taskItems = taskResponse?.result?.items;
      const taskItem = itemForOffer(taskItems, request.merchantSku);
      const taskProductId = productIdOf(taskItem);
      if (!taskItem || taskItems.length !== 1 || taskItem.status !== "imported" ||
          (Array.isArray(taskItem.errors) && taskItem.errors.length > 0) || !positiveIntegerLike(taskProductId)) {
        return unknownOutcome("product_import_identity", "terminal_import_receipt_incomplete");
      }

      const stockBody = {
        stocks: [{
          offer_id: request.merchantSku,
          stock: 100,
          warehouse_id: Number(capabilities.warehouseId)
        }]
      };
      let inventoryResponse;
      try {
        inventoryResponse = await call({
          endpoint: OZON_INVENTORY_WRITE_ENDPOINT,
          body: stockBody,
          write: true,
          executionKey: request.executionKey
        });
      } catch (error) {
        return unknownOutcome("inventory_write_transport", error.message);
      }
      const inventoryItems = inventoryResponse?.result;
      const inventoryItem = itemForOffer(inventoryItems, request.merchantSku);
      if (!inventoryItem || inventoryItems.length !== 1 || inventoryItem.updated !== true ||
          (Array.isArray(inventoryItem.errors) && inventoryItem.errors.length > 0) ||
          String(inventoryItem.warehouse_id || "") !== capabilities.warehouseId ||
          productIdOf(inventoryItem) !== taskProductId) {
        return unknownOutcome("inventory_write_receipt", "inventory_receipt_incomplete_or_identity_mismatch");
      }
      return freeze({
        status: "accepted",
        productId: taskProductId,
        offerId: request.merchantSku,
        requestReceiptRef: receipt("ozon-import-receipt", { taskId, taskItem, evidenceRef: capabilities.productImport.evidenceRef }),
        inventoryReceiptRef: receipt("ozon-inventory-receipt", { inventoryItem, evidenceRef: capabilities.inventoryWrite.evidenceRef }),
        retryAllowed: false
      });
    },

    async readbackSellerApi(query) {
      const store = normalizeStore(query?.store);
      const offerId = String(query?.merchantSku || "");
      const supplierSkuId = String(query?.supplierSkuId || "");
      const expectedProductId = String(query?.platformProductId || "");
      if (query?.platform !== "ozon" || store !== capabilities.store || query?.writeAllowed !== false ||
          !nonEmpty(offerId) || supplierSkuId !== offerId || !positiveIntegerLike(expectedProductId)) {
        throw new Error("OZON_DE_READBACK_SCOPE_REJECTED: 店铺或商品身份未锁定");
      }
      const requests = [
        ["attributes", READBACK_ENDPOINTS.attributes, { filter: { offer_id: [offerId], visibility: "ALL" }, limit: 10, sort_dir: "ASC" }],
        ["info", READBACK_ENDPOINTS.info, { offer_id: [offerId] }],
        ["prices", READBACK_ENDPOINTS.prices, { cursor: "", filter: { offer_id: [offerId], visibility: "ALL" }, limit: 10 }],
        ["stocks", READBACK_ENDPOINTS.stocks, { cursor: "", filter: { offer_id: [offerId] }, limit: 10 }],
        ["stateFailed", READBACK_ENDPOINTS.stateFailed, { filter: { offer_id: [offerId], product_id: [Number(expectedProductId)], visibility: "STATE_FAILED" }, last_id: "", limit: 10 }]
      ];
      const responses = {};
      for (const [name, endpoint, body] of requests) {
        responses[name] = await call({ endpoint, body, write: false });
      }
      const attrItem = itemForOffer(responses.attributes?.result, offerId);
      const infoItem = itemForOffer(responses.info?.items, offerId);
      const priceItem = itemForOffer(responses.prices?.items, offerId);
      const stockItem = itemForOffer(responses.stocks?.items, offerId);
      const failedItems = responses.stateFailed?.result?.items;
      if (!Array.isArray(failedItems)) throw new Error("OZON_DE_READBACK_STATE_FAILED_INVALID: 失败队列响应不完整");
      const stateFailedItem = itemForOffer(failedItems, offerId);
      for (const [name, item] of [["attributes", attrItem], ["info", infoItem], ["prices", priceItem], ["stocks", stockItem]]) {
        if (!item || productIdOf(item) !== expectedProductId) throw new Error(`OZON_DE_READBACK_IDENTITY_MISMATCH: ${name}`);
      }
      const currentPrice = priceOf(priceItem);
      const currentStock = availableStock(stockItem);
      if (!currentPrice) throw new Error("OZON_DE_READBACK_PRICE_INVALID: 未取得CNY当前价格");
      if (!Number.isInteger(currentStock) || currentStock < 0) throw new Error("OZON_DE_READBACK_STOCK_INVALID: 未取得available库存");
      const images = uniqueImageUrls(attrItem.primary_image, attrItem.images);
      if (images.length === 0) throw new Error("OZON_DE_READBACK_IMAGES_INVALID: 未取得平台图片");
      const errors = mergeErrors(infoItem, stateFailedItem);
      const observation = {
        platform: "ozon",
        store: capabilities.store,
        skuPackageId: String(query.skuPackageId || ""),
        supplierSkuId,
        merchantSku: offerId,
        platformProductId: expectedProductId,
        currentPrice,
        currentStock,
        imageCount: images.length,
        moderationStatus: String(infoItem.statuses?.moderate_status || "unknown"),
        validationStatus: String(infoItem.statuses?.validation_status || "unknown"),
        saleStatus: saleStatus(infoItem),
        errors,
        platformEvidenceRef: receipt("ozon-independent-readback", {
          store: capabilities.store,
          offerId,
          expectedProductId,
          currentPrice,
          currentStock,
          images,
          statuses: infoItem.statuses,
          errors,
          evidenceRef: capabilities.independentReadback.evidenceRef
        })
      };
      return freeze(observation);
    }
  });
}

export const OZON_DE_READBACK_ENDPOINTS = READBACK_ENDPOINTS;
