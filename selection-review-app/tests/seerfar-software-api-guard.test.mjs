import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 29000 + (process.pid % 10000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

test("Seerfar软件作业默认关闭时动态拒绝且共享数据字节不变", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "seerfar-software-guard-"));
  const dataFile = path.join(directory, "candidates.json");
  const original = JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-24T00:00:00.000Z", automationStarted: false },
    rules: {}, candidates: [], dispatches: [], nodeDispatches: [], workflowComments: [], controlAlerts: [], evidencePacks: []
  });
  await writeFile(dataFile, original);
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_SEERFAR_SOFTWARE_ENABLED: "false"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);
  const before = await readFile(dataFile, "utf8");
  const response = await fetch(`${baseUrl}/api/candidates/NO-SUCH/lifecycle/c1/keyword-evidence-software-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 1, runtimeInputTemplate: {}, seerfarRequest: {} })
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /SEERFAR_SOFTWARE_EXECUTION_DISABLED/);
  assert.equal(await readFile(dataFile, "utf8"), before);
});

test("执行开启后客户端仍只能提交revision，服务端缺证据时422且零写入", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "seerfar-software-not-ready-"));
  const dataFile = path.join(directory, "candidates.json");
  const original = JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-24T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [{
      id: "CX-C1-NOT-READY",
      dataRevision: 7,
      lifecycleV11: {
        skuPackage: {
          candidateId: "CX-C1-NOT-READY",
          skuPackageId: "sku:not-ready:7",
          businessPhase: "C1",
          c1ProductPlan: { status: "inputs_ready" }
        }
      }
    }],
    dispatches: [], nodeDispatches: [], workflowComments: [], controlAlerts: [], evidencePacks: []
  });
  await writeFile(dataFile, original);
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_SEERFAR_SOFTWARE_ENABLED: "true"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  const unsafe = await fetch(`${baseUrl}/api/candidates/CX-C1-NOT-READY/lifecycle/c1/keyword-evidence-software-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4317" },
    body: JSON.stringify({ dataRevision: 7, seerfarRequest: { skuIds: ["unsafe"] } })
  });
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).message, /CLIENT_INPUT_REJECTED/);

  const notReady = await fetch(`${baseUrl}/api/candidates/CX-C1-NOT-READY/lifecycle/c1/keyword-evidence-software-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4317" },
    body: JSON.stringify({ dataRevision: 7 })
  });
  assert.equal(notReady.status, 422);
  assert.match((await notReady.json()).message, /C1_KEYWORD_SOFTWARE_NOT_READY/);
  assert.equal(await readFile(dataFile, "utf8"), original);
});
