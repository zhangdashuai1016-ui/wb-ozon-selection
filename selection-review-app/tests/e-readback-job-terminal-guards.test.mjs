import { createSyntheticDCompletionAdapter } from "./helpers/d-synthetic-completion-adapter.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { savedDProductionJobFixture } from "./fixtures/d-production-saved-job-fixture.mjs";
import { exactObservation } from "./helpers/d-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { runPersistedDExecution } from "../lib/d-e-software-integration.mjs";
import { createSystemEReadbackSoftwareRuntime } from "../lib/e-readback-software-use-case.mjs";

const clone = value => structuredClone(value);
const validator = await loadPublishedSchemaValidator();
const validateAttempt = validator.getSchema("e-readback-attempt-v1");
const validateJob = validator.getSchema("software-job-v1.schema.json");

async function fixture({ claim = true } = {}) {
  const d = await savedDProductionJobFixture();
  // E-only precondition: explicit synthetic DTOs pass through the formal D persistence and terminal reducers.
  assert.equal((await runPersistedDExecution({ ...d.input, createAdapter: ({request}) => createSyntheticDCompletionAdapter({request}) })).status, "succeeded");
  const document = await d.repository.readSnapshot(), candidate = document.candidates[0];
  const jobId = candidate.lifecycleV11.eIndependentReadbackJobRefV1.jobId;
  const leaseId = "lease:synthetic:e-terminal-review";
  if (claim) await d.jobStore.claim({ jobId, worker: d.worker, leaseId, leaseDurationMs: 60_000 });
  const input = { candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    sourceRecordId: candidate.lifecycleV11.skuPackage.productionRecord.productionRecordId };
  const observation = exactObservation(candidate.lifecycleV11.skuPackage.productionRecord,
    { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  return { d, candidate, jobId, input, observation, runArgs: { actor: d.input.actor, input,
    softwareJobContext: { jobStore: d.jobStore, jobId, workerId: d.worker.workerId, leaseId } } };
}

const jobOf = (document, f) => document.runtime.softwareJobs.find(job => job.jobId === f.jobId);
const skuOf = document => document.candidates[0].lifecycleV11.skuPackage;
const service = (f, readPlatform) => createSystemEReadbackSoftwareRuntime({ repository: f.d.repository,
  runtimeMode: "local_development", serverClock: f.d.input.serverClock, readPlatform });

function assertPublished(document, f) {
  assert.equal(validateJob(jobOf(document, f)), true, JSON.stringify(validateJob.errors));
  for (const attempt of skuOf(document).readbackHistory) {
    assert.equal(validateAttempt(attempt), true, JSON.stringify(validateAttempt.errors));
  }
}

test("a missing E handoff pointer cannot downgrade a saved PA→D→E job to the historical human path", async () => {
  const f = await fixture({ claim: false });
  await f.d.repository.transact(document => {
    delete document.candidates[0].lifecycleV11.eIndependentReadbackJobRefV1;
    return { changed: true, document, result: null };
  });
  const before = await f.d.repository.readSnapshot();
  let reads = 0;
  await assert.rejects(() => service(f, async () => { reads += 1; return f.observation; }).run({
    actor: f.d.owner.args.actor, input: f.input
  }), /E_READBACK_SOFTWARE_JOB_CONTEXT_REQUIRED|E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT/);
  assert.equal(reads, 0);
  assert.deepEqual(await f.d.repository.readSnapshot(), before);
  assert.equal(jobOf(before, f).status, "queued");
});

test("the original E lease holder retains late evidence after actual expiry reconciliation without applying it", async () => {
  const f = await fixture();
  let reads = 0, reconciledJob;
  const runtime = service(f, async () => {
    reads += 1; f.d.advance(60_001);
    assert.deepEqual((await f.d.jobStore.reconcileExpiredLeases()).reconciled, [f.jobId]);
    reconciledJob = jobOf(await f.d.repository.readSnapshot(), f);
    return f.observation;
  });
  const result = await runtime.run(f.runArgs);
  assert.equal(result.status, "not_applied");
  const saved = await f.d.repository.readSnapshot(), sku = skuOf(saved);
  assert.deepEqual(jobOf(saved, f), reconciledJob);
  assert.equal(sku.readbackHistory.length, 1);
  assert.equal(sku.readbackHistory[0].applicationDisposition, "reconciliation_required_not_applied");
  assert.deepEqual(sku.readbackHistory[0].result.observation, f.observation);
  assert.equal(sku.eVerificationRecord, null);
  assert.equal(saved.candidates[0].dataRevision, f.input.expectedCandidateRevision);
  assert.notEqual(saved.candidates[0].workflowStatus, "listed");
  assertPublished(saved, f);
  assert.equal((await runtime.run(f.runArgs)).status, "idempotent_replay");
  assert.equal(reads, 1);
  assert.deepEqual(await f.d.repository.readSnapshot(), saved);
});

test("G1 or variant drift during an E read preserves the frozen result and never overwrites current verification", async t => {
  for (const field of ["identity", "variant"]) await t.test(field, async () => {
    const f = await fixture();
    let reads = 0;
    const result = await service(f, async () => {
      reads += 1;
      await f.d.repository.transact(document => {
        const sku = skuOf(document);
        if (field === "identity") sku.g1Identity.merchantSku = "merchant:synthetic:changed";
        else sku.variantKey = "variant:synthetic:changed";
        return { changed: true, document, result: null };
      });
      return f.observation;
    }).run(f.runArgs);
    assert.equal(result.status, "not_applied");
    const saved = await f.d.repository.readSnapshot(), sku = skuOf(saved);
    assert.equal(sku.readbackHistory[0].applicationDisposition, "source_conflict_not_applied");
    assert.deepEqual(sku.readbackHistory[0].result.observation, f.observation);
    assert.equal(sku.eVerificationRecord, null);
    assert.equal(jobOf(saved, f).status, "completed");
    assert.equal(saved.candidates[0].dataRevision, f.input.expectedCandidateRevision);
    assert.equal(reads, 1);
    assertPublished(saved, f);
  });
});

test("owner, holder and unique E job corruption during a real read cannot apply verification", async t => {
  const changes = {
    owner: (document, f) => { jobOf(document, f).ownerUserId = "owner:synthetic:other"; },
    worker: (document, f) => { jobOf(document, f).workerId = "worker:synthetic:other"; },
    lease: (document, f) => { jobOf(document, f).leaseId = "lease:synthetic:other"; },
    duplicate_job: (document, f) => { document.runtime.softwareJobs.push({ ...clone(jobOf(document, f)), jobId: `${f.jobId}:duplicate` }); }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = await fixture(); let reads = 0, beforeSettlement;
    await assert.rejects(() => service(f, async () => {
      reads += 1;
      await f.d.repository.transact(document => { change(document, f); return { changed: true, document, result: null }; });
      beforeSettlement = await f.d.repository.readSnapshot();
      return f.observation;
    }).run(f.runArgs), /E_READBACK_SOFTWARE_JOB_REFERENCE_CONFLICT|DE_JOB_RESULT_AUTHORIZATION_OWNER_CONFLICT|E_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT/);
    assert.equal(reads, 1);
    assert.deepEqual(await f.d.repository.readSnapshot(), beforeSettlement);
    assert.equal(skuOf(beforeSettlement).eVerificationRecord, null);
    assert.equal(skuOf(beforeSettlement).readbackHistory[0].result, null);
  });
});

test("a failed read cannot settle against a concurrently replaced external request reference", async () => {
  const f = await fixture(); let reads = 0, beforeSettlement;
  await assert.rejects(() => service(f, async () => {
    reads += 1;
    await f.d.repository.transact(document => {
      jobOf(document, f).externalRequestRef = "e-readback-request:synthetic-other-request";
      return { changed: true, document, result: null };
    });
    beforeSettlement = await f.d.repository.readSnapshot();
    throw new Error("synthetic read transport disconnect");
  }).run(f.runArgs), /DE_JOB_RESULT_REQUEST_SOURCE_CONFLICT|E_READBACK_SOFTWARE_JOB_REFERENCE_CONFLICT/);
  assert.equal(reads, 1);
  assert.deepEqual(await f.d.repository.readSnapshot(), beforeSettlement);
  assert.equal(skuOf(beforeSettlement).readbackHistory[0].result, null);
  assert.equal(skuOf(beforeSettlement).eVerificationRecord, null);
});

test("pure E result readers never import execution use cases or generic job persistence", () => {
  const visited = new Set();
  function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    assert.doesNotMatch(url.pathname.split("/").at(-1),
      /^(?:business-mutation-transaction|software-job-(?:contract|repository)|production-authorization|draft-production-execution|d-e-software-integration)\.mjs$/);
    const source = readFileSync(url, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) inspect(new URL(match[1], url));
  }
  inspect(new URL("../lib/e-readback-attempt.mjs", import.meta.url));
  inspect(new URL("../lib/d-e-software-job-results.mjs", import.meta.url));
  assert.ok(visited.size > 3);
});
