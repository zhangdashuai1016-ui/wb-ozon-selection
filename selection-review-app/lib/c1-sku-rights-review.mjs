import { isDeepStrictEqual } from "node:util";
import { isCompleteStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, isCanonicalFrozenRef, C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS } from "./production-contract-primitives.mjs";

export const C1_SKU_RIGHTS_REVIEW_VERSION = "c1-sku-rights-review-v1";
export const C1_SKU_RIGHTS_REVIEW_RECORD_VERSION = "c1-sku-rights-review-record-v1";
export const C1_CURRENT_FACT_VERIFICATION_VERSION = "c1-fact-verification-v1.2";
export const C1_SKU_RIGHTS_REVIEW_FAILURE_CODES = Object.freeze([
  "C1_SKU_RIGHTS_REVIEW_INVALID", "C1_SKU_RIGHTS_REVIEW_UNSAFE", "C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH",
  "C1_SKU_RIGHTS_REVIEW_TIME_INVALID", "C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID", "C1_SKU_RIGHTS_REVIEW_EXPIRED",
  "C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT", "C1_SKU_RIGHTS_REVIEW_REQUIRED", "C1_SKU_RIGHTS_REVIEW_PROJECTION_DRIFT",
  "C1_SKU_RIGHTS_REVIEW_BLOCKED", "C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED", "C1_SKU_RIGHTS_REVIEW_UNKNOWN"
]);
const IDENTITY_FIELDS = ["schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId", "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"];
const REVIEW_FIELDS = ["schemaVersion", "reviewId", "sourceIdentity", "variantKey", "sourceSkuRevision", "sourceSupplySnapshotId", "reviewedAt", "expiresAt", "brand", "rights"];
const OUTCOMES = ["verified", "unknown", "blocked", "requires_authorization"];
const BASES = ["owned", "licensed", "no_third_party_rights_identified"];
const MISSING_REFS = ["unknown", "null", "undefined", "not_applicable", "missing"];
function exact(value, fields) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)); }
function text(value) { return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value); }
function reference(value) { return isCanonicalFrozenRef(value) && !MISSING_REFS.includes(value.toLowerCase()); }
function instant(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function evidenceRefs(value) { return Array.isArray(value) && value.length <= 16 && value.every(reference) && new Set(value).size === value.length; }
function identity(value) {
  return exact(value, IDENTITY_FIELDS) && value.schemaVersion === "g1-identity-v1" && ["ozon", "wb"].includes(value.platform) &&
    ["candidateId", "skuPackageId", "supplierSkuId"].every(key => reference(value[key])) && isCompleteStoreRef(value.storeRef, value.storeRef?.stableStoreId) &&
    Object.values(value.storeRef).every(reference) && ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"].every(key => value[key] === "not_applicable");
}
export class C1SkuRightsReviewError extends Error {
  constructor(code) { super(code); this.name = "C1SkuRightsReviewError"; this.code = code; }
}
function reject(code) { throw new C1SkuRightsReviewError(code); }

/** References are traceability bindings. This validator does not consult a rights database or prove a licence. */
export function validateC1SkuRightsReview(review, context = {}) {
  const errors = [];
  if (!exact(review, REVIEW_FIELDS) || review.schemaVersion !== C1_SKU_RIGHTS_REVIEW_VERSION || !reference(review.reviewId) ||
      !identity(review.sourceIdentity) || !text(review.variantKey) || !Number.isSafeInteger(review.sourceSkuRevision) || review.sourceSkuRevision < 0 ||
      !reference(review.sourceSupplySnapshotId) || !instant(review.reviewedAt) || !instant(review.expiresAt) || Date.parse(review.reviewedAt) >= Date.parse(review.expiresAt) ||
      !exact(review.brand, ["status", "name", "evidenceRefs"]) || !["branded", "unbranded", "unknown"].includes(review.brand.status) ||
      !evidenceRefs(review.brand.evidenceRefs) || (review.brand.status === "branded" ? !text(review.brand.name) : review.brand.name !== null) ||
      (review.brand.status !== "unknown" && review.brand.evidenceRefs.length === 0) ||
      !exact(review.rights, ["status", "basis", "evidenceRefs"]) || !OUTCOMES.includes(review.rights.status) || !evidenceRefs(review.rights.evidenceRefs) ||
      (review.rights.status === "verified" ? !BASES.includes(review.rights.basis) || review.rights.evidenceRefs.length === 0 || review.brand.status === "unknown" : review.rights.basis !== null) ||
      (["blocked", "requires_authorization"].includes(review.rights.status) && review.rights.evidenceRefs.length === 0) ||
      (review.rights.basis === "no_third_party_rights_identified" && review.brand.status !== "unbranded")) {
    return { valid: false, errors: ["C1_SKU_RIGHTS_REVIEW_INVALID"] };
  }
  try { assertNoRawPersistenceKeys(review, "skuRightsReview", { errorCode: "C1_SKU_RIGHTS_REVIEW_UNSAFE" }); assertNoProductionSecrets(review, "skuRightsReview"); }
  catch (error) {
    if (!/^(PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C1_SKU_RIGHTS_REVIEW_UNSAFE|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)/.test(error.message)) throw error;
    return { valid: false, errors: ["C1_SKU_RIGHTS_REVIEW_UNSAFE"] };
  }
  for (const field of ["sourceIdentity", "variantKey", "sourceSkuRevision", "sourceSupplySnapshotId"]) {
    if (Object.hasOwn(context, field) && !isDeepStrictEqual(review[field], context[field])) errors.push("C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH");
  }
  if (Object.hasOwn(context, "observedAt")) {
    if (!instant(context.observedAt)) errors.push("C1_SKU_RIGHTS_REVIEW_TIME_INVALID");
    else if (Date.parse(context.observedAt) < Date.parse(review.reviewedAt)) errors.push("C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID");
    else if (Date.parse(context.observedAt) >= Date.parse(review.expiresAt)) errors.push("C1_SKU_RIGHTS_REVIEW_EXPIRED");
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function contextFor(plan, sourceIdentity, observedAt) {
  if (!plan?.identity || !plan.revisionRefs || !plan.inputRefs || !plan.inputSnapshots?.confirmedSupplierSkuSnapshot || !Array.isArray(plan.inputSnapshots?.platformSchemaRules?.requiredFields)) reject("C1_SKU_RIGHTS_REVIEW_INVALID");
  const seenFields = new Set();
  for (const field of plan.inputSnapshots.platformSchemaRules.requiredFields) {
    if (!field || typeof field !== "object" || Array.isArray(field) || typeof field.fieldKey !== "string" || field.fieldKey.trim().length === 0 ||
        typeof field.label !== "string" || field.label.trim().length === 0 || field.required !== true || seenFields.has(field.fieldKey)) {
      reject("C1_SKU_RIGHTS_REVIEW_INVALID");
    }
    seenFields.add(field.fieldKey);
    if (field.sourceAttributeKeys !== undefined) {
      if (!Array.isArray(field.sourceAttributeKeys)) reject("C1_SKU_RIGHTS_REVIEW_INVALID");
      for (const key of field.sourceAttributeKeys) {
        if (typeof key !== "string" || key.trim().length === 0) reject("C1_SKU_RIGHTS_REVIEW_INVALID");
      }
    }
  }
  return { sourceIdentity, variantKey: plan.identity.variantKey, sourceSkuRevision: plan.revisionRefs.resultRevision,
    sourceSupplySnapshotId: plan.inputRefs.selectedSupplySnapshotId, observedAt };
}

export function assertC1SkuRightsReviewEvidence({ review, plan, sourceIdentity, observedAt }) {
  const reuse = plan?.draftOnlySeo?.pricingReuseRecord;
  let reviewPlan = plan;
  if (reuse !== undefined) {
    const source = reuse?.sourcePlan;
    if (reuse.schemaVersion !== "c1-pricing-result-reuse-v1" || reuse.targetPlanId !== plan.c1PlanId ||
        reuse.targetProfitModelVersion !== plan.inputRefs.profitModelVersion || !source || source.draftOnlySeo?.pricingReuseRecord !== undefined ||
        !isDeepStrictEqual(source.identity, plan.identity) || !isDeepStrictEqual(reuse.sourceIdentity, sourceIdentity) ||
        !isDeepStrictEqual(source.inputSnapshots?.confirmedSupplierSkuSnapshot, plan.inputSnapshots.confirmedSupplierSkuSnapshot) ||
        !isDeepStrictEqual({ ...source.inputSnapshots?.platformSchemaRules, collectedAt: null }, { ...plan.inputSnapshots.platformSchemaRules, collectedAt: null }) ||
        !isDeepStrictEqual(source.inputSnapshots?.skuRightsReview, review)) reject("C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH");
    reviewPlan = source;
  }
  const result = validateC1SkuRightsReview(review, contextFor(reviewPlan, sourceIdentity, observedAt));
  if (!result.valid) reject(result.errors[0]);
  const attributes = plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku?.attributes;
  const declaredKeys = new Set(["brand", "品牌"]);
  for (const field of plan.inputSnapshots.platformSchemaRules.requiredFields) {
    if (field.fieldKey === "brand" && field.sourceAttributeKeys !== undefined) {
      for (const key of field.sourceAttributeKeys) declaredKeys.add(key);
    }
  }
  for (const key of declaredKeys) {
    const observed = attributes?.[key];
    if (observed === undefined || observed === null || observed === "" || observed === "unknown") continue;
    // Even a no-brand label is just an observed claim until this review supplies its own evidence.
    const unbranded = ["无品牌", "无牌", "Нет бренда", "no_brand"].includes(observed);
    if ((unbranded && review.brand.status !== "unbranded") || (!unbranded && (review.brand.status !== "branded" || review.brand.name !== observed))) {
      reject("C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT");
    }
  }
  return review;
}

export function projectC1SkuRightsReviewFacts(review, missingSourceRef) {
  const unknown = reason => ({ value: "unknown", verificationStatus: "unknown", sourceRefs: [missingSourceRef], reason });
  if (review === null) return { brand: unknown("sku_brand_review_missing"), rights: unknown("sku_rights_review_missing") };
  const known = (value, refs) => ({ value: structuredClone(value), verificationStatus: "confirmed", sourceRefs: [...refs], reason: null });
  return {
    brand: review.brand.status === "unknown" ? unknown("sku_brand_review_unknown") : known({ status: review.brand.status, name: review.brand.name }, review.brand.evidenceRefs),
    rights: review.rights.status === "unknown" ? unknown("sku_rights_review_unknown") : known({ status: review.rights.status, basis: review.rights.basis }, review.rights.evidenceRefs)
  };
}

/** Current action gate; callers must pass the trusted time of that action, never a historic review time. */
export function assertCurrentC1SkuRightsReview({ plan, sourceIdentity, observedAt }) {
  if (!instant(observedAt)) reject("C1_SKU_RIGHTS_REVIEW_TIME_INVALID");
  if (plan?.factVerificationVersion !== C1_CURRENT_FACT_VERIFICATION_VERSION || !plan.inputSnapshots || !Object.hasOwn(plan.inputSnapshots, "skuRightsReview")) reject("C1_SKU_RIGHTS_REVIEW_REQUIRED");
  const review = plan.inputSnapshots.skuRightsReview;
  if (review === null) reject("C1_SKU_RIGHTS_REVIEW_REQUIRED");
  assertC1SkuRightsReviewEvidence({ review, plan, sourceIdentity, observedAt });
  if (!isDeepStrictEqual(plan.platformCompliance?.skuRightsReview, projectC1SkuRightsReviewFacts(review, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`))) reject("C1_SKU_RIGHTS_REVIEW_PROJECTION_DRIFT");
  if (review.rights.status === "blocked") reject("C1_SKU_RIGHTS_REVIEW_BLOCKED");
  if (review.rights.status === "requires_authorization") reject("C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED");
  if (review.rights.status !== "verified" || review.brand.status === "unknown") reject("C1_SKU_RIGHTS_REVIEW_UNKNOWN");
  return review;
}

/** Server projection only: the browser displays this result without importing Node or reimplementing the gate. */
export function buildC1SkuRightsReviewView(input) {
  try { assertCurrentC1SkuRightsReview(input); return { status: "verified", code: null }; }
  catch (error) {
    if (!(error instanceof C1SkuRightsReviewError)) throw error;
    return rightsFailureView(error.code);
  }
}

function rightsFailureView(code) {
  let status = "invalid";
  if (["C1_SKU_RIGHTS_REVIEW_REQUIRED", "C1_SKU_RIGHTS_REVIEW_UNKNOWN", "C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID"].includes(code)) status = "unknown";
  if (["C1_SKU_RIGHTS_REVIEW_BLOCKED", "C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT"].includes(code)) status = "blocked";
  if (code === "C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED") status = "requires_authorization";
  if (code === "C1_SKU_RIGHTS_REVIEW_EXPIRED") status = "expired";
  return { status, code };
}

const RECORD_FIELDS = ["schemaVersion", "recordId", "c1PlanId", "sourceCandidateRevision", "resultCandidateRevision",
  "declaredByUserId", "declaredAt", "ownerDeclaration", "review"];

function declaredReview(record) {
  const { review, ownerDeclaration, recordId } = record;
  return { ...review, reviewId: `${recordId}:review`, reviewedAt: ownerDeclaration.reviewedAt, expiresAt: ownerDeclaration.expiresAt,
    brand: { ...ownerDeclaration.brand, evidenceRefs: [review.sourceSupplySnapshotId, `${recordId}#/ownerDeclaration/brand`] },
    rights: { ...ownerDeclaration.rights, evidenceRefs: [review.sourceSupplySnapshotId, `${recordId}#/ownerDeclaration/rights`] } };
}

/** Owner declarations are first-class evidence, not uploaded licence requirements or production authorization. */
export function validateC1SkuRightsReviewRecord(record, context = {}) {
  if (!exact(record, RECORD_FIELDS) || record.schemaVersion !== C1_SKU_RIGHTS_REVIEW_RECORD_VERSION ||
      !reference(record.recordId) || !reference(record.c1PlanId) || !reference(record.declaredByUserId) ||
      !Number.isSafeInteger(record.sourceCandidateRevision) || record.sourceCandidateRevision < 0 ||
      !Number.isSafeInteger(record.resultCandidateRevision) || record.resultCandidateRevision !== record.sourceCandidateRevision + 1 ||
      !instant(record.declaredAt) || !exact(record.ownerDeclaration, ["brand", "rights", "reviewedAt", "expiresAt"]) ||
      !exact(record.ownerDeclaration.brand, ["status", "name"]) || !exact(record.ownerDeclaration.rights, ["status", "basis"])) {
    return { valid: false, errors: ["C1_RIGHTS_RECORD_INVALID"] };
  }
  const result = validateC1SkuRightsReview(record.review, context);
  if (!result.valid) return result;
  if (record.recordId !== `c1-rights-declaration:${record.review.sourceIdentity.candidateId}:${record.resultCandidateRevision}` ||
      !isDeepStrictEqual(record.review, declaredReview(record)) || Date.parse(record.review.reviewedAt) > Date.parse(record.declaredAt)) {
    return { valid: false, errors: ["C1_RIGHTS_RECORD_DECLARATION_MISMATCH"] };
  }
  if (Object.hasOwn(context, "c1PlanId") && context.c1PlanId !== record.c1PlanId) {
    return { valid: false, errors: ["C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH"] };
  }
  try { assertNoRawPersistenceKeys(record, "c1RightsReviewRecord", { errorCode: "C1_SKU_RIGHTS_REVIEW_UNSAFE" }); assertNoProductionSecrets(record, "c1RightsReviewRecord"); }
  catch (error) {
    if (!/^(PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C1_SKU_RIGHTS_REVIEW_UNSAFE|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)/.test(error.message)) throw error;
    return { valid: false, errors: ["C1_SKU_RIGHTS_REVIEW_UNSAFE"] };
  }
  return { valid: true, errors: [] };
}

/** Validates persisted bindings; expiry and a known negative decision are deliberately saveable. */
export function assertC1SkuRightsReviewRecord({ record, plan, sourceIdentity }) {
  const context = contextFor(plan, sourceIdentity, null);
  delete context.observedAt;
  const result = validateC1SkuRightsReviewRecord(record, { ...context, c1PlanId: plan.c1PlanId });
  if (!result.valid) reject(result.errors[0]);
  const supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  if (supply.snapshotId !== record.review.sourceSupplySnapshotId || supply.supplierSku?.supplierSkuId !== sourceIdentity.supplierSkuId ||
      supply.supplierSku?.variantKey !== plan.identity.variantKey || supply.ownerSupplyConfirmation?.status !== "confirmed" ||
      supply.ownerSupplyConfirmation?.supplierSkuId !== sourceIdentity.supplierSkuId) reject("C1_RIGHTS_SOURCE_EVIDENCE_INVALID");
  return record;
}

export function createC1SkuRightsReviewRecord({ plan, sourceIdentity, sourceCandidateRevision, declaredByUserId, declaredAt, ownerDeclaration }) {
  if (!identity(sourceIdentity) || !exact(ownerDeclaration, ["brand", "rights", "reviewedAt", "expiresAt"]) ||
      !exact(ownerDeclaration.brand, ["status", "name"]) || !exact(ownerDeclaration.rights, ["status", "basis"])) reject("C1_RIGHTS_RECORD_INVALID");
  contextFor(plan, sourceIdentity, null);
  const recordId = `c1-rights-declaration:${sourceIdentity.candidateId}:${sourceCandidateRevision + 1}`;
  const record = { schemaVersion: C1_SKU_RIGHTS_REVIEW_RECORD_VERSION, recordId, c1PlanId: plan.c1PlanId,
    sourceCandidateRevision, resultCandidateRevision: sourceCandidateRevision + 1, declaredByUserId, declaredAt,
    ownerDeclaration: structuredClone(ownerDeclaration), review: {
      schemaVersion: C1_SKU_RIGHTS_REVIEW_VERSION, sourceIdentity: structuredClone(sourceIdentity), variantKey: plan.identity.variantKey,
      sourceSkuRevision: plan.revisionRefs.resultRevision, sourceSupplySnapshotId: plan.inputRefs.selectedSupplySnapshotId
    } };
  record.review = declaredReview(record);
  assertC1SkuRightsReviewRecord({ record, plan, sourceIdentity });
  return record;
}

function assertReviewCanProceed(review) {
  if (review.rights.status === "blocked") reject("C1_SKU_RIGHTS_REVIEW_BLOCKED");
  if (review.rights.status === "requires_authorization") reject("C1_SKU_RIGHTS_AUTHORIZATION_REQUIRED");
  if (review.rights.status !== "verified" || review.brand.status === "unknown") reject("C1_SKU_RIGHTS_REVIEW_UNKNOWN");
}

export function buildC1SkuRightsReviewRecordView({ record, plan, sourceIdentity, observedAt }) {
  try {
    assertC1SkuRightsReviewRecord({ record, plan, sourceIdentity });
    assertC1SkuRightsReviewEvidence({ review: record.review, plan, sourceIdentity, observedAt });
    assertReviewCanProceed(record.review);
    return { status: "verified", code: null };
  } catch (error) {
    if (!(error instanceof C1SkuRightsReviewError)) throw error;
    return rightsFailureView(error.code);
  }
}

/** Reads the one saved declaration before freezing facts; already-frozen evidence stays immutable. */
export function resolveC1SkuRightsReviewForFacts({ skuPackage, observedAt }) {
  const plan = skuPackage?.c1ProductPlan;
  const sourceIdentity = skuPackage?.g1Identity;
  if (plan?.status !== "inputs_ready") {
    const view = buildC1SkuRightsReviewView({ plan, sourceIdentity, observedAt });
    if (view.status !== "verified") return { ...view, review: null };
    if (Object.hasOwn(skuPackage, "c1RightsReviewRecord")) {
      const recordView = buildC1SkuRightsReviewRecordView({ record: skuPackage.c1RightsReviewRecord, plan, sourceIdentity, observedAt });
      if (recordView.status !== "verified") return { ...recordView, review: null };
      if (!isDeepStrictEqual(skuPackage.c1RightsReviewRecord.review, plan.inputSnapshots.skuRightsReview)) {
        return { status: "invalid", code: "C1_RIGHTS_RECORD_DECLARATION_MISMATCH", review: null };
      }
    }
    return { ...view, review: structuredClone(plan.inputSnapshots.skuRightsReview) };
  }
  if (!Object.hasOwn(skuPackage, "c1RightsReviewRecord")) return { status: "unknown", code: "C1_SKU_RIGHTS_REVIEW_REQUIRED", review: null };
  const record = skuPackage.c1RightsReviewRecord;
  const view = buildC1SkuRightsReviewRecordView({ record, plan, sourceIdentity, observedAt });
  return { ...view, review: view.status === "verified" ? structuredClone(record.review) : null };
}

const missingRefPattern = `^(?:${MISSING_REFS.map(value => [...value].map(char => /[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char).join("")).join("|")})$`;
const ref = { allOf: [{ $ref: "#/$defs/canonicalFrozenRef" }, { type: "string", not: { pattern: missingRefPattern } }] };
const storeRef = { ...ref, type: "string", maxLength: 200 };
const refs = { type: "array", maxItems: 16, uniqueItems: true, items: ref };
const nonEmptyText = { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?$" };
const closed = properties => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
export const C1_SKU_RIGHTS_REVIEW_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: C1_SKU_RIGHTS_REVIEW_VERSION,
  ...closed({ schemaVersion: { const: C1_SKU_RIGHTS_REVIEW_VERSION }, reviewId: ref,
    sourceIdentity: closed({ schemaVersion: { const: "g1-identity-v1" }, candidateId: ref, skuPackageId: ref, platform: { enum: ["ozon", "wb"] },
      storeRef: closed({ stableStoreId: storeRef, platformStoreId: storeRef, mappingVersion: storeRef }), supplierSkuId: ref,
      merchantSku: { const: "not_applicable" }, warehouseRef: { const: "not_applicable" }, credentialAlias: { const: "not_applicable" }, platformProductId: { const: "not_applicable" } }),
    variantKey: nonEmptyText, sourceSkuRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, sourceSupplySnapshotId: ref,
    reviewedAt: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
    expiresAt: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
    brand: { ...closed({ status: { enum: ["branded", "unbranded", "unknown"] }, name: { anyOf: [nonEmptyText, { type: "null" }] }, evidenceRefs: refs }),
      allOf: [{ if: { properties: { status: { const: "branded" } } }, then: { properties: { name: nonEmptyText } }, else: { properties: { name: { type: "null" } } } },
        { if: { properties: { status: { enum: ["branded", "unbranded"] } } }, then: { properties: { evidenceRefs: { type: "array", minItems: 1 } } } }] },
    rights: { ...closed({ status: { enum: OUTCOMES }, basis: { enum: [...BASES, null] }, evidenceRefs: refs }),
      allOf: [{ if: { properties: { status: { const: "verified" } } }, then: { properties: { basis: { enum: BASES }, evidenceRefs: { type: "array", minItems: 1 } } }, else: { properties: { basis: { type: "null" } } } },
        { if: { properties: { status: { enum: ["blocked", "requires_authorization"] } } }, then: { properties: { evidenceRefs: { type: "array", minItems: 1 } } } }] }
  }),
  allOf: [
    { if: { properties: { rights: { type: "object", properties: { status: { const: "verified" } } } } }, then: { properties: { brand: { type: "object", properties: { status: { enum: ["branded", "unbranded"] } } } } } },
    { if: { properties: { rights: { type: "object", properties: { basis: { const: "no_third_party_rights_identified" } } } } }, then: { properties: { brand: { type: "object", properties: { status: { const: "unbranded" } } } } } }
  ],
  $defs: { canonicalFrozenRef: C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS.canonicalFrozenRef }
};

const embeddedReviewSchema = structuredClone(C1_SKU_RIGHTS_REVIEW_SCHEMA);
delete embeddedReviewSchema.$schema;
delete embeddedReviewSchema.$id;
delete embeddedReviewSchema.$defs;
export const C1_SKU_RIGHTS_REVIEW_RECORD_SCHEMA = {
  $schema: C1_SKU_RIGHTS_REVIEW_SCHEMA.$schema, $id: C1_SKU_RIGHTS_REVIEW_RECORD_VERSION,
  ...closed({ schemaVersion: { const: C1_SKU_RIGHTS_REVIEW_RECORD_VERSION }, recordId: ref, c1PlanId: ref,
    sourceCandidateRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    resultCandidateRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    declaredByUserId: ref, declaredAt: C1_SKU_RIGHTS_REVIEW_SCHEMA.properties.reviewedAt,
    ownerDeclaration: closed({ brand: closed({ status: { enum: ["branded", "unbranded", "unknown"] }, name: { anyOf: [nonEmptyText, { type: "null" }] } }),
      rights: closed({ status: { enum: OUTCOMES }, basis: { enum: [...BASES, null] } }),
      reviewedAt: C1_SKU_RIGHTS_REVIEW_SCHEMA.properties.reviewedAt, expiresAt: C1_SKU_RIGHTS_REVIEW_SCHEMA.properties.expiresAt }),
    review: { $ref: "#/$defs/skuRightsReview" }
  }),
  $defs: { ...C1_SKU_RIGHTS_REVIEW_SCHEMA.$defs, skuRightsReview: embeddedReviewSchema }
};
