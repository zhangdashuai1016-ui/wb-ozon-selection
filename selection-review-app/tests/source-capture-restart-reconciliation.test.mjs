import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstPort = Number(process.env.SELECTION_REVIEW_TEST_PORT || 51000 + (process.pid % 7000));
const secondPort = Number(process.env.SELECTION_REVIEW_TEST_SECOND_PORT || firstPort + 1);

function baseCandidate(id) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `重启测试 ${id}`,
    productUrl: "https://www.ozon.ru/product/test-4403916892/",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    workflowStatus: "codex_processing",
    dataRevision: 7,
    processing: { state: "idle", manualHold: true },
    lifecycleV11: {
      schemaVersion: "product-lifecycle-v1.1",
      status: "opportunity_sales_snapshot_captured",
      opportunityPackage: { schemaVersion: "product-lifecycle-v1.1", entityType: "OpportunityPackage" },
      platformWrites: 0
    },
    comments: [],
    history: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
}

function orphanCandidate(id, kind) {
  const candidate = baseCandidate(id);
  candidate.sourceCapture = {
    captureId: `SCJ-${id}`,
    jobId: `SCJ-${id}`,
    mode: "a_supplier_capture",
    status: kind === "claimed" ? "capturing" : "waiting_extension",
    jobStatus: kind,
    attempt: kind === "claimed" ? 1 : 0,
    sourceUrl: candidate.sourceUrl,
    originalSourceUrl: candidate.sourceUrl,
    requiredExtensionVersion: "1.2.7",
    token: "must-not-survive-restart",
    extensionRequest: { token: "must-not-survive-restart" },
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  return candidate;
}

function document(candidates) {
  return {
    meta: { version: 2, title: "restart-test", updatedAt: "2026-08-19T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates,
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  };
}

async function waitForHealth(child, baseUrl, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function startServer(t, dataFile, port) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(child, baseUrl, stderr);
  return { child, baseUrl };
}

test("正常启动、状态读取、心跳和再次重启均不改历史或领取旧作业", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-restart-"));
  const residualFile = path.join(directory, "residual.json");
  const queued = orphanCandidate("A-QUEUED", "queued");
  const claimed = orphanCandidate("A-CLAIMED", "claimed");
  const untouched = baseCandidate("OTHER-UNTOUCHED");
  await writeFile(residualFile, JSON.stringify(document([queued, claimed, untouched]), null, 2));

  const before = await readFile(residualFile, "utf8");
  const { baseUrl, child } = await startServer(t, residualFile, firstPort);
  assert.equal(await readFile(residualFile, "utf8"), before);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.captureControl.status, "idle");
  assert.equal(state.candidates.find(item => item.id === queued.id).sourceCapture.token, undefined);
  assert.equal(state.candidates.find(item => item.id === claimed.id).sourceCapture.extensionRequest, undefined);
  const runtime = await (await fetch(`${baseUrl}/api/integrations/seerfar/runtime-status`)).json();
  assert.equal(runtime.credentialStatus, "not_checked");
  assert.equal(runtime.configured, null);
  assert.equal(await readFile(residualFile, "utf8"), before);
  const claim = await fetch(`${baseUrl}/api/extension/capture-jobs/SCJ-A-QUEUED/claim`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    body: JSON.stringify({ version: "1.2.7" })
  });
  assert.equal(claim.status, 409);
  assert.equal((await claim.json()).code, "capture_job_not_current");
  const heartbeat = await fetch(`${baseUrl}/api/extension/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    body: JSON.stringify({ version: "1.2.7", backgroundReady: true, observedAt: new Date().toISOString() })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).captureJob, null, "重启后不得重建、恢复或重新领取旧作业");

  assert.equal(await readFile(residualFile, "utf8"), before);
  await stopApiProcess(child);
  await startServer(t, residualFile, secondPort);
  assert.equal(await readFile(residualFile, "utf8"), before, "服务再次重启也不得改历史字节");
});
