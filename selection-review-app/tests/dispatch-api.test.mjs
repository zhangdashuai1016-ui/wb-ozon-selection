import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43917;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

test("candidate entry auto-dispatches once and failure only retries from an explicit UI suggestion", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-dispatch-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-11T08:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: []
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

  const exchangePack = await post("/api/evidence-packs", {
    kind: "exchange_rate",
    scope: { pair: "RUB/CNY" },
    summary: "本轮官方RUB/CNY汇率",
    sourceType: "real",
    checkedAt: "2026-08-11T08:30:00.000Z"
  });
  assert.equal(exchangePack.status, 201);

  const createResponse = await post("/api/candidates", {
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/auto-1/"
  });
  assert.equal(createResponse.status, 201);
  const createdBody = await createResponse.json();
  assert.equal(createdBody.candidate.workflowStatus, "codex_processing");
  assert.equal(createdBody.candidate.processing.dispatchTrigger, "candidate_entry_auto");
  assert.equal(createdBody.dispatch.assigneeRole, "selection_task");
  assert.equal(createdBody.dispatch.status, "queued");
  assert.equal(createdBody.dispatch.candidateSnapshot.candidateId, createdBody.candidate.id);
  assert.equal(createdBody.dispatch.candidateSnapshot.dataRevision, createdBody.candidate.dataRevision);
  assert.equal(createdBody.dispatch.reusableEvidencePacks.length, 1);
  assert.equal(createdBody.dispatch.reusableEvidencePacks[0].kind, "exchange_rate");

  const duplicateDispatch = await post(`/api/candidates/${createdBody.candidate.id}/dispatch`, {
    dataRevision: createdBody.candidate.dataRevision
  });
  assert.equal(duplicateDispatch.status, 409);

  const recordedComment = await post(`/api/candidates/${createdBody.candidate.id}/comments`, {
    actor: "user",
    message: "这只是说明，不要启动任务",
    requestReview: false
  });
  assert.equal(recordedComment.status, 201);
  const forbiddenCommentDispatch = await post(`/api/candidates/${createdBody.candidate.id}/comments`, {
    actor: "user",
    message: "旧按钮不应再派发",
    requestReview: true
  });
  assert.equal(forbiddenCommentDispatch.status, 409);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  const originalDispatch = persisted.dispatches.find((item) => item.id === createdBody.dispatch.id);
  originalDispatch.status = "failed";
  originalDispatch.failureLayer = "market_page";
  originalDispatch.error = "公开页读取失败";
  const storedCandidate = persisted.candidates.find((item) => item.id === createdBody.candidate.id);
  storedCandidate.processing.state = "blocked";
  storedCandidate.processing.manualHold = true;
  storedCandidate.processing.blockReason = "公开页读取失败";
  await writeFile(dataFile, JSON.stringify(persisted));

  const stateBeforeRetry = await (await fetch(`${baseUrl}/api/state`)).json();
  const stopped = stateBeforeRetry.candidates.find((item) => item.id === createdBody.candidate.id);
  assert.equal(stopped.latestDispatch.status, "failed");
  assert.equal(stateBeforeRetry.summary.dispatch.processingCounts.stopped, 1);

  const retryResponse = await post("/api/control/resume", {
    candidateId: stopped.id,
    dataRevision: stopped.dataRevision,
    recoveryPath: "同规格竞品不足5个也可以，按现有可追溯样本完成B阶段"
  });
  assert.equal(retryResponse.status, 200);
  const retryBody = await retryResponse.json();
  assert.equal(retryBody.candidate.processing.dispatchTrigger, "user_guided_retry");
  assert.equal(retryBody.candidate.processing.manualHold, false);
  assert.equal(retryBody.dispatch.trigger, "user_guided_retry");
  assert.equal(retryBody.dispatch.assigneeRole, "selection_task");

  const secondClick = await post("/api/control/resume", {
    candidateId: stopped.id,
    dataRevision: retryBody.candidate.dataRevision,
    recoveryPath: "重复点击"
  });
  assert.equal(secondClick.status, 409);

  const finalState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(finalState.meta.automationStarted, false);
  assert.equal(finalState.summary.dispatch.processingCounts.dispatched, 1);
});
