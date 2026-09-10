import test from "node:test";
import assert from "node:assert/strict";
import { createTrainFinalAssetsFixture, createAuthorizedTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { createProductionAuthorization, validateProductionAuthorization } from "../lib/production-authorization.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../lib/production-plan.mjs";
import { executeSingleSkuDraftCreation } from "../lib/draft-production-execution.mjs";
import { preflightFixture, currentProductionBindingFixture } from "./helpers/d-software-fixture.mjs";

test("13C新源证据经真实B追加profit-v2、正式C1回执和C2，旧冻结利润原样保留", () => {
  const files = ["09-成品图-俄文.png", "01-成品图-俄文.png", "05-成品图-俄文.png", "详情-01.jpg"];
  const result = createTrainFinalAssetsFixture({ files });
  const oldSku = result.before.lifecycleV11.skuPackage;
  const beforeProfit = structuredClone(oldSku.profitModels[0]);
  const sku = result.skuPackage;
  const active = sku.profitModels.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
  assert.equal(oldSku.activeProfitModelVersion, "profit-v1");
  assert.equal(oldSku.productionAuthorization, null);
  assert.deepEqual(sku.profitModels[0], beforeProfit);
  assert.equal(sku.profitModels.length, 2);
  assert.equal(sku.activeProfitModelVersion, "profit-v2");
  assert.equal(active.internationalFreight.amount, 23.87);
  assert.equal(active.unitProfitRmb, 47.48);
  assert.equal(active.profitMargin, 0.3128);
  assert.equal(active.result, "passed");
  assert.equal(sku.skuFacts.weight.value, 0.21);
  assert.equal(oldSku.skuFacts.weight.value, 0.3);
  assert.notEqual(sku.selectedSupplySnapshot.snapshotId, oldSku.selectedSupplySnapshot.snapshotId);
  assert.ok(active.inputSnapshotRefs.includes(sku.selectedSupplySnapshot.snapshotId));
  assert.ok(beforeProfit.inputSnapshotRefs.includes(oldSku.selectedSupplySnapshot.snapshotId));
  const count = source => source.c1ProductPlan.productAttributes.supplierAttributes.find(item => item.fieldKey === "piece_count").fact.value;
  assert.equal(count(oldSku), 320);
  assert.equal(count(sku), 282);
  assert.match(sku.c1ProductPlan.seoTitleDraft.text, /282/);
  assert.doesNotMatch(sku.c1ProductPlan.seoTitleDraft.text, /320/);
  assert.notEqual(sku.c1ProductPlan.draftOnlySeo.providerJobRef.jobId, oldSku.c1ProductPlan.draftOnlySeo.providerJobRef.jobId);
  assert.equal(sku.c2FinalAssets.status, "completed");
  assert.deepEqual(sku.c2FinalAssets.assets.finalUploads.map(asset => asset.fileName), files);
  assert.equal(sku.c2FinalAssets.assets.finalUploads[0].role, "main_image");
  assert.equal(sku.c2FinalAssets.assets.finalUploads.some(asset => asset.fileName === "02-成品图-俄文.png"), false);
  assert.equal(sku.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.equal(sku.productionAuthorization, null);
  assert.equal(sku.productionRecord, null);
  assert.equal(result.fixture.receipt.productionWrites, 0);
  assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
});

test("精确主人单次授权锁定冻结B价格与草稿范围，不启动D", () => {
  const finalized = createTrainFinalAssetsFixture({ files: ["09-成品图-俄文.png", "01-成品图-俄文.png"] });
  const before = structuredClone(finalized.authorizationInput);
  const result = createProductionAuthorization(finalized.authorizationInput);
  const authorization = result.productionAuthorization;
  assert.deepEqual(validateProductionAuthorization(authorization), { valid: true, errors: [] });
  assert.equal(authorization.lockedScope.platform, "ozon");
  assert.equal(authorization.lockedScope.storeRef.stableStoreId, "dandanshu");
  assert.equal(authorization.lockedScope.supplierSkuId, "4993364145574");
  assert.notEqual(authorization.lockedScope.merchantSku, authorization.lockedScope.supplierSkuId);
  assert.deepEqual(authorization.lockedScope.buyerTargetPrice, { amount: 1831, currency: "RUB" });
  assert.deepEqual(authorization.lockedScope.platformWritePrice, { amount: 151.78, currency: "CNY" });
  assert.deepEqual(authorization.lockedScope.priceConversion, {
    rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-12T12:20:00.000Z"
  });
  assert.equal(authorization.confirmedByActorId, authorization.authorizedByActorId);
  assert.equal(authorization.ownerConfirmation.schemaVersion, "production-owner-confirmation-v2");
  assert.equal(authorization.lockedScope.stock, 100);
  assert.equal(authorization.lockedScope.publishScope, "create_draft_only");
  assert.deepEqual(authorization.lockedScope.exclusions, ["no_publish_or_activation", "no_moderation_submission"]);
  assert.equal(authorization.productionExecuted, false);
  assert.equal(authorization.platformWrites, 0);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.deepEqual(finalized.authorizationInput, before);
});

test("合成五图库存100授权经当前前检与内存adapter保留精确草稿合同，未写入外部", async () => {
  const candidate = createAuthorizedTrainCandidate();
  const sourceSku = candidate.lifecycleV11.skuPackage;
  const authorization = sourceSku.productionAuthorization;
  const before = structuredClone(candidate);
  const plan = createProductionPlan({ productionAuthorization: authorization, candidateId: candidate.id,
    candidateRevision: candidate.dataRevision, skuPackage: sourceSku, createdAt: "2026-08-22T07:05:00.000Z" });
  const inputs = projectProductionPlanInputs(plan);
  assert.equal(inputs.publishScope, "create_draft_only");
  assert.equal(inputs.stock, 100);
  assert.equal(inputs.finalUploads.length, 5);
  assert.equal(inputs.finalUploads[0].fileName, "09-成品图-俄文.png");
  const preflight = await preflightFixture(plan, { writableFields: inputs.allowedWriteFields });
  let payload;
  const result = await executeSingleSkuDraftCreation({
    productionPlan: plan, productionAuthorization: authorization, platformWritePreflight: preflight,
    currentProductionBinding: currentProductionBindingFixture(authorization),
    executedAt: "2026-08-22T07:11:00.000Z",
    createPlatformDraft: async value => {
      payload = value;
      return { status: "draft", productId: "CONTRACT-ONLY-NO-PLATFORM", offerId: inputs.sku.merchantSku,
        writeEvidenceRef: "test:contract-only:write", moderationSubmitted: false, published: false, activated: false };
    },
    readbackPlatformDraft: async () => ({
      status: "draft", productId: "CONTRACT-ONLY-NO-PLATFORM", title: inputs.title, price: inputs.platformWritePrice,
      stock: 100, inventoryModified: true, finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId),
      mainImageAssetId: inputs.finalUploads[0].assetId, evidenceRef: "test:contract-only:readback",
      moderationSubmitted: false, published: false, activated: false
    })
  });
  assert.equal(payload.stock, 100);
  assert.equal(payload.finalUploads.length, 5);
  assert.equal(payload.publish, false);
  assert.equal(payload.activate, false);
  assert.equal(result.productionRecord.imagesUploaded, 5);
  assert.equal(result.productionRecord.stockWritten, 100);
  assert.equal(result.productionRecord.independentReadbackVerified, true);
  assert.equal(candidate.lifecycleV11.skuPackage.productionRecord, null);
  assert.deepEqual(candidate, before);
});
