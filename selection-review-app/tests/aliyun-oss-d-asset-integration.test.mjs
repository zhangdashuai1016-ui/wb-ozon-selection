import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createJsonBusinessStateRepository, initialBusinessStateDocument } from "../lib/business-state-repository.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { assertSafeRuntimeRecord } from "../lib/runtime-identity.mjs";
import { buildDESoftwareIntegrationView } from "../lib/d-e-software-integration.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createHash } from "node:crypto";
import {
  createPersistableAliyunOssAssetIntent,
  executeAliyunOssAssetIntent,
  markAliyunOssAssetIntentPersisted,
  settleAliyunOssAssetIntent,
  reconcileAliyunOssAssetIntentAfterRestart
} from "../lib/aliyun-oss-d-asset-integration.mjs";
import { inspectAdapterCapabilities, resolveFinalUploads } from "../lib/ozon-seller-api-de-adapter.mjs";
import { projectProductionPlanInputs, fingerprintProductionAuthorization } from "../lib/production-plan.mjs";
import { authorizedProductionFixture, localFinalAssets } from "./helpers/c2-software-fixture.mjs";
import { historicalPlanFixture, currentProductionBindingFixture } from "./helpers/d-software-fixture.mjs";

const NOW = "2026-08-22T12:00:00.000Z";

function authorizedCandidate() {
  const fixture = authorizedProductionFixture({ assets: localFinalAssets() });
  return { id: fixture.candidateId, dataRevision: fixture.candidateRevision, lifecycleV11: { skuPackage: fixture.skuPackage } };
}

function ownerDecision(candidate) {
  const sku = candidate.lifecycleV11.skuPackage;
  return {
    confirmed: true,
    confirmedBy: "owner",
    authorizationId: sku.productionAuthorization.authorizationId,
    skuPackageId: sku.skuPackageId,
    finalUploadAssetIds: sku.productionAuthorization.lockedScope.finalUploads.map((asset) => asset.assetId)
  };
}

test("OSS素材意图必须绑定当前revision、主人授权和完整finalUploads顺序", () => {
  const candidate = authorizedCandidate();
  const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW });
  assert.equal(intent.status, "awaiting_persistence");
  assert.equal(intent.mustPersistBeforeUpload, true);
  assert.equal(intent.attemptLimit, 1);
  assert.equal(intent.ossWrites, 0);
  assert.equal(intent.platformWrites, 0);
  assert.throws(() => createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision - 1, ownerDecision: ownerDecision(candidate), startedAt: NOW }), /OSS_D_REVISION_CONFLICT/);
  assert.throws(() => createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: { ...ownerDecision(candidate), finalUploadAssetIds: ownerDecision(candidate).finalUploadAssetIds.toReversed() }, startedAt: NOW }), /OSS_D_SCOPE_MISMATCH/);
});

test("持久化后只调用一次OSS并把稳定URL证据直接接入D适配器", async () => {
  const candidate = authorizedCandidate();
  const baseIntent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW });
  const persistedIntent = markAliyunOssAssetIntentPersisted({ intent: baseIntent, persistedAt: "2026-08-22T12:00:01.000Z", persistedCandidateRevision: candidate.dataRevision + 1 });
  candidate.dataRevision += 1;
  let calls = 0;
  const result = await executeAliyunOssAssetIntent({
    persistedIntent,
    candidate,
    currentProductionBinding: currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization),
    serverClock: () => "2026-08-22T12:00:02.000Z",
    upload: async ({ finalUploads, beforePublicWrite }) => {
      calls += 1;
      for (const { assetId, order, sha256 } of finalUploads) await beforePublicWrite({ assetId, order, sha256 });
      return {
        status: "verified",
        mode: "preapproved_stable_https",
        protocolVersion: "aliyun-oss-final-assets-v1",
        approvedHosts: ["assets.example.invalid"],
        resolvedAssets: finalUploads.map((asset) => ({
          assetId: asset.assetId, sha256: asset.sha256, order: asset.order,
          platformAcceptedUrl: `https://assets.example.invalid/${asset.assetId}.png`,
          stable: true, authorizationStatus: "approved", evidenceRef: `oss:${asset.assetId}`
        })),
        evidenceRef: "oss:verified:CX-OSS-001"
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.intent.status, "completed");
  const inputs = projectProductionPlanInputs(persistedIntent.productionPlan);
  const capabilities = inspectAdapterCapabilities({
    store: "dandanshu", storeRef: inputs.storeRef, warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias, warehouseId: "70001", inspectedAt: NOW,
    storeIdentity: { status: "verified", expectedStore: "dandanshu", observedStore: "dandanshu", observedStoreRef: inputs.storeRef, credentialAlias: inputs.credentialAlias, evidenceRef: "store:1" },
    productImport: { status: "verified", protocolVersion: "ozon-product-import-v3", endpoint: "/v3/product/import", statusEndpoint: "/v1/product/import/info", evidenceRef: "import:1" },
    assetTransport: result.assetTransport,
    inventoryWrite: { status: "verified", protocolVersion: "ozon-products-stocks-v2", endpoint: "/v2/products/stocks", warehouseId: "70001", storeRef: inputs.storeRef, warehouseRef: inputs.warehouseRef, credentialAlias: inputs.credentialAlias, evidenceRef: "stock:1" },
    independentReadback: { status: "verified", protocolVersion: "ozon-independent-readback-v1", endpoints: { attributes: "/v4/product/info/attributes", info: "/v3/product/info/list", prices: "/v5/product/info/prices", stocks: "/v4/product/info/stocks", stateFailed: "/v3/product/list" }, evidenceRef: "readback:1" }
  });
  assert.equal(capabilities.status, "ready");
  const resolved = resolveFinalUploads({ finalUploads: inputs.finalUploads, adapterCapabilities: capabilities });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.resolvedAssets.length, 2);
});

test("OSS失败或服务重启都收口unknown_outcome且不重试", async () => {
  const candidate = authorizedCandidate();
  const intent = markAliyunOssAssetIntentPersisted({
    intent: createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW }),
    persistedAt: "2026-08-22T12:00:01.000Z"
  });
  let calls = 0;
  const failed = await executeAliyunOssAssetIntent({
    persistedIntent: intent, candidate, serverClock: () => "2026-08-22T12:00:02.000Z",
    currentProductionBinding: currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization),
    upload: async () => { calls += 1; throw new Error("OSS_PUBLIC_READBACK_FAILED: HTTP 403"); }
  });
  assert.equal(calls, 1);
  assert.equal(failed.status, "unknown_outcome");
  assert.equal(failed.retryAllowed, false);
  assert.equal(failed.assetTransport, null);
  const restarted = reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent: intent, restartedAt: "2026-08-22T12:05:00.000Z" });
  assert.equal(restarted.status, "unknown_outcome");
  assert.equal(restarted.failureCode, "OSS_D_RESTART_UNKNOWN_OUTCOME");
  assert.equal(restarted.retryAllowed, false);
});

test("未落盘或落盘后资料再变动时上传调用为零", async () => {
  const candidate = authorizedCandidate();
  const base = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW });
  let calls = 0;
  const upload = async () => { calls += 1; throw new Error("must not run"); };
  await assert.rejects(() => executeAliyunOssAssetIntent({ persistedIntent: base, candidate, upload, serverClock: () => NOW }), /INTENT_NOT_PERSISTED/);
  const persisted = markAliyunOssAssetIntentPersisted({ intent: base, persistedAt: NOW, persistedCandidateRevision: candidate.dataRevision + 1 });
  candidate.dataRevision += 2;
  await assert.rejects(() => executeAliyunOssAssetIntent({ persistedIntent: persisted, candidate, upload, serverClock: () => NOW }), /BINDING_DRIFT/);
  assert.equal(calls, 0);
});

test("a saved historical OSS intent cannot transfer assets under the retired authorization contract", async () => {
  const { fixture, plan } = historicalPlanFixture({ assets: localFinalAssets() });
  const candidate = { id: fixture.candidateId, dataRevision: fixture.candidateRevision + 1,
    lifecycleV11: { skuPackage: structuredClone(fixture.skuPackage) } };
  // Synthetic old persisted envelope; the current admission API must not create this record.
  const inputs = projectProductionPlanInputs(plan);
  const intentCore = { candidateId: candidate.id, candidateDataRevision: fixture.candidateRevision,
    skuPackageId: fixture.skuPackage.skuPackageId, authorizationId: fixture.productionAuthorization.authorizationId,
    authorizationFingerprint: fingerprintProductionAuthorization(fixture.productionAuthorization), productionPlanId: plan.planId, productionPlan: plan,
    assetsFinalUploadsVersion: inputs.assetsFinalUploadsVersion, finalUploadAssetIds: inputs.finalUploads.map(asset => asset.assetId), startedAt: NOW };
  const persistedIntent = { schemaVersion: "aliyun-oss-d-asset-integration-v1",
    intentId: `oss-asset-intent:${createHash("sha256").update(JSON.stringify(intentCore)).digest("hex")}`, ...intentCore,
    status: "in_flight", attempt: 1, attemptLimit: 1, mustPersistBeforeUpload: true, persistedAt: NOW,
    persistedCandidateRevision: candidate.dataRevision, automaticRetry: false, retryAllowed: false, ossWrites: 0, platformWrites: 0 };
  const before = structuredClone({ candidate, persistedIntent }); let uploads = 0;
  await assert.rejects(() => executeAliyunOssAssetIntent({ persistedIntent, candidate, currentProductionBinding: currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization), serverClock: () => NOW,
    upload: async () => { uploads += 1; throw new Error("must not upload"); } }), /PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  assert.equal(uploads, 0); assert.deepEqual({ candidate, persistedIntent }, before);
});

test("current configuration drift after OSS intent persistence prevents every upload", async () => {
  const candidate = authorizedCandidate();
  const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision,
    ownerDecision: ownerDecision(candidate), startedAt: NOW });
  const persistedIntent = markAliyunOssAssetIntentPersisted({ intent, persistedAt: NOW, persistedCandidateRevision: candidate.dataRevision + 1 });
  candidate.dataRevision += 1;
  const binding = currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization);
  const before = structuredClone({ candidate, persistedIntent }); let uploads = 0;
  for (const patch of [{ bindingId: "binding:another" }, { configurationVersion: "config-v2" }, { warehouseId: "70002" },
    { warehouseRef: "warehouse:another" }, { credentialAlias: "credential-alias:another" },
    { storeRef: { ...binding.storeRef, mappingVersion: "stores-v2" } },
    { verification: { ...binding.verification, expiresAt: NOW } }]) {
    const result = await executeAliyunOssAssetIntent({ persistedIntent, candidate, currentProductionBinding: { ...binding, ...patch }, serverClock: () => NOW,
      upload: async () => { uploads += 1; throw new Error("must not upload"); } });
    assert.equal(result.status, "failed"); assert.equal(result.intent.status, "failed");
    assert.equal(result.intent.externalRequestState, "not_attempted"); assert.equal(result.intent.ossWrites, 0);
    assert.equal(result.intent.failureLayer, "production_configuration"); assert.equal(result.assetTransport, null);
  }
  const missing = await executeAliyunOssAssetIntent({ persistedIntent, candidate, serverClock: () => NOW,
    upload: async () => { uploads += 1; throw new Error("must not upload"); } });
  assert.equal(missing.intent.failureCode, "PRODUCTION_EXECUTION_BINDING_REQUIRED");
  assert.equal(missing.intent.ossWrites, 0);
  assert.equal(uploads, 0); assert.deepEqual({ candidate, persistedIntent }, before);
});

test("persisted OSS intent requires a current clock and saves expired rights as not attempted across JSON restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oss-rights-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "business-state.json");
  const candidate = authorizedCandidate();
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const expiresAt = authorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
  const intent = createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision,
    ownerDecision: ownerDecision(candidate), startedAt: NOW });
  const persistedIntent = markAliyunOssAssetIntentPersisted({ intent, persistedAt: NOW, persistedCandidateRevision: candidate.dataRevision + 1 });
  const document = initialBusinessStateDocument({ now: NOW }); document.candidates = [structuredClone(candidate)];
  const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: document });
  await repository.transact(current => {
    const value = current.candidates[0]; value.dataRevision += 1;
    value.lifecycleV11.skuPackage.dAssetTransport = { schemaVersion: "aliyun-oss-d-asset-state-v1", status: "in_flight", executionRevision: 1,
      intent: persistedIntent, assetTransport: null, automaticRetry: false, platformWrites: 0 };
    return { changed: true, document: current, result: null };
  });
  const saved = (await repository.readSnapshot()).candidates[0]; const before = structuredClone(saved);
  let uploads = 0;
  const input = { persistedIntent, candidate: saved, currentProductionBinding: currentProductionBindingFixture(authorization),
    upload: async () => { uploads += 1; throw new Error("must not upload"); } };
  await assert.rejects(() => executeAliyunOssAssetIntent({ ...input, completedAt: NOW }), /OSS_D_SERVER_CLOCK_REQUIRED/);
  const result = await executeAliyunOssAssetIntent({ ...input, serverClock: () => expiresAt });
  assert.equal(result.status, "failed"); assert.equal(result.intent.failureLayer, "sku_rights_review");
  assert.equal(result.intent.failureCode, "C1_SKU_RIGHTS_REVIEW_EXPIRED"); assert.equal(result.intent.ossWrites, 0);
  assert.equal(result.intent.externalRequestState, "not_attempted"); assert.equal(uploads, 0); assert.deepEqual(saved, before);
  await repository.transact(current => {
    current.candidates[0] = settleAliyunOssAssetIntent({ candidate: current.candidates[0], persistedIntent, result, settledAt: expiresAt });
    return { changed: true, document: current, result: null };
  });
  const restored = (await createJsonBusinessStateRepository({ filePath }).readSnapshot()).candidates[0].lifecycleV11.skuPackage;
  assert.equal(restored.dAssetTransport.status, "failed"); assert.equal(restored.dAssetTransport.executionRevision, 2);
  assert.equal(restored.dAssetTransport.intent.failureLayer, "sku_rights_review"); assert.equal(restored.dAssetTransport.intent.ossWrites, 0);
  assert.deepEqual(restored.productionAuthorization, authorization);
  assert.deepEqual(validateSkuLifecyclePackage(restored), { valid: true, errors: [] });
  const validateSku = (await loadPublishedSchemaValidator()).getSchema("product-lifecycle-v1.1");
  assert.equal(validateSku(restored), true, JSON.stringify(validateSku.errors));
});

test("post-admission OSS configuration failure is persisted as not attempted and survives a real JSON restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oss-d-zero-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "business-state.json");
  const candidate = authorizedCandidate();
  const document = initialBusinessStateDocument({ now: NOW }); document.candidates = [candidate];
  const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: document });
  const saved = await repository.transact(current => {
    const value = current.candidates[0];
    const intent = createPersistableAliyunOssAssetIntent({ candidate: value, expectedDataRevision: value.dataRevision,
      ownerDecision: ownerDecision(value), startedAt: NOW });
    const persistedIntent = markAliyunOssAssetIntentPersisted({ intent, persistedAt: NOW, persistedCandidateRevision: value.dataRevision + 1 });
    value.dataRevision += 1;
    value.lifecycleV11.skuPackage.dAssetTransport = { schemaVersion: "aliyun-oss-d-asset-state-v1", status: "in_flight", executionRevision: 1,
      intent: persistedIntent, assetTransport: null, automaticRetry: false, platformWrites: 0 };
    assertSafeRuntimeRecord(value, "candidate"); assertSafeRuntimeRecord(persistedIntent, "ossIntent");
    return { changed: true, document: current, result: { candidate: structuredClone(value), intent: persistedIntent } };
  });
  const currentProductionBinding = currentProductionBindingFixture(saved.candidate.lifecycleV11.skuPackage.productionAuthorization);
  currentProductionBinding.verification.expiresAt = "2026-08-22T12:00:01.000Z";
  let uploads = 0;
  const result = await executeAliyunOssAssetIntent({ persistedIntent: saved.intent, candidate: saved.candidate, currentProductionBinding,
    serverClock: () => "2026-08-22T12:00:01.000Z", upload: async () => { uploads += 1; throw new Error("must not upload"); } });
  assert.equal(result.status, "failed"); assert.equal(uploads, 0);
  const settledAt = "2026-08-22T12:00:02.000Z";
  const invalidResults = [
    { ...result, applied: true }, { ...result, automaticRetry: true },
    ...[{ ossWrites: "unknown" }, { externalRequestState: "in_flight" }, { failureCode: "UNKNOWN" },
      { completedAt: "2026-08-21T00:00:00.000Z" }, { failureLayer: "aliyun_oss_asset_transport" }]
      .map(patch => ({ ...result, intent: { ...result.intent, ...patch } }))
  ];
  for (const invalid of invalidResults) assert.throws(() => settleAliyunOssAssetIntent({ candidate: saved.candidate,
    persistedIntent: saved.intent, result: invalid, settledAt }), /SETTLEMENT_RESULT_INVALID/);
  await repository.transact(current => {
    current.candidates[0] = settleAliyunOssAssetIntent({ candidate: current.candidates[0], persistedIntent: saved.intent, result, settledAt });
    const sku = current.candidates[0].lifecycleV11.skuPackage;
    assert.deepEqual(validateSkuLifecyclePackage(sku), { valid: true, errors: [] });
    assertSafeRuntimeRecord(current.candidates[0], "candidate");
    return { changed: true, document: current, result: null };
  });
  const bytes = await readFile(filePath);
  const reopened = createJsonBusinessStateRepository({ filePath });
  const restored = (await reopened.readSnapshot()).candidates[0];
  const state = restored.lifecycleV11.skuPackage.dAssetTransport;
  assertSafeRuntimeRecord(state, "assetTransportState");
  assert.throws(() => assertSafeRuntimeRecord({ body: state.intent }, "body"), error =>
    error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
  const adjacent = structuredClone(state);
  adjacent.intent.adjacent = { authorizationId: "authorization:c1-ai-draft:synthetic-adjacent" };
  assert.throws(() => assertSafeRuntimeRecord(adjacent, "assetTransportState"), error =>
    error.message.startsWith("RUNTIME_IDENTITY_INVALID:") && error.cause.message.startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:"));
  assert.equal(state.status, "failed"); assert.equal(state.intent.externalRequestState, "not_attempted");
  assert.equal(state.intent.ossWrites, 0); assert.equal(state.executionRevision, 2); assert.equal(state.assetTransport, null);
  assert.equal(state.intent.failureCode, "PRODUCTION_EXECUTION_BINDING_UNVERIFIED");
  assert.equal(reconcileAliyunOssAssetIntentAfterRestart({ persistedIntent: state.intent, restartedAt: settledAt }).status, "failed");
  const validator = await loadPublishedSchemaValidator();
  const validateState = validator.getSchema("product-lifecycle-v1.1#/$defs/SkuLifecyclePackage/properties/dAssetTransport");
  assert.equal(typeof validateState, "function"); assert.equal(validateState(state), true, JSON.stringify(validateState.errors));
  for (const patch of [{ ossWrites: "unknown" }, { externalRequestState: "succeeded" }, { failureLayer: "aliyun_oss_asset_transport" }]) {
    const malformed = { ...state, intent: { ...state.intent, ...patch } };
    assert.equal(validateState(malformed), false);
    assert.equal(validateSkuLifecyclePackage({ ...restored.lifecycleV11.skuPackage, dAssetTransport: malformed }).valid, false);
  }
  assert.ok(buildDESoftwareIntegrationView({ candidate: restored, inspectedAt: settledAt }).gaps.some(item => item.code === "asset_transport_not_attempted"));
  assert.deepEqual(await readFile(filePath), bytes);
});

test("rights expiring inside the uploader are zero-write only before the first public write attempt", async () => {
  for (const expireDuring of ["local_read", "between_images"]) {
    const candidate = structuredClone(authorizedCandidate());
    const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
    const expiresAt = authorization.lockedScope.finalCardInputSnapshot.c1Snapshot.inputSnapshots.skuRightsReview.expiresAt;
    const persistedIntent = markAliyunOssAssetIntentPersisted({
      intent: createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW }),
      persistedAt: NOW, persistedCandidateRevision: candidate.dataRevision + 1 });
    candidate.dataRevision += 1;
    candidate.lifecycleV11.skuPackage.dAssetTransport = { schemaVersion: "aliyun-oss-d-asset-state-v1", status: "in_flight", executionRevision: 1,
      intent: persistedIntent, assetTransport: null, automaticRetry: false, platformWrites: 0 };
    const before = structuredClone(candidate); let observedAt = NOW; let puts = 0;
    const result = await executeAliyunOssAssetIntent({ candidate, persistedIntent, currentProductionBinding: currentProductionBindingFixture(authorization),
      serverClock: () => observedAt,
      upload: async ({ finalUploads, beforePublicWrite }) => {
        await Promise.resolve(); if (expireDuring === "local_read") observedAt = expiresAt;
        for (const { assetId, order, sha256 } of finalUploads) {
          await beforePublicWrite({ assetId, order, sha256 }); puts += 1; observedAt = expiresAt;
        }
        throw new Error("second write gate must have stopped execution");
      } });
    assert.equal(puts, expireDuring === "local_read" ? 0 : 1); assert.deepEqual(candidate, before);
    assert.equal(result.intent.failureCode, "C1_SKU_RIGHTS_REVIEW_EXPIRED");
    assert.equal(result.status, puts === 0 ? "failed" : "unknown_outcome");
    assert.equal(result.intent.ossWrites, puts === 0 ? 0 : "unknown");
    if (puts === 0) assert.equal(result.intent.externalRequestState, "not_attempted");
    else assert.equal(Object.hasOwn(result.intent, "externalRequestState"), false);
    const settled = settleAliyunOssAssetIntent({ candidate, persistedIntent, result, settledAt: expiresAt });
    assert.equal(settled.lifecycleV11.skuPackage.dAssetTransport.status, result.status);
    assert.deepEqual(settled.lifecycleV11.skuPackage.productionAuthorization, authorization);
  }
});

test("上传后并发编辑不丢回执，保存结果只改执行状态并阻止后续生产", async () => {
  const candidate = structuredClone(authorizedCandidate());
  const persistedIntent = markAliyunOssAssetIntentPersisted({
    intent: createPersistableAliyunOssAssetIntent({ candidate, expectedDataRevision: candidate.dataRevision, ownerDecision: ownerDecision(candidate), startedAt: NOW }),
    persistedAt: NOW, persistedCandidateRevision: candidate.dataRevision + 1
  });
  candidate.dataRevision += 1;
  candidate.lifecycleV11.skuPackage.dAssetTransport = { status: "in_flight", intent: persistedIntent, executionRevision: 1, assetTransport: null };
  const result = await executeAliyunOssAssetIntent({ persistedIntent, candidate, currentProductionBinding: currentProductionBindingFixture(candidate.lifecycleV11.skuPackage.productionAuthorization), serverClock: () => NOW,
    upload: async ({ finalUploads, beforePublicWrite }) => {
      for (const { assetId, order, sha256 } of finalUploads) await beforePublicWrite({ assetId, order, sha256 });
      return { status: "verified", mode: "preapproved_stable_https", evidenceRef: "receipt:assets", approvedHosts: ["assets.example.invalid"],
      resolvedAssets: finalUploads.map(asset => ({ assetId: asset.assetId, sha256: asset.sha256, order: asset.order,
        platformAcceptedUrl: `https://assets.example.invalid/${asset.assetId}.jpg`, stable: true, authorizationStatus: "approved", evidenceRef: `receipt:${asset.assetId}` })) }; } });
  const normal = settleAliyunOssAssetIntent({ candidate, persistedIntent, result, settledAt: NOW });
  assert.equal(normal.lifecycleV11.skuPackage.dAssetTransport.continuationBlocked, false);
  candidate.dataRevision += 1; candidate.ownerNote = "Newly saved owner input";
  const before = structuredClone(candidate);
  const settled = settleAliyunOssAssetIntent({ candidate, persistedIntent, result, settledAt: NOW });
  const state = settled.lifecycleV11.skuPackage.dAssetTransport;
  assert.equal(state.continuationBlocked, true);
  assert.equal(state.executionRevision, 2);
  assert.deepEqual(state.assetTransport, result.assetTransport);
  assert.equal(state.intent.ossWrites, 2);
  for (const receipt of [null, {}, { ...result.assetTransport, resolvedAssets: result.assetTransport.resolvedAssets.toReversed() },
    { ...result.assetTransport, resolvedAssets: result.assetTransport.resolvedAssets.map(asset => ({ ...asset, sha256: "f".repeat(64) })) }]) {
    assert.throws(() => settleAliyunOssAssetIntent({ candidate, persistedIntent, result: { ...result, assetTransport: receipt }, settledAt: NOW }), /RECEIPT_INVALID/);
  }
  for (const change of [{ candidateId: "another" }, { attempt: 2 }, { persistedCandidateRevision: 999 }, { finalUploadAssetIds: ["another"] }]) {
    assert.throws(() => settleAliyunOssAssetIntent({ candidate, persistedIntent, result: { ...result, intent: { ...result.intent, ...change } }, settledAt: NOW }), /RESULT_INVALID/);
  }
  assert.equal(settled.ownerNote, candidate.ownerNote);
  assert.equal(settled.dataRevision, candidate.dataRevision);
  assert.deepEqual(candidate, before);
  assert.throws(() => settleAliyunOssAssetIntent({ candidate: settled, persistedIntent, result, settledAt: NOW }), /SETTLEMENT_CONFLICT/);
  assert.throws(() => settleAliyunOssAssetIntent({ candidate, persistedIntent, result: { ...result, intent: { ...result.intent, intentId: "another" } }, settledAt: NOW }), /RESULT_INVALID/);
});
