import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.resolve(appDir, "..");
const port = 43920;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("server marks a dispatch running only after turn/start returns a real turn id", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-real-turn-"));
  const dataFile = path.join(directory, "candidates.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const fakeCodexRunner = path.join(directory, "fake-codex");
  await writeFile(fakeCodex, `#!${process.execPath}\nlet buffer = "";\nconst send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => {\n  buffer += chunk;\n  let at = buffer.indexOf("\\n");\n  while (at >= 0) {\n    const line = buffer.slice(0, at).trim();\n    buffer = buffer.slice(at + 1);\n    if (line) {\n      const message = JSON.parse(line);\n      if (message.id && message.method === "initialize") send({ id: message.id, result: {} });\n      else if (message.id && message.method === "thread/read") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品", cwd: ${JSON.stringify(projectDir)}, status: { type: "idle" } } } });\n      else if (message.id && message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品" } } });\n      else if (message.id && message.method === "turn/start") send({ id: message.id, result: { turn: { id: "turn-integration-001", status: "inProgress", items: [] } } });\n      else if (message.id) send({ id: message.id, error: { code: -32601, message: "Unsupported test protocol method" } });\n    }\n    at = buffer.indexOf("\\n");\n  }\n});\n`);
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeCodexRunner, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`);
  await chmod(fakeCodexRunner, 0o755);
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-07T00:00:00.000Z", automationStarted: false },
    rules: {},
    taskRoutes: {
      selection_task: { role: "selection_task", title: "选品", threadId: "selection-thread", projectPath: projectDir }
    },
    candidates: [{
      id: "REAL-TURN-1",
      source: "user",
      group: "userAdded",
      targetStore: "dandanshu",
      productName: "真实turn测试商品",
      productUrl: "https://www.ozon.ru/product/123/?token=private",
      sourceUrl: "https://detail.1688.com/offer/456.html?spm=private",
      competitorUrl: "",
      purchasePriceRmb: 10,
      packagingCostRmb: 1.5,
      packedWeightKg: 0.3,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      powered: false,
      complianceStatus: "clear",
      authorizationStatus: "clear",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      workflowStatus: "codex_processing",
      processing: { state: "queued", dispatchState: "requested", manualHold: false },
      dataRevision: 3,
      comments: [],
      history: []
    }]
  }));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_CODEX_BIN: fakeCodexRunner,
      SELECTION_REVIEW_CODEX_DISPATCH: "on",
      SELECTION_REVIEW_AUTO_DELIVER: "on"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));

  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, `测试服务未启动：${stderr.join("")}`);
  const response = await fetch(`${baseUrl}/api/candidates/REAL-TURN-1/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 3 })
  });
  assert.equal(response.status, 201);

  const state = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/state`)).json();
    return body.candidates[0].activeDispatch?.status === "running" ? body : null;
  }, `派发未进入真实运行：${stderr.join("")}`);
  const current = state.candidates[0];
  assert.equal(current.activeDispatch.runId, "turn-integration-001");
  assert.equal(current.processing.runId, "turn-integration-001");
  assert.equal(current.processing.state, "running");
  assert.equal(current.processing.claimRevision, 3);
  assert.equal(state.meta.automationStarted, false);
});

test("a blocked selection assignee does not starve an idle listing assignee at startup", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-route-groups-"));
  const dataFile = path.join(directory, "candidates.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const fakeCodexRunner = path.join(directory, "fake-codex");
  const parallelPort = 43922;
  const parallelBaseUrl = `http://127.0.0.1:${parallelPort}`;
  const skillsDirectory = path.join(directory, "skills");
  for (const name of ["ozon-wb-pricing", "optimize-ecommerce-seo"]) {
    const skillDirectory = path.join(skillsDirectory, name);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "Synthetic integration fixture only; no business execution.\n");
  }
  await writeFile(fakeCodex, `#!${process.execPath}\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport path from "node:path";\nlet buffer = "";\nconst send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => {\n  buffer += chunk;\n  let at = buffer.indexOf("\\n");\n  while (at >= 0) {\n    const line = buffer.slice(0, at).trim();\n    buffer = buffer.slice(at + 1);\n    if (line) {\n      const message = JSON.parse(line);\n      const threadId = message.params?.threadId;\n      if (message.id && message.method === "initialize") send({ id: message.id, result: {} });\n      else if (message.id && message.method === "thread/read") {\n        const selection = threadId === "selection-thread";\n        send({ id: message.id, result: { thread: { id: threadId, name: selection ? "选品" : "上架", cwd: ${JSON.stringify(projectDir)}, status: { type: selection ? "active" : "idle" } } } });\n      } else if (message.id && message.method === "thread/resume") {\n        send({ id: message.id, result: { thread: { id: threadId, name: threadId === "selection-thread" ? "选品" : "上架" } } });\n      } else if (message.id && message.method === "turn/start") {\n        const skills = message.params.input.filter((item) => item.type === "skill");\n        assert.deepEqual(skills.map((item) => item.name), ["ozon-wb-pricing", "optimize-ecommerce-seo"]);\n        for (const skill of skills) {\n          assert.equal(skill.path, path.join(${JSON.stringify(skillsDirectory)}, skill.name, "SKILL.md"));\n          assert.equal(readFileSync(skill.path, "utf8"), "Synthetic integration fixture only; no business execution.\\n");\n        }\n        send({ id: message.id, result: { turn: { id: "turn-listing-parallel", status: "inProgress", items: [] } } });\n      } else if (message.id) send({ id: message.id, error: { code: -32601, message: "Unsupported test protocol method" } });\n    }\n    at = buffer.indexOf("\\n");\n  }\n});\n`);
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeCodexRunner, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`);
  await chmod(fakeCodexRunner, 0o755);
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-12T00:00:00.000Z", automationStarted: false },
    rules: {},
    taskRoutes: {
      selection_task: { role: "selection_task", title: "选品", threadId: "selection-thread", projectPath: projectDir },
      listing_task: { role: "listing_task", title: "上架", threadId: "listing-thread", projectPath: projectDir }
    },
    candidates: [{
      id: "SELECTION-WAITING",
      source: "user",
      targetStore: "dandanshu",
      productName: "选品等待商品",
      workflowStatus: "codex_processing",
      processing: { state: "queued", dispatchState: "waiting_assignee", manualHold: false },
      dataRevision: 1,
      comments: [],
      history: []
    }, {
      id: "LISTING-READY",
      source: "user",
      targetStore: "dandanshu",
      productName: "上架准备商品",
      productUrl: "https://www.ozon.ru/product/123/",
      sourceUrl: "https://detail.1688.com/offer/456.html",
      purchasePriceRmb: 10,
      packagingCostRmb: 1.5,
      packedWeightKg: 0.3,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      workflowStatus: "listing_preparation",
      listingHandoff: { state: "queued", owner: "listing_task" },
      sourceCapture: {
        captureId: "SC-PARALLEL",
        status: "verified",
        offerId: "456",
        sourceUrl: "https://detail.1688.com/offer/456.html",
        selectedSkus: [{ sourceSkuId: "sku-1", attributes: { "规格": "目标款" }, priceCny: 10 }]
      },
      dataRevision: 2,
      comments: [],
      history: []
    }],
    dispatches: [{
      id: "D-SELECTION-WAITING",
      nodeId: "M04",
      candidateId: "SELECTION-WAITING",
      dataRevision: 1,
      assigneeRole: "selection_task",
      assigneeThreadId: "selection-thread",
      assigneeTitle: "选品",
      scope: "candidate",
      status: "waiting_assignee",
      message: "等待选品任务"
    }, {
      id: "D-LISTING-READY",
      nodeId: "M07",
      candidateId: "LISTING-READY",
      dataRevision: 2,
      assigneeRole: "listing_task",
      assigneeThreadId: "listing-thread",
      assigneeTitle: "上架",
      scope: "candidate",
      status: "waiting_assignee",
      message: "开始上架准备"
    }]
  }));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(parallelPort),
      SELECTION_REVIEW_CODEX_BIN: fakeCodexRunner,
      SELECTION_REVIEW_CODEX_DISPATCH: "on",
      SELECTION_REVIEW_DISPATCH_SKILLS_DIR: skillsDirectory,
      SELECTION_REVIEW_AUTO_DELIVER: "on"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));

  await waitFor(async () => (await fetch(`${parallelBaseUrl}/api/health`)).ok, `测试服务未启动：${stderr.join("")}`);
  const state = await waitFor(async () => {
    const body = await (await fetch(`${parallelBaseUrl}/api/state`)).json();
    const listing = body.candidates.find((item) => item.id === "LISTING-READY");
    return listing?.activeDispatch?.runId === "turn-listing-parallel" ? body : null;
  }, `空闲上架任务被选品任务阻塞：${stderr.join("")}`);
  const selection = state.candidates.find((item) => item.id === "SELECTION-WAITING");
  const listing = state.candidates.find((item) => item.id === "LISTING-READY");
  assert.equal(selection.activeDispatch.status, "waiting_assignee");
  assert.equal(listing.activeDispatch.status, "running");
  assert.equal(listing.activeDispatch.runId, "turn-listing-parallel");
  assert.equal(state.meta.automationStarted, false);
});
