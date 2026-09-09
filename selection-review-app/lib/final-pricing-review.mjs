import { isDeepStrictEqual } from "node:util";
import { evaluateFinalMarketPricing } from "./market-sample-policy.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets } from "./production-contract-primitives.mjs";

export class FinalPricingReviewError extends Error {
  constructor(code, message) { super(message); this.name = "FinalPricingReviewError"; this.code = code; }
}

export function assertFinalPricingReviewCurrent(skuPackage) {
  const record = skuPackage.finalPricingReview;
  if (!record) throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_REQUIRED", "最终定价尚未完成多样本比较，B阶段参考价仍可用于前期利润计算。");
  const keys = ["schemaVersion", "assessment", "salesSnapshots", "reviews", "supplierSkuId", "variantKey", "profitModelVersion"];
  if (typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== keys.length ||
      keys.some(key => !Object.hasOwn(record, key)) || record.schemaVersion !== "final-pricing-review-v1") {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_INVALID", "最终定价复核记录无效。");
  }
  assertNoProductionSecrets(record, "finalPricingReview");
  const assessment = record.assessment;
  const target = assessment?.target;
  const profit = skuPackage.profitModels.find(model => model.profitModelVersion === skuPackage.activeProfitModelVersion);
  if (!target || target.candidateId !== skuPackage.g1Identity.candidateId || target.skuPackageId !== skuPackage.skuPackageId ||
      target.platform !== skuPackage.targetPlatform || target.store !== skuPackage.targetStore ||
      !sameStoreRef(target.storeRef, skuPackage.g1Identity.storeRef) || record.supplierSkuId !== skuPackage.supplierSkuId ||
      record.variantKey !== skuPackage.variantKey || record.profitModelVersion !== skuPackage.activeProfitModelVersion ||
      !profit || profit.result !== "passed" || profit.recommendedSalePriceRub !== assessment.selectedPriceRub) {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_SOURCE_CHANGED", "最终价格、SKU或利润版本已变化，须重新复核。");
  }
  const expected = evaluateFinalMarketPricing({ assessmentId: assessment.assessmentId, assessedAt: assessment.assessedAt,
    target, salesSnapshots: record.salesSnapshots, reviews: record.reviews, selectedPriceRub: assessment.selectedPriceRub });
  if (expected.status !== "ready" || !isDeepStrictEqual(expected, assessment)) {
    throw new FinalPricingReviewError("FINAL_PRICING_REVIEW_INVALID", "最终多样本比较与保存的证据不一致。");
  }
  return record;
}
