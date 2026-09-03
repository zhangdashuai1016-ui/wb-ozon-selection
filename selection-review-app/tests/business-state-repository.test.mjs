import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CENTRAL_PERSISTENCE_ERROR,
  assertBusinessStateRepositoryBoundary,
  assertCentralPersistenceBoundary,
  createConfiguredBusinessStateRepository,
  createJsonBusinessStateRepository,
  createMemoryBusinessStateRepository,
  initialBusinessStateDocument
} from "../lib/business-state-repository.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import {
  commitProductionAuthorizationHandoff,
  buildProductionOwnerDecisionSnapshot,
  fingerprintC1Snapshot,
  fingerprintFinalCardInputSnapshot,
  fingerprintFinalManifest,
  fingerprintFinalUploads,
  fingerprintMediaRequirements,
  fingerprintProductionAuthorizationPreparation
} from "../lib/production-authorization.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

const AUTH_TIME = "2026-08-31T08:00:00.000Z";

function authorizationFixture() {
  const candidateId = "candidate:atomic-auth-1";
  const skuPackageId = "sku-lifecycle:atomic-auth-1";
  const identity = {
    schemaVersion: "g1-identity-v1",
    candidateId,
    skuPackageId,
    platform: "ozon",
    storeRef: { stableStoreId: "store:ozon:dandanshu", platformStoreId: "seller-001", mappingVersion: "stores-v1" },
    supplierSkuId: "SUPPLIER-SKU-1",
    merchantSku: "not_applicable",
    warehouseRef: "not_applicable",
    credentialAlias: "not_applicable",
    platformProductId: "not_applicable"
  };
  const c1Snapshot = { status: "seo_draft_ready", unknownManifest: [] };
  const sourceC1Fingerprint = fingerprintC1Snapshot(identity, c1Snapshot);
  const canonicalC1 = {
    contractVersion: "g1-c1-domain-contract-v1",
    identity: structuredClone(identity),
    handoffRevisionRefs: { sourceRevision: 6, resultRevision: 7 },
    unknownManifest: []
  };
  const finalCardInputSnapshot = {
    schemaVersion: "c2-final-card-input-snapshot-v1",
    skuPackageId,
    sourceDataRevision: 7,
    resultDataRevision: 8,
    sourceC1Fingerprint,
    identity: structuredClone(identity),
    variantKey: "color:white",
    inheritedSalesSnapshotRefs: ["sales:fixture:1"],
    selectedSupplySnapshot: { snapshotId: "supply:fixture:1", ownerSupplyConfirmation: { status: "confirmed" } },
    activeProfitModelVersion: "profit-v1",
    activeProfitModel: { profitModelVersion: "profit-v1", result: "passed" },
    c1Snapshot,
    canonicalC1: structuredClone(canonicalC1)
  };
  const mediaRequirements = {
    schemaVersion: "c2-media-requirements-v1",
    evidenceRef: "schema:fixture:ozon:shelf",
    evidenceVersion: "media-v1",
    platform: "ozon",
    targetStore: identity.storeRef.stableStoreId,
    storeRef: identity.storeRef.stableStoreId,
    categoryId: "category:ozon:shelf",
    schemaRevision: "schema-v1",
    sourceDataRevision: 7,
    imageSlots: [{ slotId: "main", mediaType: "image", role: "main_image", minCount: 1, maxCount: 1 }],
    videoSlots: [{ slotId: "video", mediaType: "video", role: "product_video", minCount: 0, maxCount: 1 }],
    schemaVideoRequirement: { status: "not_required" }
  };
  mediaRequirements.requirementsFingerprint = fingerprintMediaRequirements(mediaRequirements);
  const finalUploads = [{
    assetId: "asset:final:main",
    mediaType: "image",
    assetRef: "https://assets.example.test/final-main.png",
    fileName: "final-main.png",
    assetVersion: "asset-v1",
    sha256: "a".repeat(64),
    sourceEvidenceRef: "evidence:asset:main",
    stableUrlEvidenceRef: "evidence:stable-url:main",
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "rights:asset:main" },
    sourceType: "owner_provided_final_upload",
    order: 1,
    role: "main_image",
    slotId: "main",
    byteSize: 1024,
    width: 1000,
    height: 1000,
    addedAt: AUTH_TIME,
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true
  }];
  const effectiveVideoRequirement = { status: "not_required", requiredBy: "schema", evidenceRefs: ["schema:fixture:ozon:shelf"] };
  const finalManifestSha256 = fingerprintFinalManifest({
    mediaRequirementsFingerprint: mediaRequirements.requirementsFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId: finalUploads[0].assetId,
    videoDisposition: "excludes_video",
    assets: finalUploads
  });
  const ownerFinalUploadConfirmation = {
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt: AUTH_TIME,
    approvedManifestVersion: "c2-final-manifest-v1",
    approvedManifestSha256: finalManifestSha256,
    approvedMediaRequirementsFingerprint: mediaRequirements.requirementsFingerprint,
    approvedAssetIds: finalUploads.map((asset) => asset.assetId),
    approvedMainImageAssetId: finalUploads[0].assetId,
    approvedVideoDisposition: "excludes_video",
    confirmationNote: null
  };
  const preparation = {
    schemaVersion: "c2-production-authorization-preparation-v1",
    status: "awaiting_final_card_approval",
    skuPackageId,
    sourceDataRevision: 7,
    resultDataRevision: 8,
    sourceC1Fingerprint,
    mediaRequirementsFingerprint: mediaRequirements.requirementsFingerprint,
    finalManifestVersion: "c2-final-manifest-v1",
    finalManifestSha256,
    finalUploadsFingerprint: fingerprintFinalUploads(finalUploads),
    mainImageAssetId: finalUploads[0].assetId,
    videoDisposition: "excludes_video",
    ownerConfirmationAt: AUTH_TIME,
    targetContext: {
      platform: "ozon",
      targetStore: identity.storeRef.stableStoreId,
      storeRef: identity.storeRef.stableStoreId,
      categoryId: "category:ozon:shelf",
      schemaRevision: "schema-v1",
      schemaEvidenceRef: "schema:fixture:ozon:shelf",
      schemaEvidenceVersion: "media-v1",
      mediaRequirementsFingerprint: mediaRequirements.requirementsFingerprint
    },
    frozenC1Handoff: structuredClone(canonicalC1),
    mediaRequirements: structuredClone(mediaRequirements),
    finalUploads: structuredClone(finalUploads),
    effectiveVideoRequirement: structuredClone(effectiveVideoRequirement),
    ownerVideoRequirement: null,
    ownerFinalUploadConfirmation: structuredClone(ownerFinalUploadConfirmation),
    finalCardInputSnapshot,
    finalCardInputFingerprint: fingerprintFinalCardInputSnapshot(finalCardInputSnapshot),
    ownerFinalCardAuthorizationDecision: null,
    pendingAuthorizationInputs: {
      schemaVersion: "c2-authorization-pending-inputs-v1",
      status: "awaiting_independent_owner_authorization",
      merchantSku: null,
      credentialAlias: null,
      warehouseRef: null,
      stock: null,
      price: null,
      allowedWriteFields: null,
      exclusions: null,
      sourceConfirmationCardId: null,
      ownerBusinessDecision: null,
      buyerTargetPrice: null,
      platformWritePrice: null,
      priceConversion: null,
      publishScope: null,
      confirmedAt: null
    },
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  };
  preparation.preparationFingerprint = fingerprintProductionAuthorizationPreparation(preparation);
  const profitModel = {
    profitModelVersion: "profit-v1",
    calculatedAt: AUTH_TIME,
    inputSnapshotRefs: ["sales:fixture:1", "supply:fixture:1"],
    recommendedSalePriceCny: 151.78,
    unitProfitRmb: 44.95,
    profitMargin: 44.95 / 151.78,
    result: "passed"
  };
  const skuPackage = {
    schemaVersion: "product-lifecycle-v1.1",
    entityType: "SkuLifecyclePackage",
    skuPackageId,
    parentOpportunityId: "opportunity:atomic-auth-1",
    supplierOptionId: "supplier-option:1",
    supplierSkuId: identity.supplierSkuId,
    variantKey: finalCardInputSnapshot.variantKey,
    targetPlatform: identity.platform,
    targetStore: identity.storeRef.stableStoreId,
    g1Identity: structuredClone(identity),
    dataRevision: 8,
    businessPhase: "C2",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "authorize_production",
    inheritedSalesSnapshotRefs: ["sales:fixture:1"],
    selectedSupplySnapshot: { snapshotId: "supply:fixture:1" },
    skuFacts: {},
    profitModels: [profitModel],
    activeProfitModelVersion: "profit-v1",
    c1ProductPlan: { status: "seo_draft_ready" },
    c2FinalAssets: {
      schemaVersion: "c2-asset-lifecycle-v1.1",
      status: "completed",
      assets: { collected: [], aiDrafts: [], finalUploads: structuredClone(finalUploads) },
      ownerFinalUploadConfirmation: structuredClone(ownerFinalUploadConfirmation),
      productionAuthorizationPreparation: structuredClone(preparation),
      dReadPolicy: { onlyAllowedArea: "assets.finalUploads", collectedAllowed: false, aiDraftsAllowed: false, ownerConfirmationRequired: true },
      platformUploads: 0,
      productionStarted: false
    },
    productionConfirmationCard: null,
    productionAuthorization: null,
    dHandoff: null,
    dAssetTransport: null,
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
    audit: { createdAt: AUTH_TIME, updatedAt: AUTH_TIME, history: [] }
  };
  const candidate = {
    id: candidateId,
    dataRevision: 12,
    lifecycleV11: { status: "c2_ready", platformWrites: 0, skuPackage },
    updatedAt: AUTH_TIME,
    lastModifiedBy: "owner"
  };
  const ownerDecision = {
    decisionId: "owner-decision:atomic-auth-1",
    selectedOption: "approve_for_production_authorization",
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceConfirmationCardId: `final-plan-card:${skuPackageId}:8`,
    merchantSku: "MERCHANT-SKU-1",
    warehouseRef: "warehouse:ozon:main",
    credentialAlias: "credential-alias:ozon:dandanshu",
    stock: 100,
    buyerTargetPrice: { amount: 1517.8, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 10, evidenceRef: "fx:rub-cny:2026-08-31", checkedAt: AUTH_TIME },
    publishScope: "create_draft_only",
    allowedWriteFields: ["create_product", "title", "description", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"],
    exclusions: ["no_activation", "no_advertising", "no_other_sku_write"]
  };
  const ownerDecisionFingerprint = fingerprintCanonicalRecord(buildProductionOwnerDecisionSnapshot({
    candidateId,
    sourceCandidateRevision: candidate.dataRevision,
    skuPackage,
    preparation,
    ownerDecision
  }));
  ownerDecision.ownerDecisionFingerprint = ownerDecisionFingerprint;
  ownerDecision.ownerConfirmation = {
    schemaVersion: "production-owner-confirmation-v1",
    decisionId: ownerDecision.decisionId,
    actorId: "owner-1",
    actorType: "human",
    role: "owner",
    confirmedAt: AUTH_TIME,
    sourcePreparationFingerprint: ownerDecision.sourcePreparationFingerprint,
    sourceFinalCardInputFingerprint: ownerDecision.sourceFinalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision: candidate.dataRevision,
    sourceSkuRevision: skuPackage.dataRevision,
    ownerDecisionFingerprint
  };
  const actor = createActorContext({
    userId: "technical-authorizer-1",
    sessionId: "session-technical-authorizer-1",
    actorType: "human",
    roles: ["production_authorizer"],
    source: "authenticated_identity_provider",
    authenticatedAt: AUTH_TIME
  });
  return { candidate, ownerDecision, actor, preparation };
}

async function repositoryContract(repository) {
  const initial = await repository.readSnapshot();
  assert.equal(initial.candidates[0].dataRevision, 1);
  const result = await repository.transact(async (document) => {
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: "saved" };
  });
  assert.equal(result, "saved");
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
  await repository.transact(async () => ({ changed: false, result: "unchanged" }));
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 2);
}

test("JSON与内存适配器遵守相同Repository契约，但不冒充中央多人存储", async () => {
  await repositoryContract(createMemoryBusinessStateRepository({ candidates: [{ id: "C-1", dataRevision: 1 }] }));

  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-repository-"));
  const filePath = path.join(directory, "candidates.json");
  await writeFile(filePath, JSON.stringify({ candidates: [{ id: "C-1", dataRevision: 1 }] }), "utf8");
  try {
    const repository = createJsonBusinessStateRepository({ filePath });
    await repositoryContract(repository);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).candidates[0].dataRevision, 2);
    assert.deepEqual(assertBusinessStateRepositoryBoundary(repository), {
      status: "business_state_repository_boundary_present",
      adapter: "json",
      concurrencyScope: "single_process",
      multiUserReady: false
    });
    assert.throws(() => assertCentralPersistenceBoundary(repository), new RegExp(CENTRAL_PERSISTENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSON适配器只在显式允许时初始化缺失文件，坏JSON必须失败", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-init-"));
  const missingPath = path.join(directory, "missing", "candidates.json");
  try {
    await assert.rejects(
      createJsonBusinessStateRepository({ filePath: missingPath }).readSnapshot(),
      /ENOENT/
    );

    const repository = createJsonBusinessStateRepository({
      filePath: missingPath,
      initializeIfMissing: true,
      initialDocument: () => initialBusinessStateDocument({ now: AUTH_TIME, title: "test state" })
    });
    const initial = await repository.readSnapshot();
    assert.deepEqual(initial.candidates, []);
    assert.equal(initial.meta.version, 2);
    assert.equal(initial.meta.title, "test state");
    await repository.transact(async (document) => {
      document.candidates.push({ id: "C-NEW", dataRevision: 1 });
      return { changed: true, document, result: "created" };
    });
    const persisted = JSON.parse(await readFile(missingPath, "utf8"));
    assert.equal(persisted.candidates[0].id, "C-NEW");

    const badJsonPath = path.join(directory, "bad.json");
    await writeFile(badJsonPath, "{not-json", "utf8");
    await assert.rejects(
      createJsonBusinessStateRepository({
        filePath: badJsonPath,
        initializeIfMissing: true
      }).readSnapshot(),
      /JSON/
    );
    assert.equal(await readFile(badJsonPath, "utf8"), "{not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("运行配置仓库默认不初始化缺失数据文件，只有显式开关才创建", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "central-state-config-init-"));
  const filePath = path.join(directory, "state", "candidates.json");
  const baseConfig = {
    schemaVersion: "selection-review-runtime-configuration-v1",
    stateAdapter: "json",
    dataFile: filePath
  };
  try {
    await assert.rejects(
      createConfiguredBusinessStateRepository({ ...baseConfig, initializeDataFile: false }).readSnapshot(),
      /ENOENT/
    );

    const repository = createConfiguredBusinessStateRepository({ ...baseConfig, initializeDataFile: true });
    await repository.transact(async (document) => {
      document.candidates.push({ id: "C-CONFIG", dataRevision: 1 });
      return { changed: true, document, result: "initialized" };
    });
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.candidates[0].id, "C-CONFIG");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("事务失败不留下半套业务状态，缺少Repository边界明确失败", async () => {
  const repository = createMemoryBusinessStateRepository({ candidates: [{ id: "C-1", dataRevision: 1 }], audit: [] });
  await assert.rejects(repository.transact(async (document) => {
    document.candidates[0].dataRevision = 2;
    document.audit.push({ eventId: "partial" });
    throw new Error("simulated_failure");
  }), /simulated_failure/);
  assert.deepEqual(await repository.readSnapshot(), { candidates: [{ id: "C-1", dataRevision: 1 }], audit: [] });
  assert.throws(() => assertCentralPersistenceBoundary({ readSnapshot() {} }), new RegExp(CENTRAL_PERSISTENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("C2冻结快照与主人独立决定在一个Repository事务内生成唯一授权和唯一D handoff", async () => {
  const { candidate, ownerDecision, actor, preparation } = authorizationFixture();
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate], runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] });
  const input = {
    repository,
    runtimeMode: "local_development",
    actor,
    candidateId: candidate.id,
    expectedCandidateRevision: candidate.dataRevision,
    ownerDecision,
    confirmedAt: AUTH_TIME
  };
  const first = await commitProductionAuthorizationHandoff(input);
  assert.equal(first.status, "committed");
  const stored = await repository.readSnapshot();
  const nextCandidate = stored.candidates[0];
  const nextSku = nextCandidate.lifecycleV11.skuPackage;
  assert.equal(nextCandidate.dataRevision, 13);
  assert.equal(nextSku.dataRevision, 9);
  assert.deepEqual(nextSku.c2FinalAssets.productionAuthorizationPreparation, preparation);
  assert.equal(nextSku.productionAuthorization.authorizationId, nextSku.dHandoff.productionAuthorizationId);
  assert.equal(nextSku.productionAuthorization.identity.merchantSku, ownerDecision.merchantSku);
  assert.deepEqual(nextSku.productionAuthorization.identity.storeRef, preparation.finalCardInputSnapshot.identity.storeRef);
  assert.equal(nextSku.productionAuthorization.lockedScope.mainImageAssetId, preparation.mainImageAssetId);
  assert.deepEqual(nextSku.productionAuthorization.lockedScope.finalUploads, preparation.finalUploads);
  assert.equal(nextSku.dHandoff.productionPlanCreated, false);
  assert.equal(nextSku.dHandoff.executionIntentCreated, false);
  assert.equal(nextSku.dHandoff.softwareJobCreated, false);
  assert.equal(nextSku.dHandoff.dWritePermissionGranted, false);
  assert.equal(nextSku.dHandoff.externalRequests, 0);
  assert.equal(nextSku.dHandoff.platformWrites, 0);
  assert.equal(stored.dispatches.length, 0);
  assert.equal(stored.runtime.operationAudit.length, 1);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);

  const replay = await commitProductionAuthorizationHandoff({ ...input, confirmedAt: "2026-08-31T08:05:00.000Z" });
  assert.equal(replay.status, "idempotent_replay");
  assert.equal(replay.result.productionAuthorization.authorizationId, first.result.productionAuthorization.authorizationId);
  assert.deepEqual(await repository.readSnapshot(), stored);

  await assert.rejects(commitProductionAuthorizationHandoff({
    ...input,
    ownerDecision: { ...ownerDecision, stock: 99 }
  }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await repository.readSnapshot(), stored);
});

test("旧revision、缺图、未确认、秘密与unknown_outcome均零授权零handoff且原子回滚", async () => {
  const cases = [
    ["old revision", ({ input }) => { input.expectedCandidateRevision -= 1; }, /REVISION_CONFLICT/],
    ["incomplete images", ({ candidate }) => {
      candidate.lifecycleV11.skuPackage.c2FinalAssets.productionAuthorizationPreparation.finalUploads = [];
    }, /PREPARATION_DRIFT|MEDIA_INVALID/],
    ["unconfirmed owner", ({ input }) => { input.ownerDecision.selectedOption = "return_to_c_stage"; }, /OWNER_CONFIRMATION_REQUIRED/],
    ["unauthorized actor", ({ input }) => {
      input.actor = createActorContext({
        userId: "reviewer-1", sessionId: "session-review", actorType: "human", roles: ["reviewer"], source: "authenticated_identity_provider", authenticatedAt: AUTH_TIME
      });
    }, /PRODUCTION_AUTHORIZATION_TECHNICAL_AUTHORIZER_REQUIRED|RUNTIME_OPERATION_FORBIDDEN/],
    ["secret key", ({ input }) => { input.ownerDecision.credentialAlias = "accessToken=secret-value"; }, /SECRET_REJECTED/],
    ["secret url", ({ input }) => { input.ownerDecision.warehouseRef = "https://user:pass@example.test/warehouse"; }, /SECRET_REJECTED/],
    ["unknown outcome", ({ candidate }) => {
      candidate.lifecycleV11.skuPackage.dAssetTransport = {
        schemaVersion: "aliyun-oss-d-asset-state-v1",
        status: "unknown_outcome",
        intent: { schemaVersion: "aliyun-oss-d-asset-integration-v1", status: "unknown_outcome" },
        assetTransport: null,
        automaticRetry: false,
        platformWrites: 0
      };
    }, /GATE_REJECTED/]
  ];
  for (const [label, mutate, expected] of cases) {
    const { candidate, ownerDecision, actor } = authorizationFixture();
    const input = {
      repository: null,
      runtimeMode: "local_development",
      actor,
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.dataRevision,
      ownerDecision,
      confirmedAt: AUTH_TIME
    };
    mutate({ candidate, input });
    const document = { candidates: [candidate], runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] };
    const repository = createMemoryBusinessStateRepository(document);
    input.repository = repository;
    await assert.rejects(commitProductionAuthorizationHandoff(input), expected, label);
    const stored = await repository.readSnapshot();
    assert.deepEqual(stored, document, label);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null, label);
    assert.equal(stored.candidates[0].lifecycleV11.skuPackage.dHandoff, null, label);
    assert.equal(stored.dispatches.length, 0, label);
  }
});

test("授权事务持久化失败时授权、handoff、审计与幂等记录全部不落盘", async () => {
  const { candidate, ownerDecision, actor } = authorizationFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "production-authorization-rollback-"));
  const filePath = path.join(directory, "state.json");
  const document = { candidates: [candidate], runtime: { operationAudit: [], idempotencyRecords: [] }, dispatches: [] };
  await writeFile(filePath, JSON.stringify(document), "utf8");
  try {
    const repository = createJsonBusinessStateRepository({
      filePath,
      atomicWriter: async () => { throw new Error("simulated_atomic_replace_failure"); }
    });
    await assert.rejects(commitProductionAuthorizationHandoff({
      repository,
      runtimeMode: "local_development",
      actor,
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.dataRevision,
      ownerDecision,
      confirmedAt: AUTH_TIME
    }), /simulated_atomic_replace_failure/);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), document);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
