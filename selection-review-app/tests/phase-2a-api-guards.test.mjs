import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 31000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, lifecycle = false) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `${id}历史候选`,
    productUrl: "https://www.ozon.ru/product/simulation/",
    sourceUrl: "https://detail.1688.com/offer/712421624571.html",
    purchasePriceRmb: 41,
    packedWeightKg: 0.21,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    powered: false,
    workflowStatus: "listing_preparation",
    dataRevision: 1,
    processing: { state: "idle", manualHold: false },
    listingPreparation: { status: "awaiting_user_start" },
    listingHandoff: { state: "awaiting_user_start", owner: "listing_task" },
    comments: [],
    history: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...(lifecycle ? { lifecycleV11: { opportunityPackage: { parentOpportunityId: `opportunity:${id}` } } } : {})
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

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("2A模拟接口零持久化，旧C入口明确拒绝且awaiting_user_start只读", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "phase-2a-api-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-14T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [candidate("LEGACY-AWAITING"), candidate("LIFECYCLE-NEW", true)]
  }));
  const before = await readFile(dataFile);

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

  const initialState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(initialState.candidates.length, 2);
  assert.equal(initialState.candidates.find((item) => item.id === "LEGACY-AWAITING").listingHandoff.state, "awaiting_user_start");

  for (const id of ["LEGACY-AWAITING", "LIFECYCLE-NEW"]) {
    const response = await post(`/api/candidates/${id}/start-listing-preparation`, { dataRevision: 1 });
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /旧“开始上架准备”入口已停用/);
  }

  const capture = await post("/api/candidates/LIFECYCLE-NEW/source-capture/start", { dataRevision: 1 });
  assert.equal(capture.status, 409);
  assert.match((await capture.json()).message, /不会创建旧C阶段派发/);

  const oldEvaluation = await post("/api/candidates/LIFECYCLE-NEW/user-evaluation", {
    dataRevision: 1,
    decision: "viable"
  });
  assert.equal(oldEvaluation.status, 409);
  assert.match((await oldEvaluation.json()).message, /新版生命周期商品不能使用旧方向确认入口/);

  const demoCard = await (await fetch(`${baseUrl}/api/simulations/phase-2a`)).json();
  assert.equal(demoCard.card.isSimulation, true);
  assert.equal(demoCard.card.sharedCandidatesAffected, 0);
  const simulated = await post("/api/simulations/phase-2a/confirm", {
    decision: "confirm",
    supplierConfirmation: demoCard.card.supplierConfirmation
  });
  assert.equal(simulated.status, 200);
  const simulatedBody = await simulated.json();
  assert.equal(simulatedBody.result.status, "c1_handed_off");
  assert.deepEqual(simulatedBody.persistence, {
    sharedCandidatesWritten: 0,
    dispatchesCreated: 0,
    platformAccesses: 0,
    platformWrites: 0
  });

  const after = await readFile(dataFile);
  assert.equal(sha(after), sha(before));
  const finalState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(finalState.meta.automationStarted, false);
  assert.equal(finalState.candidates.length, 2);
  assert.equal(finalState.candidates.every((item) => item.activeDispatch === null), true);
});
