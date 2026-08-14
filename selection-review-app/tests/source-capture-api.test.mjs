import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 20000 + (process.pid % 30000);
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, productName = "机械发条木质火车320片3D拼图") {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName,
    productUrl: "https://www.ozon.ru/product/test/",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html?tracking=removed",
    competitorUrl: "",
    purchasePriceRmb: 41,
    domesticShippingRmb: 0,
    packagingCostRmb: 1.5,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    acceptedTestRisk: true,
    workflowStatus: "listing_preparation",
    dataRevision: 1,
    processing: { state: "idle", manualHold: false },
    codexReview: {
      decision: "sourcePending",
      sourceSku: { sku: productName },
      marketEvidence: { comparableCount: 1 },
      profitCalculation: { status: "estimated", directionalStatus: "passed", inputsComplete: true, unitProfitRmb: 25, marginRate: 0.2 }
    },
    listingPreparation: { status: "awaiting_user_start", defaultStock: 100 },
    listingHandoff: { state: "awaiting_user_start", owner: "listing_task", defaultStock: 100 },
    comments: [],
    history: [],
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}

function listedRecoveryCandidate() {
  return {
    ...candidate("LISTED-RECOVERY", "发光木质3D鬼屋拼图（不含电池）"),
    workflowStatus: "listed",
    listingPreparation: { status: "queued", requestedBy: "user" },
    listingHandoff: { state: "completed", owner: "listing_task" },
    listingRecord: {
      platform: "ozon",
      store: "dandanshu",
      method: "manual_fallback",
      stateOnly: true,
      confirmedAt: "2026-08-11T12:13:00.000Z"
    }
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

function capturedEvidence(skus) {
  return {
    offerId: "712421624571",
    title: "机械发条木质火车",
    offerStatus: "online",
    observedAt: new Date().toISOString(),
    titleSource: "offerBaseInfo",
    offerIdSource: "offerBaseInfo.offerId",
    priceRanges: [{ minimumQuantity: 2, priceCny: 39, source: "tradeModel.offerPriceRanges" }],
    supplierAttributes: { 材质: "木质" },
    skus
  };
}

test("旧1688 C入口不再派发，已上架证据恢复仍保持只读", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-api-"));
  const dataFile = path.join(directory, "candidates.json");
  const originalOther = candidate("OTHER-1", "其他商品100片");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-11T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [candidate("CAPTURE-1"), originalOther, candidate("AMBIG-1", "木质火车"), listedRecoveryCandidate(), candidate("UNTOUCHED-1", "未触碰商品50片")]
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

  const preflight = await fetch(`${baseUrl}/api/candidates/CAPTURE-1/source-capture/result`, {
    method: "OPTIONS",
    headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const start = await post("/api/candidates/CAPTURE-1/source-capture/start", { dataRevision: 1 });
  assert.equal(start.status, 409);
  assert.match((await start.json()).message, /不会创建旧C阶段派发/);

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  const listedRecovery = state.candidates.find((item) => item.id === "LISTED-RECOVERY");
  const listedRecordBefore = structuredClone(listedRecovery.listingRecord);
  const listedStart = await post("/api/candidates/LISTED-RECOVERY/source-capture/start", {
    dataRevision: listedRecovery.dataRevision,
    mode: "listed_evidence_recovery"
  });
  assert.equal(listedStart.status, 201);
  const listedSession = await listedStart.json();
  assert.equal(listedSession.candidate.workflowStatus, "listed");
  assert.deepEqual(listedSession.candidate.listingRecord, listedRecordBefore);
  assert.equal(listedSession.candidate.sourceCapture.mode, "listed_evidence_recovery");

  const listedResult = await post("/api/candidates/LISTED-RECOVERY/source-capture/result", {
    captureId: listedSession.captureId,
    token: listedSession.extensionRequest.token,
    dataRevision: listedSession.dataRevision,
    status: "captured",
    evidence: capturedEvidence([
      { sourceSkuId: "ghost-house", attributes: { 款式: "发光鬼屋" }, priceCny: 53, priceSource: "sku.price", stock: 8, stockSource: "sku.stock" }
    ])
  });
  assert.equal(listedResult.status, 200);
  const listedCaptured = await listedResult.json();
  assert.equal(listedCaptured.candidate.workflowStatus, "listed");
  assert.equal(listedCaptured.candidate.sourceCapture.status, "needs_sku_selection");
  assert.equal(listedCaptured.dispatch, null);

  const listedSelection = await post("/api/candidates/LISTED-RECOVERY/source-capture/select-sku", {
    dataRevision: listedCaptured.candidate.dataRevision,
    sourceSkuIds: ["ghost-house"]
  });
  assert.equal(listedSelection.status, 200);
  const listedCompleted = await listedSelection.json();
  assert.equal(listedCompleted.candidate.workflowStatus, "listed");
  assert.deepEqual(listedCompleted.candidate.listingRecord, listedRecordBefore);
  assert.equal(listedCompleted.candidate.sourceCapture.status, "verified");
  assert.equal(listedCompleted.candidate.sourceCapture.selectedSkus[0].sourceSkuId, "ghost-house");
  assert.equal(listedCompleted.dispatch, null);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(persisted.dispatches.filter((item) => item.candidateId === "CAPTURE-1").length, 0);
  assert.equal(persisted.dispatches.filter((item) => item.candidateId === "OTHER-1").length, 0);
  assert.equal(persisted.dispatches.filter((item) => item.candidateId === "AMBIG-1").length, 0);
  assert.equal(persisted.dispatches.filter((item) => item.candidateId === "LISTED-RECOVERY").length, 0);
  const persistedListed = persisted.candidates.find((item) => item.id === "LISTED-RECOVERY");
  assert.equal(persistedListed.workflowStatus, "listed");
  assert.deepEqual(persistedListed.listingRecord, listedRecordBefore);
  const persistedOther = persisted.candidates.find((item) => item.id === "OTHER-1");
  assert.equal(persistedOther.sourceCapture, undefined);
  const untouched = persisted.candidates.find((item) => item.id === "UNTOUCHED-1");
  assert.equal(untouched.dataRevision, 1);
  assert.equal(untouched.sourceCapture, undefined);
});
