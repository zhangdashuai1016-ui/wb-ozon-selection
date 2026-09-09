import { createFormalC1C2Fixture } from "./formal-c1-flow-fixture.mjs";
import { collectMockOzonSalesSnapshot } from "../../lib/sales-snapshot.mjs";
import { evaluateFinalMarketPricing } from "../../lib/market-sample-policy.mjs";
import { buildLifecycleBExplicitOtherCosts } from "../../lib/lifecycle-b-evidence-runtime.mjs";
import { createLifecycleBInputBundle } from "../../lib/lifecycle-b-input-bundle.mjs";

export function createFinalPricingRevalidationFixture() {
  const original = createFormalC1C2Fixture({ salesSnapshotVersion: "sales-snapshot-v1.1" });
  const candidate = structuredClone(original.candidate), sku = candidate.lifecycleV11.skuPackage;
  const profit = sku.profitModels.at(-1), observedAt = "2026-08-18T06:00:00.000Z";
  const context = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(sku.g1Identity.storeRef),
    category: "ozon:17028665:92935", salesScheme: "rfbs", route: profit.internationalFreight.route, logisticsRuleVersion: "synthetic-tariff-v1",
    exchangePair: "RUB/CNY", schemaRuleVersion: original.schema.schemaRevision };
  candidate.lifecycleEvidenceContextV11 = context;
  candidate.packagingCostRmb = profit.otherCosts.components.packagingRmb;
  const rules = { ozonDandanshu: { costPolicySnapshot: structuredClone(profit.otherCosts.costPolicySnapshot), targetMarginRate: 0.15,
    minimumUnitProfitRmb: 20, priceRoundRmb: 1, thresholdPolicy: "either" } };
  const pack = (kind, id, scope, evidenceData) => ({ kind, id, scope, evidenceData, status: "active", sourceType: "isolated_test",
    sourceRef: `synthetic:${kind}`, checkedAt: "2026-08-18T05:00:00.000Z", expiresAt: "2026-08-19T06:00:00.000Z" });
  const evidencePacks = [
    pack("commission", profit.inputSnapshotRefs[2], { platform: context.platform, store: context.store, storeRef: context.storeRef, category: context.category, salesScheme: context.salesScheme }, { commissionRate: profit.commissionRate, commissionEvidenceMode: "exact" }),
    pack("logistics_tariff", profit.inputSnapshotRefs[3], { route: context.route, ruleVersion: context.logisticsRuleVersion }, {
      chargeableWeightRule: "actual_weight", perKgRmb: 0, perParcelRmb: profit.internationalFreight.amount, minimumChargeableWeightKg: 0, weightRoundingRule: "none", weightRoundingKg: null }),
    pack("exchange_rate", profit.inputSnapshotRefs[4], { pair: "RUB/CNY" }, { rubPerCny: profit.priceConversion.rubPerCny }),
    pack("schema", original.schema.evidenceId, { platform: context.platform, store: context.store, storeRef: context.storeRef, category: context.category, ruleVersion: context.schemaRuleVersion }, original.schema)
  ];
  const supplier = sku.selectedSupplySnapshot.supplierSku;
  candidate.lifecycleV11.bSystemEvidenceBundle = createLifecycleBInputBundle({ candidate, evidencePacks, createdAt: observedAt,
    otherCosts: buildLifecycleBExplicitOtherCosts(candidate, rules.ozonDandanshu, { asOf: observedAt }),
    normalizedSubmission: { supplierConfirmation: { weightKg: supplier.weight.value, dimensionsCm: supplier.dimensions } } });
  const salesSnapshots = [1, 2, 3].map(index => collectMockOzonSalesSnapshot({ sourceMode: "mock_ozon_fixture", snapshotId: `final-sample-${index}`,
    platform: "ozon", marketScope: "ozon_cn_cross_border", sellerType: "unknown", sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: `synthetic:seller:${index}` },
    productUrl: `https://www.ozon.ru/product/final-sample-${900000000 + index}/`, title: "synthetic comparable", imageRefs: [], currentPrice: 1800 + index * 100,
    currency: "RUB", categoryPath: "synthetic", attributes: {}, collectedAt: observedAt, evidenceRef: `synthetic:snapshot:${index}` }));
  const reviews = salesSnapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, ...Object.fromEntries(["exactProduct", "exactSpecification", "sameMarket", "currentlyForSale"].map(key => [key, { value: true, evidenceRef: `synthetic:${key}` }])),
    anomaly: null, salesWindow: { count: 10, startDate: "2026-07-19", endDate: "2026-08-18", dayCount: 30, provenance: "third_party_estimate", evidenceRef: "synthetic:window", validityStatus: "current", validityEvidenceRef: "synthetic:validity" } }));
  const assessmentInput = { assessmentId: "final-pricing:synthetic-1", assessedAt: observedAt,
    target: { candidateId: candidate.id, sourceRevision: candidate.dataRevision, skuPackageId: sku.skuPackageId, platform: sku.targetPlatform, store: sku.targetStore, storeRef: sku.g1Identity.storeRef, market: "ozon_cn_cross_border" },
    salesSnapshots, reviews, selectedPriceRub: profit.recommendedSalePriceRub };
  return { candidate, assessmentInput, assessment: evaluateFinalMarketPricing(assessmentInput), evidencePacks, currentCommissionCatalogs: [], rules, observedAt };
}
