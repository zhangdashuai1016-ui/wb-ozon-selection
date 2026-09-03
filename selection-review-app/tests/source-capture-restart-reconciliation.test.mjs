import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstPort = 51000 + (process.pid % 7000);

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
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(child, baseUrl, stderr);
  return { child, baseUrl };
}

test("服务重启只收口遗留A采集作业且正常启动零写入", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-restart-"));
  const residualFile = path.join(directory, "residual.json");
  const queued = orphanCandidate("A-QUEUED", "queued");
  const claimed = orphanCandidate("A-CLAIMED", "claimed");
  const untouched = baseCandidate("OTHER-UNTOUCHED");
  await writeFile(residualFile, JSON.stringify(document([queued, claimed, untouched]), null, 2));

  const { baseUrl } = await startServer(t, residualFile, firstPort);
  const persisted = JSON.parse(await readFile(residualFile, "utf8"));
  const queuedAfter = persisted.candidates.find((item) => item.id === queued.id);
  const claimedAfter = persisted.candidates.find((item) => item.id === claimed.id);
  const untouchedAfter = persisted.candidates.find((item) => item.id === untouched.id);

  assert.equal(queuedAfter.sourceCapture.status, "failed");
  assert.equal(queuedAfter.sourceCapture.jobStatus, "failed");
  assert.equal(queuedAfter.sourceCapture.technicalStatus, "system_error");
  assert.equal(queuedAfter.sourceCapture.failureCode, "service_restarted_before_claim");
  assert.equal(queuedAfter.sourceCapture.attempt, 0);
  assert.equal(queuedAfter.dataRevision, queued.dataRevision + 1);
  assert.equal(queuedAfter.workflowStatus, queued.workflowStatus);
  assert.equal(queuedAfter.lifecycleV11.status, queued.lifecycleV11.status);
  assert.equal(queuedAfter.sourceCapture.token, undefined);
  assert.equal(queuedAfter.sourceCapture.extensionRequest, undefined);
  assert.equal(queuedAfter.sourceCapture.requiresOwnerNewAuthorization, true);
  assert.equal(queuedAfter.history.at(-1).action, "aSupplierCaptureStoppedAfterRestart");

  assert.equal(claimedAfter.sourceCapture.status, "failed");
  assert.equal(claimedAfter.sourceCapture.jobStatus, "unknown_outcome");
  assert.equal(claimedAfter.sourceCapture.technicalStatus, "unknown_outcome");
  assert.equal(claimedAfter.sourceCapture.failureCode, "unknown_outcome");
  assert.equal(claimedAfter.sourceCapture.attempt, 1);
  assert.equal(claimedAfter.dataRevision, claimed.dataRevision + 1);
  assert.equal(claimedAfter.workflowStatus, claimed.workflowStatus);
  assert.equal(claimedAfter.lifecycleV11.status, claimed.lifecycleV11.status);
  assert.equal(claimedAfter.sourceCapture.token, undefined);
  assert.equal(claimedAfter.sourceCapture.extensionRequest, undefined);
  assert.equal(claimedAfter.history.at(-1).action, "aSupplierCaptureUnknownAfterRestart");

  assert.deepEqual(untouchedAfter, untouched);
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(persisted.dispatches.length, 0);

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

  const cleanFile = path.join(directory, "clean.json");
  await writeFile(cleanFile, JSON.stringify(document([baseCandidate("CLEAN-1")]), null, 2));
  const cleanBefore = await readFile(cleanFile);
  await startServer(t, cleanFile, firstPort + 1);
  const cleanAfter = await readFile(cleanFile);
  assert.deepEqual(cleanAfter, cleanBefore, "没有遗留作业时启动不得改写共享文件任何字节");
});
