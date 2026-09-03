import assert from "node:assert/strict";
import test from "node:test";

import { runtimeArchitectureView } from "../src/runtimeArchitectureView.js";

test("评审台不把当前本地单进程状态冒充多人部署", () => {
  const local = runtimeArchitectureView({
    schemaVersion: "runtime-architecture-status-v1", multiUserReady: false, deploymentMode: "local_development"
  });
  assert.deepEqual([local.code, local.label, local.multiUserReady], ["local_development", "本地开发模式", false]);
  assert.match(local.detail, /JSON仅支持单进程/);
});

test("中央边界齐全时才显示中央运行可用，状态缺失明确报不可用", () => {
  const central = runtimeArchitectureView({
    schemaVersion: "runtime-architecture-status-v1",
    status: "central_runtime_ready",
    deploymentMode: "central_test",
    multiUserReady: true,
    concurrencyScope: "database_transaction",
    identityProvider: "company_sso",
    softwareJobStore: "postgres",
    workerRegistry: "postgres",
    currentUser: { userId: "user-1" }
  });
  assert.deepEqual([central.code, central.multiUserReady], ["central_ready", true]);
  assert.match(central.detail, /user-1/);
  assert.equal(runtimeArchitectureView(null).code, "unavailable");
  for (const contradictory of [
    { ...central, deploymentMode: "local_development" },
    { ...central, status: "local_development_ready" },
    { ...central, identityProvider: "development_default" },
    { ...central, concurrencyScope: "single_process" },
    { schemaVersion: "runtime-architecture-status-v1", multiUserReady: true }
  ]) assert.notEqual(runtimeArchitectureView(contradictory).code, "central_ready");
});
