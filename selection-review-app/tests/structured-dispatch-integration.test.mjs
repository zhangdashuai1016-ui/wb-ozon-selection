import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.resolve(appDir, "..");
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

for (const scenario of ["structured", "text", "narrative", "late"]) {
test(`current protocol completion remains scoped: ${scenario}`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-structured-result-"));
  const dataFile = path.join(directory, "candidates.json");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const fakeCodexRunner = path.join(directory, "fake-codex");
  const releaseFile = path.join(directory, "release-result");
  const structured = scenario === "narrative" ? "任务已完成，有一段证据文字" : JSON.stringify({
    status: "completed",
    reply: "当前SKU已按证据淘汰",
    resultType: scenario === "text" ? "none" : "selection_review",
    resultJson: scenario === "text" ? "" : JSON.stringify({ decision: "eliminated", reason: "测试证据明确不满足利润门" }),
    evidenceSummary: "结构化审核结果"
  });
  await writeFile(fakeCodex, `#!${process.execPath}
import { existsSync } from "node:fs";
let buffer = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id && message.method === "initialize") send({ id: message.id, result: {} });
      else if (message.id && message.method === "thread/read") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品", cwd: ${JSON.stringify(projectDir)}, status: { type: "idle" } } } });
      else if (message.id && message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId, name: "选品" } } });
      else if (message.id && message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-structured-001", status: "inProgress", items: [] } } });
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(releaseFile)})) return;
          clearInterval(timer);
          send({ method: "item/completed", params: { turnId: "turn-structured-001", item: { type: "agentMessage", text: ${JSON.stringify(structured)} } } });
          send({ method: "turn/completed", params: { turn: { id: "turn-structured-001", status: "completed", error: null } } });
        }, 10);
      } else if (message.id) send({ id: message.id, error: { code: -32601, message: "Unsupported test protocol method" } });
    }
    at = buffer.indexOf("\\n");
  }
});
`);
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
      executionRuntime: {
        schemaVersion: "software-execution-runtime-v1",
        candidateId: "STRUCTURED-1",
        dataRevision: 3,
        businessPhase: "A",
        executorType: "software",
        status: "blocked",
        stepId: "MAINTENANCE_REQUIRED",
        inputRevision: 3,
        outputRevision: null,
        inferenceJobId: null,
        inferenceReceiptId: null,
        technicalFailure: null,
        codexWakeupCount: 0,
        updatedAt: "2026-08-11T00:00:00.000Z",
        history: [],
        exceptionCase: {
          schemaVersion: "exception-case-v2", exceptionId: "exc-structured-1", candidateId: "STRUCTURED-1",
          skuPackageId: null, sourceRevision: 3, businessPhase: "A", softwareJobId: null,
          stepId: "MAINTENANCE_REQUIRED", lastSuccessfulStepId: null, businessStateChanged: false,
          reasonCode: "system_failure", failureLayer: "test", evidenceRefs: [], externalRequestRefs: [],
          unknownOutcome: false, automaticRetryAllowed: false,
          forbiddenAutomaticActions: ["retry", "change_model", "change_path", "advance_business_stage"],
          safeMessageKey: "exception.system_failure", message: "测试技术维护案件。",
          dispatchState: "queued", maintenanceAuthorizationId: "maintenance:structured-1", turnId: null,
          status: "open", openedAt: "2026-08-11T00:00:00.000Z", authorizedAt: "2026-08-11T00:00:00.000Z", resolvedAt: null
        }
      },
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
    headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 3 })
  });
  assert.equal(response.status, 201);

  await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/state`)).json();
    return body.candidates[0].activeDispatch?.runId === "turn-structured-001" ? body : null;
  }, `真实任务没有取得当前运行证明：${stderr.join("")}`);
  let candidateBeforeLateResult = null;
  if (scenario === "late") {
    const edited = await fetch(`${baseUrl}/api/candidates/STRUCTURED-1`, { method: "PATCH",
      headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ dataRevision: 3, notes: "主人已更新资料，旧结果不能覆盖" }) });
    assert.equal(edited.status, 200);
    candidateBeforeLateResult = JSON.parse(await readFile(dataFile, "utf8")).candidates[0];
    assert.equal(candidateBeforeLateResult.dataRevision, 4);
  }
  await writeFile(releaseFile, "release");
  const state = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/state`)).json();
    return body.candidates[0].latestDispatch?.turnCompletedAt ? body : null;
  }, `协议结果未收口：${stderr.join("")}`);
  const finalCandidate = state.candidates[0];
  if (scenario === "structured") {
    assert.equal(finalCandidate.latestDispatch.status, "completed");
    assert.equal(finalCandidate.workflowStatus, "eliminated");
    assert.equal(finalCandidate.codexReview.decision, "eliminated");
  } else if (scenario === "late") {
    assert.equal(finalCandidate.latestDispatch.status, "failed");
    assert.deepEqual(JSON.parse(await readFile(dataFile, "utf8")).candidates[0], candidateBeforeLateResult);
  } else {
    assert.equal(finalCandidate.latestDispatch.status, "responded_unverified");
    assert.equal(finalCandidate.workflowStatus, "codex_processing");
    assert.equal(finalCandidate.processing.state, "blocked");
    assert.equal(Object.hasOwn(finalCandidate, "codexReview"), false);
  }
  assert.equal(finalCandidate.processingStatus.actualRunning, false);
  assert.equal(state.meta.automationStarted, false);
  assert.equal(stderr.join(""), "");
});
}
