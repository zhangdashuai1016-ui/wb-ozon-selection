import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("全店能力地图 API 只连接纯只读事实投影，不读取候选、不探测平台或写入状态", async () => {
  const server = await readFile(path.join(appDir, "server.mjs"), "utf8");
  const routeStart = server.indexOf('if (req.method === "GET" && pathname === "/api/three-store-map")');
  const routeEnd = server.indexOf('if (req.method === "GET" && pathname === "/api/workflow-map")', routeStart);
  assert.ok(routeStart >= 0, "server must expose the read-only map route");
  assert.ok(routeEnd > routeStart, "new map route must remain separate from the legacy workflow map route");

  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /buildThreeStoreMapView\(/);
  for (const forbidden of ["readData(", "mutateData(", "requestBody(", "inspectSeerfarRuntimeConfiguration(", "fetch("]) {
    assert.equal(route.includes(forbidden), false, `read-only route must not call ${forbidden}`);
  }

  const model = await readFile(path.join(appDir, "lib", "three-store-map.mjs"), "utf8");
  assert.match(model, /只把启动期安全运行事实投影到地图/);
  assert.doesNotMatch(model, /(?:\/Users\/|dataFile|runtimeConfiguration|api[_-]?key|password)/i);
});
