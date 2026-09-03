import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDESoftwareIntegrationView,
  createPersistableDExecutionIntent,
  reconcilePersistedDExecutionOnRestart
} from "../lib/d-e-software-integration.mjs";

function candidateFixture(overrides = {}) {
  return {
    id: "CX-DE-NON-TRAIN-001",
    lifecycleV11: {
      skuPackage: {
        skuPackageId: "sku-lifecycle:CX-DE-NON-TRAIN-001:SUP-MUSIC-001",
        targetPlatform: "ozon",
        targetStore: "dandanshu",
        productionAuthorization: null,
        productionRecord: null,
        eVerificationRecord: null,
        ...overrides
      }
    }
  };
}

test("第6C无生命周期时不展示D/E入口", () => {
  const view = buildDESoftwareIntegrationView({ candidate: { id: "legacy" }, inspectedAt: "2026-08-22T10:00:00.000Z" });
  assert.equal(view.available, false);
  assert.equal(view.platform, null);
  assert.equal(view.canExecutePlatformWrite, false);
  assert.equal(view.platformWrites, 0);
});

test("第6C未取得主人生产授权时只显示缺口且零写入", () => {
  const candidate = candidateFixture();
  const before = structuredClone(candidate);
  const view = buildDESoftwareIntegrationView({ candidate, inspectedAt: "2026-08-22T10:00:00.000Z" });
  assert.equal(view.status, "awaiting_production_authorization");
  assert.deepEqual(view.gaps.map((item) => item.code), ["production_authorization_missing"]);
  assert.equal(view.canExecutePlatformWrite, false);
  assert.equal(view.executionIntentPersisted, false);
  assert.equal(view.platformWrites, 0);
  assert.deepEqual(candidate, before);
});

test("第6C已有系统生产记录时只进入E等待，不混入外部发现路径", () => {
  const view = buildDESoftwareIntegrationView({
    candidate: candidateFixture({ productionRecord: { productionRecordId: "production-record:non-train:1" } }),
    inspectedAt: "2026-08-22T10:00:00.000Z"
  });
  assert.equal(view.status, "awaiting_e_readback");
  assert.equal(view.productionRecordId, "production-record:non-train:1");
  assert.equal(view.requiresExactOwnerExecutionAuthorization, false);
  assert.equal(view.canExecutePlatformWrite, false);
});

test("第6C E验证完成后只显示已验证，不再开放执行", () => {
  const view = buildDESoftwareIntegrationView({
    candidate: candidateFixture({
      productionRecord: { productionRecordId: "production-record:non-train:1" },
      eVerificationRecord: { verificationId: "e-verification:non-train:1" }
    }),
    inspectedAt: "2026-08-22T10:00:00.000Z"
  });
  assert.equal(view.status, "listed_verified");
  assert.equal(view.eVerificationId, "e-verification:non-train:1");
  assert.equal(view.canExecutePlatformWrite, false);
  assert.equal(view.platformWrites, 0);
});

test("第6C不会因为有授权就自动执行，旧授权缺字段时准确停止", () => {
  const view = buildDESoftwareIntegrationView({
    candidate: candidateFixture({ productionAuthorization: { authorizationId: "production-auth:non-train:1", status: "confirmed" } }),
    inspectedAt: "2026-08-22T10:00:00.000Z"
  });
  assert.equal(view.status, "authorization_not_runnable");
  assert.equal(view.gaps[0].code, "production_plan_not_ready");
  assert.equal(view.canExecutePlatformWrite, false);
  assert.equal(view.automaticRetry, false);
  assert.equal(view.browserFallback, false);
  assert.equal(view.codexDispatch, false);
});

function preparedExecutionFixture() {
  const request = {
    sourceAuthorizationId: "production-auth:music-box:9",
    sourceProductionPlanId: "production-plan:music-box:9",
    platform: "ozon",
    store: "dandanshu",
    skuPackageId: "sku-lifecycle:MUSIC-BOX:SUP-MUSIC-009",
    supplierSkuId: "SUP-MUSIC-009",
    merchantSku: "SUP-MUSIC-009",
    platformWritePrice: { amount: 117.85, currency: "CNY" },
    stock: 100,
    assetsFinalUploadsVersion: "c2-final:music-box:v4",
    finalUploads: [
      { assetId: "final:music:main", order: 1 },
      { assetId: "final:music:detail", order: 2 }
    ],
    publishScope: "create_and_allow_validation_moderation",
    executionKey: "d-execution:music-box-safe-key",
    idempotencyKey: "d-execution:music-box-safe-key"
  };
  return { schemaVersion: "d-software-execution-v1", status: "ready", executableRequest: request };
}

function ownerDecisionFixture(overrides = {}) {
  return {
    confirmed: true,
    authorizationId: "production-auth:music-box:9",
    productionPlanId: "production-plan:music-box:9",
    store: "dandanshu",
    skuPackageId: "sku-lifecycle:MUSIC-BOX:SUP-MUSIC-009",
    supplierSkuId: "SUP-MUSIC-009",
    platformWritePrice: { amount: 117.85, currency: "CNY" },
    stock: 100,
    assetsFinalUploadsVersion: "c2-final:music-box:v4",
    finalUploadAssetIds: ["final:music:main", "final:music:detail"],
    publishScope: "create_and_allow_validation_moderation",
    ...overrides
  };
}

test("第6C只生成必须先持久化的单次D执行意图，不调用平台", () => {
  const preparedExecution = preparedExecutionFixture();
  const before = structuredClone(preparedExecution);
  const state = createPersistableDExecutionIntent({
    candidateId: "CX-MUSIC-009",
    candidateDataRevision: 31,
    expectedCandidateRevision: 31,
    preparedExecution,
    ownerExecutionDecision: ownerDecisionFixture(),
    startedAt: "2026-08-22T12:00:00.000Z"
  });
  assert.equal(state.status, "in_flight");
  assert.equal(state.mustPersistBeforeSellerApi, true);
  assert.equal(state.canCallSellerApiBeforePersist, false);
  assert.equal(state.attemptLimit, 1);
  assert.equal(state.automaticRetry, false);
  assert.equal(state.platformWrites, 0);
  assert.equal(state.attempt.persistBeforeWrite, true);
  assert.equal(state.attempt.request.stock, 100);
  assert.deepEqual(preparedExecution, before);
});

test("第6C相同输入生成同一执行键和attemptId，不能制造第二轮", () => {
  const input = {
    candidateId: "CX-MUSIC-009",
    candidateDataRevision: 31,
    expectedCandidateRevision: 31,
    preparedExecution: preparedExecutionFixture(),
    ownerExecutionDecision: ownerDecisionFixture(),
    startedAt: "2026-08-22T12:00:00.000Z"
  };
  const first = createPersistableDExecutionIntent(input);
  const second = createPersistableDExecutionIntent(input);
  assert.equal(first.executionKey, second.executionKey);
  assert.equal(first.attempt.attemptId, second.attempt.attemptId);
  assert.deepEqual(first, second);
});

test("第6C候选revision漂移时拒绝生成执行意图", () => {
  assert.throws(() => createPersistableDExecutionIntent({
    candidateId: "CX-MUSIC-009",
    candidateDataRevision: 32,
    expectedCandidateRevision: 31,
    preparedExecution: preparedExecutionFixture(),
    ownerExecutionDecision: ownerDecisionFixture(),
    startedAt: "2026-08-22T12:00:00.000Z"
  }), /D_EXECUTION_REVISION_CONFLICT/);
});

test("第6C主人确认与授权快照任一字段不一致都会停止", () => {
  assert.throws(() => createPersistableDExecutionIntent({
    candidateId: "CX-MUSIC-009",
    candidateDataRevision: 31,
    expectedCandidateRevision: 31,
    preparedExecution: preparedExecutionFixture(),
    ownerExecutionDecision: ownerDecisionFixture({ platformWritePrice: { amount: 118, currency: "CNY" } }),
    startedAt: "2026-08-22T12:00:00.000Z"
  }), /D_EXECUTION_OWNER_SCOPE_MISMATCH/);
});

test("第6C服务重启把已落盘in_flight收口为unknown_outcome且不重试", () => {
  const state = createPersistableDExecutionIntent({
    candidateId: "CX-MUSIC-009",
    candidateDataRevision: 31,
    expectedCandidateRevision: 31,
    preparedExecution: preparedExecutionFixture(),
    ownerExecutionDecision: ownerDecisionFixture(),
    startedAt: "2026-08-22T12:00:00.000Z"
  });
  const reconciled = reconcilePersistedDExecutionOnRestart({
    executionState: state,
    restartedAt: "2026-08-22T12:05:00.000Z"
  });
  assert.equal(reconciled.status, "unknown_outcome");
  assert.equal(reconciled.attempt.status, "unknown_outcome");
  assert.equal(reconciled.attempt.reason, "service_restart_after_persist_before_terminal_receipt");
  assert.equal(reconciled.retryAllowed, false);
  assert.equal(reconciled.platformWrites, 0);
});
