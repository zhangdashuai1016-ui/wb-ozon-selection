import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { currentProductionBindingFixture, historicalPlanFixture } from "./helpers/d-software-fixture.mjs";
import { createProductionPlan, projectProductionPlanInputs } from "../lib/production-plan.mjs";
import {
  PLATFORM_WRITE_PREFLIGHT_VERSION,
  assertCurrentProductionExecutionBinding,
  runPlatformWritePreflight,
  assertCurrentPlatformWritePreflight,
  validatePlatformWritePreflight
} from "../lib/platform-write-preflight.mjs";
import { platformWritePreflightTechnicalStatus } from "../lib/platform-write-preflight-contract.mjs";

test("production execution requires the exact current verified configuration frozen by the owner", () => {
  const productionAuthorization = authorizedProductionFixture().productionAuthorization;
  const currentProductionBinding = currentProductionBindingFixture(productionAuthorization);
  const input = { productionAuthorization, currentProductionBinding, checkedAt: "2026-08-22T07:15:00.000Z" };
  const before = structuredClone(input);
  assert.deepEqual(assertCurrentProductionExecutionBinding(input), currentProductionBinding);
  for (const patch of [{ bindingId: "binding:another" }, { configurationVersion: "config-v2" }, { warehouseId: "70002" },
    { warehouseRef: "warehouse:another" }, { credentialAlias: "credential-alias:another" }, { platform: "wb" },
    { storeRef: { ...currentProductionBinding.storeRef, platformStoreId: "another-store" } },
    { storeRef: { ...currentProductionBinding.storeRef, mappingVersion: "stores-v2" } },
    { warehouseId: "070001" }, { undeclared: true },
    { verification: { ...currentProductionBinding.verification, checkedAt: "2026-08-22T08:00:00.000Z" } },
    { verification: { ...currentProductionBinding.verification, expiresAt: input.checkedAt } },
    { verification: { ...currentProductionBinding.verification, expiresAt: "2026-02-30T00:00:00.000Z" } }]) {
    assert.throws(() => assertCurrentProductionExecutionBinding({ ...input, currentProductionBinding: { ...currentProductionBinding, ...patch } }),
      /PRODUCTION_(?:EXECUTION_BINDING_|BINDINGS_INVALID)/);
  }
  assert.throws(() => assertCurrentProductionExecutionBinding({ ...input, currentProductionBinding: null }), /BINDING_REQUIRED/);
  assert.throws(() => assertCurrentProductionExecutionBinding({ ...input, checkedAt: "2026-02-30T00:00:00.000Z" }), /BINDING_TIME_INVALID/);
  assert.throws(() => assertCurrentProductionExecutionBinding({ ...input, checkedAt: "2026-08-21T00:00:00.000Z" }), /BINDING_TIME_INVALID/);
  assert.throws(() => assertCurrentProductionExecutionBinding({ ...input, productionAuthorization: historicalPlanFixture().authorization }), /RECONFIRMATION_REQUIRED/);
  assert.deepEqual(input, before);
});

function productionPlanFixture() {
  return createProductionPlan(authorizedProductionFixture());
}

function successfulInspection(overrides = {}) {
  return {
    observedStore: "dandanshu",
    observedStoreRef: { stableStoreId: "dandanshu", platformStoreId: "seller-dandanshu-001", mappingVersion: "stores-v1" },
    storeIdentityStatus: "matched",
    storeIdentityEvidenceRef: "seller-api:client-info:2026-08-22T07:10:00Z",
    permissionStatus: "verified",
    permissionEvidenceRef: "seller-api:read-only-permission-check:2026-08-22T07:10:00Z",
    connections: {
      api: { status: "connected", checkedVia: "seller_api_read_only", evidenceRef: "seller-api:health:2026-08-22T07:10:00Z" },
      sellerBackend: { status: "connected", checkedVia: "seller_backend_read_only", evidenceRef: "seller-backend:session:2026-08-22T07:10:00Z" }
    },
    platformWritableFields: ["create_product", "title", "attributes", "price", "stock", "assets.finalUploads", "publish_scope", "advertising"],
    imagePermissionStatus: "verified",
    imagePermissionEvidenceRef: "seller-api:image-scope:2026-08-22T07:10:00Z",
    priceFieldCurrency: "CNY",
    priceCurrencyEvidenceRef: "seller-api:store-currency:CNY:2026-08-22T07:10:00Z",
    risks: [],
    ...overrides
  };
}

test("13B-1 generates a complete read-only PlatformWritePreflight from ProductionPlan", async () => {
  const plan = productionPlanFixture();
  let request;
  const result = await runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async (value) => {
      request = value;
      return successfulInspection();
    }
  });
  assert.equal(result.schemaVersion, PLATFORM_WRITE_PREFLIGHT_VERSION);
  assert.equal(result.targetPlatform, "ozon");
  assert.deepEqual(result.storeIdentity, {
    expectedStore: "dandanshu",
    observedStore: "dandanshu",
    expectedStoreRef: projectProductionPlanInputs(plan).storeRef, observedStoreRef: projectProductionPlanInputs(plan).storeRef,
    status: "matched",
    evidenceRef: "seller-api:client-info:2026-08-22T07:10:00Z"
  });
  assert.equal(result.permission.status, "verified");
  assert.equal(result.connectionStatus.api.status, "connected");
  assert.equal(result.connectionStatus.sellerBackend.status, "connected");
  assert.equal(result.imagePermission.status, "verified");
  assert.equal(result.technicalStatus, "completed");
  assert.equal(result.businessStateEffect, "none");
  assert.deepEqual(validatePlatformWritePreflight(result), { valid: true, errors: [] });
  assert.deepEqual(Object.keys(request).sort(), [
    "expectedPlatformWriteCurrency", "expectedStore", "expectedStoreRef", "imageUploadRequested", "inventoryWriteRequested", "mode",
    "platformWriteRequested", "productCreationRequested", "requestedWriteFields", "targetPlatform"
  ]);
  assert.equal(request.mode, "read_only_preflight");
  assert.equal(request.productCreationRequested, true);
  assert.equal(request.inventoryWriteRequested, true);
  assert.equal(request.platformWriteRequested, false);
  assert.equal(result.priceCurrency.status, "matched");
});

test("13B-1 intersects platform capabilities with the authorized field scope", async () => {
  const result = await runPlatformWritePreflight({
    productionPlan: productionPlanFixture(),
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      platformWritableFields: ["title", "attributes", "advertising"]
    })
  });
  assert.deepEqual(result.effectiveWritableFields, ["title", "attributes"]);
  assert.equal(result.effectiveWritableFields.includes("advertising"), false);
  assert.ok(result.risks.some((risk) => risk.code === "write_scope_not_fully_available"));
  assert.equal(result.readyForPlatformWrite, false);
});

test("13B-1 records connection failure only as technicalStatus without a business effect", async () => {
  const plan = productionPlanFixture();
  const before = structuredClone(plan);
  const result = await runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      connections: {
        api: { status: "unavailable", checkedVia: "seller_api_read_only", evidenceRef: "seller-api:timeout:2026-08-22T07:10:00Z" },
        sellerBackend: { status: "system_error", checkedVia: "seller_backend_read_only", evidenceRef: "seller-backend:connection-error:2026-08-22T07:10:00Z" }
      },
      permissionStatus: "unknown",
      permissionEvidenceRef: "permission:not-observed:2026-08-22T07:10:00Z",
      imagePermissionStatus: "unknown",
      imagePermissionEvidenceRef: "image-permission:not-observed:2026-08-22T07:10:00Z"
    })
  });
  assert.equal(result.technicalStatus, "system_error");
  assert.equal(result.businessStateEffect, "none");
  assert.deepEqual(plan, before);
  assert.ok(result.risks.some((risk) => risk.code === "technical_system_error"));
});

test("13B-1 records missing permission without creating or modifying anything", async () => {
  const result = await runPlatformWritePreflight({
    productionPlan: productionPlanFixture(),
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async () => successfulInspection({
      permissionStatus: "permission_required",
      permissionEvidenceRef: "seller-api:permission-required:2026-08-22T07:10:00Z",
      imagePermissionStatus: "permission_required",
      imagePermissionEvidenceRef: "seller-api:image-permission-required:2026-08-22T07:10:00Z"
    })
  });
  assert.equal(result.technicalStatus, "permission_required");
  assert.equal(result.productCreated, false);
  assert.equal(result.imagesUploaded, 0);
  assert.equal(result.inventoryModified, false);
  assert.equal(result.storeDataModified, false);
  assert.equal(result.productionRecordCreated, false);
  assert.equal(result.platformWrites, 0);
});

test("13B-1 rejects an inspector that attempts to mutate the frozen ProductionPlan request", async () => {
  const plan = productionPlanFixture();
  await assert.rejects(() => runPlatformWritePreflight({
    productionPlan: plan,
    checkedAt: "2026-08-22T07:10:00.000Z",
    inspectPlatform: async (request) => {
      request.requestedWriteFields.push("advertising");
      return successfulInspection();
    }
  }), TypeError);
  assert.equal(projectProductionPlanInputs(plan).allowedWriteFields.includes("advertising"), false);
});

test("published PlatformWritePreflight schema freezes the no-write boundary", async () => {
  const url = new URL("../schema/platform-write-preflight-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  for (const field of [
    "targetPlatform", "storeIdentity", "permission", "connectionStatus", "authorizedWriteFields",
    "platformWritableFields", "effectiveWritableFields", "imagePermission", "priceCurrency", "risks", "technicalStatus"
  ]) assert.ok(schema.required.includes(field), field);
  assert.equal(schema.properties.businessStateEffect.const, "none");
  assert.equal(schema.properties.readyForPlatformWrite.const, false);
  assert.equal(schema.properties.productCreated.const, false);
  assert.equal(schema.properties.imagesUploaded.const, 0);
  assert.equal(schema.properties.inventoryModified.const, false);
  assert.equal(schema.properties.storeDataModified.const, false);
  assert.equal(schema.properties.productionRecordCreated.const, false);
  assert.equal(schema.properties.platformWrites.const, 0);
});

test("前检不信任同名匹配声明，旧平台ID或映射必须阻断", async () => {
  const plan = productionPlanFixture();
  for (const field of ["platformStoreId", "mappingVersion"]) {
    const inspection = successfulInspection(); inspection.observedStoreRef[field] = "another";
    const result = await runPlatformWritePreflight({ productionPlan: plan, checkedAt: "2026-08-22T08:00:00.000Z", inspectPlatform: async () => inspection });
    assert.equal(result.storeIdentity.status, "mismatched");
    assert.equal(result.platformWrites, 0);
    const forged = structuredClone(result); forged.storeIdentity.status = "matched";
    assert.equal(validatePlatformWritePreflight(forged).valid, false);
  }
  const missing = successfulInspection(); delete missing.observedStoreRef;
  await assert.rejects(() => runPlatformWritePreflight({ productionPlan: plan, checkedAt: "2026-08-22T08:00:00.000Z", inspectPlatform: async () => missing }), /INSPECTION_INVALID/);
});

test('v1.2 API route retains unobserved backend without making it a required connection', async () => {
  const inspection = successfulInspection();
  inspection.connections.sellerBackend = { status: 'unknown', checkedVia: 'not_checked', evidenceRef: 'evidence:backend-unobserved' };
  inspection.connectionRequirements = { requiredConnections: [] };
  const result = await runPlatformWritePreflight({ productionPlan: productionPlanFixture(), checkedAt: '2026-08-22T07:10:00.000Z', inspectPlatform: async () => inspection });
  assert.equal(result.schemaVersion, 'platform-write-preflight-v1.2');
  assert.deepEqual(result.connectionRequirements, { contractVersion: 'ozon-connection-requirements-v1', route: 'seller_api', requiredConnections: ['api'] });
  assert.equal(result.technicalStatus, 'completed');
  assert.deepEqual(result.connectionStatus.sellerBackend, inspection.connections.sellerBackend);
  assert.equal(assertCurrentPlatformWritePreflight(result), result);
  for (const value of [[], ['sellerBackend'], ['api', 'api']]) {
    const bad = structuredClone(result); bad.connectionRequirements.requiredConnections = value;
    assert.equal(validatePlatformWritePreflight(bad).valid, false);
  }
  const bad = structuredClone(result); bad.connectionStatus.api.status = 'unknown';
  assert.equal(validatePlatformWritePreflight(bad).valid, false, 'an unobserved required API cannot claim completed');
  assert.equal(platformWritePreflightTechnicalStatus(inspection, ['api', 'sellerBackend']), 'data_unavailable', 'legacy dual-connection interpretation remains explicit');
});

test('v1.1 historical results remain readable without being promoted to current execution', async () => {
  const current = await runPlatformWritePreflight({ productionPlan: productionPlanFixture(), checkedAt: '2026-08-22T07:10:00.000Z', inspectPlatform: async () => successfulInspection() });
  const old = structuredClone(current); old.schemaVersion = 'platform-write-preflight-v1.1'; delete old.connectionRequirements;
  old.preflightId = 'platform-preflight:historical-identity';
  const before = structuredClone(old);
  assert.equal(validatePlatformWritePreflight(old).valid, true);
  assert.throws(() => assertCurrentPlatformWritePreflight(old), /VERSION_OUTDATED/);
  assert.deepEqual(old, before);
  const mixed = { ...old, connectionRequirements: current.connectionRequirements };
  assert.equal(validatePlatformWritePreflight(mixed).valid, false);
  const schema = JSON.parse(await readFile(new URL('../schema/platform-write-preflight-v1.2.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('connectionRequirements'));
  assert.equal(schema.properties.connectionRequirements.additionalProperties, false);
  assert.deepEqual(schema.properties.connectionRequirements.properties.requiredConnections.const, ['api']);
  assert.equal(schema.properties.schemaVersion.const, current.schemaVersion);
});
