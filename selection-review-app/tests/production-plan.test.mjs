import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createProductionPlan,
  PRODUCTION_PLAN_VERSION,
  validateProductionPlan,
  validateProductionPlanAuthorizationBinding
} from "../lib/production-plan.mjs";

function authorizationFixture() {
  return {
    schemaVersion: "production-authorization-v1.1",
    authorizationId: "production-auth:sku-lifecycle:CX-20260803-010:4993364145574:23",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt: "2026-08-12T13:30:00.000Z",
    sourceConfirmationCardId: "final-plan-card:CX-20260803-010:22",
    authorizedDataRevision: 23,
    lockedScope: {
      platform: "ozon",
      store: "dandanshu",
      skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
      supplierSkuId: "4993364145574",
      variantKey: "豪华小火车",
      titleVersion: "c1-seo-draft-v1.1:2026-08-12T13:00:00.000Z",
      title: "Механический деревянный 3D-пазл «Паровоз», 320 деталей",
      attributeVersion: "c1-fact-verification-v1.1:2026-08-12T12:30:00.000Z",
      attributes: { brand: { value: "unknown", status: "unknown" } },
      platformCategory: {
        descriptionCategoryId: { value: "17028665", verificationStatus: "confirmed" },
        typeId: { value: "92935", verificationStatus: "confirmed" }
      },
      recommendedPrice: { rub: 1831, cny: 151.78 },
      buyerTargetPrice: { amount: 1831, currency: "RUB" },
      platformWritePrice: { amount: 151.78, currency: "CNY" },
      priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
      stock: 100,
      assetsFinalUploadsVersion: "c2-assets:CX-20260803-010:2026-08-12T13:12:00.000Z",
      finalUploads: [{
        assetId: "final:CX-20260803-010:main",
        ownerConfirmed: true,
        productionEligible: true
      }],
      publishScope: "create_draft_only",
      exclusions: ["do_not_submit", "do_not_publish"],
      allowedWriteFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"]
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
}

test("13A creates a complete ProductionPlan only from ProductionAuthorization", () => {
  const plan = createProductionPlan({
    productionAuthorization: authorizationFixture(),
    createdAt: "2026-08-12T14:00:00.000Z"
  });
  assert.equal(plan.schemaVersion, PRODUCTION_PLAN_VERSION);
  assert.equal(plan.platform, "ozon");
  assert.equal(plan.store, "dandanshu");
  assert.equal(plan.skuPackageId, "sku-lifecycle:CX-20260803-010:4993364145574");
  assert.deepEqual(plan.sku, { supplierSkuId: "4993364145574", variantKey: "豪华小火车" });
  assert.match(plan.titleVersion, /^c1-seo-draft-v1\.1:/);
  assert.match(plan.title, /Паровоз/);
  assert.match(plan.attributeVersion, /^c1-fact-verification-v1\.1:/);
  assert.equal(plan.platformCategory.typeId.value, "92935");
  assert.deepEqual(plan.buyerTargetPrice, { amount: 1831, currency: "RUB" });
  assert.deepEqual(plan.platformWritePrice, { amount: 151.78, currency: "CNY" });
  assert.equal(plan.executionStrategy.primaryPath, "seller_api");
  assert.equal(plan.executionStrategy.manualActionsRequired, 1);
  assert.equal(plan.executionStrategy.forbiddenBrowserActions.includes("fill_price"), true);
  assert.equal(plan.stock, 100);
  assert.match(plan.assetsFinalUploadsVersion, /^c2-assets:/);
  assert.equal(plan.publishScope, "create_draft_only");
  assert.deepEqual(validateProductionPlan(plan), { valid: true, errors: [] });
});

test("13A exposes no A/B/C source input and performs no research or external operation", () => {
  const plan = createProductionPlan({
    productionAuthorization: authorizationFixture(),
    createdAt: "2026-08-12T14:00:00.000Z"
  });
  assert.equal(plan.sourceDataAccess, "production_authorization_only");
  assert.equal(plan.sourceReadPolicy, "authorization_snapshot_only");
  assert.equal(plan.productResearchPerformed, false);
  assert.equal("salesSnapshot" in plan, false);
  assert.equal("supplierOption" in plan, false);
  assert.equal("profitModel" in plan, false);
  assert.equal("c1ProductPlan" in plan, false);
  assert.equal("c2FinalAssets" in plan, false);
  assert.equal(plan.platformWrites, 0);
  assert.equal(plan.productCreated, false);
  assert.equal(plan.assetsUploaded, 0);
  assert.equal(plan.readbackPerformed, false);
});

test("13A freezes the plan and never mutates its ProductionAuthorization input", () => {
  const authorization = authorizationFixture();
  const before = structuredClone(authorization);
  const plan = createProductionPlan({
    productionAuthorization: authorization,
    createdAt: "2026-08-12T14:00:00.000Z"
  });
  assert.deepEqual(authorization, before);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.platformWritePrice), true);
  assert.throws(() => { plan.stock = 5; }, TypeError);
  assert.throws(() => { plan.platformWritePrice.amount = 1; }, TypeError);
});

test("13A keeps an existing plan unchanged and reports later authorization drift", () => {
  const authorization = authorizationFixture();
  const plan = createProductionPlan({
    productionAuthorization: authorization,
    createdAt: "2026-08-12T14:00:00.000Z"
  });
  const originalPlan = structuredClone(plan);
  const unchanged = validateProductionPlanAuthorizationBinding(plan, authorization);
  assert.equal(unchanged.valid, true);
  assert.equal(unchanged.status, "authorization_unchanged");

  const changedAuthorization = structuredClone(authorization);
  changedAuthorization.lockedScope.title = "Изменённый заголовок";
  const drift = validateProductionPlanAuthorizationBinding(plan, changedAuthorization);
  assert.equal(drift.valid, false);
  assert.equal(drift.status, "authorization_drift_detected");
  assert.deepEqual(plan, originalPlan);
  assert.equal(plan.platformWritePrice.amount, 151.78);
});

test("13A rejects an invalid or unconfirmed authorization instead of building a fallback plan", () => {
  const invalid = authorizationFixture();
  invalid.status = "pending";
  assert.throws(() => createProductionPlan({
    productionAuthorization: invalid,
    createdAt: "2026-08-12T14:00:00.000Z"
  }), /ProductionAuthorization校验失败/);
});

test("published ProductionPlan schema freezes the simulation-only no-write boundary", async () => {
  const url = new URL("../schema/production-plan-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  for (const field of [
    "platform", "store", "skuPackageId", "sku", "titleVersion", "title", "attributeVersion",
    "attributes", "platformCategory", "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock", "assetsFinalUploadsVersion", "finalUploads", "executionStrategy", "publishScope"
  ]) assert.ok(schema.required.includes(field), field);
  assert.equal(schema.properties.mode.const, "simulation");
  assert.equal(schema.properties.sourceDataAccess.const, "production_authorization_only");
  assert.equal(schema.properties.sourceReadPolicy.const, "authorization_snapshot_only");
  assert.equal(schema.properties.stock.const, 100);
  assert.equal(schema.properties.platformWrites.const, 0);
  assert.equal(schema.properties.productCreated.const, false);
  assert.equal(schema.properties.assetsUploaded.const, 0);
  assert.equal(schema.properties.readbackPerformed.const, false);
});
