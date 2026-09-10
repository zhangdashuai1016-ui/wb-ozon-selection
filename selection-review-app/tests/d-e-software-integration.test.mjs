import test from "node:test";
import assert from "node:assert/strict";
import { successfulExecution, exactObservation } from "./helpers/d-software-fixture.mjs";
import { runSystemCreatedEReadback } from "../lib/d-e-software-closure.mjs";
import {
  buildDESoftwareIntegrationView
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

test("第6C只有完整且绑定当前生产记录的E证明才能显示已验证", async () => {
  const { result } = await successfulExecution();
  const productionRecord = result.productionRecord;
  const completed = await runSystemCreatedEReadback({ productionRecord, verifiedAt: "2026-08-22T10:00:00.000Z",
    readPlatform: async () => exactObservation(productionRecord, { currentPrice: { amount: 151.78, currency: "CNY" }, imageCount: 2,
      moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" }) });
  const candidate = candidateFixture({ skuPackageId: productionRecord.skuPackageId, productionRecord, eVerificationRecord: completed.eVerificationRecord });
  const view = buildDESoftwareIntegrationView({ candidate, inspectedAt: "2026-08-22T10:00:00.000Z" });
  assert.equal(view.status, "listed_verified");
  assert.equal(view.eVerificationId, completed.eVerificationRecord.verificationId);
  assert.equal(view.canExecutePlatformWrite, false);
  assert.equal(view.platformWrites, 0);
  for (const record of [{ verificationId: "unproven" }, { ...completed.eVerificationRecord, sourceRecordId: "another" },
    { ...completed.eVerificationRecord, moderationStatus: "unknown" },
    { ...completed.eVerificationRecord, store: "miska" }, { ...completed.eVerificationRecord, currentStock: 99 },
    { ...completed.eVerificationRecord, platformProductId: "another" }, { ...completed.eVerificationRecord, verifiedAt: "2026-08-21T00:00:00.000Z" }]) {
    const changed = structuredClone(candidate); changed.lifecycleV11.skuPackage.eVerificationRecord = record;
    assert.equal(buildDESoftwareIntegrationView({ candidate: changed, inspectedAt: "2026-08-22T10:00:00.000Z" }).status, "awaiting_e_readback");
  }
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
