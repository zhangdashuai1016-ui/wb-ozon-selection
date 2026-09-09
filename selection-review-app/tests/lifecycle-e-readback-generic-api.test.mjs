import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createSoftwareExecutionRuntime, startSoftwareStep } from "../lib/software-execution-state.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createSystemEReadbackSoftwareRuntime } from "../lib/e-readback-software-use-case.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { systemEReadbackFixture } from "./helpers/e-readback-fixture.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;

async function startTestServer(t, dataFile) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000);
    let output = "";
    const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
  });
  return { child, stderr };
}

test("已应用E来源冲突在实际HTTP局部显示，重启保留历史和其他商品且零重新读取", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "e-source-conflict-api-"));
  const dataFile = path.join(directory, "state.json");
  const f = await systemEReadbackFixture();
  const repository = createMemoryBusinessStateRepository(f.document);
  const at = "2026-08-22T07:30:00.000Z";
  const actor = createActorContext({ userId: "synthetic-owner", sessionId: "synthetic-e-http",
    actorType: "human", source: "authenticated_identity_provider", roles: ["owner"], authenticatedAt: at });
  let reads = 0;
  await createSystemEReadbackSoftwareRuntime({ repository, runtimeMode: "local_development", serverClock: () => at,
    readPlatform: async () => { reads += 1; return f.observation; } }).run({ actor, input: f.input });
  const source = await repository.readSnapshot();
  source.meta = { version: 2, automationStarted: false };
  source.dispatches = [];
  source.evidencePacks = [];
  source.candidates[0].lifecycleV11.skuPackage.variantKey = "changed-variant";
  source.candidates[1].workflowStatus = "eliminated";
  await writeFile(dataFile, JSON.stringify(source));
  const bytes = await readFile(dataFile);
  for (let round = 0; round < 2; round += 1) {
    const { child, stderr } = await startTestServer(t, dataFile);
    const response = await fetch(`${base}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.candidates.length, 2);
    const target = state.candidates.find(candidate => candidate.id === f.input.candidateId);
    const other = state.candidates.find(candidate => candidate.id === f.untouched.id);
    assert.equal(target.eReadbackRuntimeView.status, "source_conflict");
    assert.equal(target.eReadbackRuntimeView.currentVerified, false);
    assert.equal(target.dESoftwareRuntimeView.status, "e_source_conflict");
    assert.equal(target.dESoftwareRuntimeView.canExecutePlatformWrite, false);
    assert.equal(target.workflowStatus, "listed");
    assert.deepEqual(target.lifecycleV11.skuPackage.readbackHistory, source.candidates[0].lifecycleV11.skuPackage.readbackHistory);
    assert.equal(other.notes, f.untouched.notes);
    assert.equal(other.dataRevision, f.untouched.dataRevision);
    assert.deepEqual(await readFile(dataFile), bytes);
    assert.equal(stderr.join(""), "");
    await stopApiProcess(child);
  }
  assert.equal(reads, 1);
});

test("未接正式身份和可信E读取时拒绝伪造生产确认，历史数据保持逐字节不变", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "production-boundary-api-"));
  const dataFile = path.join(directory, "state.json");
  const source = { meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [{ id: "synthetic-history", dataRevision: 7, productName: "Historical product", targetStore: "dandanshu",
      workflowStatus: "codex_processing", processing: { state: "running", runId: "historical-job", startedAt: "2026-08-01T00:00:00.000Z", lastProgressAt: "2026-08-01T00:00:00.000Z" },
      executionRuntime: startSoftwareStep(createSoftwareExecutionRuntime({ candidateId: "synthetic-history", dataRevision: 7, at: "2026-08-01T00:00:00.000Z" }),
        { stepId: "HISTORICAL_STEP", inputRevision: 7, at: "2026-08-01T00:00:00.000Z" }) }],
    dispatches: [{ id: "old-dispatch", candidateId: "synthetic-history", dataRevision: 7, workflowStatusAtDispatch: "codex_processing", status: "running", runId: "historical-job" }], evidencePacks: [] };
  await writeFile(dataFile, JSON.stringify(source));
  const bytes = await readFile(dataFile);
  const { stderr } = await startTestServer(t, dataFile);
  async function post(suffix, input) {
    const response = await fetch(`${base}/api/candidates/synthetic-history/lifecycle/${suffix}`, { method: "POST",
      headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "x-session-id": "pretend-owner" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  }
  const reference = { dataRevision: 7, cardId: "card:synthetic", cardRevision: 2, decisionId: "decision:synthetic", ownerDecisionFingerprint: "a".repeat(64) };
  const oldAuthorization = await post("production-authorization", reference);
  assert.equal(oldAuthorization.status, 409);
  assert.equal(oldAuthorization.body.code, "production_authorization_reconfirmation_required");
  const singleOwnerInput = { contractVersion: "production-authorization-v1.2", dataRevision: 7, skuRevision: 1,
    cardId: "card:synthetic", cardRevision: 1, sourcePreparationFingerprint: "a".repeat(64), sourceFinalCardInputFingerprint: "b".repeat(64),
    bindingId: "synthetic-warehouse", configurationVersion: "synthetic-v1", merchantSku: "SYNTHETIC-MERCHANT", confirmExactScope: true };
  const forged = await post("production-authorization", { ...singleOwnerInput, ownerConfirmation: { actorId: "owner" } });
  assert.equal(forged.status, 400);
  const arbitraryPrice = await post("production-owner-decision", { ...singleOwnerInput, platformWritePrice: { amount: 1, currency: "CNY" } });
  assert.equal(arbitraryPrice.status, 400);
  const authorization = await post("production-authorization", singleOwnerInput);
  assert.equal(authorization.status, 503);
  assert.equal(authorization.body.code, "production_identity_unavailable");
  const oldOwner = await post("production-owner-decision", { dataRevision: 7, skuRevision: 1, cardId: "card:synthetic", cardRevision: 1,
    sourcePreparationFingerprint: "a".repeat(64), sourceFinalCardInputFingerprint: "b".repeat(64), commercialDecision: {} });
  assert.equal(oldOwner.status, 409);
  assert.equal(oldOwner.body.code, "production_authorization_reconfirmation_required");
  const owner = await post("production-owner-decision", singleOwnerInput);
  assert.equal(owner.status, 503);
  assert.equal(owner.body.platformWrites, 0);
  const preparation = await fetch(`${base}/api/candidates/synthetic-history/lifecycle/production-owner-preparation`);
  assert.equal(preparation.status, 200);
  const unavailablePreparation = await preparation.json();
  assert.equal(unavailablePreparation.ready, false);
  assert.deepEqual(unavailablePreparation.executionBindings, []);
  assert.equal(unavailablePreparation.scope, null);
  assert.ok(unavailablePreparation.gaps.some(gap => gap.code === "PRODUCTION_BINDING_NOT_CONFIGURED"));
  assert.deepEqual(await readFile(dataFile), bytes);
  const fakeObservation = await post("e-readback", { dataRevision: 7, path: "system_created", sourceRecordId: "record:synthetic",
    verifiedObservation: { saleStatus: "on_sale" } });
  assert.equal(fakeObservation.status, 400);
  const readback = await post("e-readback", { dataRevision: 7, path: "system_created", sourceRecordId: "record:synthetic" });
  assert.equal(readback.status, 503);
  assert.equal(readback.body.code, "trusted_e_readback_runtime_unavailable");
  for (const route of ["/api/dispatches/old-dispatch/progress", "/api/automation/progress"]) {
    const progress = await fetch(`${base}${route}`, { method: "POST",
      headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: "synthetic-history", dataRevision: 7, runId: "historical-job",
        progressType: "new_evidence", currentStep: "Pretend new progress", evidenceRef: "evidence:pretend" }) });
    assert.equal(progress.status, 403);
    assert.equal((await progress.json()).code, "trusted_progress_required");
  }
  for (const [route, payload] of [
    ["/api/dispatches/old-dispatch/complete", { runId: "historical-job", status: "completed", reply: "Pretend completion", evidence: "evidence:pretend" }],
    ["/api/dispatches/old-dispatch/complete", { runId: "historical-job", status: "completed", reply: "Pretend completion", structuredResultApplied: true }],
    ["/api/automation/release", { candidateId: "synthetic-history", dataRevision: 7, runId: "historical-job", error: "Pretend failure", readAttempts: 1 }]
  ]) {
    const completion = await fetch(`${base}${route}`, { method: "POST",
      headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(completion.status, 403);
    assert.equal((await completion.json()).code, "trusted_completion_required");
    assert.deepEqual(await readFile(dataFile), bytes);
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.runtimeArchitecture.currentUser.authenticated, false);
  assert.equal(state.runtimeArchitecture.currentUser.canSaveProductionOwnerDecision, false);
  assert.equal(state.runtimeArchitecture.currentUser.canAuthorizeProduction, false);
  assert.equal(state.candidates[0].activeDispatch, null);
  assert.equal(state.candidates[0].currentSourceCapture, null);
  assert.equal(state.candidates[0].latestDispatch.id, "old-dispatch");
  assert.equal(state.candidates[0].processingStatus.actualRunning, false);
  assert.equal(state.candidates[0].processingStatus.key, "historical_unconfirmed");
  assert.equal(state.candidates[0].executionRuntimeView.historicalExecution, true);
  assert.equal(state.candidates[0].executionRuntimeView.currentExecutionConfirmed, false);
  assert.equal(state.summary.dispatch.processingCounts.actualRunning, 0);
  assert.equal(state.summary.dispatch.processingCounts.historicalPending, 1);
  assert.deepEqual(await readFile(dataFile), bytes);
  const edited = await fetch(`${base}/api/candidates/synthetic-history`, { method: "PATCH",
    headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 7, notes: "Owner added a note" }) });
  assert.equal(edited.status, 200);
  const updated = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(updated.candidates[0].notes, "Owner added a note");
  assert.deepEqual(updated.candidates[0].processing, source.candidates[0].processing);
  assert.deepEqual(updated.dispatches, source.dispatches);
  assert.equal(updated.meta.automationStarted, false);
  assert.equal(stderr.join(""), "");
});
