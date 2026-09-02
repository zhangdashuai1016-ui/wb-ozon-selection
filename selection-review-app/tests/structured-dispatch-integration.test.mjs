import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.resolve(appDir, "..");
const port = 43921;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("structured App Server result is applied without the task calling back to 4317", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-structured-result-"));
  const dataFile = path.join(directory, "candidates.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const fakeCodexRunner = path.join(directory, "fake-codex");
  const structured = JSON.stringify({
    status: "completed",
    reply: "当前SKU已按证据淘汰",
    resultType: "selection_review",
    resultJson: JSON.stringify({ decision: "eliminated", reason: "测试证据明确不满足利润门" }),
    evidenceSummary: "结构化审核结果"
  });
  await writeFile(fakeCodex, `#!${process.execPath}\nlet buffer = "";\nconst send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => {\n  buffer += chunk;\n  let at = buffer.indexOf("\\n");\n  while (at >= 0) {\n    const line = buffer.slice(0, at).trim();\n    buffer = buffer.slice(at + 1);\n    if (line) {\n      const message = JSON.parse(line);\n      if (message.id && message.method === "initialize") send({ id: message.id, result: {} });\n      else if (message.id && message.method === "thread/read") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品", cwd: ${JSON.stringify(projectDir)}, status: { type: "idle" } } } });\n      else if (message.id && message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品" } } });\n      else if (message.id && message.method === "turn/start") {\n        send({ id: message.id, result: { turn: { id: "turn-structured-001", status: "inProgress", items: [] } } });\n        setTimeout(() => {\n          send({ method: "item/completed", params: { turnId: "turn-structured-001", item: { type: "agentMessage", text: ${JSON.stringify(structured)} } } });\n          send({ method: "turn/completed", params: { turn: { id: "turn-structured-001", status: "completed", error: null } } });\n        }, 100);\n      } else if (message.id) send({ id: message.id, error: { code: -32601, message: "Unsupported test protocol method" } });\n    }\n    at = buffer.indexOf("\\n");\n  }\n});\n`);
  await chmod(fakeCodex, 0o755);
  await writeFile(fakeCodexRunner, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`);
  await chmod(fakeCodexRunner, 0o755);
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-11T00:00:00.000Z", automationStarted: false },
    rules: {},
    taskRoutes: {
      selection_task: { role: "selection_task", title: "选品", threadId: "selection-thread", projectPath: projectDir }
    },
    candidates: [{
      id: "STRUCTURED-1",
      source: "user",
      group: "userAdded",
      targetStore: "dandanshu",
      productName: "结构化回传测试商品",
      productUrl: "https://www.ozon.ru/product/123/",
      purchasePriceRmb: 10,
      packagingCostRmb: 1.5,
      packedWeightKg: 0.3,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      powered: false,
      complianceStatus: "clear",
      authorizationStatus: "clear",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
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
  const response = await fetch(`${baseUrl}/api/candidates/STRUCTURED-1/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 3 })
  });
  assert.equal(response.status, 201);

  const state = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/state`)).json();
    return body.candidates[0].workflowStatus === "eliminated" && body.candidates[0].latestDispatch?.status === "completed"
      ? body
      : null;
  }, `结构化结果未落盘：${stderr.join("")}`);
  assert.equal(state.candidates[0].latestDispatch.status, "completed");
  assert.equal(state.candidates[0].codexReview.decision, "eliminated");
  assert.equal(state.candidates[0].processingStatus.actualRunning, false);
  assert.equal(state.meta.automationStarted, false);
});
