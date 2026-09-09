import { sameStoreRef } from "./store-binding.mjs";
import { C1_CANONICAL_CONTRACT_VERSION, C1_PRODUCT_PLAN_SCHEMA_VERSION, validateC1ProductPlan } from "./c1-product-plan.mjs";
import { C1_CURRENT_FACT_VERIFICATION_VERSION, resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";

function unavailable(code, rightsCode = "C1_SKU_RIGHTS_REVIEW_REQUIRED") {
  return { rights: { status: rightsCode === "C1_SKU_RIGHTS_REVIEW_REQUIRED" ? "unknown" : "invalid", code: rightsCode },
    compliance: { status: "unknown", assessment: null, code } };
}

function matchesCurrentSku(candidate, sku, plan) {
  const identity = sku.g1Identity;
  const source = plan.inputSnapshots?.platformSchemaRules;
  const supply = plan.inputSnapshots?.confirmedSupplierSkuSnapshot;
  return identity?.schemaVersion === "g1-identity-v1" && identity.candidateId === candidate.id &&
    identity.skuPackageId === sku.skuPackageId && identity.supplierSkuId === sku.supplierSkuId &&
    identity.platform === sku.targetPlatform && candidate.targetPlatform === sku.targetPlatform &&
    sku.targetStore === candidate.targetStore && identity.storeRef?.stableStoreId === candidate.targetStore &&
    sameStoreRef(candidate.storeRef, identity.storeRef) && sameStoreRef(source?.storeRef, identity.storeRef) &&
    plan.identity?.skuPackageId === sku.skuPackageId && plan.identity.supplierSkuId === sku.supplierSkuId &&
    plan.identity.variantKey === sku.variantKey && plan.identity.targetPlatform === sku.targetPlatform &&
    plan.identity.targetStore === candidate.targetStore && source.platform === sku.targetPlatform && source.store === candidate.targetStore &&
    plan.frozenInputRefs?.candidateId === candidate.id && plan.frozenInputRefs.skuPackageId === sku.skuPackageId &&
    plan.frozenInputRefs.platform === sku.targetPlatform && plan.frozenInputRefs.storeRef === candidate.targetStore &&
    source.evidenceId === plan.schemaSnapshotRef && source.evidenceId === plan.frozenInputRefs.schemaSnapshotRef &&
    supply?.snapshotId === plan.inputRefs?.selectedSupplySnapshotId && supply?.supplierSku?.supplierSkuId === sku.supplierSkuId &&
    supply.supplierSku.variantKey === sku.variantKey && plan.frozenInputRefs.selectedSupplySnapshotId === supply.snapshotId &&
    Number.isSafeInteger(plan.revisionRefs?.sourceRevision) && plan.revisionRefs.sourceRevision >= 0 &&
    plan.revisionRefs.resultRevision === plan.revisionRefs.sourceRevision + 1 &&
    plan.revisionRefs.sourceRevision === plan.frozenInputRefs.sourceRevision &&
    Number.isSafeInteger(sku.dataRevision) && plan.revisionRefs.resultRevision <= sku.dataRevision;
}

/** Server-only display DTO. It reports saved evidence and grants no workflow or production permission. */
export function buildC1ReviewPresentation({ candidate, observedAt }) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  if (!plan) return unavailable("C1_COMPLIANCE_EVIDENCE_REQUIRED");
  if (!matchesCurrentSku(candidate, sku, plan)) return unavailable("C1_COMPLIANCE_SCOPE_MISMATCH", "C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH");
  // Partial saved inputs are an explicit display gap, never an exception that makes the candidate list unreadable.
  if (!plan.inputSnapshots || !plan.revisionRefs || !Number.isSafeInteger(plan.revisionRefs.resultRevision) ||
      plan.schemaVersion !== C1_PRODUCT_PLAN_SCHEMA_VERSION || plan.contractVersion !== C1_CANONICAL_CONTRACT_VERSION ||
      !validateC1ProductPlan(plan).valid) return unavailable("C1_COMPLIANCE_RECORD_INVALID", "C1_SKU_RIGHTS_REVIEW_INVALID");
  const { status: rightsStatus, code: rightsCode } = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt });
  const rights = { status: rightsStatus, code: rightsCode };
  const source = plan.inputSnapshots.platformSchemaRules;
  const fact = plan.platformCompliance?.assessment;
  if (fact?.verificationStatus !== "confirmed" || fact.reason !== null ||
      !Array.isArray(fact.sourceRefs) || !fact.sourceRefs.includes(`${source.evidenceId}#/platformCompliance`) ||
      source.evidenceId !== plan.inputRefs.platformSchemaEvidenceId ||
      typeof fact.value?.status !== "string" || fact.value.status === "unknown" || fact.value.status !== source.platformCompliance?.status) {
    return { rights, compliance: { status: "unknown", assessment: null, code: "C1_COMPLIANCE_EVIDENCE_REQUIRED" } };
  }
  if (plan.factVerificationVersion === "c1-fact-verification-v1.1") {
    return { rights, compliance: { status: "historical", assessment: fact.value.status, code: "C1_COMPLIANCE_HISTORICAL_RECORD" } };
  }
  if (plan.factVerificationVersion !== C1_CURRENT_FACT_VERIFICATION_VERSION) {
    return { rights, compliance: { status: "unknown", assessment: null, code: "C1_COMPLIANCE_RECORD_INVALID" } };
  }
  return { rights, compliance: { status: fact.value.status === "clear" ? "clear" : "review_required", assessment: fact.value.status, code: null } };
}
