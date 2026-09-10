export const C2_MEDIA_CONTENT_RULES_VERSION = "c2-media-content-rules-v1";
const MIME_TYPES = Object.freeze({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4" });
const LIMIT_FIELDS = ["byteSize", "width", "height", "aspectRatio"];

function invalid(message) { throw new Error(`C2_MEDIA_CONTENT_RULES_INVALID: ${message}`); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.trim().length > 0; }
function exact(value, fields) {
  return object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function instant(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }

// Absent rules remain absent so loading old snapshots never rewrites their fingerprints.
export function assertC2MediaContentRules(rules, slots) {
  if (rules === undefined) return;
  if (rules?.status === "missing") {
    if (!exact(rules, ["schemaVersion", "status", "reason"]) || rules.schemaVersion !== C2_MEDIA_CONTENT_RULES_VERSION || !text(rules.reason)) invalid("缺失原因未明确");
    return;
  }
  if (!exact(rules, ["schemaVersion", "status", "evidenceRef", "evidenceVersion", "checkedAt", "validUntil", "slotRules"]) ||
      rules.schemaVersion !== C2_MEDIA_CONTENT_RULES_VERSION || rules.status !== "verified" || !text(rules.evidenceRef) || !text(rules.evidenceVersion) ||
      !instant(rules.checkedAt) || !instant(rules.validUntil) || Date.parse(rules.validUntil) <= Date.parse(rules.checkedAt) ||
      !Array.isArray(rules.slotRules) || !rules.slotRules.length || new Set(rules.slotRules.map(rule => rule?.slotId)).size !== rules.slotRules.length) invalid("内容规则、来源或有效期不完整");
  for (const rule of rules.slotRules) {
    if (!exact(rule, ["slotId", "mediaType", "mimeTypes", ...LIMIT_FIELDS]) || !slots.some(slot => slot.slotId === rule.slotId && slot.mediaType === rule.mediaType) ||
        !Array.isArray(rule.mimeTypes) || !rule.mimeTypes.length || new Set(rule.mimeTypes).size !== rule.mimeTypes.length ||
        rule.mimeTypes.some(mime => !Object.values(MIME_TYPES).includes(mime) || !mime.startsWith(`${rule.mediaType}/`))) invalid("槽位或文件格式不属于当前媒体合同");
    for (const field of LIMIT_FIELDS) {
      const limit = rule[field];
      const number = value => field === "aspectRatio" ? Number.isFinite(value) : Number.isSafeInteger(value);
      if (!exact(limit, ["min", "max"]) || !number(limit.min) || limit.min < 0 ||
          (limit.max !== "unrestricted" && (!number(limit.max) || limit.max <= 0 || limit.max < limit.min))) invalid(`${field}必须明确上下限，缺失不能表示无限制`);
    }
  }
}

export function assertC2FinalMediaContent({ mediaRequirements, assets, checkedAt }) {
  const slots = [...(mediaRequirements?.imageSlots || []), ...(mediaRequirements?.videoSlots || [])];
  const rules = mediaRequirements?.contentRules;
  assertC2MediaContentRules(rules, slots);
  if (rules?.status !== "verified") throw new Error("C2_MEDIA_CONTENT_RULES_MISSING: 尚未取得平台素材格式、大小和尺寸规则，素材可保存，暂不能最终确认");
  if (!instant(checkedAt) || Date.parse(checkedAt) < Date.parse(rules.checkedAt) || Date.parse(checkedAt) > Date.parse(rules.validUntil)) {
    throw new Error("C2_MEDIA_CONTENT_RULES_EXPIRED: 平台媒体规则不在本次确认的有效期内");
  }
  for (const asset of assets) {
    const rule = rules.slotRules.find(item => item.slotId === asset.slotId && item.mediaType === asset.mediaType);
    if (!rule) throw new Error("C2_MEDIA_CONTENT_RULES_MISSING: 已选素材槽位缺少平台内容规则");
    const extension = typeof asset.fileName === "string" ? asset.fileName.split(".").at(-1).toLowerCase() : "";
    if (!rule.mimeTypes.includes(MIME_TYPES[extension])) throw new Error("C2_MEDIA_FORMAT_REJECTED: 素材格式不满足已选槽位的平台规则");
    if (!["byteSize", "width", "height"].every(field => Number.isSafeInteger(asset[field]) && asset[field] > 0)) {
      throw new Error("C2_MEDIA_OBSERVATION_MISSING: 最终素材缺少实际文件大小或像素尺寸");
    }
    const observed = { byteSize: asset.byteSize, width: asset.width, height: asset.height, aspectRatio: asset.width / asset.height };
    for (const field of LIMIT_FIELDS) {
      if (observed[field] < rule[field].min || (rule[field].max !== "unrestricted" && observed[field] > rule[field].max)) {
        throw new Error(`C2_MEDIA_CONTENT_REJECTED: ${field}不满足已选槽位的平台规则`);
      }
    }
  }
}

function rangeSchema(integer) {
  const numeric = { type: integer ? "integer" : "number", minimum: 0 };
  return { type: "object", additionalProperties: false, required: ["min", "max"], properties: {
    min: numeric, max: { oneOf: [{ ...numeric, exclusiveMinimum: 0 }, { const: "unrestricted" }] }
  } };
}
export const C2_MEDIA_CONTENT_RULES_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["schemaVersion", "status", "reason"], properties: {
      schemaVersion: { const: C2_MEDIA_CONTENT_RULES_VERSION }, status: { const: "missing" }, reason: { type: "string", minLength: 1 }
    } },
    { type: "object", additionalProperties: false, required: ["schemaVersion", "status", "evidenceRef", "evidenceVersion", "checkedAt", "validUntil", "slotRules"], properties: {
      schemaVersion: { const: C2_MEDIA_CONTENT_RULES_VERSION }, status: { const: "verified" },
      evidenceRef: { type: "string", minLength: 1 }, evidenceVersion: { type: "string", minLength: 1 },
      checkedAt: { type: "string", format: "date-time" }, validUntil: { type: "string", format: "date-time" },
      slotRules: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["slotId", "mediaType", "mimeTypes", ...LIMIT_FIELDS], properties: {
          slotId: { type: "string", minLength: 1 }, mediaType: { enum: ["image", "video"] },
          mimeTypes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...new Set(Object.values(MIME_TYPES))] } },
          byteSize: rangeSchema(true), width: rangeSchema(true), height: rangeSchema(true), aspectRatio: rangeSchema(false)
        }
      } }
    } }
  ]
};
