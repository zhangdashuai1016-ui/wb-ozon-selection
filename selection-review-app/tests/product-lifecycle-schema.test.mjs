import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PRODUCT_LIFECYCLE_SCHEMA_VERSION,
  appendProfitModelVersion,
  readbackStopReason,
  supplierSearchStopReason,
  validateLifecyclePackage,
  validateLifecycleTransition,
  validateOpportunityPackage,
  validateSkuLifecyclePackage
} from "../lib/product-lifecycle-schema.mjs";

const NOW = "2026-08-12T08:00:00.000Z";

function opportunity(overrides = {}) {
  return {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "OpportunityPackage",
    parentOpportunityId: "OPP-001",
    dataRevision: 0,
    directionName: "木质机械模型",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    businessPhase: "A",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    salesSnapshots: [],
    supplierOptions: [],
    recommendedSupplierOptionId: null,
    confirmedSupplierOptionId: null,
    supplierSearch: {
      status: "not_started",
      limits: {
        maxSearchRounds: 3,
        maxSupplierOptions: 5,
        maxConsecutiveNoEvidenceRounds: 2
      },
      searchRounds: 0,
      supplierOptionsFound: 0,
      consecutiveNoEvidenceRounds: 0,
      stopReason: null,
      stoppedAt: null
    },
    audit: { createdAt: NOW, updatedAt: NOW, history: [] },
    ...overrides
  };
}

function profitModel(version = "profit-v1", overrides = {}) {
  return {
    profitModelVersion: version,
    calculatedAt: NOW,
    inputSnapshotRefs: ["sales-1", "supply-1", "fees-1"],
    recommendedSalePriceCny: 151.78,
    unitProfitRmb: 44.95,
    profitMargin: 0.2962,
    result: "passed",
    ...overrides
  };
}

function sku(overrides = {}) {
  return {
    schemaVersion: PRODUCT_LIFECYCLE_SCHEMA_VERSION,
    entityType: "SkuLifecyclePackage",
    skuPackageId: "SKU-PKG-001",
    parentOpportunityId: "OPP-001",
    supplierOptionId: "SUPPLY-001",
    supplierSkuId: "4993364145574",
    variantKey: "豪华小火车",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    dataRevision: 0,
    businessPhase: "B",
    businessResult: "pending",
    technicalStatus: "not_started",
    ownerAction: "none",
    inheritedSalesSnapshotRefs: ["sales-1"],
    selectedSupplySnapshot: { snapshotId: "supply-1" },
    skuFacts: {},
    profitModels: [],
    activeProfitModelVersion: null,
    c1ProductPlan: null,
    c2FinalAssets: null,
    productionAuthorization: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    readbackPolicy: {
      status: "not_started",
      maxAutomaticAttempts: 2,
      automaticAttempts: 0,
      maxConsecutiveSameFailure: 1,
      consecutiveSameFailureCount: 0,
      lastFailureLayer: null,
      stopReason: null,
      stoppedAt: null
    },
    readbackHistory: [],
    audit: { createdAt: NOW, updatedAt: NOW, history: [] },
    ...overrides
  };
}

function errorPaths(result) {
  return result.errors.map((item) => item.path);
}

test("published schema freezes product-lifecycle-v1.1 and both package types", async () => {
  const url = new URL("../schema/product-lifecycle-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.equal(schema.$id, PRODUCT_LIFECYCLE_SCHEMA_VERSION);
  assert.equal(schema.$defs.OpportunityPackage.properties.entityType.const, "OpportunityPackage");
  assert.equal(schema.$defs.SkuLifecyclePackage.properties.entityType.const, "SkuLifecyclePackage");
  for (const name of ["businessPhase", "businessResult", "technicalStatus", "ownerAction"]) {
    assert.ok(schema.$defs.OpportunityPackage.required.includes(name));
    assert.ok(schema.$defs.SkuLifecyclePackage.required.includes(name));
  }
  assert.ok(schema.$defs.profitModel.required.includes("profitModelVersion"));
  assert.ok(schema.$defs.readbackPolicy.required.includes("maxAutomaticAttempts"));
  assert.ok(schema.$defs.supplierSearch.required.includes("limits"));
});

test("native OpportunityPackage uses A/closed while legacy read-only views may use unknown", () => {
  assert.deepEqual(validateOpportunityPackage(opportunity()), { valid: true, errors: [] });
  const wrongPhase = validateOpportunityPackage(opportunity({ businessPhase: "B" }));
  assert.equal(wrongPhase.valid, false);
  assert.ok(errorPaths(wrongPhase).includes("businessPhase"));
});

test("valid SkuLifecyclePackage starts at B and keeps an independent SKU identity", () => {
  assert.deepEqual(validateSkuLifecyclePackage(sku()), { valid: true, errors: [] });
  const missingIdentity = validateSkuLifecyclePackage(sku({ supplierSkuId: "", businessPhase: "A" }));
  assert.equal(missingIdentity.valid, false);
  assert.ok(errorPaths(missingIdentity).includes("supplierSkuId"));
  assert.ok(errorPaths(missingIdentity).includes("businessPhase"));
});

test("all four state lines are required and independently validated", () => {
  const value = sku();
  delete value.ownerAction;
  value.technicalStatus = "passed";
  const result = validateLifecyclePackage(value);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("ownerAction"));
  assert.ok(errorPaths(result).includes("technicalStatus"));
});

test("supplier collection cannot run after a finite stop condition is reached", () => {
  const value = opportunity();
  value.supplierSearch.status = "running";
  value.supplierSearch.searchRounds = 3;
  const result = validateOpportunityPackage(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "supplierSearch.status" && /停止条件/.test(item.message)));
  assert.equal(supplierSearchStopReason(value.supplierSearch), "max_search_rounds");
});

test("supplier collection requires explicit finite positive limits", () => {
  const value = opportunity();
  value.supplierSearch.limits.maxSearchRounds = null;
  value.supplierSearch.limits.maxSupplierOptions = Infinity;
  const result = validateOpportunityPackage(value);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("supplierSearch.limits.maxSearchRounds"));
  assert.ok(errorPaths(result).includes("supplierSearch.limits.maxSupplierOptions"));
});

test("profitModelVersion is mandatory, unique and strictly increasing", () => {
  const result = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1"), profitModel("profit-v1")],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path.endsWith("profitModelVersion") && /重复|递增/.test(item.message)));
});

test("profit margin uses recommended sale price and current pass requires either frozen threshold", () => {
  const wrongFormula = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", { profitMargin: 0.5 })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.ok(wrongFormula.errors.some((item) => item.path.endsWith("profitMargin") && /建议成交价/.test(item.message)));

  const neitherThreshold = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", {
      recommendedSalePriceCny: 100,
      unitProfitRmb: 14,
      profitMargin: 0.14,
      result: "passed"
    })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.ok(neitherThreshold.errors.some((item) => item.path.endsWith("result") && /任一项/.test(item.message)));

  const marginOnly = validateSkuLifecyclePackage(sku({
    profitModels: [profitModel("profit-v1", {
      recommendedSalePriceCny: 100,
      unitProfitRmb: 15,
      profitMargin: 0.15,
      result: "passed"
    })],
    activeProfitModelVersion: "profit-v1"
  }));
  assert.equal(marginOnly.valid, true);
});

test("appendProfitModelVersion preserves prior profit evidence without mutation", () => {
  const original = sku();
  const first = appendProfitModelVersion(original, profitModel("profit-v1"));
  const secondModel = profitModel("profit-v2", {
    calculatedAt: "2026-08-12T09:00:00.000Z",
    unitProfitRmb: 42,
    profitMargin: 42 / 151.78
  });
  const second = appendProfitModelVersion(first, secondModel);
  assert.equal(original.profitModels.length, 0);
  assert.equal(first.profitModels.length, 1);
  assert.equal(second.profitModels.length, 2);
  assert.deepEqual(second.profitModels[0], first.profitModels[0]);
  assert.equal(second.activeProfitModelVersion, "profit-v2");
  assert.throws(() => appendProfitModelVersion(second, profitModel("profit-v2")), /profit-v3/);
});

test("transition validation rejects deletion or overwrite of historical profit models", () => {
  const previous = sku({
    dataRevision: 1,
    profitModels: [profitModel("profit-v1")],
    activeProfitModelVersion: "profit-v1"
  });
  const next = structuredClone(previous);
  next.dataRevision = 2;
  next.profitModels[0].unitProfitRmb = 999;
  const result = validateLifecycleTransition(previous, next);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "profitModels" && /覆盖/.test(item.message)));
});

test("technical failure does not change business phase or business result", () => {
  const previous = sku();
  const next = sku({
    dataRevision: 1,
    businessPhase: "C1",
    businessResult: "rejected",
    technicalStatus: "data_acquisition_failed"
  });
  const result = validateLifecycleTransition(previous, next);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes("businessPhase"));
  assert.ok(errorPaths(result).includes("businessResult"));
});

test("E readback cannot keep running at the automatic-attempt boundary", () => {
  const value = sku({ businessPhase: "C2" });
  value.readbackPolicy = {
    ...value.readbackPolicy,
    status: "running",
    automaticAttempts: 2,
    consecutiveSameFailureCount: 0
  };
  const result = validateSkuLifecyclePackage(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "readbackPolicy.status" && /停止条件/.test(item.message)));
  assert.equal(readbackStopReason(value.readbackPolicy), "max_automatic_attempts");
});

test("stopped E readback records an explicit failure boundary and time", () => {
  const value = sku({ businessPhase: "C2", technicalStatus: "stopped", ownerAction: "decide_readback_failure" });
  value.readbackPolicy = {
    ...value.readbackPolicy,
    status: "stopped",
    automaticAttempts: 2,
    stopReason: "max_automatic_attempts",
    stoppedAt: "2026-08-12T10:00:00.000Z"
  };
  assert.deepEqual(validateSkuLifecyclePackage(value), { valid: true, errors: [] });
});

test("D and E are blocked until C1, C2 and exact production authorization exist", () => {
  const blockedD = validateSkuLifecyclePackage(sku({ businessPhase: "D" }));
  assert.equal(blockedD.valid, false);
  assert.ok(errorPaths(blockedD).includes("c1ProductPlan.status"));
  assert.ok(errorPaths(blockedD).includes("c2FinalAssets.status"));
  assert.ok(errorPaths(blockedD).includes("productionAuthorization.status"));

  const allowedD = sku({
    businessPhase: "D",
    c1ProductPlan: { status: "completed" },
    c2FinalAssets: {
      schemaVersion: "c2-asset-lifecycle-v1.1",
      status: "completed",
      assets: {
        collected: [],
        aiDrafts: [],
        finalUploads: [{
          assetId: "final-1",
          ownerConfirmed: true,
          productionEligible: true
        }]
      },
      ownerFinalUploadConfirmation: {
        status: "confirmed",
        confirmedBy: "owner",
        confirmedAt: NOW,
        approvedAssetIds: ["final-1"]
      },
      dReadPolicy: {
        onlyAllowedArea: "assets.finalUploads",
        collectedAllowed: false,
        aiDraftsAllowed: false,
        ownerConfirmationRequired: true
      },
      platformUploads: 0,
      productionStarted: false
    },
    productionAuthorization: {
      schemaVersion: "production-authorization-v1.1",
      authorizationId: "production-auth:SKU-PKG-001:0",
      status: "confirmed",
      confirmedBy: "owner",
      confirmedAt: NOW,
      sourceConfirmationCardId: "final-plan-card:SKU-PKG-001:0",
      authorizedDataRevision: 0,
      lockedScope: {
        platform: "ozon",
        store: "dandanshu",
        skuPackageId: "SKU-PKG-001",
        supplierSkuId: "4993364145574",
        variantKey: "豪华小火车",
        titleVersion: "c1-seo-draft-v1.1:test",
        title: "3D-пазл паровоз",
        attributeVersion: "c1-fact-verification-v1.1:test",
        attributes: {},
        platformCategory: {},
        recommendedPrice: { rub: 1831, cny: 151.78 },
        buyerTargetPrice: { amount: 1831, currency: "RUB" },
        platformWritePrice: { amount: 151.78, currency: "CNY" },
        priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
        stock: 100,
        assetsFinalUploadsVersion: "c2-assets:SKU-PKG-001:test",
        finalUploads: [{ assetId: "final-1", ownerConfirmed: true, productionEligible: true }],
        publishScope: "create_draft_only",
        exclusions: [],
        allowedWriteFields: ["title", "price", "stock", "assets.finalUploads"]
      },
      scopeExpansionAllowed: false,
      fieldMutationAllowed: false,
      skuReplacementAllowed: false,
      assetReplacementAllowed: false,
      readPolicy: "authorization_snapshot_only",
      productionExecuted: false,
      platformWrites: 0
    }
  });
  assert.deepEqual(validateSkuLifecyclePackage(allowedD), { valid: true, errors: [] });

  const blockedE = validateSkuLifecyclePackage({ ...allowedD, businessPhase: "E" });
  assert.ok(errorPaths(blockedE).includes("productionRecord"));
});
