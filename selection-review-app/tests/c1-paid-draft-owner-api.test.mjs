import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createC1PaidFormalFixture, c1DraftPaidReceipt } from "./fixtures/c1-draft-source-fixture.mjs";
import { buildC1PaidDraftInput } from "../src/c1PaidDraftInput.js";
import { buildC1SavedDraftContinuationInput } from "../src/c1PaidDraftInput.js";
import { createC1DraftSoftwareUseCase } from "../lib/c1-draft-software-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
for (const value of [port, gatewayPort]) if (!Number.isSafeInteger(value) || value < 1 || [4317, 4318, 4173].includes(value)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;

test("认证主人一次许可经真实本地HTTP保存、执行和回读；重复提交与重启不再外呼", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "c1-paid-owner-api-"));
  await mkdir(path.join(dir, "private"), { mode: 0o700 }); await mkdir(path.join(dir, "business"));
  const dataFile = path.join(dir, "business/state.json");
  const at = new Date().toISOString();
  const { candidate, request } = createC1PaidFormalFixture({ candidateId: "SYNTHETIC-C1-PAID-API", at });
  candidate.workflowStatus = "listing_preparation";
  const state = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate], dispatches: [], evidencePacks: [],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } };
  // Produce the crash-window fixture through the real admission transaction:
  // permission/job committed, no worker claimed and no request sent.
  const recovery = createC1PaidFormalFixture({ candidateId: "SYNTHETIC-C1-QUEUED-API", at });
  recovery.candidate.workflowStatus = "listing_preparation"; state.candidates.push(recovery.candidate);
  const fixtureRepository = createMemoryBusinessStateRepository(state);
  const fixtureRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => at });
  fixtureRegistry.register({ workerId: "worker:synthetic:owner-api", version: "1", capabilities: ["ai-draft-gateway"], observedAt: at });
  const fixtureUseCase = createC1DraftSoftwareUseCase({ repository: fixtureRepository, runtimeMode: "local_development", serverClock: () => at,
    workerRegistry: fixtureRegistry, executionBinding: { provider: recovery.request.provider, modelVersion: `gpt-5.6-${recovery.request.provider}`,
      credentialAlias: "gateway-alias:synthetic:owner-api", allowedWorkerIds: ["worker:synthetic:owner-api"] }, requestGateway: null });
  await fixtureUseCase.authorizeAndEnqueue({ actor: createActorContext({ userId: "owner:synthetic:prior", sessionId: "session:synthetic:prior",
    actorType: "human", roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: at }),
  input: { candidateId: recovery.candidate.id, expectedRevision: recovery.candidate.dataRevision, requestRef: recovery.request.requestId,
    requestFingerprint: recovery.request.requestFingerprint, confirmPaidCall: true, expiresAt: null,
    idempotencyKey: "synthetic:queued:permit", auditEventId: "synthetic:queued:permit-audit" } });
  await writeFile(dataFile, JSON.stringify(await fixtureRepository.readSnapshot()));
  const initialBytes = await readFile(dataFile);
  let providerCalls = 0, gatewayJob, gatewayFailure;
  const gateway = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/v1/inference-jobs") {
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        providerCalls += 1;
        assert.equal(Object.hasOwn(input, "paymentAuthorization"), false);
        const persisted = JSON.parse(await readFile(dataFile, "utf8"));
        const job = persisted.runtime.softwareJobs.find(value => value.jobId === input.sourceBinding.softwareJobId);
        const savedRequest = persisted.candidates.find(value => value.id === input.candidateId).lifecycleV11.c1AiDraftRequestV1;
        assert.equal(input.sourceBinding.requestFingerprint, savedRequest.requestFingerprint);
        assert.equal(job.externalRequestState, "in_flight");
        assert.equal(persisted.runtime.softwareJobAuthorizationRecords.find(value => value.authorizationId === job.scopeBinding.authorizationRef).useCount, 1);
        const responseAt = new Date().toISOString();
        const output = c1DraftPaidReceipt({ request: savedRequest, authorizedExecution: { jobId: job.jobId } }, at).output;
        gatewayJob = { jobId: `gateway:synthetic:${input.candidateId}`, sourceBinding: input.sourceBinding,
          candidateId: input.candidateId, skuPackageId: input.skuPackageId, dataRevision: input.dataRevision,
          businessPhase: "C1", taskType: input.taskType, model: input.model, status: "completed", attempt: 1,
          startedAt: responseAt, completedAt: responseAt, receipt: { receiptVersion: "inference-receipt-v1", providerRequestId: "provider:synthetic:owner-api",
            requestHash: "a".repeat(64), requestedAt: responseAt, completedAt: responseAt, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            validation: { schemaValid: true, strictJson: true }, output } };
        res.writeHead(202); return res.end(JSON.stringify({ jobId: gatewayJob.jobId, status: "queued", sourceBinding: input.sourceBinding }));
      }
      assert.equal(req.method, "GET"); assert.equal(req.url, `/v1/inference-jobs/${encodeURIComponent(gatewayJob.jobId)}`);
      const saved = JSON.parse(await readFile(dataFile, "utf8"));
      assert.equal(saved.runtime.softwareJobs.find(value => value.jobId === gatewayJob.sourceBinding.softwareJobId).progressRef, gatewayJob.jobId);
      res.end(JSON.stringify(gatewayJob));
    } catch (error) { gatewayFailure = error; res.writeHead(500); res.end(JSON.stringify({ code: "SYNTHETIC_GATEWAY_ASSERTION_FAILED" })); }
  });
  await new Promise(resolve => gateway.listen(gatewayPort, "127.0.0.1", resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  let child; const stderr = [];
  async function start() {
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir,
      env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
        SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(dir, "private/owner.json"),
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([{ schemaVersion: "c1-draft-service-binding-v1",
          provider: request.provider, modelVersion: `gpt-5.6-${request.provider}`, credentialAlias: "gateway-alias:synthetic:owner-api",
          workerId: "worker:synthetic:owner-api", workerVersion: "1", gatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
          configurationVersion: "synthetic:owner-api:1", leaseDurationMs: 90000 }]) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000); let output = "";
      const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("")}`));
      function done(error) { clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit); if (error) reject(error); else resolve(); }
      child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
    });
  }
  t.after(async () => { if (child) await stopApiProcess(child); });
  await start(); let cookie = "";
  async function post(route, body, origin = base) {
    const res = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
  }
  async function readState() { const res = await fetch(`${base}/api/state`, { headers: cookie ? { Cookie: cookie } : {} }); assert.equal(res.status, 200); return res.json(); }
  const route = `/api/candidates/${candidate.id}/lifecycle/c1/paid-draft/authorize`;
  assert.equal((await post(route, { candidateId: candidate.id }, "https://untrusted.invalid")).status, 403);
  assert.deepEqual(await readFile(dataFile), initialBytes); assert.equal(providerCalls, 0);
  assert.equal((await post(route, { candidateId: candidate.id })).status, 401);
  assert.deepEqual(await readFile(dataFile), initialBytes); assert.equal(providerCalls, 0);
  const password = "synthetic c1 paid test password";
  const setup = await post("/api/owner-access/setup", { password }); assert.equal(setup.status, 200); cookie = setup.cookie.split(";")[0];
  const view = await readState(); assert.equal(view.runtimeArchitecture.currentUser.canAuthorizeC1PaidCall, true);
  const input = buildC1PaidDraftInput({ candidate: view.candidates[0], confirmed: true, sourceRevision: candidate.dataRevision });
  for (const patch of [{ confirmPaidCall: false }, { maximumAmountMinor: 1 }, { requestRef: "request:another" }]) {
    assert.ok([400, 409].includes((await post(route, { ...input, ...patch })).status));
    assert.deepEqual(await readFile(dataFile), initialBytes); assert.equal(providerCalls, 0);
  }
  const done = await post(route, input); assert.equal(done.status, 200, JSON.stringify(done.body) + stderr.join("").replaceAll(password, "[REDACTED]").replaceAll(cookie, "[REDACTED]"));
  assert.equal(gatewayFailure, undefined); assert.equal(done.body.executionStatus, "applied"); assert.equal(providerCalls, 1);
  const saved = await readState(); assert.equal(saved.candidates[0].lifecycleV11.skuPackage.businessPhase, "C2");
  assert.equal(saved.candidates[0].c1DraftRuntimeView.accounting.usage.total_tokens, 10);
  const savedBytes = await readFile(dataFile);
  assert.equal((await post(route, input)).body.authorizationStatus, "idempotent_replay");
  assert.deepEqual(await readFile(dataFile), savedBytes); assert.equal(providerCalls, 1);
  await stopApiProcess(child); await start();
  assert.deepEqual(await readFile(dataFile), savedBytes); assert.equal(providerCalls, 1);
  const login = await post("/api/owner-access/login", { password }); assert.equal(login.status, 200); cookie = login.cookie.split(";")[0];
  assert.equal((await post(route, input)).body.executionStatus, "idempotent_replay");
  assert.deepEqual(await readFile(dataFile), savedBytes); assert.equal(providerCalls, 1);
  const recoveryState = await readState();
  const queuedView = recoveryState.candidates.find(value => value.id === recovery.candidate.id);
  assert.equal(queuedView.c1DraftRuntimeView.status, "queued"); assert.equal(queuedView.c1DraftRuntimeView.canContinueSaved, true);
  const continuationInput = buildC1SavedDraftContinuationInput({ candidate: queuedView, sourceRevision: queuedView.dataRevision });
  const continuationRoute = `/api/candidates/${queuedView.id}/lifecycle/c1/paid-draft/continue-saved`;
  const beforeContinue = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal((await post(continuationRoute, { ...continuationInput, confirmPaidCall: true })).status, 400);
  assert.equal((await post(continuationRoute, { ...continuationInput, jobId: "job:unrelated" })).status, 409);
  assert.deepEqual(JSON.parse(await readFile(dataFile, "utf8")), beforeContinue); assert.equal(providerCalls, 1);
  const continued = await post(continuationRoute, continuationInput);
  assert.equal(continued.status, 200, JSON.stringify(continued.body)); assert.equal(continued.body.executionStatus, "applied");
  assert.equal(providerCalls, 2);
  const afterContinue = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(afterContinue.runtime.softwareJobs.length, beforeContinue.runtime.softwareJobs.length);
  assert.equal(afterContinue.runtime.softwareJobAuthorizationRecords.length, beforeContinue.runtime.softwareJobAuthorizationRecords.length);
  assert.equal((await post(continuationRoute, continuationInput)).status, 409); assert.equal(providerCalls, 2);
  assert.equal(stderr.join(""), "");
});
