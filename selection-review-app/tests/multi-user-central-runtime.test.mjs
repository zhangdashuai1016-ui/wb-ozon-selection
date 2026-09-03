import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CENTRAL_TRUTH_ERROR,
  LOCAL_RUNTIME_LOCK_IN_AUDIT,
  MULTI_USER_MIGRATION_STAGES,
  MULTI_USER_CENTRAL_RUNTIME_INVARIANTS,
  MULTI_USER_RUNTIME_ERROR,
  RUNTIME_SECRET_BOUNDARIES,
  assertNoUnreviewedLocalMachineDependency,
  assertProductionStateRepository,
  assertProductionStatePersistence,
  assertRuntimeBoundaries,
  findLocalMachineDependencies
} from "../lib/multi-user-central-runtime.mjs";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.(?:mjs|js|jsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

test("Multi-user Central Runtime正式不变量与Codex Independence同时成立", () => {
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.centralServiceIsBusinessAuthority, true);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.browserIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.localWorkerIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.codexIsBusinessAuthority, false);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.revisionRequiredForBusinessMutation, true);
  assert.equal(MULTI_USER_CENTRAL_RUNTIME_INVARIANTS.workerLeaseRequiredForLocalCapability, true);
});

test("现状审计覆盖开发期合理、迁移前抽象和当前最小修正三类", () => {
  const classifications = new Set(LOCAL_RUNTIME_LOCK_IN_AUDIT.map((item) => item.classification));
  assert.deepEqual([...classifications].sort(), [
    "development_local_reasonable", "minimum_fix_now", "must_abstract_before_multi_user"
  ]);
  for (const assumption of [
    "localhost_and_fixed_ports", "macos_keychain", "json_state_file", "whole_json_rewrite",
    "in_memory_job_maps", "single_extension_heartbeat", "global_single_job_gate", "missing_user_identity",
    "missing_worker_identity", "hardcoded_ai_gateway_scope", "fixed_local_paths", "local_clock_as_authority",
    "file_hash_as_concurrency", "service_restart_recovery", "central_and_local_secrets"
  ]) assert.ok(LOCAL_RUNTIME_LOCK_IN_AUDIT.some((item) => item.assumption === assumption), assumption);
});

test("七阶段迁移路线与中央秘密/本机登录秘密边界已正式冻结", () => {
  assert.deepEqual(MULTI_USER_MIGRATION_STAGES.map((stage) => stage.order), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(MULTI_USER_MIGRATION_STAGES.map((stage) => stage.code), [
    "single_machine_single_user", "single_machine_multi_identity", "central_test_service",
    "two_user_pilot", "postgres_migration", "multi_worker", "internal_team_launch"
  ]);
  assert.ok(RUNTIME_SECRET_BOUNDARIES.centralService.includes("ai_model_api_key"));
  assert.ok(RUNTIME_SECRET_BOUNDARIES.localWorker.includes("browser_cookie"));
  assert.ok(!RUNTIME_SECRET_BOUNDARIES.businessRecordMayContain.some((value) => /token|cookie|password|credential/.test(value)));
});

test("生产状态只能通过中央Repository边界，页面/插件/Worker/Codex临时状态全部拒绝", () => {
  assert.equal(assertProductionStatePersistence({
    stateType: "sku_lifecycle", persistenceBoundary: "central_repository"
  }).status, "centrally_persisted");
  for (const boundary of ["react_memory", "browser_local_storage", "plugin_storage", "worker_temp_file", "codex_conversation"]) {
    assert.throws(() => assertProductionStatePersistence({ stateType: "sku_lifecycle", persistenceBoundary: boundary }), new RegExp(CENTRAL_TRUTH_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("本机依赖门禁拒绝领域代码写死地址、个人目录和固定Worker，仅允许明确本地适配器", () => {
  const source = "fetch('http://127.0.0.1:4317'); const root='/Users/shuaizhang/data'; const worker='fixed-worker';";
  assert.deepEqual(findLocalMachineDependencies(source).map((item) => item.rule), [
    "loopback_address", "personal_home_path", "fixed_worker_identity"
  ]);
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({ filePath: "lib/domain.mjs", sourceText: source }), new RegExp(MULTI_USER_RUNTIME_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs", sourceText: source, allowedInfrastructureFile: true
  }), /broad infrastructure allowlist is forbidden/);
  assert.equal(assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs",
    sourceText: source,
    boundary: "local_adapter",
    reviewedFindingCounts: { loopback_address: 1, personal_home_path: 1, fixed_worker_identity: 1 }
  }).status, "reviewed_local_adapter");
  assert.throws(() => assertNoUnreviewedLocalMachineDependency({
    filePath: "lib/runtime-configuration.mjs",
    sourceText: `${source} fetch('http://localhost:9999')`,
    boundary: "local_adapter",
    reviewedFindingCounts: { loopback_address: 1, personal_home_path: 1, fixed_worker_identity: 1 }
  }), /Local machine dependency entered production domain/);
});

test("本机依赖扫描覆盖IPv6回环、其他用户目录和动态HOME", () => {
  const source = "fetch('http://[::1]:4317'); const a='file:///Users/alice/private'; os.homedir(); process.env.HOME;";
  assert.deepEqual(findLocalMachineDependencies(source).map((item) => item.rule), [
    "loopback_address", "personal_home_path", "dynamic_home_dependency", "dynamic_home_dependency"
  ]);
});

test("生产源码新增本机假设必须进入明确审计文件，不能静默扩散", async () => {
  const roots = [path.join(appDir, "lib"), path.join(appDir, "src"), path.join(appDir, "extension", "1688-capture")];
  const files = [path.join(appDir, "server.mjs")];
  for (const root of roots) files.push(...await sourceFiles(root));
  const reviewedAdapters = new Map([
    ["extension/1688-capture/background.js", ["worker_adapter", { loopback_address: 4 }]],
    ["extension/1688-capture/bridge.js", ["worker_adapter", { loopback_address: 1 }]],
    ["extension/1688-capture/capture-request.js", ["worker_adapter", { loopback_address: 1 }]],
    ["lib/c1-seo-draft.mjs", ["local_adapter", { personal_home_path: 2 }]],
    ["lib/codex-dispatcher.mjs", ["local_adapter", { loopback_address: 1, personal_home_path: 4 }]],
    ["lib/lifecycle-b-real-evidence-readers.mjs", ["local_adapter", { loopback_address: 2 }]],
    ["lib/multi-user-central-runtime.mjs", ["local_adapter", { loopback_address: 3, fixed_worker_identity: 3 }]],
    ["lib/runtime-configuration.mjs", ["local_adapter", { loopback_address: 8 }]],
    ["lib/workflow-map.mjs", ["local_adapter", { personal_home_path: 3 }]]
  ]);
  const checked = [];
  for (const file of files) {
    const relative = path.relative(appDir, file);
    const sourceText = await readFile(file, "utf8");
    const findings = findLocalMachineDependencies(sourceText);
    if (findings.length === 0) continue;
    const review = reviewedAdapters.get(relative);
    assert.ok(review, `未审计本机依赖: ${relative}`);
    assert.doesNotThrow(() => assertNoUnreviewedLocalMachineDependency({
      filePath: relative,
      sourceText,
      boundary: review[0],
      reviewedFindingCounts: review[1]
    }));
    checked.push(relative);
  }
  assert.deepEqual(checked.sort(), [...reviewedAdapters.keys()].sort());
});

test("当前本地运行明确标记为不具备多人并发，中央模式缺任一边界就fail-fast", () => {
  const localRepository = {
    boundaryType: "business_state_repository", authoritative: true, adapter: "json",
    concurrencyScope: "single_process", multiUserReady: false,
    readSnapshot() {}, transact() {}
  };
  const localIdentity = {
    boundaryType: "runtime_identity_provider", providerType: "development_default", multiUserReady: false,
    resolveActor() {}
  };
  const localJobs = { boundaryType: "software_job_store", persistenceClass: "business_state_repository", multiUserReady: false };
  const localWorkers = {
    boundaryType: "worker_registry", persistenceClass: "local_development_ephemeral", multiUserReady: false,
    findEligible() {}
  };
  const localConfiguration = { schemaVersion: "selection-review-runtime-configuration-v1", deploymentMode: "local_development" };
  const status = assertRuntimeBoundaries({
    configuration: localConfiguration,
    businessStateRepository: localRepository,
    identityProvider: localIdentity,
    softwareJobStore: localJobs,
    workerRegistry: localWorkers,
    legacyBusinessMutationPathsPresent: true
  });
  assert.deepEqual([status.status, status.multiUserReady, status.concurrencyScope], ["local_development_ready", false, "single_process"]);
  assert.match(status.limitations.join("\n"), /旧业务写路由/);
  assert.equal(assertProductionStateRepository({ runtimeMode: "local_development", repository: localRepository }).adapter, "json");

  const centralConfiguration = { schemaVersion: "selection-review-runtime-configuration-v1", deploymentMode: "central_test" };
  assert.throws(() => assertRuntimeBoundaries({
    configuration: centralConfiguration,
    businessStateRepository: localRepository,
    identityProvider: localIdentity,
    softwareJobStore: localJobs,
    workerRegistry: localWorkers,
    legacyBusinessMutationPathsPresent: false
  }), /Production state has no central persistence boundary/);
});

test("服务启动先收口持久化通用作业，再开始监听，不靠Worker临时内存恢复", async () => {
  const serverSource = await readFile(path.join(appDir, "server.mjs"), "utf8");
  const reconciliationIndex = serverSource.indexOf("await softwareJobStore.reconcileAfterRestart()");
  const listenIndex = serverSource.indexOf("server.listen(port, host");
  assert.ok(reconciliationIndex >= 0, "缺少通用软件作业重启收口");
  assert.ok(listenIndex > reconciliationIndex, "必须先收口遗留作业再监听新请求");
});
