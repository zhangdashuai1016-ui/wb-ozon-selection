import { C1_SKU_RIGHTS_REVIEW_VERSION, C1_CURRENT_FACT_VERIFICATION_VERSION, projectC1SkuRightsReviewFacts } from "../../lib/c1-sku-rights-review.mjs";

// Explicit synthetic evidence, never a rights provider or a production licence.
export const SYNTHETIC_LICENSED_BRAND = Object.freeze({ status: "branded", name: "Synthetic fixture brand", evidenceRefs: ["evidence:synthetic:brand-review"] });
export const SYNTHETIC_UNBRANDED = Object.freeze({ status: "unbranded", name: null, evidenceRefs: ["evidence:synthetic:unbranded-review"] });
export const SYNTHETIC_LICENSED_RIGHTS = Object.freeze({ status: "verified", basis: "licensed", evidenceRefs: ["evidence:synthetic:licence-review"] });
export const SYNTHETIC_NO_THIRD_PARTY_RIGHTS = Object.freeze({ status: "verified", basis: "no_third_party_rights_identified", evidenceRefs: ["evidence:synthetic:third-party-rights-review"] });

export function syntheticSkuRightsReview({ plan, sourceIdentity, reviewedAt, brand, rights, expiresAt = "2099-01-01T00:00:00.000Z", reviewId = "rights-review:synthetic:1" }) {
  if (!brand || !rights) throw new Error("SYNTHETIC_RIGHTS_DECISION_REQUIRED");
  return { schemaVersion: C1_SKU_RIGHTS_REVIEW_VERSION, reviewId, sourceIdentity: structuredClone(sourceIdentity),
    variantKey: plan.identity.variantKey, sourceSkuRevision: plan.revisionRefs.resultRevision,
    sourceSupplySnapshotId: plan.inputRefs.selectedSupplySnapshotId, reviewedAt, expiresAt,
    brand: structuredClone(brand), rights: structuredClone(rights) };
}

/** Builds a new, handwritten checked test fixture with explicit synthetic licence evidence. Never a migration. */
export function addSyntheticLicensedRightsToCheckedFixture(skuPackage, { sourceSkuRevision, reviewedAt }) {
  const plan = skuPackage.c1ProductPlan;
  plan.revisionRefs = { sourceRevision: sourceSkuRevision - 1, resultRevision: sourceSkuRevision };
  plan.frozenInputRefs = { ...plan.frozenInputRefs, candidateId: skuPackage.g1Identity.candidateId };
  plan.inputSnapshots.platformSchemaRules.storeRef = structuredClone(skuPackage.g1Identity.storeRef);
  plan.factVerificationVersion = C1_CURRENT_FACT_VERIFICATION_VERSION;
  plan.factsVerifiedAt = reviewedAt;
  const review = syntheticSkuRightsReview({ plan, sourceIdentity: skuPackage.g1Identity, reviewedAt,
    brand: SYNTHETIC_LICENSED_BRAND, rights: SYNTHETIC_LICENSED_RIGHTS });
  plan.inputSnapshots.skuRightsReview = review;
  plan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(review, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`);
  return skuPackage;
}
