import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createSystemEReadbackSoftwareRuntime } from "../lib/e-readback-software-use-case.mjs";
import { settleSoftwareJob } from "../lib/software-job-contract.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import { c1AiSoftwareJobFixture } from "./fixtures/c1-ai-software-job-fixture.mjs";

const clone = value => structuredClone(value);
const validator = await loadPublishedSchemaValidator();
const validateJob = validator.getSchema("software-job-v1.schema.json");
const validateDState = validator.getSchema("d-software-execution-state-v2");
const validateOldEnvelope = validator.getSchema("software-job-admission-v1.schema.json#/$defs/softwareJobResultEnvelope");
const accepts = (validate, value) => assert.equal(validate(value), true, JSON.stringify(validate.errors));
const rejects = (validate, value) => assert.equal(validate(value), false, "Malformed terminal contract was accepted");

async function dResult(mode) {
  const f = await savedDProductionJobFixture();
  const factory = ({request}) => createSyntheticDCompletionAdapter({request,
    beforeCheckpoint:async({event})=>{
      if(mode === 'unknown' && event.kind === 'import_task_received')throw new Error('synthetic lost import response');
      if(mode === 'source_conflict' && event.kind === 'stock_receipt_observed')
        await f.repository.transact(document=>{document.candidates[0].dataRevision++;return {changed:true,document};});
    },afterCheckpoint:async()=>{f.commits.push(await f.repository.readSnapshot());}
  });
  const outcome = await runPersistedDExecution({ ...f.input, createAdapter: async context => {
    if (mode === "blocked") f.changeServiceVersion();
    return factory(context);
  } });
  const document = await f.repository.readSnapshot();
  const job = document.runtime.softwareJobs.find(job => job.jobId === f.job.jobId);
  const state = document.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution;
  assert.equal(outcome.status, mode === "unknown" ? "unknown_outcome" : mode === "blocked" ? "failed" : "succeeded");
  return { f, document, job, state };
}

const dResults = Object.fromEntries(await Promise.all(["success", "source_conflict", "blocked", "unknown"].map(async mode => [mode, await dResult(mode)])));

async function eResult(mode) {
  // Clone the formally committed synthetic D result; every E case starts from its real queued handoff.
  const { f, document } = dResults.success;
  const repository = createMemoryBusinessStateRepository(document);
  const candidate = document.candidates[0], record = candidate.lifecycleV11.skuPackage.productionRecord;
  const configuration = clone(dResults.success.job.admissionDecision.executionBindingSnapshot);
  const jobStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: f.input.serverClock,
    workerRegistry: f.registry, resolveDEExecutionBinding: () => clone(configuration) });
  const jobId = candidate.lifecycleV11.eIndependentReadbackJobRefV1.jobId, leaseId = "lease:synthetic:terminal-schema-e";
  await jobStore.claim({ jobId, worker: f.worker, leaseId, leaseDurationMs: 60_000 });
  let reads = 0, issuedJob;
  const runtime = createSystemEReadbackSoftwareRuntime({ repository, runtimeMode: "local_development", serverClock: f.input.serverClock,
    readPlatform: async () => {
      reads += 1;
      issuedJob = (await repository.readSnapshot()).runtime.softwareJobs.find(job => job.jobId === jobId);
      if (mode === "unknown") throw new Error("synthetic independent read disconnect");
      if (mode === "source_conflict") await repository.transact(document => {
        document.candidates[0].dataRevision += 1; return { changed: true, document };
      });
      return exactObservation(record, { moderationStatus: "approved", validationStatus: "success",
        saleStatus: mode === "not_verified" ? "not_for_sale" : "on_sale" });
    } });
  await runtime.run({ actor: f.input.actor, input: { candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    sourceRecordId: record.productionRecordId }, softwareJobContext: { jobStore, jobId, workerId: f.worker.workerId, leaseId } });
  const saved = await repository.readSnapshot();
  assert.equal(reads, 1);
  return { document: saved, job: saved.runtime.softwareJobs.find(job => job.jobId === jobId), issuedJob };
}

const eResults = Object.fromEntries(await Promise.all(["verified", "not_verified", "source_conflict", "unknown"].map(async mode => [mode, await eResult(mode)])));

test("strict public schemas accept domain-produced synthetic D success, source conflict, zero-send failure and unknown states", () => {
  for (const { job, state, document } of Object.values(dResults)) {
    accepts(validateJob, job); accepts(validateDState, state);
    for (const entry of document.runtime.softwareJobs) accepts(validateJob, entry);
  }
  assert.equal(dResults.success.job.resultEnvelope.payload.executionRevision, 8);
  assert.equal(dResults.success.job.resultEnvelope.applicationDisposition, "applied");
  assert.equal(dResults.source_conflict.job.resultEnvelope.applicationDisposition, "revision_conflict_not_applied");
  assert.equal(dResults.source_conflict.job.resultEnvelope.payload.continuationBlocked, true);
  assert.equal(dResults.blocked.job.externalRequestState, "not_sent"); assert.equal(dResults.blocked.job.resultEnvelope, null);
  assert.equal(dResults.unknown.job.externalRequestState, "unknown_outcome"); assert.equal(dResults.unknown.job.resultEnvelope, null);
});

test("D softwareJobRef is optional for standalone states and closed/bounded when present", () => {
  const source = dResults.success.state;
  const standalone = clone(source); delete standalone.softwareJobRef; accepts(validateDState, standalone);
  for (const key of ["jobId", "revision", "workerId", "leaseId"]) {
    const invalid = clone(source); delete invalid.softwareJobRef[key]; rejects(validateDState, invalid);
  }
  for (const change of [s => { s.softwareJobRef.extra = true; }, s => { s.softwareJobRef = null; },
    s => { s.softwareJobRef.revision = -1; }, s => { s.softwareJobRef.revision = Number.MAX_SAFE_INTEGER + 1; },
    s => { s.softwareJobRef.jobId = "token=synthetic-private-value"; }, s => { s.softwareJobRef.workerId = "unknown"; },
    s => { s.softwareJobRef.leaseId = "x".repeat(257); }, s => { s.blockReason = "arbitrary_fallback"; }]) {
    const invalid = clone(source); change(invalid); rejects(validateDState, invalid);
  }
  const blocked = clone(dResults.blocked.state); accepts(validateDState, blocked);
  delete blocked.softwareJobRef; rejects(validateDState, blocked);
  const reconciled = clone(source); reconciled.blockReason = "software_job_reconciliation_required";
  accepts(validateDState, reconciled); delete reconciled.softwareJobRef; rejects(validateDState, reconciled);
});

test("D completed payload has exactly eight fields and cannot borrow generic or E payloads", () => {
  const source = dResults.success.job;
  assert.equal(Object.keys(source.resultEnvelope.payload).length, 8);
  for (const key of Object.keys(source.resultEnvelope.payload)) {
    const invalid = clone(source); delete invalid.resultEnvelope.payload[key]; rejects(validateJob, invalid);
  }
  for (const change of [j => { j.resultEnvelope.payload.extra = true; }, j => { j.resultEnvelope.payload = {}; },
    j => { j.resultEnvelope.payload.schemaVersion = "e-readback-job-result-v1"; }, j => { j.resultEnvelope.payload.executionRevision = 7; },
    j => { j.resultEnvelope.payload.productionRecordId = "x".repeat(1025); }, j => { j.resultEnvelope.payload.candidateRevision = 1.5; },
    j => { j.resultEnvelope.payload.productionRecordFingerprint = "g".repeat(64); }, j => { j.resultEnvelope.payload.continuationBlocked = true; },
    j => { j.resultEnvelope.jobType = "c1_ai_draft"; }, j => { j.resultEnvelope.payloadKind = "e_independent_readback"; },
    j => { j.resultEnvelope.applicationDisposition = "result_recorded_no_candidate_mutation"; }, j => { j.resultEnvelope.resultRef = "unrelated:result"; }]) {
    const invalid = clone(source); change(invalid); rejects(validateJob, invalid);
  }
});

test("real E verification, ordinary gaps, source conflict and unknown use distinct strict terminal branches", () => {
  for (const { job } of Object.values(eResults)) accepts(validateJob, job);
  assert.equal(eResults.verified.job.resultEnvelope.payload.verificationStatus, "verified");
  assert.equal(eResults.verified.job.resultEnvelope.applicationDisposition, "applied");
  assert.equal(eResults.not_verified.job.resultEnvelope.payload.verificationApplied, false);
  assert.equal(eResults.not_verified.job.resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.equal(eResults.source_conflict.job.resultEnvelope.applicationDisposition, "revision_conflict_not_applied");
  assert.equal(eResults.source_conflict.job.resultEnvelope.payload.verificationApplied, false);
  assert.equal(eResults.unknown.job.status, "unknown_outcome"); assert.equal(eResults.unknown.job.resultEnvelope, null);
});

test("E eight-field payload and application mapping reject incomplete, excessive and contradictory evidence", () => {
  const source = eResults.verified.job;
  assert.equal(Object.keys(source.resultEnvelope.payload).length, 8);
  for (const key of Object.keys(source.resultEnvelope.payload)) {
    const invalid = clone(source); delete invalid.resultEnvelope.payload[key]; rejects(validateJob, invalid);
  }
  for (const change of [j => { j.resultEnvelope.payload.extra = true; }, j => { j.resultEnvelope.payload.attemptId = "x".repeat(1025); },
    j => { j.resultEnvelope.payload.sourceProductionRecordId = "unknown"; }, j => { j.resultEnvelope.payload.attemptFingerprint = "invalid"; },
    j => { j.resultEnvelope.payload.candidateRevision = Number.MAX_SAFE_INTEGER + 1; }, j => { j.resultEnvelope.payload.verificationApplied = false; },
    j => { j.resultEnvelope.payload.verificationStatus = "not_verified"; }, j => { j.resultEnvelope.applicationDisposition = "revision_conflict_not_applied"; },
    j => { j.resultEnvelope.payloadKind = "d_production_execution"; }, j => { j.resultEnvelope.payload = dResults.success.job.resultEnvelope.payload; }]) {
    const invalid = clone(source); change(invalid); rejects(validateJob, invalid);
  }
  const gaps = clone(eResults.not_verified.job); gaps.resultEnvelope.payload.verificationStatus = "verified";
  rejects(validateJob, gaps);
});

test("terminal jobs require their saved attempt, worker, lease and non-null completion evidence", () => {
  for (const source of [dResults.success.job, dResults.blocked.job, dResults.unknown.job, ...Object.values(eResults).map(result => result.job)]) {
    for (const change of [j => { j.attempt = 0; }, j => { j.startedAt = null; }, j => { j.completedAt = null; },
      j => { j.workerId = null; }, j => { j.workerVersion = null; }, j => { j.leaseId = null; }, j => { j.leaseExpiresAt = null; },
      j => { j.workerCapabilitiesSnapshot = []; }, j => { j.admissionDecision = null; }, j => { j.automaticRetryAllowed = true; }]) {
      const invalid = clone(source); change(invalid); rejects(validateJob, invalid);
    }
    if (source.status === "completed") {
      const invalid = clone(source); invalid.resultEnvelope = null; rejects(validateJob, invalid);
    } else {
      for (const change of [j => { j.failureClass = null; }, j => { j.resultRef = "result:unearned"; },
        j => { j.resultEnvelope = dResults.success.job.resultEnvelope; }, j => { j.externalRequestState = "in_flight"; }]) {
        const invalid = clone(source); change(invalid); rejects(validateJob, invalid);
      }
    }
  }
  const impossible = clone(eResults.unknown.job); impossible.status = "failed"; impossible.externalRequestState = "succeeded";
  rejects(validateJob, impossible);
});

test("old generic envelope and C1/C2 jobs cannot adopt new D/E terminal evidence", () => {
  const c1 = c1AiSoftwareJobFixture().job;
  for (const envelope of [dResults.success.job.resultEnvelope, eResults.verified.job.resultEnvelope]) {
    rejects(validateOldEnvelope, envelope);
    rejects(validateJob, { ...clone(c1), resultEnvelope: clone(envelope) });
  }
  const changedD = clone(dResults.success.job); changedD.resultEnvelope = clone(eResults.verified.job.resultEnvelope);
  rejects(validateJob, changedD);
  const changedE = clone(eResults.verified.job); changedE.resultEnvelope = clone(dResults.success.job.resultEnvelope);
  rejects(validateJob, changedE);
});

test("a recomputed payload fingerprint cannot make generic settlement a D/E result producer", () => {
  for (const [job, envelope] of [[dResults.success.f.commits.at(-1).runtime.softwareJobs.find(job => job.jobType === "d_production_execution"), dResults.success.job.resultEnvelope],
    [eResults.verified.issuedJob, eResults.verified.job.resultEnvelope]]) {
    const changed = clone(envelope); changed.payload.candidateRevision += 1;
    changed.payloadFingerprint = fingerprintCanonicalRecord(changed.payload);
    // Standard JSON Schema cannot compare a payload with the current persisted candidate.
    // The domain-only settlement boundary remains mandatory even for structurally valid JSON.
    accepts(validator.getSchema(`software-job-v1.schema.json#/$defs/${job.jobType === "d_production_execution" ? "dProduction" : "eReadback"}ResultEnvelope`), changed);
    assert.throws(() => settleSoftwareJob({ job, workerId: job.workerId, leaseId: job.leaseId, status: "completed",
      externalRequestState: "succeeded", serverTime: envelope.recordedAt, resultRef: envelope.resultRef, resultEnvelope: changed }), /SOFTWARE_JOB_DOMAIN_SETTLEMENT_REQUIRED/);
  }
});
