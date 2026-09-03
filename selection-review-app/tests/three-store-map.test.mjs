import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  THREE_STORE_MAP_AREAS,
  THREE_STORE_MAP_EXECUTION_STATES,
  THREE_STORE_MAP_REGISTRY,
  assertThreeStoreMapIntegrity,
  buildThreeStoreMapView
} from "../lib/three-store-map.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function allRefs(module) {
  return [...module.codeRefs, ...module.uiRefs, ...module.testEvidence.refs];
}

test("全店能力地图使用稳定编号、完整分区和四种诚实的执行状态", () => {
  assert.equal(assertThreeStoreMapIntegrity(), true);
  assert.deepEqual(Object.keys(THREE_STORE_MAP_EXECUTION_STATES).sort(), [
    "code_not_connected",
    "connected",
    "manual_or_codex_experiment",
    "not_implemented"
  ]);
  assert.equal(new Set(THREE_STORE_MAP_AREAS.map((item) => item.id)).size, THREE_STORE_MAP_AREAS.length);
  assert.equal(new Set(THREE_STORE_MAP_REGISTRY.map((item) => item.id)).size, THREE_STORE_MAP_REGISTRY.length);
  assert.deepEqual(
    Object.fromEntries(THREE_STORE_MAP_REGISTRY.map((item) => [item.id, [item.areaId, item.title]])),
    {
      "1.1": ["1", "保存候选、修订号和本地状态"],
      "2.1": ["2", "确认一个可计算的供应方案"],
      "2.2": ["2", "从登录态页面补采外部证据"],
      "3.1": ["3", "算具体 SKU 的利润，并自动交给 C1"],
      "4.1": ["4", "整理商品事实、属性和 SEO 草稿"],
      "4.2": ["4", "取得正式关键词与市场证据"],
      "5.1": ["5", "锁定最终素材和最终商品方案"],
      "6.1": ["6", "锁定精确生产授权，不执行写店"],
      "6.2": ["6", "把 Ozon 素材和商品真正写进店铺"],
      "6.3": ["6", "把商品正式写进 WB 店铺"],
      "7.1": ["7", "独立读取 Ozon，确认真实结果"],
      "7.2": ["7", "独立读取 WB，确认真实结果"],
      "8.1": ["8", "异常停机与 Codex 维护支路"],
      "8.2": ["8", "多人中央运行与受控 Worker"]
    }
  );

  const statuses = new Set(THREE_STORE_MAP_REGISTRY.map((item) => item.executionStatus));
  for (const status of Object.keys(THREE_STORE_MAP_EXECUTION_STATES)) assert.equal(statuses.has(status), true);

  for (const item of THREE_STORE_MAP_REGISTRY) {
    assert.match(item.id, /^\d+\.\d+$/);
    assert.ok(item.plainDescription.length > 12, `${item.id} must have a plain-language purpose`);
    assert.ok(item.inputs.length > 0, `${item.id} must name inputs`);
    assert.ok(item.outputs.length > 0, `${item.id} must name outputs`);
    assert.ok(item.breakpoint.length > 0, `${item.id} must name its current breakpoint`);
    assert.ok(item.nextStep.length > 0, `${item.id} must name its next step`);
    if (item.executionStatus === "connected") {
      assert.equal(item.connection.codePresent, true, `${item.id} connected requires code`);
      assert.equal(item.connection.uiConnected, true, `${item.id} connected requires a UI connection`);
      assert.equal(item.connection.executionConnected, true, `${item.id} connected requires an execution connection`);
      assert.ok(item.testEvidence.refs.length > 0, `${item.id} connected requires test evidence`);
    }
    if (item.executionStatus === "not_implemented") {
      assert.equal(item.connection.codePresent, false, `${item.id} must not call absent code implemented`);
      assert.equal(item.connection.executionConnected, false, `${item.id} must not call absent code connected`);
    }
  }
});

test("全店能力地图的关键断点不把 C1、D/E、WB 或 Codex 维护冒充正常闭环", () => {
  const map = buildThreeStoreMapView({
    runtimeArchitecture: { deploymentMode: "local_development", status: "local_development_ready", multiUserReady: false },
    seerfarSoftwareExecutionEnabled: false
  });
  const moduleById = new Map(map.modules.map((item) => [item.id, item]));

  assert.equal(map.title, "全店能力地图");
  assert.equal(map.readOnly, true);
  assert.match(map.evidenceScope, /不证明/);
  assert.equal(moduleById.get("4.2").executionStatus, "code_not_connected");
  assert.match(moduleById.get("4.2").runtimeNote, /未开启/);
  assert.equal(moduleById.get("6.2").connection.executionConnected, false);
  assert.match(moduleById.get("6.2").breakpoint, /canExecutePlatformWrite=false/);
  assert.equal(moduleById.get("7.1").connection.executionConnected, false);
  assert.match(moduleById.get("7.1").breakpoint, /caller-supplied verifiedObservation/);
  assert.equal(moduleById.get("6.3").executionStatus, "not_implemented");
  assert.equal(moduleById.get("7.2").executionStatus, "not_implemented");
  assert.equal(moduleById.get("8.1").executionStatus, "manual_or_codex_experiment");
  assert.match(moduleById.get("8.1").codexRule, /(?:不能|绝不)/);
  assert.match(map.exceptionRoute.returnRule, /不能/);
});

test("全店能力地图的代码和测试定位均为可检索的项目相对引用", async () => {
  for (const item of THREE_STORE_MAP_REGISTRY) {
    for (const reference of allRefs(item)) {
      assert.equal(path.isAbsolute(reference.path), false, `${item.id} must not expose an absolute path`);
      assert.equal(reference.path.includes(".."), false, `${item.id} must not traverse outside the app`);
      const filePath = path.join(appDir, reference.path);
      await access(filePath);
      const source = await readFile(filePath, "utf8");
      assert.equal(source.includes(reference.anchor), true, `${item.id} reference ${reference.path} must keep its anchor`);
    }
  }
});

test("全店能力地图是只读代码事实，不暴露绝对路径或敏感字段名称", () => {
  const serialized = JSON.stringify(buildThreeStoreMapView());
  assert.doesNotMatch(serialized, /(?:\/Users\/|\\\\Users\\\\|dataFile|runtimeConfiguration)/);
  assert.doesNotMatch(serialized, /(?:api[_-]?key|password|bearer\s|session[_-]?token)/i);
});
