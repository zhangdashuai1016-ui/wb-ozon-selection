import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { createSystemEReadbackSoftwareRuntime } from "../lib/e-readback-software-use-case.mjs";
import { buildDESavedJobRuntimeView } from "../lib/d-e-runtime-view.mjs";
import { dESavedJobRuntimeDisplay } from "../src/dESoftwareRuntimeView.js";
import { createSoftwareExecutionRuntime, openExceptionCase } from "../lib/software-execution-state.mjs";

const clone = value => structuredClone(value);
const dependencies = { transport: true, preflight: true, capabilities: true, assetTransport: true };

function viewInput(document, binding, worker, observedAt) {
  return { candidate: document.candidates[0], runtime: { ...document.runtime, workers: [worker] }, observedAt,
    productionBindings: [binding], dependencyView: { ...dependencies }, serviceBindings: [{
      schemaVersion: "d-e-service-binding-v1", serviceId: "service:synthetic:view", configurationVersion: "service-config:1",
      productionBindingId: binding.bindingId, productionConfigurationVersion: binding.configurationVersion,
      workerId: worker.workerId, workerVersion: worker.version, leaseDurationMs: 60_000
    }] };
}

async function queuedFixture() {
  const owner = productionOwnerDecisionFixture();
  await commitSingleOwnerProductionAuthorization(owner.args);
  const document = await owner.repository.readSnapshot(), candidate = document.candidates[0];
  const pa = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const binding = { ...clone(pa.executionBinding), platform: "ozon", storeRef: clone(candidate.storeRef),
    storeName: "合成测试店铺", warehouseName: "合成测试仓库", warehouseRef: pa.lockedScope.warehouseRef,
    credentialAlias: pa.lockedScope.credentialAlias, verification: { evidenceRef: "evidence:synthetic:view-config",
      checkedAt: owner.formal.at, expiresAt: new Date(Date.parse(owner.formal.at) + 300_000).toISOString() } };
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => owner.formal.at });
  const worker = registry.register({ workerId: "worker:synthetic:view", version: "worker-version:1",
    capabilities: ["ozon-production-execution", "ozon-independent-readback"], observedAt: owner.formal.at });
  return viewInput(document, binding, worker, owner.formal.at);
}

async function completedFixture({ e = null, reconcile = false } = {}) {
  const d = await savedDProductionJobFixture();
  await runPersistedDExecution({...d.input,createAdapter:({request})=>createSyntheticDCompletionAdapter({request,
    beforeCheckpoint:async({event})=>{
      if(reconcile && event.kind === 'stock_receipt_observed'){d.advance(60001);await d.jobStore.reconcileExpiredLeases();}
    }
  })});
  if (e !== null) {
    const document = await d.repository.readSnapshot(), candidate = document.candidates[0];
    const jobId = candidate.lifecycleV11.eIndependentReadbackJobRefV1.jobId, leaseId = "lease:synthetic:view-e";
    await d.jobStore.claim({ jobId, worker: d.worker, leaseId, leaseDurationMs: 60_000 });
    const runtime = createSystemEReadbackSoftwareRuntime({ repository: d.repository, runtimeMode: "local_development",
      serverClock: d.input.serverClock, readPlatform: async () => exactObservation(candidate.lifecycleV11.skuPackage.productionRecord,
        { moderationStatus: "approved", validationStatus: "success", saleStatus: e === "verified" ? "on_sale" : "not_for_sale" }) });
    await runtime.run({ actor: d.input.actor, input: { candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
      sourceRecordId: candidate.lifecycleV11.skuPackage.productionRecord.productionRecordId },
    softwareJobContext: { jobStore: d.jobStore, jobId, workerId: d.worker.workerId, leaseId } });
  }
  return viewInput(await d.repository.readSnapshot(), clone(d.currentProductionBinding), d.registry.snapshot()[0], d.input.serverClock());
}

test("accepted import without a query policy displays that no observation has been scheduled", async () => {
  const d=await savedDProductionJobFixture();
  assert.equal((await runPersistedDExecution({...d.input,createAdapter:d.createAdapter()})).status,'waiting_platform');
  const document=await d.repository.readSnapshot();
  const view=buildDESavedJobRuntimeView(viewInput(document,clone(d.currentProductionBinding),d.registry.snapshot()[0],d.input.serverClock()));
  assert.equal(view.d.sourceBlockReason,null);
  assert.equal(view.d.platformObservation.nextJobId,null);
  assert.equal(view.d.platformObservation.queriesUsed,0);
  assert.equal(view.d.platformObservation.queryLimit,null);
  assert.ok(view.d.blockers.some(item=>item.message.includes('查询策略未配置，尚未安排查询')));
  assert.deepEqual(d.calls,['/v3/product/import']);
  assert.equal(view.e,null);
});

test("a confirmed import stopped after lease expiry remains accepted material with an accurate stop explanation", async () => {
  const d=await savedDProductionJobFixture();
  assert.equal((await runPersistedDExecution({...d.input,createAdapter:d.createAdapter(async()=>d.advance(60001))})).status,'failed');
  const document=await d.repository.readSnapshot();
  const view=buildDESavedJobRuntimeView(viewInput(document,clone(d.currentProductionBinding),d.registry.snapshot()[0],d.input.serverClock()));
  assert.equal(view.d.sourceBlockReason,null);
  assert.equal(view.d.status,'failed');assert.equal(view.d.externalRequestState,'succeeded');
  assert.equal(view.d.receiptStatus,'progress_saved');assert.equal(view.d.businessStatus,'blocked');
  assert.equal(view.d.platformObservation.queriesUsed,0);assert.equal(view.d.platformObservation.inventoryWriteState,'not_sent');
  assert.ok(view.d.blockers.some(item=>item.message.includes('执行租约已过期')));
  assert.equal(view.canContinueSaved,false);assert.equal(view.e,null);
  assert.deepEqual(d.calls,['/v3/product/import']);
});

test("query policy expiry during import retains acceptance and stops before creating any observation", async () => {
  const d=await savedDProductionJobFixture();
  const policy={schemaVersion:'d-platform-observation-policy-v1',policyRef:'policy:synthetic:view',version:'1',
    maxQueries:3,intervalMs:10,requestTimeoutMs:1000,expiresAt:new Date(Date.parse(d.input.serverClock())+1000).toISOString()};
  const result=await runPersistedDExecution({...d.input,platformObservationPolicy:policy,createAdapter:d.createAdapter(async()=>d.advance(1001))});
  assert.equal(result.status,'failed');assert.equal(result.platformWrites,1);
  const document=await d.repository.readSnapshot(),state=document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.blockReason,'context_changed');assert.equal(state.platformContinuation.queryCount,0);
  assert.equal(state.platformContinuation.inventoryWriteState,'not_sent');assert.equal(state.attempt.platformResult.taskId,'501');
  assert.equal(document.runtime.softwareJobs.length,1);assert.deepEqual(d.calls,['/v3/product/import']);
  const view=buildDESavedJobRuntimeView(viewInput(document,clone(d.currentProductionBinding),d.registry.snapshot()[0],d.input.serverClock()));
  assert.equal(view.d.sourceBlockReason,null);assert.equal(view.d.status,'failed');assert.equal(view.e,null);
  assert.equal((await runPersistedDExecution({...d.input,platformObservationPolicy:policy,createAdapter:d.createAdapter()})).status,'idempotent_replay');
  assert.deepEqual(await d.repository.readSnapshot(),document);assert.deepEqual(d.calls,['/v3/product/import']);
});

test("initial acceptance after lease reconciliation preserves the original unknown job and late task evidence without continuation", async () => {
  const d=await savedDProductionJobFixture();let reconciledJob,acceptance;
  const createAdapter=d.createAdapter(async()=>{
    d.advance(60001);await d.jobStore.reconcileExpiredLeases();
    reconciledJob=clone((await d.repository.readSnapshot()).runtime.softwareJobs.find(job=>job.jobId===d.job.jobId));
  });
  const result=await runPersistedDExecution({...d.input,createAdapter:async context=>{
    const adapter=await createAdapter(context);
    return {...adapter,executeSellerApi:async(...args)=>{acceptance=await adapter.executeSellerApi(...args);return acceptance;}};
  }});
  assert.equal(result.status,'unknown_outcome');assert.equal(result.platformWrites,'unknown');
  const document=await d.repository.readSnapshot(),sku=document.candidates[0].lifecycleV11.skuPackage,state=sku.dSoftwareExecution;
  assert.deepEqual(document.runtime.softwareJobs.find(job=>job.jobId===d.job.jobId),reconciledJob);
  assert.equal(state.attempt.platformResult.taskId,'501');assert.equal(state.checkpoints[1].taskId,'501');
  assert.deepEqual(state.attempt.platformResult,acceptance);assert.equal(state.checkpoints.length,2);
  assert.equal(state.platformContinuation,undefined);assert.equal(sku.productionRecord,null);
  assert.equal(document.runtime.softwareJobs.length,1);assert.deepEqual(d.calls,['/v3/product/import']);
  const view=buildDESavedJobRuntimeView(viewInput(document,clone(d.currentProductionBinding),d.registry.snapshot()[0],d.input.serverClock()));
  assert.equal(view.d.status,'unknown_outcome');assert.equal(view.d.lateMaterial,true);assert.equal(view.e,null);
  assert.equal(view.canContinueSaved,false);
  assert.equal((await runPersistedDExecution({...d.input,createAdapter:d.createAdapter()})).status,'idempotent_replay');
  assert.deepEqual(await d.repository.readSnapshot(),document);assert.deepEqual(d.calls,['/v3/product/import']);
});

test("an unknown acceptance guard error persists task evidence and preserves the existing exception contract before rethrowing", async t => {
 for (const scenario of ['new_case','existing_case','null_throw']) await t.test(scenario,async()=>{
  const existingCase=scenario === 'existing_case';
  const d=await savedDProductionJobFixture(),cause=scenario === 'null_throw'?null:new TypeError('synthetic private internal detail');let received=false,acceptance;
  let originalCase;
  if(existingCase) await d.repository.transact(document=>{
    const candidate=document.candidates[0],at=d.input.serverClock();
    candidate.executionRuntime=openExceptionCase(createSoftwareExecutionRuntime({candidateId:candidate.id,dataRevision:candidate.dataRevision,
      businessPhase:'D',stepId:'previous_maintenance',at}),{exceptionId:'exception:synthetic:previous',reasonCode:'system_failure',
      failureLayer:'previous_step',evidenceRefs:['receipt:synthetic:previous'],softwareJobId:'job:synthetic:previous',at});
    originalCase=clone(candidate.executionRuntime.exceptionCase);
    return {changed:true,document};
  });
  const jobStore={...d.jobStore,assertDEExecutionInDocument(args){
    if(received)throw cause;
    return d.jobStore.assertDEExecutionInDocument(args);
  }};
  const createAdapter=d.createAdapter(async()=>{received=true;});
  const input={...d.input,softwareJobContext:{...d.input.softwareJobContext,jobStore},createAdapter:async context=>{
    const adapter=await createAdapter(context);
    return {...adapter,executeSellerApi:async(...args)=>{acceptance=await adapter.executeSellerApi(...args);return acceptance;}};
  }};
  await assert.rejects(runPersistedDExecution(input),error=>error===cause);
  const document=await d.repository.readSnapshot(),candidate=document.candidates[0],state=candidate.lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(state.status,'unknown_outcome');assert.equal(state.platformWrites,'unknown');
  assert.equal(state.attempt.platformResult.taskId,'501');assert.equal(state.checkpoints.length,2);
  assert.deepEqual(state.attempt.platformResult,acceptance);
  assert.equal(state.platformContinuation,undefined);assert.equal(document.runtime.softwareJobs.length,1);
  assert.equal(document.runtime.softwareJobs[0].status,'unknown_outcome');
  assert.equal(candidate.executionRuntime.businessPhase,'D');
  if(existingCase) assert.deepEqual(candidate.executionRuntime.exceptionCase,originalCase);
  else {
    assert.equal(candidate.executionRuntime.exceptionCase.lastSuccessfulStepId,'import_task_received');
    assert.equal(candidate.executionRuntime.exceptionCase.unknownOutcome,true);
    assert.equal(candidate.executionRuntime.exceptionCase.softwareJobId,d.job.jobId);
    assert.equal(candidate.executionRuntime.exceptionCase.sourceRevision,state.softwareJobRef.revision);
    assert.deepEqual(candidate.executionRuntime.exceptionCase.evidenceRefs,[state.attempt.platformResult.requestReceiptRef]);
  }
  assert.equal(state.step,'import_task_received');assert.equal(state.attempt.reason,'initial_import_acceptance_guard_system_failure');
  assert.equal(JSON.stringify(document).includes('synthetic private internal detail'),false);
  assert.equal(candidate.lifecycleV11.skuPackage.productionRecord,null);assert.deepEqual(d.calls,['/v3/product/import']);
  assert.equal((await runPersistedDExecution(input)).status,'idempotent_replay');
  assert.deepEqual(await d.repository.readSnapshot(),document);assert.deepEqual(d.calls,['/v3/product/import']);
 });
});

test("historical candidates keep their existing view while a real PA saved job gets a detached continuation projection", async () => {
  const f = await queuedFixture(), before = clone(f);
  const view = buildDESavedJobRuntimeView(f);
  assert.equal(view.status, "queued"); assert.equal(view.d.status, "queued"); assert.equal(view.e, null);
  assert.equal(view.canContinueSaved, true); assert.equal(view.currentVerified, false);
  assert.equal(view.continueJobId, f.runtime.softwareJobs[0].jobId);
  assert.equal(view.expectedRevision, f.candidate.dataRevision);
  assert.equal(view.platformHealth, "not_checked"); assert.equal(view.automaticRetryAllowed, false);
  assert.deepEqual(f, before);
  view.d.blockers.push({ code: "synthetic", message: "local edit" });
  assert.deepEqual(f, before);
  const historical = clone(f); historical.candidate.lifecycleV11.skuPackage.dHandoff.schemaVersion = "c2-d-handoff-v1";
  delete historical.candidate.lifecycleV11.skuPackage.dHandoff.softwareJobRef; historical.runtime = {};
  assert.equal(buildDESavedJobRuntimeView(historical), null);
});

test("v2 missing reference, cross-candidate jobs and current source drift are explicit conflicts, never legacy fallback", async () => {
  const original = await queuedFixture();
  for (const mutate of [
    f => { delete f.candidate.lifecycleV11.skuPackage.dHandoff.softwareJobRef; },
    f => { f.runtime.softwareJobs[0].candidateId = "candidate:other"; },
    f => { f.runtime.softwareJobs.push(clone(f.runtime.softwareJobs[0])); },
    f => { f.candidate.lifecycleV11.skuPackage.variantKey = "variant:changed"; },
    f => { f.candidate.dataRevision += 1; }
  ]) {
    const f = clone(original); mutate(f);
    const view = buildDESavedJobRuntimeView(f);
    assert.equal(view.status, "source_conflict"); assert.ok(view.d.sourceBlockReason);
    assert.equal(view.canContinueSaved, false); assert.equal(view.currentVerified, false);
  }
});

test("queued missing services, provider functions, worker or current binding evidence shows precise blockers", async () => {
  const original = await queuedFixture();
  const cases = [
    [f => { f.serviceBindings = []; }, "DE_SERVICE_REQUIRED"],
    [f => { f.productionBindings = []; }, "DE_PRODUCTION_BINDING_REQUIRED"],
    [f => { f.runtime.workers = []; }, "DE_WORKER_REQUIRED"],
    [f => { f.runtime.workers[0].version = "worker:other"; }, "DE_WORKER_REQUIRED"],
    [f => { f.productionBindings[0].verification.expiresAt = f.observedAt; }, "SOFTWARE_JOB_ADMISSION_DE_BINDING_EVIDENCE_EXPIRED"],
    [f => { f.productionBindings[0].credentialAlias = "alias:other"; }, "SOFTWARE_JOB_ADMISSION_DE_BINDING_SOURCE_CONFLICT"],
    ...Object.keys(dependencies).map(key => [f => { f.dependencyView[key] = false; }, key === "assetTransport" ? "DE_ASSET_TRANSPORT_REQUIRED" : `DE_${key.toUpperCase()}_REQUIRED`])
  ];
  for (const [mutate, code] of cases) {
    const f = clone(original); mutate(f);
    const view = buildDESavedJobRuntimeView(f);
    assert.equal(view.d.status, "queued"); assert.equal(view.d.externalRequestState, "not_sent");
    assert.equal(view.canContinueSaved, false); assert.ok(view.d.blockers.some(item => item.code === code), JSON.stringify(view.d.blockers));
    assert.equal(view.platformHealth, "not_checked");
  }
});

test("saved intent/preparation, attempts and terminal states never produce a resend button", async () => {
  const original = await queuedFixture();
  for (const mutate of [
    f => { f.runtime.softwareJobs[0].preparationEvidence = null; },
    f => { f.candidate.lifecycleV11.skuPackage.dSoftwareExecution = { status: "in_flight" }; },
    ...["claimed", "waiting_platform", "failed", "unknown_outcome", "completed"].map(status => f => { f.runtime.softwareJobs[0].status = status; }),
    f => { f.runtime.softwareJobs[0].attempt = 1; },
    f => { f.runtime.softwareJobs[0].externalRequestState = "in_flight"; }
  ]) {
    const f = clone(original); mutate(f);
    assert.equal(buildDESavedJobRuntimeView(f).canContinueSaved, false);
  }
});

test("current rights expiry is a source block and unexpected exceptions are never converted into configuration gaps", async () => {
  const f = await queuedFixture();
  f.observedAt = f.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt;
  const blocked = buildDESavedJobRuntimeView(f);
  assert.equal(blocked.status, "source_conflict"); assert.equal(blocked.canContinueSaved, false);
  assert.throws(() => buildDESavedJobRuntimeView({ ...f, observedAt: "invalid" }), /TIME_INVALID/);
  const unexpected = new TypeError("synthetic source getter failure"), normal = await queuedFixture();
  Object.defineProperty(normal.candidate.lifecycleV11.skuPackage, "g1Identity", { get() { throw unexpected; } });
  assert.throws(() => buildDESavedJobRuntimeView(normal), error => error === unexpected);
});

test("real D completion exposes only queued E continuation; E dependencies do not require another production preflight", async () => {
  const f = await completedFixture();
  f.dependencyView.preflight = false; f.dependencyView.assetTransport = false;
  const view = buildDESavedJobRuntimeView(f);
  assert.equal(view.d.status, "completed"); assert.equal(view.d.receiptStatus, "production_record_saved");
  assert.equal(view.e.status, "queued"); assert.equal(view.e.canContinueSaved, true);
  assert.equal(view.continueJobId, f.candidate.lifecycleV11.eIndependentReadbackJobRefV1.jobId);
  assert.equal(view.currentVerified, false);
  delete f.candidate.lifecycleV11.eIndependentReadbackJobRefV1;
  f.runtime.softwareJobs = f.runtime.softwareJobs.filter(job => job.jobType !== "e_independent_readback");
  assert.equal(buildDESavedJobRuntimeView(f).status, "source_conflict");
});

test("real reconciled D late receipts remain material awaiting reconciliation, never completion or permission", async () => {
  const view = buildDESavedJobRuntimeView(await completedFixture({ reconcile: true }));
  assert.equal(view.d.status, "unknown_outcome"); assert.equal(view.d.lateMaterial, true);
  assert.equal(view.d.receiptStatus, "production_record_saved"); assert.equal(view.e, null);
  assert.equal(view.canContinueSaved, false); assert.equal(view.currentVerified, false);
  assert.match(dESavedJobRuntimeDisplay(view).stages[0].reconciliationMessage, /晚到材料.*对账/);
});

test("real E completed/not_verified stays non-green; verified is green only while its source and current record match", async () => {
  const notVerified = buildDESavedJobRuntimeView(await completedFixture({ e: "not_verified" }));
  assert.equal(notVerified.e.status, "completed"); assert.equal(notVerified.e.businessStatus, "not_verified");
  assert.equal(notVerified.currentVerified, false); assert.equal(dESavedJobRuntimeDisplay(notVerified).tone, "waiting");
  const f = await completedFixture({ e: "verified" }), verified = buildDESavedJobRuntimeView(f);
  assert.equal(verified.currentVerified, true); assert.equal(dESavedJobRuntimeDisplay(verified).tone, "completed");
  for (const alter of [
    value => { value.candidate.lifecycleV11.skuPackage.readbackHistory[0].softwareJobRef.leaseId = "lease:other"; },
    value => { value.candidate.lifecycleV11.skuPackage.readbackHistory[0].sourceFingerprint = "0".repeat(64); }
  ]) {
    const changed = clone(f); alter(changed);
    assert.equal(buildDESavedJobRuntimeView(changed).currentVerified, false);
    assert.equal(buildDESavedJobRuntimeView(changed).status, "source_conflict");
  }
  f.candidate.lifecycleV11.skuPackage.variantKey = "variant:changed";
  const changed = buildDESavedJobRuntimeView(f);
  assert.equal(changed.status, "source_conflict"); assert.equal(changed.currentVerified, false);
  assert.equal(changed.e.receiptStatus, "readback_saved");
});

test("actual saved-job card has one continuation action, honest configuration copy and no second authorization", async () => {
  const entry = fileURLToPath(new URL("./de-saved-view-entry.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/DESoftwareRuntimeCard.jsx", import.meta.url));
  const built = await build({ configFile: false, logLevel: "warn", plugins: [react(), {
    name: "de-saved-view-test", resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from "react"; import {renderToStaticMarkup} from "react-dom/server";
      import Card from ${JSON.stringify(component)};
      export const render = (savedJobRuntime, enabled = true) => renderToStaticMarkup(<Card savedJobRuntime={savedJobRuntime}
        onContinueSaved={enabled ? ()=>{throw new Error("render continued job")} : null}/>);
      export function renderInteraction(savedJobRuntime, onContinueSaved) {
        let button;
        function findButton(element) {
          if (!React.isValidElement(element)) return;
          if (element.type === "button") button = element;
          React.Children.forEach(element.props.children, findButton);
        }
        function Subject() {
          const tree = Card({savedJobRuntime, onContinueSaved});
          findButton(tree);
          return tree;
        }
        const html = renderToStaticMarkup(<Subject/>);
        return {html, click: button.props.onClick};
      }` : null
  }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const output = built.output.find(item => item.type === "chunk" && item.isEntry);
  const { render, renderInteraction } = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
  const f = await queuedFixture();
  const view = buildDESavedJobRuntimeView(f);
  const ready = render(view);
  assert.match(ready, /继续已保存任务/); assert.match(ready, /配置存在不代表平台在线/);
  assert.doesNotMatch(ready, /checkbox|等待主人生产授权|production-job:|credentialAlias/);
  assert.match(render(view, false), /<button[^>]*disabled=""/);
  let rejectRequest;
  const request = new Promise((resolve, reject) => { rejectRequest = reject; });
  const calls = [];
  const interaction = renderInteraction(view, async input => { calls.push(input); await request; });
  const firstClick = interaction.click(), duplicateClick = interaction.click();
  assert.deepEqual(calls, [{ jobId: view.continueJobId, expectedRevision: view.expectedRevision }]);
  rejectRequest(new Error("当前任务条件已改变，未继续执行"));
  // Exercise the actual card event handler and shared hook: rejection is handled,
  // and the ref-based lock blocks a second click even before a React rerender.
  await assert.doesNotReject(Promise.all([firstClick, duplicateClick]));
  assert.equal(calls.length, 1);
  f.dependencyView.transport = false;
  const blocked = render(buildDESavedJobRuntimeView(f));
  assert.match(blocked, /尚未接入平台连接/); assert.doesNotMatch(blocked, /<button/);
  const failed = render(buildDESavedJobRuntimeView(await completedFixture({ e: "not_verified" })));
  assert.match(failed, /商品尚未通过验证/); assert.doesNotMatch(failed, /status-completed|<button/);
});
