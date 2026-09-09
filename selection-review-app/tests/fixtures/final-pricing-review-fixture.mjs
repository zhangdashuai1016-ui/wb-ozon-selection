import assert from 'node:assert/strict';
import { createMusicBoxCandidate } from '../helpers/legacy-candidate-fixture.mjs';
import { evaluateFinalMarketPricing } from '../../lib/market-sample-policy.mjs';
import { assertFinalPricingReviewCurrent } from '../../lib/final-pricing-review.mjs';

/** Explicit synthetic comparison for production-boundary tests, never marketplace evidence. */
export function attachSyntheticFinalPricingReview(skuPackage, { at, candidateRevision = 1 } = {}) {
  assert.ok(typeof at === 'string' && Number.isFinite(Date.parse(at)), 'synthetic comparison requires an explicit clock');
  const result = structuredClone(skuPackage), original = structuredClone(skuPackage);
  const profit = result.profitModels.find(model => model.profitModelVersion === result.activeProfitModelVersion);
  const base = createMusicBoxCandidate().salesSnapshotsV11[0];
  const endDate = at.slice(0, 10), startDate = new Date(Date.parse(`${endDate}T00:00:00.000Z`) - 29 * 86400000).toISOString().slice(0, 10);
  const salesSnapshots = [0, 1].map(index => ({ ...structuredClone(base), snapshotId: `synthetic-final-price:${index}`,
    productUrl: `https://www.ozon.ru/product/${900000000 + index}/`, title: `Synthetic comparable SKU ${result.supplierSkuId} sample ${index + 1}`,
    currentPrice: profit.recommendedSalePriceRub + index * 10, collectedAt: at, evidenceRef: `synthetic-final-price-source:${index}` }));
  const reviews = salesSnapshots.map((snapshot, index) => ({ snapshotId: snapshot.snapshotId,
    ...Object.fromEntries(['exactProduct', 'exactSpecification', 'sameMarket', 'currentlyForSale'].map(key => [key, { value: true, evidenceRef: `synthetic-final-price-review:${index}:${key}` }])),
    salesWindow: { count: 20 - index, startDate, endDate, dayCount: 30, provenance: 'third_party_estimate', evidenceRef: `synthetic-final-sales:${index}`, validityStatus: 'current', validityEvidenceRef: `synthetic-final-validity:${index}` }, anomaly: null }));
  const assessment = evaluateFinalMarketPricing({ assessmentId: `synthetic-final-price:${result.skuPackageId}`, assessedAt: at,
    target: { candidateId: result.g1Identity.candidateId, sourceRevision: candidateRevision, skuPackageId: result.skuPackageId,
      platform: result.targetPlatform, store: result.targetStore, storeRef: structuredClone(result.g1Identity.storeRef), market: base.marketScope },
    salesSnapshots, reviews, selectedPriceRub: profit.recommendedSalePriceRub });
  assert.equal(assessment.status, 'ready'); assert.equal(assessment.coreSampleIds.length, 2); assert.equal(assessment.insufficientSamples, true);
  result.finalPricingReview = { schemaVersion: 'final-pricing-review-v1', assessment: structuredClone(assessment), salesSnapshots, reviews,
    supplierSkuId: result.supplierSkuId, variantKey: result.variantKey, profitModelVersion: result.activeProfitModelVersion };
  assertFinalPricingReviewCurrent(result);
  assert.deepEqual(result.profitModels, original.profitModels); assert.deepEqual(result.c2FinalAssets, original.c2FinalAssets);
  assert.deepEqual(skuPackage, original);
  return result;
}
