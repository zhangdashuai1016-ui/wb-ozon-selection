import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43927;
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, productId) {
  return {
    id,
    source: "codex",
    group: "dandanshu",
    targetStore: "dandanshu",
    productName: `测试Ozon商品${productId}`,
    productUrl: `https://www.ozon.ru/product/test-${productId}/`,
    sourceUrl: "unknown",
    purchasePriceRmb: 20,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 10, width: 10, height: 5 },
    powered: false,
    workflowStatus: "codex_processing",
    dataRevision: 1,
    processing: { state: "blocked", manualHold: true, blockReason: "历史技术失败" },
    comments: [],
    history: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z"
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

async function post(url, body, headers = {}) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function evidence(productId) {
  return {
    productId,
    productUrl: `https://www.ozon.ru/product/test-${productId}/`,
    title: "Музыкальная швейная машинка",
    imageRefs: ["https://ir.ozone.ru/test.jpg"],
    currentPrice: 2598,
    currency: "RUB",
    categoryPath: "Хобби > Музыкальные шкатулки",
    attributes: { Тип: "Музыкальная шкатулка" },
    sellerIdentitySignals: [{ field: "seller_display_name", value: "Example", sourcePath: "widget.heading" }],
    marketScope: "ozon_general_market",
    observedAt: "2026-08-14T01:00:00.000Z"
  };
}

test("one Ozon capture appends a verified SalesSnapshot without changing business state", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ozon-sales-capture-api-"));
  const dataFile = path.join(directory, "candidates.json");
  const target = candidate("OZON-CAPTURE-1", "4403916892");
  const other = candidate("OZON-OTHER-1", "4403916999");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-14T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [target, other]
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

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.captureControl.status, "idle");

  const preflight = await fetch(`${baseUrl}/api/candidates/OZON-CAPTURE-1/sales-capture/result`, {
    method: "OPTIONS",
    headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  });
  assert.equal(preflight.status, 204);

  const start = await post("/api/candidates/OZON-CAPTURE-1/sales-capture/start", { dataRevision: 1 });
  assert.equal(start.status, 201);
  const started = await start.json();
  assert.equal(started.expectedProductId, "4403916892");
  assert.equal(started.candidate.salesCapture.status, "waiting_extension");
  assert.equal(started.candidate.workflowStatus, "codex_processing");
  assert.equal(started.candidate.processing.state, "blocked");

  const busyState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(busyState.captureControl, {
    status: "busy",
    label: "正在采集 OZON-CAPTURE-1（ozon）",
    candidateId: "OZON-CAPTURE-1",
    captureId: started.captureId,
    platform: "ozon",
    captureKind: "sales",
    startedAt: busyState.captureControl.startedAt,
    expiresAt: busyState.captureControl.expiresAt
  });

  const blockedParallel = await post("/api/candidates/OZON-OTHER-1/sales-capture/start", { dataRevision: 1 });
  assert.equal(blockedParallel.status, 409);
  const blockedParallelBody = await blockedParallel.json();
  assert.match(blockedParallelBody.message, /本次没有启动，也不会排队或自动重试/);
  assert.equal(blockedParallelBody.captureControl.candidateId, "OZON-CAPTURE-1");
  const storedDuringCapture = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(storedDuringCapture.candidates.find((item) => item.id === "OZON-OTHER-1").dataRevision, 1);
  assert.equal(storedDuringCapture.candidates.find((item) => item.id === "OZON-OTHER-1").salesCapture, undefined);

  const result = await post("/api/candidates/OZON-CAPTURE-1/sales-capture/result", {
    captureId: started.captureId,
    token: started.extensionRequest.token,
    dataRevision: started.dataRevision,
    status: "captured",
    evidence: evidence("4403916892")
  }, { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(result.status, 200);
  const completed = await result.json();
  assert.equal(completed.dispatch, null);
  assert.equal(completed.candidate.salesCapture.status, "verified");
  assert.equal(completed.candidate.salesCapture.currentPrice, 2598);
  assert.equal(completed.candidate.workflowStatus, "codex_processing");
  assert.equal(completed.candidate.processing.state, "blocked");
  assert.equal(completed.candidate.lifecycleV11.status, "opportunity_sales_snapshot_captured");
  assert.equal(completed.candidate.lifecycleV11.platformWrites, 0);
  assert.equal(completed.candidate.lifecycleV11.opportunityPackage.salesSnapshots.length, 2);
  const snapshot = completed.candidate.lifecycleV11.opportunityPackage.salesSnapshots[1];
  assert.equal(snapshot.productId, "4403916892");
  assert.equal(snapshot.sellerType, "unknown");
  assert.equal(snapshot.currentPrice, 2598);

  const idleState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(idleState.captureControl.status, "idle");

  const stored = JSON.parse(await readFile(dataFile, "utf8"));
  const storedOther = stored.candidates.find((item) => item.id === "OZON-OTHER-1");
  assert.deepEqual(storedOther, other, "其他候选必须完全不变");
  assert.equal(stored.meta.automationStarted, false);

  const failedStart = await post("/api/candidates/OZON-OTHER-1/sales-capture/start", { dataRevision: 1 });
  const failedSession = await failedStart.json();
  const failedResult = await post("/api/candidates/OZON-OTHER-1/sales-capture/result", {
    captureId: failedSession.captureId,
    token: failedSession.extensionRequest.token,
    dataRevision: failedSession.dataRevision,
    status: "failed",
    failureCode: "site_verification_required",
    message: "页面要求人工验证",
    observedAt: "2026-08-14T01:05:00.000Z"
  }, { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal(failedResult.status, 200);
  const failed = await failedResult.json();
  assert.equal(failed.candidate.salesCapture.technicalStatus, "permission_required");
  assert.equal(failed.candidate.salesCapture.businessStateEffect, "unchanged");
  assert.equal(failed.candidate.workflowStatus, "codex_processing");
  assert.equal(failed.candidate.lifecycleV11, undefined);
});
