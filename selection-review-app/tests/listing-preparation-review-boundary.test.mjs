import assert from "node:assert/strict";
import test from "node:test";

import {
  listingPreparationCStageFields,
  listingPreparationInheritedFields,
  normalizeListingPreparationReviewInput
} from "../lib/listing-preparation-review-boundary.mjs";

test("C阶段回写只接受明确C字段和preparation边界，不覆盖B阶段codexReview", () => {
  const input = normalizeListingPreparationReviewInput({
    dataRevision: 12,
    status: "prepared",
    runId: "run-c1-1",
    candidateData: {
      sourceUrl: "https://detail.1688.com/offer/712421624571.html",
      purchasePriceRmb: 41,
      packedWeightKg: 0.3,
      dimensionsCm: { length: 23, width: 16, height: 3 },
      materialsAndAge: "木质，14岁以上",
      powered: false,
      complianceStatus: "clear",
      authorizationStatus: "needs_confirmation"
    },
    evidencePackIds: ["pack-c1", "pack-c1"],
    sourceCaptureId: "SC-1",
    preparation: {
      exactSourceSku: "ghost-house",
      category: "Игрушки > Пазлы",
      schemaEvidence: "schema:ozon:cat:1",
      finalPrice: "2598 RUB",
      assets: ["asset:1", "asset:2"]
    }
  });
  assert.equal(input.dataRevision, 12);
  assert.deepEqual(input.evidencePackIds, ["pack-c1"]);
  assert.deepEqual(Object.keys(input.candidateData).sort(), [
    "authorizationStatus",
    "complianceStatus",
    "dimensionsCm",
    "materialsAndAge",
    "packedWeightKg",
    "powered",
    "purchasePriceRmb",
    "sourceUrl"
  ]);
  assert.deepEqual(input.preparation.assets, ["asset:1", "asset:2"]);
});

test("C阶段回写拒绝B字段覆盖、未知candidateData和未知preparation字段", () => {
  assert.throws(() => normalizeListingPreparationReviewInput({
    dataRevision: 12,
    status: "blocked",
    reason: "缺Schema",
    codexReview: { profitCalculation: { unitProfitRmb: -999 } }
  }), /不能覆盖B阶段Codex审核事实/);
  assert.throws(() => normalizeListingPreparationReviewInput({
    dataRevision: 12,
    status: "blocked",
    reason: "缺Schema",
    candidateData: { profitCalculation: { unitProfitRmb: -999 } }
  }), /候选字段不允许写入/);
  assert.throws(() => normalizeListingPreparationReviewInput({
    dataRevision: 12,
    status: "prepared",
    preparation: {
      exactSourceSku: "sku",
      category: "cat",
      schemaEvidence: "schema",
      finalPrice: "price",
      assets: ["asset"],
      defaultStock: 100
    }
  }), /preparation包含未声明字段/);
});

test("C阶段字段清单可由server用于继承冲突和C存储边界", () => {
  assert.deepEqual(listingPreparationInheritedFields(), ["sourceUrl", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"]);
  assert.deepEqual(listingPreparationCStageFields(), ["materialsAndAge", "powered", "complianceStatus", "authorizationStatus"]);
});
