import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { finalizeReal13CForOwnerCard } from "../lib/real-c1-preparation.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import {
  createProductionAuthorization,
  reviseProductionAuthorizationPriceSemantics,
  validateProductionAuthorization
} from "../lib/production-authorization.mjs";
import { createProductionPlan, fingerprintProductionPlan } from "../lib/production-plan.mjs";
import { executeSingleSkuDraftCreation } from "../lib/draft-production-execution.mjs";

async function fixtureCandidate() {
  const document = JSON.parse(await readFile(new URL("../data/candidates.json", import.meta.url), "utf8"));
  return structuredClone(document.candidates.find((item) => item.id === "CX-20260803-010"));
}

function ownerFinalState(candidate) {
  const sku = candidate.lifecycleV11?.skuPackage;
  if (sku?.activeProfitModelVersion === "profit-v2" && sku?.productionConfirmationCard) {
    return { lifecycle: structuredClone(candidate.lifecycleV11), confirmationCard: structuredClone(sku.productionConfirmationCard) };
  }
  return null;
}

function priceSafeLifecycle(lifecycle) {
  const next = structuredClone(lifecycle);
  const sku = next?.skuPackage;
  const authorization = sku?.productionAuthorization;
  if (!authorization || authorization.lockedScope?.platformWritePrice) return next;
  const repaired = reviseProductionAuthorizationPriceSemantics({
    skuPackage: sku,
    buyerTargetPrice: { amount: authorization.lockedScope.recommendedPrice.rub, currency: "RUB" },
    platformWritePrice: { amount: authorization.lockedScope.recommendedPrice.cny, currency: "CNY" },
    priceConversion: {
      rubPerCny: 12.0637,
      evidenceRef: "fx:cbr:2026-08-07:RUB-CNY",
      checkedAt: "2026-08-07T00:00:00.000Z"
    },
    repairedAt: "2026-08-13T08:00:00.000Z"
  });
  return { ...next, skuPackage: repaired.skuPackage };
}

test("13C owner correction appends profit-v2, completes C2 and creates a no-write confirmation card", async () => {
  const candidate = await fixtureCandidate();
  const alreadyFinal = ownerFinalState(candidate);
  if (alreadyFinal) {
    const safeLifecycle = priceSafeLifecycle(alreadyFinal.lifecycle);
    const sku = safeLifecycle.skuPackage;
    assert.equal(sku.activeProfitModelVersion, "profit-v2");
    assert.equal(sku.c2FinalAssets.status, "completed");
    if (sku.productionAuthorization) {
      assert.equal(sku.productionConfirmationCard.status, "owner_business_approved");
      assert.ok(["create_draft_only", "create_and_allow_validation_moderation"].includes(sku.productionAuthorization.lockedScope.publishScope));
      assert.deepEqual(validateProductionAuthorization(sku.productionAuthorization), { valid: true, errors: [] });
    } else {
      assert.equal(sku.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
    }
    assert.equal(sku.productionRecord, null);
    assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
    return;
  }
  const beforeProfit = structuredClone(candidate.lifecycleV11.skuPackage.profitModels[0]);
  const files = ["09-成品图-俄文.png", "01-成品图-俄文.png", "05-成品图-俄文.png", "详情-01.jpg"];
  const result = finalizeReal13CForOwnerCard({
    candidate,
    ownerFactConfirmation: {
      brandDecision: "no_brand",
      material: "DVP",
      pieceCount: 282,
      mechanism: "mechanical_wind_up",
      powered: false,
      containsBattery: false
    },
    packedWeightKg: 0.21,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    finalUploadAssets: files.map((fileName, index) => ({
      assetId: `final-${index + 1}`,
      mediaType: "image",
      assetRef: `/owner/${fileName}`,
      fileName,
      sha256: `${index}`.padStart(64, "0"),
      byteSize: 1000 + index,
      order: index + 1,
      role: index === 0 ? "main_image" : "detail_image",
      sourceType: "owner_provided_final_upload",
      addedAt: "2026-08-12T16:00:00.000Z"
    })),
    excludedAssets: [{ fileName: "02-成品图-俄文.png", reason: "material_conflict" }],
    preparedAt: "2026-08-12T16:00:00.000Z"
  });

  const sku = result.lifecycle.skuPackage;
  assert.deepEqual(sku.profitModels[0], beforeProfit);
  assert.equal(sku.profitModels.length, 2);
  assert.equal(sku.activeProfitModelVersion, "profit-v2");
  assert.equal(result.activeProfitModel.internationalFreight.amount, 23.87);
  assert.equal(result.activeProfitModel.unitProfitRmb, 47.48);
  assert.equal(result.activeProfitModel.profitMargin, 0.3128);
  assert.equal(result.activeProfitModel.result, "passed");
  assert.equal(sku.c1ProductPlan.productAttributes.supplierAttributes.find((item) => item.fieldKey === "piece_count").fact.value, 282);
  assert.match(sku.c1ProductPlan.seoTitleDraft.text, /282/);
  assert.doesNotMatch(sku.c1ProductPlan.seoTitleDraft.text, /320/);
  assert.equal(sku.c2FinalAssets.status, "completed");
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads.map((asset) => asset.fileName), files);
  assert.equal(sku.c2FinalAssets.assets.finalUploads[0].role, "main_image");
  assert.equal(sku.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.equal(sku.productionAuthorization, null);
  assert.equal(sku.productionRecord, null);
  assert.equal(result.lifecycle.platformWrites, 0);
  assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
});

test("owner approval locks CX-20260803-010 for draft-only production without starting D", async () => {
  const candidate = await fixtureCandidate();
  const current = ownerFinalState(candidate);
  if (current?.lifecycle.skuPackage.productionAuthorization) {
    const safeLifecycle = priceSafeLifecycle(current.lifecycle);
    const existing = safeLifecycle.skuPackage.productionAuthorization;
    assert.deepEqual(validateProductionAuthorization(existing), { valid: true, errors: [] });
    assert.ok(["create_draft_only", "create_and_allow_validation_moderation"].includes(existing.lockedScope.publishScope));
    assert.equal(existing.lockedScope.stock, 100);
    assert.equal(existing.productionExecuted, false);
    assert.equal(existing.platformWrites, 0);
    assert.equal(safeLifecycle.skuPackage.productionRecord, null);
    return;
  }
  const finalized = current || finalizeReal13CForOwnerCard({
    candidate,
    ownerFactConfirmation: {
      brandDecision: "no_brand",
      material: "DVP",
      pieceCount: 282,
      mechanism: "mechanical_wind_up",
      powered: false,
      containsBattery: false
    },
    packedWeightKg: 0.21,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    finalUploadAssets: ["09-成品图-俄文.png", "01-成品图-俄文.png"].map((fileName, index) => ({
      assetId: `final-${index + 1}`,
      mediaType: "image",
      assetRef: `/owner/${fileName}`,
      fileName,
      sha256: `${index}`.padStart(64, "0"),
      byteSize: 1000 + index,
      order: index + 1,
      role: index === 0 ? "main_image" : "detail_image",
      sourceType: "owner_provided_final_upload",
      addedAt: "2026-08-12T16:00:00.000Z"
    })),
    excludedAssets: [],
    preparedAt: "2026-08-12T16:00:00.000Z"
  });
  const card = finalized.lifecycle.skuPackage.productionConfirmationCard;
  const result = createProductionAuthorization({
    skuPackage: finalized.lifecycle.skuPackage,
    ownerDecision: {
      selectedOption: "approve_for_production_authorization",
      confirmedBy: "owner",
      cardId: card.cardId
    },
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: ["no_publish_or_activation", "no_moderation_submission"],
    confirmedAt: "2026-08-12T16:10:00.000Z"
  });

  assert.deepEqual(validateProductionAuthorization(result.productionAuthorization), { valid: true, errors: [] });
  assert.equal(result.productionAuthorization.lockedScope.platform, "ozon");
  assert.equal(result.productionAuthorization.lockedScope.store, "dandanshu");
  assert.equal(result.productionAuthorization.lockedScope.supplierSkuId, "4993364145574");
  assert.equal(result.productionAuthorization.lockedScope.buyerTargetPrice.amount, 1831);
  assert.equal(result.productionAuthorization.lockedScope.platformWritePrice.amount, 151.78);
  assert.equal(result.productionAuthorization.lockedScope.stock, 100);
  assert.equal(result.productionAuthorization.lockedScope.publishScope, "create_draft_only");
  assert.equal(result.productionAuthorization.productionExecuted, false);
  assert.equal(result.productionAuthorization.platformWrites, 0);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.equal(result.skuPackage.businessPhase, "C2");
});

test("historical CX-20260803-010 authorization cannot bypass newly required content and packing locks", async () => {
  const candidate = await fixtureCandidate();
  const lifecycle = priceSafeLifecycle(candidate.lifecycleV11);
  const authorization = lifecycle?.skuPackage?.productionAuthorization;
  assert.ok(authorization, "current real production authorization is required");
  assert.equal(authorization.lockedScope.content, undefined);
  assert.equal(authorization.lockedScope.packing, undefined);
  assert.throws(() => createProductionPlan({
    productionAuthorization: authorization,
    createdAt: "2026-08-13T00:30:00.000Z"
  }), /PRODUCTION_PLAN_INPUT_GAP/);
  assert.equal(candidate.lifecycleV11.skuPackage.productionRecord, null);
});
