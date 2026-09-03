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

test("新版候选进入软件状态机且任何旧Codex入口都不能推动", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-software-entry-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-22T08:00:00.000Z", automationStarted: false },
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
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      CODEX_OFFLINE: "true"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  const createResponse = await post("/api/candidates", {
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/software-entry-1/"
  });
  assert.equal(createResponse.status, 201);
  const createdBody = await createResponse.json();
  assert.equal(createdBody.candidate.workflowStatus, "awaiting_user_direction");
  assert.equal(createdBody.candidate.executionRuntime.executorType, "software");
  assert.equal(createdBody.candidate.executionRuntime.status, "not_started");
  assert.equal(createdBody.candidate.executionRuntime.codexWakeupCount, 0);
  assert.equal(createdBody.dispatch, null);

  const oldDispatch = await post(`/api/candidates/${createdBody.candidate.id}/dispatch`, {
    dataRevision: createdBody.candidate.dataRevision
  });
  assert.equal(oldDispatch.status, 409);
  assert.match((await oldDispatch.json()).message, /不能使用旧通用派发入口|当前业务阶段不能直接派发/);

  const oldCommentDispatch = await post(`/api/candidates/${createdBody.candidate.id}/comments`, {
    actor: "user",
    message: "旧按钮不应再派发",
    requestReview: true
  });
  assert.equal(oldCommentDispatch.status, 409);
  assert.match((await oldCommentDispatch.json()).message, /普通留言不会启动任务|Normal production path attempted Codex dependency\./);

  const simulation = await (await fetch(`${baseUrl}/api/simulations/software-execution`)).json();
  assert.equal(simulation.result.codexWakeups, 0);
  assert.equal(simulation.persistence.codexTasksWoken, 0);
  assert.equal(simulation.persistence.sharedCandidatesWritten, 0);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const current = state.candidates.find((item) => item.id === createdBody.candidate.id);
  assert.equal(current.executionRuntimeView.executorType, "software");
  assert.equal(current.executionRuntimeView.legacyReadOnly, false);
  assert.equal(state.meta.automationStarted, false);
  assert.equal(state.summary.dispatch.processingCounts.dispatched, 0);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(persisted.candidates[0].executionRuntime.codexWakeupCount, 0);
});
