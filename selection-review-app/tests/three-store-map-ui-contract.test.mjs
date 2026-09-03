import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(appDir, relativePath), "utf8");
}

test("全店能力地图组件只展示代码事实，不包含网络、表单、派发或生产写入回调", async () => {
  const component = await source("src/components/ThreeStoreMap.jsx");
  for (const forbidden of ["fetch(", "api.", "<form", "onSubmit", "onApproval", "onProductionAuthorization", "dispatchCandidate"]) {
    assert.equal(component.includes(forbidden), false, `map must not contain ${forbidden}`);
  }
  assert.match(component, /只读/);
  assert.match(component, /map\.evidenceScope/);
  assert.match(component, /全店能力地图/);
  assert.match(component, /返回今日选品评审/);
  assert.doesNotMatch(component, /三店地图/);

  assert.doesNotMatch(component, /WorkflowMap/);
});

test("全店经营工作台只把全店能力地图作为只读用户入口", async () => {
  const app = await source("src/App.jsx");
  const api = await source("src/api.js");
  const index = await source("index.html");
  const dailyProgress = await source("src/components/DailyProgress.jsx");
  const simulation = await source("src/components/Phase2ASimulation.jsx");
  const inspector = await source("src/components/UserInspector.jsx");
  assert.match(app, /import ThreeStoreMap/);
  assert.match(app, /api\.getThreeStoreMap\(\)/);
  assert.match(app, /<ThreeStoreMap/);
  assert.match(app, /全店经营工作台/);
  assert.match(app, /今日选品评审/);
  assert.match(app, /全店能力地图/);
  assert.doesNotMatch(app, /今日选品评审台|三店地图/);
  assert.doesNotMatch(app, /<WorkflowMap/);
  assert.match(index, /<title>全店经营工作台<\/title>/);
  assert.doesNotMatch(index, /今日选品评审台/);
  assert.match(dailyProgress, /全店合计/);
  assert.doesNotMatch(dailyProgress, /三店合计/);
  assert.match(simulation, /返回今日选品评审/);
  assert.match(inspector, /交回今日选品评审/);
  assert.doesNotMatch(inspector, /交回评审台/);
  assert.match(api, /getThreeStoreMap: \(\) => request\("\/api\/three-store-map"\)/);

  const mapBranch = app.slice(app.indexOf('view === "map"'), app.indexOf("<DailyProgress"));
  for (const forbidden of ["onSubmit=", "onApproval=", "onProductionAuthorization="]) {
    assert.equal(mapBranch.includes(forbidden), false, `map branch must not pass ${forbidden}`);
  }
});

test("产品显示名更新时保留运行目录、服务名和地图 API 技术标识", async () => {
  const server = await source("server.mjs");
  const dispatcher = await source("lib/codex-dispatcher.mjs");
  const launchScript = await source("scripts/launch-server.sh");
  const desktopLauncher = await source("启动今日选品评审台.command");

  assert.match(server, /console\.log\(`全店经营工作台/);
  assert.match(dispatcher, /title: "全店经营工作台"/);
  assert.match(dispatcher, /【全店经营工作台一次性派发】/);
  assert.match(launchScript, /全店经营工作台无法启动/);
  assert.match(desktopLauncher, /没有找到全店经营工作台的运行副本/);

  for (const technicalSource of [launchScript, desktopLauncher]) {
    assert.match(technicalSource, /Application Support\/今日选品评审台/);
  }
  assert.match(server, /\/api\/three-store-map/);
  assert.match(dispatcher, /name: "selection-review-app"/);
});
