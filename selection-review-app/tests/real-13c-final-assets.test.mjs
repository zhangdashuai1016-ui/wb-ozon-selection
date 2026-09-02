import test from "node:test";
import assert from "node:assert/strict";
import { createTrainCandidate, createAuthorizedTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { finalizeReal13CForOwnerCard } from "../lib/real-c1-preparation.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import {
  createProductionAuthorization,
  validateProductionAuthorization
} from "../lib/production-authorization.mjs";
import { createProductionPlan, fingerprintProductionPlan } from "../lib/production-plan.mjs";
import { executeSingleSkuDraftCreation } from "../lib/draft-production-execution.mjs";

async function fixtureCandidate() {
  return createTrainCandidate({ returnOpsReserveRate: 0.03 });
}

test("13C owner correction appends profit-v2, completes C2 and creates a no-write confirmation card", async () => {
  const candidate = await fixtureCandidate();
  assert.equal(candidate.lifecycleV11.skuPackage.activeProfitModelVersion, "profit-v1");
  assert.equal(candidate.lifecycleV11.skuPackage.productionAuthorization, null);
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
  assert.equal(candidate.lifecycleV11.skuPackage.productionAuthorization, null);
  const finalized = finalizeReal13CForOwnerCard({
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

test("synthetic CX-20260803-010 authorization forms an exact five-image stock-100 draft contract without external writes", async () => {
  const candidate = createAuthorizedTrainCandidate();
  const lifecycle = candidate.lifecycleV11;
  const authorization = lifecycle?.skuPackage?.productionAuthorization;
  assert.ok(authorization, "synthetic production authorization is required");
  const plan = createProductionPlan({ productionAuthorization: authorization, createdAt: "2026-08-13T00:30:00.000Z" });
  assert.ok(["create_draft_only", "create_and_allow_validation_moderation"].includes(plan.publishScope));
  assert.equal(plan.stock, 100);
  assert.equal(plan.finalUploads.length, 5);
  assert.equal(plan.finalUploads[0].fileName, "09-成品图-俄文.png");

  const preflight = {
    schemaVersion: "platform-write-preflight-v1.1",
    preflightId: "platform-preflight:real-CX-20260803-010-contract-only",
    sourceProductionPlanId: plan.planId,
    sourceProductionPlanFingerprint: fingerprintProductionPlan(plan),
    targetPlatform: "ozon",
    storeIdentity: { expectedStore: "dandanshu", observedStore: "dandanshu", status: "matched", evidenceRef: "test:contract-only:store" },
    permission: { status: "verified", evidenceRef: "test:contract-only:permission" },
    connectionStatus: {
      api: { status: "connected", checkedVia: "contract_test_only", evidenceRef: "test:contract-only:api" },
      sellerBackend: { status: "connected", checkedVia: "contract_test_only", evidenceRef: "test:contract-only:backend" }
    },
    authorizedWriteFields: [...plan.allowedWriteFields],
    platformWritableFields: [...plan.allowedWriteFields],
    effectiveWritableFields: [...plan.allowedWriteFields],
    imagePermission: { status: "verified", evidenceRef: "test:contract-only:image" },
    priceCurrency: { expected: "CNY", observed: "CNY", status: "matched", evidenceRef: "test:contract-only:currency" },
    risks: [], technicalStatus: "completed", businessStateEffect: "none", checkedAt: "2026-08-13T00:31:00.000Z",
    readyForPlatformWrite: false, productCreated: false, imagesUploaded: 0, inventoryModified: false,
    storeDataModified: false, productionRecordCreated: false, platformWrites: 0
  };
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan,
    productionAuthorization: authorization,
    platformWritePreflight: preflight,
    executedAt: "2026-08-13T00:32:00.000Z",
    createPlatformDraft: async (value) => {
      payload = value;
      return { status: plan.publishScope === "create_draft_only" ? "draft" : "validation_or_moderation", productId: "CONTRACT-ONLY-NO-PLATFORM", offerId: "CX-20260803-010", writeEvidenceRef: "test:contract-only:write", moderationSubmitted: plan.publishScope !== "create_draft_only", published: false, activated: false };
    },
    readbackPlatformDraft: async () => ({
      status: plan.publishScope === "create_draft_only" ? "draft" : "validation_or_moderation", productId: "CONTRACT-ONLY-NO-PLATFORM", title: plan.title, price: plan.platformWritePrice,
      stock: plan.publishScope === "create_draft_only" ? 100 : undefined, inventoryModified: plan.publishScope === "create_draft_only" ? true : false,
      finalUploadAssetIds: plan.finalUploads.map((asset) => asset.assetId),
      mainImageAssetId: plan.finalUploads[0].assetId, evidenceRef: "test:contract-only:readback", moderationSubmitted: plan.publishScope !== "create_draft_only", published: false, activated: false
    })
  });
  assert.equal(payload.stock, 100);
  assert.equal(payload.finalUploads.length, 5);
  assert.equal(result.productionRecord.imagesUploaded, 5);
  assert.equal(result.productionRecord.stockWritten, plan.publishScope === "create_draft_only" ? 100 : null);
  assert.equal(result.productionRecord.independentReadbackVerified, true);
  assert.equal(candidate.lifecycleV11.skuPackage.productionRecord, null);
});
