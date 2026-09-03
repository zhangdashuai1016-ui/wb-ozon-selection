import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43927;
const baseUrl = `http://127.0.0.1:${port}`;
const gatewayPort = 43928;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin", ...headers },
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

  let terraCalls = 0;
  const gateway = createServer(async (req, res) => {
    terraCalls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const body = JSON.stringify({
      jobId: "inf-ozon-capture-test",
      candidateId: request.candidateId,
      dataRevision: request.dataRevision,
      taskType: request.taskType,
      model: request.model,
      status: "completed",
      attempt: 1,
      receipt: {
        requestHash: "a".repeat(64),
        outputSchemaHash: "b".repeat(64),
        evidenceRefs: request.evidenceRefs,
        requestedAt: "2026-08-14T01:00:01.000Z",
        completedAt: "2026-08-14T01:00:02.000Z",
        validation: { strictJson: true, schemaValid: true },
        usage: "unknown",
        output: { summary: "公开销售快照已整理", comparabilitySignals: ["当前价格清晰"], attributeHints: [] }
      }
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
  t.after(() => gateway.close());

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_PUBLIC_ORIGIN: baseUrl,
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: extensionOrigin,
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`
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
    headers: { Origin: extensionOrigin }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

  const start = await post("/api/candidates/OZON-CAPTURE-1/sales-capture/start", { dataRevision: 1 });
  assert.equal(start.status, 409);
  const startBody = await start.json();
  assert.equal(startBody.code, "sales_capture_claim_protocol_required");
  assert.match(startBody.message, /没有创建采集会话或业务写入/);

  const busyState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(busyState.captureControl, { status: "idle", label: "无活动采集" });

  const blockedParallel = await post("/api/candidates/OZON-OTHER-1/sales-capture/start", { dataRevision: 1 });
  assert.equal(blockedParallel.status, 409);
  const blockedParallelBody = await blockedParallel.json();
  assert.equal(blockedParallelBody.code, "sales_capture_claim_protocol_required");
  const storedDuringCapture = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(storedDuringCapture.candidates.find((item) => item.id === "OZON-CAPTURE-1"), target);
  assert.equal(storedDuringCapture.candidates.find((item) => item.id === "OZON-OTHER-1").dataRevision, 1);
  assert.equal(storedDuringCapture.candidates.find((item) => item.id === "OZON-OTHER-1").salesCapture, undefined);
  assert.equal(terraCalls, 0);

  const stored = JSON.parse(await readFile(dataFile, "utf8"));
  const storedTarget = stored.candidates.find((item) => item.id === "OZON-CAPTURE-1");
  assert.deepEqual(storedTarget, target);
  const storedOther = stored.candidates.find((item) => item.id === "OZON-OTHER-1");
  assert.deepEqual(storedOther, other, "其他候选必须完全不变");
  assert.equal(stored.meta.automationStarted, false);
});
