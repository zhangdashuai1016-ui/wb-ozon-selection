import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { c1AiSoftwareJobFixture } from "./fixtures/c1-ai-software-job-fixture.mjs";
import { claimSoftwareJobLease, markSoftwareJobExternalRequestStarted, recordC1GatewayAcceptance,
  reconcileSoftwareJobAfterRestart, reconcileExpiredSoftwareJobLease } from "../lib/software-job-contract.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";

function fixture() {
  const f = c1AiSoftwareJobFixture();
  const claimed = claimSoftwareJobLease({ job: f.job, worker: f.worker, leaseId: "lease:synthetic:acceptance", serverTime: f.at, leaseDurationMs: 1000 });
  const waiting = markSoftwareJobExternalRequestStarted({ job: claimed, workerId: f.worker.workerId, leaseId: claimed.leaseId,
    externalRequestRef: "request:synthetic:acceptance", serverTime: f.at });
  const input = { jobId: waiting.jobId, workerId: waiting.workerId, leaseId: waiting.leaseId,
    requestFingerprint: waiting.scopeBinding.requestFingerprint, gatewayJobId: "gateway:synthetic:accepted" };
  return { ...f, claimed, waiting, input, later: new Date(Date.parse(f.at) + 2000).toISOString() };
}

test("网关接受编号只补原请求的持久引用，保留请求时间、租约和业务终态", () => {
  const f = fixture();
  const before = structuredClone(f.waiting);
  const result = recordC1GatewayAcceptance({ job: f.waiting, ...f.input, serverTime: f.later });
  assert.equal(result.changed, true);
  assert.deepEqual(result.job, { ...before, progressRef: f.input.gatewayJobId });
  assert.deepEqual(f.waiting, before);
  assert.equal(recordC1GatewayAcceptance({ job: result.job, ...f.input, serverTime: f.later }).changed, false);
  assert.throws(() => recordC1GatewayAcceptance({ job: result.job, ...f.input, gatewayJobId: "gateway:other", serverTime: f.later }), /ACCEPTANCE_CONFLICT/);
});

test("请求尚未发出、错误holder/lease/指纹、秘密和倒退时间不能保存网关编号", () => {
  const f = fixture();
  for (const patch of [{ job: f.claimed }, { workerId: "worker:other" }, { leaseId: "lease:other" },
    { requestFingerprint: "a".repeat(64) }, { gatewayJobId: f.waiting.externalRequestRef },
    { gatewayJobId: "https://example.test/?access_token=synthetic" }, { serverTime: new Date(Date.parse(f.at) - 1).toISOString() }]) {
    assert.throws(() => recordC1GatewayAcceptance({ job: f.waiting, ...f.input, serverTime: f.later, ...patch }));
  }
});

test("先发生真实恢复时仍保留原请求编号，unknown不自动变成完成或重新执行", () => {
  const f = fixture();
  for (const reconcile of [reconcileSoftwareJobAfterRestart, reconcileExpiredSoftwareJobLease]) {
    const recovered = reconcile({ job: f.waiting, serverTime: f.later });
    const result = recordC1GatewayAcceptance({ job: recovered, ...f.input, serverTime: f.later });
    assert.deepEqual(result.job, { ...recovered, progressRef: f.input.gatewayJobId });
    assert.equal(result.job.status, "unknown_outcome");
    assert.equal(result.job.automaticRetryAllowed, false);
  }
});

test("接受编号同值并发只落一次，JSON重启可追溯且来源编辑不丢原请求证据", async t => {
  const f = fixture(), directory = await mkdtemp(path.join(tmpdir(), "c1-gateway-acceptance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const source = structuredClone(f.document);
  source.runtime.softwareJobs = [f.waiting];
  source.candidates[0].dataRevision += 1;
  source.candidates[0].notes = "synthetic edit after request";
  await writeFile(filePath, JSON.stringify(source));
  const repository = createJsonBusinessStateRepository({ filePath });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: () => f.later });
  const outcomes = await Promise.all([store.recordC1GatewayAcceptance(f.input), store.recordC1GatewayAcceptance(f.input)]);
  assert.deepEqual(outcomes[0], outcomes[1]);
  const bytes = await readFile(filePath);
  assert.deepEqual(JSON.parse(bytes).candidates, source.candidates);
  const restarted = createRepositoryBackedSoftwareJobStore({ businessStateRepository: createJsonBusinessStateRepository({ filePath }), serverClock: () => f.later });
  assert.equal((await restarted.get(f.waiting.jobId)).progressRef, f.input.gatewayJobId);
  await restarted.recordC1GatewayAcceptance(f.input);
  assert.deepEqual(await readFile(filePath), bytes);
  await assert.rejects(restarted.recordC1GatewayAcceptance({ ...f.input, gatewayJobId: "gateway:other" }), /ACCEPTANCE_CONFLICT/);
  assert.deepEqual(await readFile(filePath), bytes);
});
