import { A_MARKET_ASSESSMENT_SCHEMA_VERSION } from "../../lib/market-sample-policy.mjs";

export function attachPassedMarketAssessment(opportunityPackage, {
  snapshotId = opportunityPackage.salesSnapshots[0].snapshotId,
  sellerType = opportunityPackage.salesSnapshots.find((item) => item.snapshotId === snapshotId)?.sellerType || "cross_border_cn",
  price = 1831,
  currency = "RUB",
  assessedAt = "2026-08-12T12:09:00.000Z"
} = {}) {
  const counts = {
    cross_border_cn: 0,
    other_cross_border: 0,
    unknown: 0,
    local_ru: 0
  };
  counts[sellerType] += 1;
  opportunityPackage.marketAssessment = {
    schemaVersion: A_MARKET_ASSESSMENT_SCHEMA_VERSION,
    assessmentId: "a-market:" + opportunityPackage.parentOpportunityId + ":test",
    assessedAt,
    sourceOpportunityRevision: opportunityPackage.dataRevision,
    status: "passed",
    businessResult: "passed",
    technicalStatus: "completed",
    ownerAction: "confirm_supplier_option",
    sellerPriority: ["cross_border_cn", "other_cross_border", "unknown", "local_ru"],
    sampleSummaries: [{
      snapshotId,
      sellerType,
      identityEvidenceStatus: sellerType === "unknown" ? "unverified" : "verified",
      role: "primary",
      priority: sellerType === "cross_border_cn" ? 1 : sellerType === "other_cross_border" ? 2 : 3,
      comparability: "comparable",
      priceEvidenceStatus: "verified",
      validityStatus: "current",
      evidenceTraceable: true,
      currentPrice: price,
      currency,
      collectedAt: assessedAt,
      evidenceRef: "test:sales:" + snapshotId,
      reason: sellerType === "unknown"
        ? "卖家身份未确认，当前商品和价格证据可用。"
        : "证据完整，可用于主要价格判断"
    }],
    primarySampleIds: [snapshotId],
    backgroundSampleIds: [],
    excludedSampleIds: [],
    sellerTypeCounts: counts,
    sellerTypesUsed: [sellerType],
    identityConfirmation: {
      verifiedCount: sellerType === "unknown" ? 0 : 1,
      unverifiedCount: sellerType === "unknown" ? 1 : 0
    },
    confidence: sellerType === "cross_border_cn" ? "high" : sellerType === "other_cross_border" ? "medium" : "limited",
    priceBand: { currency, minimum: price, maximum: price, sampleIds: [snapshotId] },
    recommendedSalePrice: {
      amount: price,
      currency,
      method: "median_of_comparable_primary_samples",
      evidenceRefs: ["test:sales:" + snapshotId]
    },
    containsLocalRuBackground: false,
    manualReviewRequired: false,
    gateReason: "A阶段销售证据和供应端资料满足进入B前条件",
    bEligibility: "eligible_after_owner_supply_confirmation",
    rule: "cross_border_cn_preferred_not_exclusive"
  };
  return opportunityPackage;
}
