import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43918;
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, workflowStatus, processing) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `${id}商品`,
    productUrl: "",
    sourceUrl: "",
    competitorUrl: "",
    purchasePriceRmb: 10,
    domesticShippingRmb: 0,
    packagingCostRmb: 1.5,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    acceptedTestRisk: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    workflowStatus,
    processing,
    dataRevision: 1,
    comments: [],
    history: []
  };
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function post(url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("node comments, one-shot dispatch, exact claim, and production confirmation stay isolated", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-collaboration-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-07T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [
      candidate("QUEUE-1", "codex_processing", { state: "queued", dispatchState: "requested", manualHold: false }),
      candidate("STOP-1", "codex_processing", { state: "blocked", dispatchState: "blocked", manualHold: true }),
      candidate("READY-1", "ready_to_list", { state: "idle", manualHold: false })
    ]
  }));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.meta.automationStarted, false);
  assert.equal(state.summary.dispatch.processingCounts.actualRunning, 0);
  assert.equal(state.summary.dispatch.processingCounts.authorized, 1);
  assert.equal(state.summary.dispatch.processingCounts.stopped, 1);

  const map = await (await fetch(`${baseUrl}/api/workflow-map?candidateId=QUEUE-1`)).json();
  assert.equal(map.selectedCandidate.activeNodeId, "M05");

  const recorded = await post("/api/node-comments", {
    nodeId: "M04",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "只记录这条说明",
    action: "record"
  });
  assert.equal(recorded.status, 201);
  assert.equal((await recorded.json()).dispatch, null);

  const executed = await post("/api/node-comments", {
    nodeId: "M04",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "只处理当前SKU一次",
    action: "execute"
  });
  assert.equal(executed.status, 409);

  const mainUiDispatch = await post("/api/candidates/QUEUE-1/dispatch", {
    dataRevision: 1
  });
  assert.equal(mainUiDispatch.status, 201);
  const dispatch = (await mainUiDispatch.json()).dispatch;
  assert.equal(dispatch.status, "queued");
  assert.equal(dispatch.assigneeRole, "selection_task");
  assert.equal(dispatch.trigger, "review_ui_dispatch");

  const duplicate = await post("/api/candidates/QUEUE-1/dispatch", {
    dataRevision: 1,
  });
  assert.equal(duplicate.status, 409);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.summary.dispatch.processingCounts.authorized, 0);
  assert.equal(state.summary.dispatch.processingCounts.dispatched, 1);
  assert.equal(state.summary.dispatch.processingCounts.stopped, 1);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  persisted.dispatches.find((item) => item.id === dispatch.id).status = "received";
  await writeFile(dataFile, JSON.stringify(persisted));

  const claimed = await post(`/api/dispatches/${dispatch.id}/claim`, {
    runId: "one-shot-run-1",
    currentStep: "读取当前资料"
  });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).candidate.processing.state, "running");

  const progressed = await post(`/api/dispatches/${dispatch.id}/progress`, {
    runId: "one-shot-run-1",
    currentStep: "核对当前市场",
    evidence: "新增一条可追溯证据"
  });
  assert.equal(progressed.status, 200);

  const completed = await post(`/api/dispatches/${dispatch.id}/complete`, {
    runId: "one-shot-run-1",
    status: "completed",
    reply: "任务已回复",
    evidence: ""
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).dispatch.status, "responded_unverified");

  const wrongOwner = await post("/api/node-comments", {
    nodeId: "M08",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "不能越级上架",
    action: "execute"
  });
  assert.equal(wrongOwner.status, 409);

  const listingDispatch = await post("/api/candidates/READY-1/dispatch", {
    dataRevision: 1
  });
  assert.equal(listingDispatch.status, 201);
  assert.equal((await listingDispatch.json()).dispatch.assigneeRole, "listing_task");

  const production = await post("/api/candidates/READY-1/production-authorization", {
    dataRevision: 1,
    platform: "Ozon",
    store: "蛋蛋鼠",
    product: "READY-1商品",
    sku: "READY-1-SKU",
    price: "3000 RUB",
    stock: "100",
    assets: ["主图.png", "详情图.png"],
    publishScope: "仅保存草稿",
    exclusions: "不送审、不发布",
    confirmed: true
  });
  assert.equal(production.status, 200);
  const authorized = (await production.json()).candidate;
  assert.equal(authorized.workflowStatus, "ready_to_list");
  assert.equal(authorized.productionAuthorization.status, "confirmed");
  assert.equal(authorized.dataRevision, 2);

  const finalData = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(finalData.meta.automationStarted, false);
  assert.equal(finalData.candidates.find((item) => item.id === "STOP-1").processing.manualHold, true);
});
