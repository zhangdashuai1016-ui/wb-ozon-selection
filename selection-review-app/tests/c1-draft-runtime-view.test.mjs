import test from "node:test";
import assert from "node:assert/strict";
import { buildC1DraftRuntimeView } from "../lib/c1-draft-runtime-view.mjs";
import { buildC1PaidDraftInput, buildC1KeywordHandoffRetryInput } from "../src/c1PaidDraftInput.js";
import { createC1KeywordHandoffRetryFixture, keywordHandoffDraftBinding } from "./fixtures/c1-keyword-handoff-retry-fixture.mjs";
import { createC1PaidFormalFixture } from "./fixtures/c1-draft-source-fixture.mjs";
import { prepareC1DraftSoftwareExecution } from "../lib/c1-draft-software-use-case.mjs";
import { createSoftwareJobEnvelope } from "../lib/software-job-contract.mjs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

function fixture() {
  const { candidate, request, executionBinding, at } = createC1PaidFormalFixture();
  const serviceBindings = [{ provider: request.provider, modelVersion: `gpt-5.6-${request.provider}`,
    credentialAlias: executionBinding.credentialAlias, configurationVersion: "synthetic:1" }];
  return { candidate, request, serviceBindings, observedAt: at, runtime: { softwareJobs: [] } };
}

function queuedFixture() {
  const f = fixture();
  const prepared = prepareC1DraftSoftwareExecution({ candidate: f.candidate, request: f.request,
    expectedRevision: f.candidate.dataRevision, authorizationRef: "authorization:c1-ai-draft:RUNTIME-VIEW",
    credentialAlias: f.serviceBindings[0].credentialAlias, jobId: "job:runtime-view", ownerUserId: "owner:runtime-view",
    requestedByUserId: "owner:runtime-view", idempotencyKey: "enqueue:runtime-view" });
  const job = createSoftwareJobEnvelope({ ...prepared.jobInput, createdAt: f.observedAt });
  f.candidate.dataRevision = job.revision;
  f.candidate.lifecycleV11.c1AiDraftJobRefV1 = structuredClone(prepared.jobRef);
  f.runtime.softwareJobs.push(structuredClone(job));
  return f;
}

test("一次许可只引用保存请求；配置缺失、旧修订及未确认均拒绝", () => {
  const f = fixture();
  const original = structuredClone(f);
  const view = buildC1DraftRuntimeView(f);
  assert.equal(view.status, "awaiting_paid_confirmation");
  f.candidate.c1DraftRuntimeView = view;
  const input = buildC1PaidDraftInput({ candidate: f.candidate, confirmed: true, sourceRevision: f.candidate.dataRevision });
  assert.equal(input.requestRef, f.request.requestId);
  assert.equal(input.requestFingerprint, f.request.requestFingerprint);
  assert.equal(input.expiresAt, null);
  assert.deepEqual(Object.keys(input).sort(), ["candidateId", "expectedRevision", "requestRef", "requestFingerprint", "confirmPaidCall", "expiresAt", "idempotencyKey", "auditEventId"].sort());
  assert.throws(() => buildC1PaidDraftInput({ candidate: f.candidate, confirmed: false, sourceRevision: f.candidate.dataRevision }));
  assert.throws(() => buildC1PaidDraftInput({ candidate: f.candidate, confirmed: true, sourceRevision: f.candidate.dataRevision - 1 }));
  delete f.candidate.c1DraftRuntimeView;
  assert.deepEqual(f, original);
  const missing = buildC1DraftRuntimeView({ ...f, serviceBindings: [] });
  assert.equal(missing.status, "configuration_required"); assert.equal(missing.canAuthorize, false);
  const drift = structuredClone(f); drift.candidate.lifecycleV11.skuPackage.dataRevision += 1;
  assert.equal(buildC1DraftRuntimeView(drift).status, "source_conflict");
});

test("失败和未知保留实际耗用，不显示可重新许可；作业缺失不视为未调用", () => {
  const f = fixture();
  const revision = f.candidate.dataRevision;
  const ref = { jobId: "job:synthetic", resultRevision: revision, inputFingerprint: f.request.requestFingerprint };
  f.candidate.lifecycleV11.c1AiDraftJobRefV1 = ref;
  assert.equal(buildC1DraftRuntimeView(f).status, "source_conflict");
  const accounting = { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, charge: { status: "unknown" } };
  const job = { jobId: ref.jobId, candidateId: f.candidate.id, skuPackageId: f.request.identity.skuPackageId,
    jobType: "c1_ai_draft", revision, scopeBinding: { requestFingerprint: f.request.requestFingerprint },
    status: "failed", externalRequestState: "succeeded", resultEnvelope: { applicationDisposition: "not_applied", payload: { accounting } } };
  f.runtime.softwareJobs.push(job);
  const view = buildC1DraftRuntimeView(f);
  assert.equal(view.status, "failed"); assert.equal(view.externalRequestState, "succeeded");
  assert.equal(view.canAuthorize, false); assert.equal(view.automaticRetryAllowed, false);
  assert.deepEqual(view.accounting, accounting); view.accounting.usage.total_tokens = 0;
  assert.equal(accounting.usage.total_tokens, 10);
  job.status = "unknown_outcome"; job.externalRequestState = "unknown_outcome";
  assert.equal(buildC1DraftRuntimeView(f).status, "unknown_outcome");
});

test("保存请求的K3到期、缺失或权益到期后不可许可，且不改写持久事实", () => {
  for (const [change, reason] of [
    [f => { f.observedAt = f.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1.validity.expiresAt; }, "C1_DRAFT_EVIDENCE_NOT_CURRENT"],
    [f => { delete f.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1; }, "C1_DRAFT_EVIDENCE_REQUIRED"],
    [f => { f.observedAt = f.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt; }, "C1_SKU_RIGHTS_REVIEW_EXPIRED"]
  ]) {
    const f = fixture(); change(f);
    const before = structuredClone(f);
    const view = buildC1DraftRuntimeView(f);
    assert.equal(view.canAuthorize, false, reason);
    assert.equal(view.canContinueSaved, false, reason);
    assert.equal(view.sourceBlockReason, reason);
    assert.equal(view.status, "source_conflict");
    assert.ok(view.message);
    assert.deepEqual(f, before);
  }
});

test("queued只在当前来源、修订及原服务配置匹配时允许继续；状态不被配置投影覆盖", () => {
  const f = queuedFixture();
  const job = f.runtime.softwareJobs[0];
  const ready = buildC1DraftRuntimeView(f);
  assert.equal(ready.status, "queued");
  assert.equal(ready.canAuthorize, false);
  assert.equal(ready.canContinueSaved, true);
  assert.equal(ready.jobRevision, job.revision);
  assert.equal(ready.configurationBlockReason, null);
  for (const [bindings, reason] of [
    [[], "C1_DRAFT_RUNTIME_NOT_CONFIGURED"],
    [[{ ...f.serviceBindings[0], provider: "sol", modelVersion: "gpt-5.6-sol" }], "C1_DRAFT_RUNTIME_NOT_CONFIGURED"],
    [[{ ...f.serviceBindings[0], modelVersion: "gpt-5.6-sol" }], "C1_DRAFT_RUNTIME_NOT_CONFIGURED"],
    [[{ ...f.serviceBindings[0], credentialAlias: "gateway-alias:other" }], "C1_DRAFT_SERVICE_BINDING_CONFLICT"]
  ]) {
    const view = buildC1DraftRuntimeView({ ...f, serviceBindings: bindings });
    assert.equal(view.status, "queued");
    assert.equal(view.externalRequestState, "not_sent");
    assert.equal(view.canContinueSaved, false);
    assert.equal(view.configurationBlockReason, reason);
    assert.match(view.message, /配置/);
  }
  for (const change of [
    x => { x.candidate.dataRevision += 1; },
    x => { x.observedAt = x.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1.validity.expiresAt; },
    x => { x.observedAt = x.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt; },
    x => { x.candidate.lifecycleV11.c1AiDraftRequestV1 = null; },
    x => { x.candidate.lifecycleV11.c1AiDraftJobRefV1.inputFingerprint = "0".repeat(64); }
  ]) {
    const blocked = structuredClone(f); change(blocked);
    assert.equal(buildC1DraftRuntimeView(blocked).canContinueSaved, false);
  }
});

test("已领取、发出、失败、未知或非首次queued均不可继续，不以再次许可覆盖原任务", () => {
  for (const state of [
    { status: "claimed", attempt: 1, externalRequestState: "not_sent" },
    { status: "waiting_platform", attempt: 1, externalRequestState: "in_flight" },
    { status: "failed", attempt: 1, externalRequestState: "failed" },
    { status: "unknown_outcome", attempt: 1, externalRequestState: "unknown_outcome" },
    { status: "queued", attempt: 1, externalRequestState: "not_sent" },
    { status: "queued", attempt: 0, externalRequestState: "in_flight" }
  ]) {
    const f = queuedFixture(); Object.assign(f.runtime.softwareJobs[0], state);
    const view = buildC1DraftRuntimeView(f);
    assert.equal(view.status, state.status);
    assert.equal(view.canContinueSaved, false);
    assert.equal(view.canAuthorize, false);
  }
});

test("完整已保存成功回执只应用：不重查当前K3、权益和服务别名，仍拒绝旧revision及已应用", () => {
  const f = queuedFixture();
  const job = f.runtime.softwareJobs[0];
  Object.assign(job, { status: "completed", attempt: 1, externalRequestState: "succeeded",
    resultEnvelope: { applicationDisposition: "result_recorded_no_candidate_mutation", payloadFingerprint: "a".repeat(64),
      payload: { receipt: { accounting: { usage: "unknown", charge: { status: "unknown" } } } } } });
  f.serviceBindings[0].credentialAlias = "gateway-alias:replacement";
  f.observedAt = "2099-01-01T00:00:00.000Z";
  delete f.candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1;
  const view = buildC1DraftRuntimeView(f);
  assert.equal(view.canContinueSaved, true);
  assert.equal(view.canAuthorize, false);
  assert.equal(view.configurationBlockReason, null);
  assert.equal(view.sourceBlockReason, null);
  assert.equal(view.accounting.usage, "unknown");
  const unconfigured = buildC1DraftRuntimeView({ ...f, serviceBindings: [] });
  assert.equal(unconfigured.status, "completed");
  assert.equal(unconfigured.canContinueSaved, false);
  assert.equal(unconfigured.configurationBlockReason, "C1_DRAFT_RUNTIME_NOT_CONFIGURED");
  assert.equal(unconfigured.accounting.usage, "unknown");
  for (const change of [
    x => { x.candidate.dataRevision += 1; },
    x => { x.runtime.softwareJobs[0].resultEnvelope.applicationDisposition = "applied"; },
    x => { x.runtime.softwareJobs[0].resultEnvelope = null; },
    x => { x.runtime.softwareJobs[0].externalRequestState = "unknown_outcome"; }
  ]) {
    const blocked = structuredClone(f); change(blocked);
    assert.equal(buildC1DraftRuntimeView(blocked).canContinueSaved, false);
  }
});

test("非法当前时钟及未知程序异常不得包装成等待证据", () => {
  const invalidClock = fixture(); invalidClock.observedAt = "invalid";
  assert.throws(() => buildC1DraftRuntimeView(invalidClock), /TIME_INVALID/);
  for (const error of [new Error("unexpected evidence getter"), new TypeError("C1_DRAFT_EVIDENCE_REQUIRED")]) {
    const f = fixture();
    Object.defineProperty(f.candidate.lifecycleV11, "c1SoftwareEvidenceV1", { get() { throw error; } });
    assert.throws(() => buildC1DraftRuntimeView(f), observed => observed === error);
  }
});

test("已知交接配置修复后只提供本地准备动作，当前证据与失败身份必须一致", async () => {
  const f = await createC1KeywordHandoffRetryFixture();
  const candidate = f.document.candidates[0];
  const original = structuredClone(f.document);
  const input = { candidate, runtime: f.document.runtime, serviceBindings: [keywordHandoffDraftBinding], observedAt: f.clock() };
  const view = buildC1DraftRuntimeView(input);
  assert.equal(view.canRetryKeywordHandoff, true);
  assert.equal(view.canAuthorize, false);
  assert.equal(view.canContinueSaved, false);
  assert.equal(view.keywordJobId, f.job.jobId);
  assert.deepEqual(f.document, original);
  const client = { ...candidate, c1DraftRuntimeView: view };
  const request = buildC1KeywordHandoffRetryInput({ candidate: client, sourceRevision: candidate.dataRevision });
  assert.equal(request.failureId, f.input.failureId);
  assert.deepEqual(Object.keys(request).sort(), ["candidateId", "expectedRevision", "keywordJobId", "failureId", "idempotencyKey", "auditEventId"].sort());
  assert.throws(() => buildC1KeywordHandoffRetryInput({ candidate: client, sourceRevision: candidate.dataRevision - 1 }));
  assert.equal(buildC1DraftRuntimeView({ ...input, serviceBindings: [] }).canRetryKeywordHandoff, false);
  for (const change of [
    value => { value.candidate.dataRevision += 1; },
    value => { value.candidate.executionRuntime.technicalFailure.sourceRevision += 1; },
    value => { value.candidate.executionRuntime.technicalFailure.evidenceRefs = ["unrelated:evidence"]; },
    value => { value.runtime.softwareJobs[0].status = "unknown_outcome"; }
  ]) {
    const invalid = structuredClone(input); change(invalid);
    const blocked = buildC1DraftRuntimeView(invalid);
    assert.equal(blocked.canRetryKeywordHandoff, false);
    assert.ok(blocked.sourceBlockReason);
  }
});

test("实际表单默认不勾选且按钮禁用，失败显示用量而没有再次许可入口", async () => {
  const entry = fileURLToPath(new URL("./c1-paid-form-test-entry.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/C1PaidDraftPanel.jsx", import.meta.url));
  const built = await build({ configFile: false, logLevel: "warn", plugins: [react(), {
    name: "c1-paid-form-test", resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from "react"; import {renderToStaticMarkup} from "react-dom/server";
      import Panel from ${JSON.stringify(component)};
      export const render = candidate => renderToStaticMarkup(<Panel candidate={candidate} identity={{canAuthorizeC1PaidCall:true}}
        onAuthorize={()=>{throw new Error("render performed write")}} onContinueSaved={()=>{throw new Error("render continued job")}}
        onRetryKeywordHandoff={()=>{throw new Error("render retried handoff")}}/>);` : null
  }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const output = built.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
  const f = fixture(); f.candidate.c1DraftRuntimeView = buildC1DraftRuntimeView(f);
  const html = render(f.candidate);
  assert.match(html, /一次付费调用/); assert.match(html, /disabled=""/); assert.doesNotMatch(html, /checked=""/);
  assert.doesNotMatch(html, /金额上限|报价|maximumAmountMinor/);
  f.candidate.c1DraftRuntimeView = { status: "failed", canAuthorize: false, jobId: "job:synthetic",
    accounting: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, charge: { status: "unknown" } } };
  const failed = render(f.candidate);
  assert.match(failed, /输入 7，输出 3，合计 10/); assert.doesNotMatch(failed, /type="checkbox"|确认本件商品的一次文案调用|继续已许可任务/);
  const queued = queuedFixture(); queued.candidate.c1DraftRuntimeView = buildC1DraftRuntimeView(queued);
  const continuation = render(queued.candidate);
  assert.match(continuation, /继续已许可任务/);
  assert.doesNotMatch(continuation, /type="checkbox"|确认本件商品的一次文案调用|disabled=""/);
  queued.candidate.c1DraftRuntimeView = buildC1DraftRuntimeView({ ...queued, serviceBindings: [] });
  const blocked = render(queued.candidate);
  assert.match(blocked, /配置/); assert.doesNotMatch(blocked, /继续已许可任务|等待软件执行/);
  const retry = await createC1KeywordHandoffRetryFixture();
  const retryCandidate = retry.document.candidates[0];
  retryCandidate.c1DraftRuntimeView = buildC1DraftRuntimeView({ candidate: retryCandidate,
    runtime: retry.document.runtime, serviceBindings: [keywordHandoffDraftBinding], observedAt: retry.clock() });
  const retryHtml = render(retryCandidate);
  assert.match(retryHtml, /继续准备文案/);
  assert.doesNotMatch(retryHtml, /type="checkbox"|确认本件商品的一次文案调用|继续已许可任务|disabled=""/);
});
