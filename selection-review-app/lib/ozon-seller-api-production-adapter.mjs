import { createHash } from "node:crypto";

export const OZON_SELLER_API_ADAPTER_VERSION = "ozon-seller-api-production-adapter-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unwrap(value) {
  return isObject(value) && Object.hasOwn(value, "value") ? value.value : value;
}

function numberId(value, code) {
  const parsed = Number(unwrap(value));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${code}: 必须是当前Schema确认的正整数ID`);
  return parsed;
}

function unitToMm(value, unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "mm") return value;
  if (normalized === "cm") return value * 10;
  if (normalized === "m") return value * 1000;
  throw new Error("OZON_ADAPTER_PACKING_UNIT_REJECTED: 尺寸单位必须是mm、cm或m");
}

function weightToGrams(value, unit) {
  const normalized = String(unit || "").toLowerCase();
  if (normalized === "g") return value;
  if (normalized === "kg") return value * 1000;
  throw new Error("OZON_ADAPTER_WEIGHT_UNIT_REJECTED: 重量单位必须是g或kg");
}

function textAttribute(binding, value) {
  if (!isObject(binding) || !Number.isInteger(binding.attributeId) || binding.attributeId <= 0 ||
      !Number.isInteger(binding.complexId) || binding.complexId < 0 || binding.dictionaryId !== 0) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: 普通文字字段缺少当前Schema写入绑定");
  }
  return {
    id: binding.attributeId,
    complex_id: binding.complexId,
    values: [{ dictionary_value_id: 0, value: String(value) }]
  };
}

function schemaBindings(value) {
  if (!isObject(value) || !nonEmpty(value.schemaRevision) || !nonEmpty(value.evidenceRef) ||
      !isObject(value.content) || !Array.isArray(value.requiredAttributes)) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: 未锁定当前Schema写入方式");
  }
  for (const binding of [...Object.values(value.content), ...value.requiredAttributes]) {
    if (!isObject(binding) || !nonEmpty(binding.fieldKey) || !Number.isInteger(binding.attributeId) || binding.attributeId <= 0 ||
        !Number.isInteger(binding.complexId) || binding.complexId < 0 ||
        !Number.isInteger(binding.dictionaryId) || binding.dictionaryId < 0) {
      throw new Error("OZON_ADAPTER_SCHEMA_BINDING_REJECTED: Schema字段绑定无效");
    }
  }
  return value;
}

function boundFactAttribute(field, binding) {
  const fact = field?.fact;
  if (!isObject(fact) || fact.verificationStatus !== "confirmed" || unwrap(fact) === "unknown") {
    throw new Error(`OZON_ADAPTER_REQUIRED_ATTRIBUTE_UNKNOWN: ${field?.fieldKey || "unknown"}`);
  }
  const raw = fact.value;
  if (binding.dictionaryId === 0) {
    const text = isObject(raw) ? raw.value : raw;
    if (!nonEmpty(String(text ?? ""))) throw new Error(`OZON_ADAPTER_REQUIRED_ATTRIBUTE_VALUE_INVALID: ${field.fieldKey}`);
    return textAttribute(binding, text);
  }
  if (!isObject(raw) || !Number.isInteger(raw.dictionaryValueId) || raw.dictionaryValueId <= 0 || !nonEmpty(raw.value)) {
    throw new Error(`OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED: ${field.fieldKey}`);
  }
  return {
    id: binding.attributeId,
    complex_id: binding.complexId,
    values: [{ dictionary_value_id: raw.dictionaryValueId, value: raw.value }]
  };
}

function requiredAttributes(attributes, bindings) {
  const fields = attributes?.requiredPlatformFields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("OZON_ADAPTER_REQUIRED_ATTRIBUTES_MISSING: 没有锁定平台必填属性");
  }
  const byKey = new Map(bindings.requiredAttributes.map((binding) => [binding.fieldKey, binding]));
  if (byKey.size !== fields.length || fields.some((field) => !byKey.has(field.fieldKey))) {
    throw new Error("OZON_ADAPTER_SCHEMA_BINDING_MISMATCH: 必填属性与当前Schema绑定不一致");
  }
  return fields.map((field) => boundFactAttribute(field, byKey.get(field.fieldKey)));
}

function assertRemoteAssets(finalUploads) {
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    throw new Error("OZON_ADAPTER_FINAL_ASSETS_MISSING: 没有主人确认的最终素材");
  }
  for (const asset of finalUploads) {
    if (asset?.ownerConfirmed !== true || asset?.productionEligible !== true || !nonEmpty(asset.assetId) || !/^https:\/\//i.test(String(asset.assetRef || ""))) {
      throw new Error("OZON_ADAPTER_REMOTE_ASSET_REQUIRED: Seller API只接受已确认的HTTPS最终素材地址");
    }
  }
}

function evidenceRef(prefix, value) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

export function buildOzonSellerImportRequest(payload) {
  if (!isObject(payload) || payload.platform !== "ozon") throw new Error("OZON_ADAPTER_PLATFORM_REJECTED: 只支持Ozon");
  if (payload.mode !== "single_sku_create_and_moderate" || payload.publishScope !== "create_and_allow_validation_moderation") {
    throw new Error("OZON_ADAPTER_SCOPE_REJECTED: Seller API商品导入会进入校验/审核，不支持伪装成仅保存草稿");
  }
  if (payload.platformWritePrice?.currency !== "CNY" || !Number.isFinite(payload.platformWritePrice?.amount) || payload.platformWritePrice.amount <= 0) {
    throw new Error("OZON_ADAPTER_PRICE_REJECTED: Ozon中国卖家后台价格必须是正数CNY");
  }
  if (!nonEmpty(payload.title) || !isObject(payload.content) || !nonEmpty(payload.content.description)) {
    throw new Error("OZON_ADAPTER_CONTENT_GAP: 标题或描述未锁定");
  }
  if (!isObject(payload.packing?.weight) || !isObject(payload.packing?.dimensions)) {
    throw new Error("OZON_ADAPTER_PACKING_GAP: 包装重量或尺寸未锁定");
  }
  assertRemoteAssets(payload.finalUploads);

  const descriptionCategoryId = numberId(payload.platformCategory?.descriptionCategoryId, "OZON_ADAPTER_CATEGORY_REJECTED");
  const typeId = numberId(payload.platformCategory?.typeId, "OZON_ADAPTER_TYPE_REJECTED");
  const bindings = schemaBindings(payload.schemaWriteBindings);
  const dimensions = payload.packing.dimensions;
  const weight = payload.packing.weight;
  const required = requiredAttributes(payload.attributes, bindings);
  const description = [payload.content.description, ...(payload.content.bulletPoints || [])].filter(nonEmpty).join("\n\n");
  const keywords = (payload.content.searchKeywords || []).filter(nonEmpty).join(" ");
  if (!keywords) throw new Error("OZON_ADAPTER_CONTENT_GAP: 搜索词未锁定");

  const generated = [
    textAttribute(bindings.content.title, payload.title),
    textAttribute(bindings.content.description, description),
    textAttribute(bindings.content.searchKeywords, keywords)
  ];
  const allIds = [...required, ...generated].map((item) => item.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("OZON_ADAPTER_SCHEMA_BINDING_MISMATCH: 内容字段与必填属性ID冲突");
  const byId = new Map([...required, ...generated].map((item) => [item.id, item]));
  const urls = payload.finalUploads.map((asset) => asset.assetRef);
  const item = {
    attributes: [...byId.values()],
    barcode: "",
    description_category_id: descriptionCategoryId,
    new_description_category_id: descriptionCategoryId,
    color_image: "",
    complex_attributes: [],
    currency_code: "CNY",
    depth: Math.round(unitToMm(Number(dimensions.length), dimensions.unit)),
    dimension_unit: "mm",
    height: Math.round(unitToMm(Number(dimensions.height), dimensions.unit)),
    images: urls.slice(1),
    name: payload.title,
    offer_id: payload.supplierSkuId,
    old_price: "",
    pdf_list: [],
    price: payload.platformWritePrice.amount.toFixed(2),
    primary_image: urls[0],
    type_id: typeId,
    vat: "0.00",
    weight: Math.round(weightToGrams(Number(weight.value), weight.unit)),
    weight_unit: "g",
    width: Math.round(unitToMm(Number(dimensions.width), dimensions.unit))
  };
  for (const field of ["depth", "height", "weight", "width"]) {
    if (!Number.isFinite(item[field]) || item[field] <= 0) throw new Error(`OZON_ADAPTER_PACKING_GAP: ${field}无效`);
  }
  return Object.freeze({
    adapterVersion: OZON_SELLER_API_ADAPTER_VERSION,
    schemaWriteBindings: structuredClone(bindings),
    endpoint: "/v3/product/import",
    body: { items: [item] },
    batchSize: 1,
    inventoryIncluded: false,
    published: false,
    activated: false
  });
}

function importItem(payload, offerId) {
  const items = payload?.result?.items;
  return Array.isArray(items) ? items.find((item) => String(item?.offer_id || "") === offerId) : null;
}

export function createOzonSellerApiProductionAdapter({ requestJson }) {
  if (typeof requestJson !== "function") throw new Error("OZON_ADAPTER_TRANSPORT_REQUIRED: 缺少受控店铺传输器");
  const submitted = new Map();
  return Object.freeze({
    async createPlatformDraft(payload) {
      const request = buildOzonSellerImportRequest(payload);
      const offerId = String(payload.supplierSkuId);
      const imported = await requestJson({ store: payload.store, method: "POST", endpoint: request.endpoint, body: request.body, write: true });
      const taskId = imported?.result?.task_id;
      if (!nonEmpty(String(taskId || ""))) throw new Error("OZON_ADAPTER_IMPORT_RESPONSE_INVALID: 平台未返回task_id，结果未知");
      const info = await requestJson({ store: payload.store, method: "POST", endpoint: "/v1/product/import/info", body: { task_id: taskId }, write: false });
      const item = importItem(info, offerId);
      if (!item || item.status === "pending") throw new Error("OZON_ADAPTER_IMPORT_PENDING_UNKNOWN_OUTCOME: 单次状态回读未取得终态，禁止自动轮询");
      if (item.status === "failed" || (Array.isArray(item.errors) && item.errors.length > 0)) {
        throw new Error("OZON_ADAPTER_IMPORT_REJECTED: Ozon校验未通过");
      }
      const productId = String(item.product_id || item.productId || "");
      if (!nonEmpty(productId)) throw new Error("OZON_ADAPTER_PRODUCT_ID_MISSING: 导入终态没有商品ID");
      submitted.set(productId, {
        store: payload.store,
        offerId,
        title: payload.title,
        price: structuredClone(payload.platformWritePrice),
        finalUploads: structuredClone(payload.finalUploads)
      });
      return {
        status: "validation_or_moderation",
        productId,
        offerId,
        writeEvidenceRef: evidenceRef("ozon-seller-api:import", { taskId: String(taskId), productId, offerId }),
        moderationSubmitted: true,
        published: false,
        activated: false,
        advertisingOpened: false,
        inventoryModified: false,
        imagesUploaded: payload.finalUploads.length
      };
    },
    async readbackPlatformDraft(request) {
      const expected = submitted.get(String(request.productId));
      if (!expected) throw new Error("OZON_ADAPTER_READBACK_CONTEXT_MISSING: 当前进程没有该单SKU提交上下文");
      const info = await requestJson({ store: expected.store, method: "POST", endpoint: "/v3/product/info/list", body: { offer_id: [expected.offerId] }, write: false });
      const attributes = await requestJson({ store: expected.store, method: "POST", endpoint: "/v4/product/info/attributes", body: { filter: { offer_id: [expected.offerId], visibility: "ALL" }, limit: 10, sort_dir: "ASC" }, write: false });
      const item = (info?.items || []).find((entry) => String(entry?.offer_id || "") === expected.offerId);
      const attrItem = (attributes?.result || []).find((entry) => String(entry?.offer_id || "") === expected.offerId);
      const observedImages = [attrItem?.primary_image, ...(attrItem?.images || [])].filter(nonEmpty);
      if (!item || String(item.id || item.product_id || "") !== String(request.productId)) throw new Error("OZON_ADAPTER_READBACK_IDENTITY_MISMATCH: 商品ID或货号不一致");
      if (observedImages.length !== expected.finalUploads.length) throw new Error("OZON_ADAPTER_READBACK_MEDIA_MISMATCH: 平台图片数量与授权素材不一致");
      const observedPrice = Number(item.price?.price ?? item.price ?? NaN);
      if (!Number.isFinite(observedPrice)) throw new Error("OZON_ADAPTER_READBACK_PRICE_MISSING: 平台未返回可核验价格");
      return {
        status: "validation_or_moderation",
        productId: String(request.productId),
        title: item.name,
        price: { amount: observedPrice, currency: "CNY" },
        inventoryModified: false,
        finalUploadAssetIds: expected.finalUploads.map((asset) => asset.assetId),
        mainImageAssetId: expected.finalUploads[0].assetId,
        evidenceRef: evidenceRef("ozon-seller-api:readback", { productId: String(request.productId), offerId: expected.offerId, observedImages }),
        moderationSubmitted: true,
        published: false,
        activated: false
      };
    }
  });
}
