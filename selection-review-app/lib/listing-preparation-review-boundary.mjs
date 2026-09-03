const LISTING_REVIEW_STATUSES = new Set(["prepared", "blocked", "needs_decision"]);
const CANDIDATE_INHERITED_FIELDS = Object.freeze(["sourceUrl", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"]);
const CANDIDATE_C_STAGE_FIELDS = Object.freeze(["materialsAndAge", "powered", "complianceStatus", "authorizationStatus"]);
const CANDIDATE_DATA_FIELDS = new Set([...CANDIDATE_INHERITED_FIELDS, ...CANDIDATE_C_STAGE_FIELDS]);
const PREPARATION_FIELDS = new Set(["exactSourceSku", "category", "schemaEvidence", "finalPrice", "assets"]);
const RISK_STATUSES = new Set(["clear", "needs_confirmation"]);
const POWERED_VALUES = new Set([true, false, "unknown"]);

function boundaryError(status, message, code) {
  return Object.assign(new Error(message), { status, extra: code ? { code } : {} });
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw boundaryError(400, `${label}必须是对象`, "listing_review_input_invalid");
  }
  return value;
}

function optionalText(value, field, { maxLength = 1_000 } = {}) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") throw boundaryError(400, `${field}文本无效`, "listing_review_text_invalid");
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw boundaryError(400, `${field}文本无效`, "listing_review_text_invalid");
  }
  return normalized;
}

function requiredText(value, field, options) {
  const normalized = optionalText(value, field, options);
  if (!normalized) throw boundaryError(400, `${field}不能为空`, "listing_review_text_required");
  return normalized;
}

function optionalNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw boundaryError(400, `${field}必须是非负数字`, "listing_review_number_invalid");
  }
  return value;
}

function normalizeDimensions(value) {
  if (value === null || value === undefined) return { length: null, width: null, height: null };
  const dimension = assertPlainObject(value, "dimensionsCm");
  const allowed = new Set(["length", "width", "height"]);
  for (const key of Object.keys(dimension)) {
    if (!allowed.has(key)) throw boundaryError(400, "dimensionsCm包含未声明字段", "listing_review_candidate_data_invalid");
  }
  return Object.freeze({
    length: optionalNumber(dimension.length, "dimensionsCm.length"),
    width: optionalNumber(dimension.width, "dimensionsCm.width"),
    height: optionalNumber(dimension.height, "dimensionsCm.height")
  });
}

function normalizeCandidateData(value) {
  if (value === null || value === undefined) return Object.freeze({});
  const input = assertPlainObject(value, "candidateData");
  const output = {};
  for (const [field, fieldValue] of Object.entries(input)) {
    if (!CANDIDATE_DATA_FIELDS.has(field)) {
      throw boundaryError(400, "C阶段候选字段不允许写入", "listing_review_candidate_data_forbidden");
    }
    if (field === "sourceUrl") output.sourceUrl = optionalText(fieldValue, field, { maxLength: 2_000 });
    else if (["purchasePriceRmb", "packedWeightKg"].includes(field)) output[field] = optionalNumber(fieldValue, field);
    else if (field === "dimensionsCm") output.dimensionsCm = normalizeDimensions(fieldValue);
    else if (["materialsAndAge"].includes(field)) output[field] = optionalText(fieldValue, field, { maxLength: 500 });
    else if (field === "powered") {
      if (!POWERED_VALUES.has(fieldValue)) throw boundaryError(400, "powered只能是true、false或unknown", "listing_review_powered_invalid");
      output.powered = fieldValue;
    } else if (["complianceStatus", "authorizationStatus"].includes(field)) {
      if (typeof fieldValue !== "string" || !RISK_STATUSES.has(fieldValue.trim())) {
        throw boundaryError(400, `${field}只能是clear或needs_confirmation`, "listing_review_risk_status_invalid");
      }
      output[field] = fieldValue.trim();
    }
  }
  return Object.freeze(output);
}

function normalizeEvidencePackIds(value) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw boundaryError(400, "evidencePackIds必须是数组", "listing_review_evidence_invalid");
  return Object.freeze([...new Set(value.map((item) => requiredText(item, "evidencePackId", { maxLength: 180 })))]);
}

function normalizePreparation(value) {
  const input = assertPlainObject(value, "preparation");
  for (const key of Object.keys(input)) {
    if (!PREPARATION_FIELDS.has(key)) {
      throw boundaryError(400, "C阶段preparation包含未声明字段", "listing_review_preparation_forbidden");
    }
  }
  if (!Array.isArray(input.assets)) {
    throw boundaryError(400, "C阶段preparation.assets必须是数组", "listing_review_preparation_assets_invalid");
  }
  const assets = input.assets.map((item) => requiredText(item, "preparation.assets", { maxLength: 2_000 }));
  return Object.freeze({
    exactSourceSku: requiredText(input.exactSourceSku, "preparation.exactSourceSku", { maxLength: 500 }),
    category: requiredText(input.category, "preparation.category", { maxLength: 500 }),
    schemaEvidence: requiredText(input.schemaEvidence, "preparation.schemaEvidence", { maxLength: 1_000 }),
    finalPrice: requiredText(input.finalPrice, "preparation.finalPrice", { maxLength: 500 }),
    assets: Object.freeze(assets)
  });
}

export function normalizeListingPreparationReviewInput(input) {
  const body = assertPlainObject(input, "listingPreparationReview");
  if (!Number.isInteger(body.dataRevision)) throw boundaryError(400, "C阶段回写必须提供当前数据修订号", "listing_review_revision_required");
  if (!LISTING_REVIEW_STATUSES.has(body.status)) throw boundaryError(400, "C阶段状态无效", "listing_review_status_invalid");
  if (Object.hasOwn(body, "codexReview")) {
    throw boundaryError(422, "C阶段回写不能覆盖B阶段Codex审核事实；请写入listingPreparation边界字段", "listing_review_codex_review_forbidden");
  }
  return Object.freeze({
    dataRevision: body.dataRevision,
    runId: optionalText(body.runId, "runId", { maxLength: 180 }),
    status: body.status,
    candidateData: normalizeCandidateData(body.candidateData),
    evidencePackIds: normalizeEvidencePackIds(body.evidencePackIds),
    sourceCaptureId: optionalText(body.sourceCaptureId, "sourceCaptureId", { maxLength: 180 }),
    preparation: body.status === "prepared" ? normalizePreparation(body.preparation) : null,
    reason: body.status === "prepared" ? "" : requiredText(body.reason, "reason", { maxLength: 2_000 }),
    decisionItems: Object.freeze(Array.isArray(body.decisionItems)
      ? body.decisionItems.map((item) => optionalText(item, "decisionItems", { maxLength: 300 })).filter(Boolean).slice(0, 6)
      : []),
    userAction: optionalText(body.userAction, "userAction", { maxLength: 500 }),
    failureLayer: optionalText(body.failureLayer, "failureLayer", { maxLength: 120 }) || "business_preflight",
    writeOccurred: body.writeOccurred === true
  });
}

export function listingPreparationInheritedFields() {
  return [...CANDIDATE_INHERITED_FIELDS];
}

export function listingPreparationCStageFields() {
  return [...CANDIDATE_C_STAGE_FIELDS];
}
