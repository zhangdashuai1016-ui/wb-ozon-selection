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

test("user create and evaluation request immediate dispatch and clear stale blockers", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-dispatch-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(
    dataFile,
    JSON.stringify({
      meta: { version: 2, title: "test", updatedAt: "2026-08-04T08:00:00.000Z", automationStarted: true },
      rules: {},
      candidates: [
        {
          id: "CODEX-1",
          source: "codex",
          group: "evergreen",
          targetStore: "dandanshu",
          productName: "待确认方向",
          productUrl: "https://www.ozon.ru/product/test-1/",
          sourceUrl: "",
          competitorUrl: "",
          purchasePriceRmb: null,
          domesticShippingRmb: 0,
          packagingCostRmb: 1.5,
          packedWeightKg: null,
          dimensionsCm: { length: null, width: null, height: null },
          powered: false,
          complianceStatus: "clear",
          authorizationStatus: "clear",
          acceptedTestRisk: false,
          createdAt: "2026-08-04T07:00:00.000Z",
          updatedAt: "2026-08-04T07:00:00.000Z",
          workflowStatus: "awaiting_user_direction",
          processing: {
            state: "idle",
            attempts: 2,
            lastError: "旧错误",
            blockReason: "旧阻塞",
            userAction: "旧动作",
            deferredUntil: "2026-08-04T09:00:00.000Z"
          },
          dataRevision: 1,
          comments: [],
          history: []
        }
      ]
    })
  );

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

  const createResponse = await fetch(`${baseUrl}/api/candidates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetStore: "miska",
      productUrl: "https://detail.1688.com/offer/123456.html"
    })
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).candidate;
  assert.equal(created.processing.dispatchState, "requested");
  assert.equal(created.processing.dispatchTrigger, "user_created");

  const createCandidate = async (suffix) => {
    const response = await fetch(`${baseUrl}/api/candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetStore: "dandanshu",
        productUrl: `https://detail.1688.com/offer/12345${suffix}.html`
      })
    });
    assert.equal(response.status, 201);
    return (await response.json()).candidate;
  };
  const created2 = await createCandidate("7");
  const created3 = await createCandidate("8");

  const evaluationResponse = await fetch(`${baseUrl}/api/candidates/CODEX-1/user-evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataRevision: 1,
      decision: "unsure",
      candidateData: {
        sourceUrl: "https://detail.1688.com/offer/654321.html",
        purchasePriceRmb: 20,
        packedWeightKg: 0.4,
        dimensionsCm: { length: 10, width: 10, height: 10 }
      }
    })
  });
  assert.equal(evaluationResponse.status, 200);
  const evaluated = (await evaluationResponse.json()).candidate;
  assert.equal(evaluated.workflowStatus, "codex_processing");
  assert.equal(evaluated.processing.dispatchState, "requested");
  assert.equal(evaluated.processing.lastError, null);
  assert.equal(evaluated.processing.blockReason, null);
  assert.equal(evaluated.processing.userAction, "");
  assert.equal(evaluated.processing.deferredUntil, null);

  const work = await (await fetch(`${baseUrl}/api/automation/work`)).json();
  assert.deepEqual(work.urgent.map((candidate) => candidate.id), [
    created.id,
    created2.id,
    created3.id,
    "CODEX-1"
  ]);
  assert.equal(work.urgent[0].processingStatus.queuePosition, 1);
  assert.equal(work.urgent[1].processingStatus.queuePosition, 2);
  assert.equal(work.summary.dispatch.concurrencyLimit, 3);

  const firstClaim = await (
    await fetch(`${baseUrl}/api/automation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "dispatch-test-1", candidateId: "CODEX-1", initialStep: "读取Ozon市场证据" })
    })
  ).json();
  assert.equal(firstClaim.candidate.id, "CODEX-1");
  assert.equal(firstClaim.candidate.processing.state, "running");
  assert.equal(firstClaim.candidate.processing.currentStep, "读取Ozon市场证据");
  assert.ok(firstClaim.candidate.processing.lastProgressAt);

  const duplicateClaim = await (
    await fetch(`${baseUrl}/api/automation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "dispatch-test-duplicate", candidateId: "CODEX-1", initialStep: "重复领取" })
    })
  ).json();
  assert.equal(duplicateClaim.candidate, null);
  assert.equal(duplicateClaim.alreadyRunning.candidateId, "CODEX-1");
  assert.equal(duplicateClaim.alreadyRunning.runId, "dispatch-test-1");

  const secondClaim = await (
    await fetch(`${baseUrl}/api/automation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "dispatch-test-2", candidateId: created.id, initialStep: "核对用户资料" })
    })
  ).json();
  assert.equal(secondClaim.candidate.id, created.id);

  const thirdClaim = await (
    await fetch(`${baseUrl}/api/automation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "dispatch-test-3", candidateId: created2.id, initialStep: "核对用户资料" })
    })
  ).json();
  assert.equal(thirdClaim.candidate.id, created2.id);

  const blockedClaim = await (
    await fetch(`${baseUrl}/api/automation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "dispatch-test-4", candidateId: created3.id, initialStep: "核对用户资料" })
    })
  ).json();
  assert.equal(blockedClaim.candidate, null);
  assert.deepEqual(blockedClaim.busy.candidateIds, ["CODEX-1", created.id, created2.id]);
  assert.equal(blockedClaim.busy.concurrencyLimit, 3);

  const attemptResponse = await fetch(`${baseUrl}/api/automation/attempt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "dispatch-test-1",
      candidateId: "CODEX-1",
      dataRevision: 2,
      evidenceLayer: "ozon_market",
      target: "https://www.ozon.ru/product/test-1/",
      path: "chrome_logged_in"
    })
  });
  assert.equal(attemptResponse.status, 200);
  const duplicateAttemptResponse = await fetch(`${baseUrl}/api/automation/attempt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "dispatch-test-1",
      candidateId: "CODEX-1",
      dataRevision: 2,
      evidenceLayer: "ozon_market",
      target: "https://www.ozon.ru/product/test-1/",
      path: "chrome_logged_in"
    })
  });
  assert.equal(duplicateAttemptResponse.status, 409);

  const progressResponse = await fetch(`${baseUrl}/api/automation/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "dispatch-test-1",
      candidateId: "CODEX-1",
      dataRevision: 2,
      progressType: "new_evidence",
      currentStep: "核对当前佣金",
      evidenceRef: "ozon-market-snapshot-1"
    })
  });
  assert.equal(progressResponse.status, 200);
  const progressed = (await progressResponse.json()).candidate;
  assert.equal(progressed.processing.currentStep, "核对当前佣金");
  assert.equal(progressed.processing.progressEvents.length, 1);

  const marketReleaseResponse = await fetch(`${baseUrl}/api/automation/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "dispatch-test-1",
      candidateId: "CODEX-1",
      dataRevision: 2,
      failureScope: "market_evidence",
      error: "Ozon公开页网络失败；登录Chrome读取超时",
      readAttempts: [
        { path: "chrome_logged_in", status: "failed", target: "ozon_market", detail: "页面读取超时" }
      ]
    })
  });
  assert.equal(marketReleaseResponse.status, 200);
  const marketReleased = (await marketReleaseResponse.json()).candidate;
  assert.equal(marketReleased.workflowStatus, "codex_processing");
  assert.equal(marketReleased.processing.state, "blocked");
  assert.equal(marketReleased.processing.manualHold, true);
  assert.equal(marketReleased.processing.runId, null);
  assert.equal(marketReleased.processing.failureScope, "market_evidence");
  assert.match(marketReleased.processing.userAction, /总控明确/);

  const staleResumeResponse = await fetch(`${baseUrl}/api/control/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateId: "CODEX-1",
      dataRevision: marketReleased.dataRevision - 1,
      recoveryPath: "按当前Ozon公开页只读恢复一次"
    })
  });
  assert.equal(staleResumeResponse.status, 409);

  const heldQueuedData = JSON.parse(await readFile(dataFile, "utf8"));
  const heldQueuedCandidate = heldQueuedData.candidates.find((candidate) => candidate.id === "CODEX-1");
  heldQueuedCandidate.processing.state = "queued";
  heldQueuedCandidate.processing.dispatchState = "normalized";
  heldQueuedCandidate.processing.manualHold = true;
  await writeFile(dataFile, JSON.stringify(heldQueuedData));

  const resumeResponse = await fetch(`${baseUrl}/api/control/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateId: "CODEX-1",
      dataRevision: marketReleased.dataRevision,
      recoveryPath: "按当前Ozon公开页只读恢复一次"
    })
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = (await resumeResponse.json()).candidate;
  assert.equal(resumed.processing.state, "queued");
  assert.equal(resumed.processing.manualHold, false);
  assert.equal(resumed.processing.dispatchTrigger, "control_resume");
  assert.equal(resumed.processing.recoveryPath, "按当前Ozon公开页只读恢复一次");
  assert.equal(resumed.dataRevision, marketReleased.dataRevision + 1);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  persisted.meta.automationStarted = false;
  await writeFile(dataFile, JSON.stringify(persisted));
  const disabledWork = await (await fetch(`${baseUrl}/api/automation/work`)).json();
  assert.equal(disabledWork.automationEnabled, false);
  assert.deepEqual(disabledWork.queued, []);
  assert.deepEqual(disabledWork.urgent, []);
  const disabledClaim = await fetch(`${baseUrl}/api/automation/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: "disabled-run",
      candidateId: created3.id,
      initialStep: "不得开始"
    })
  });
  assert.equal(disabledClaim.status, 409);
});
