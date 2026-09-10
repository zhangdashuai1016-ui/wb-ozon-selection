import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { persistC1KeywordPlanningEvidence } from "../lib/c1-keyword-planning-evidence-persistence.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import {
  KEYWORD_NOW,
  keywordPlanningCandidate,
  keywordPlanningSourceEvidence
} from "./fixtures/c1-keyword-planning-fixture.mjs";

function actor() {
  return createActorContext({
    userId: "selection-review-service",
    sessionId: "keyword-planning-test",
    actorType: "software",
    roles: ["operator"],
    source: "software_state_machine",
    authenticatedAt: KEYWORD_NOW
  });
}

function setup() {
  return createMemoryBusinessStateRepository({
    meta: { continuousAutomationEnabled: false },
    runtime: { dispatches: [] },
    candidates: [keywordPlanningCandidate(), { id: "OTHER", dataRevision: 4, workflowStatus: "selection_processing" }]
  });
}

function request(repository, overrides = {}) {
  return {
    repository,
    runtimeMode: "local_development",
    actor: actor(),
    candidateId: "CX-MUSIC-BOX-014",
    expectedRevision: 31,
    serverEvidence: keywordPlanningSourceEvidence(),
    producedAt: KEYWORD_NOW,
    codexOffline: true,
    ...overrides
  };
}

test("Evidence、生产收据、revision、审计和幂等记录同一事务提交", async () => {
  const repository = setup();
  const result = await persistC1KeywordPlanningEvidence(request(repository));
  assert.equal(result.status, "committed");
  assert.equal(result.candidate.dataRevision, 32);
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningEvidenceV1.binding.candidateRevision, 32);
  assert.equal(result.result.status, "ready");
  assert.equal(result.result.sideEffects.codexDispatchesPerformed, 0);
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.operationAudit.length, 1);
  assert.equal(stored.runtime.idempotencyRecords.length, 1);
  assert.deepEqual(stored.candidates[1], { id: "OTHER", dataRevision: 4, workflowStatus: "selection_processing" });
  assert.equal(stored.meta.continuousAutomationEnabled, false);
  assert.deepEqual(stored.runtime.dispatches, []);
});

test("并发同请求只执行一次；旧revision重放幂等；当前证据再次触发零写入", async () => {
  const repository = setup();
  let calls = 0;
  const producer = async () => { throw new Error("async producer forbidden"); };
  const countingProducer = (input) => {
    calls += 1;
    return request.__producer(input);
  };
  const module = await import("../lib/c1-keyword-planning-evidence-producer.mjs");
  request.__producer = module.produceC1KeywordPlanningEvidence;
  const [first, replay] = await Promise.all([
    persistC1KeywordPlanningEvidence(request(repository, { producer: countingProducer })),
    persistC1KeywordPlanningEvidence(request(repository, { producer: countingProducer }))
  ]);
  assert.deepEqual(new Set([first.status, replay.status]), new Set(["committed", "idempotent_replay"]));
  assert.equal(calls, 1);
  const current = await persistC1KeywordPlanningEvidence(request(repository, { expectedRevision: 32, producer }));
  assert.equal(current.status, "already_current");
  assert.equal(calls, 1);
  await assert.rejects(() => persistC1KeywordPlanningEvidence(request(repository, {
    expectedRevision: 32,
    actor: null,
    producer
  })), /RUNTIME_AUTHORIZATION_INVALID/);
  await assert.rejects(() => persistC1KeywordPlanningEvidence(request(repository, {
    expectedRevision: 999,
    producer
  })), /REVISION_CONFLICT/);
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 32);
  assert.equal(stored.runtime.operationAudit.length, 1);
});

test("生产器失败、revision漂移和秘密输入不留下半套状态", async () => {
  const repository = setup();
  await assert.rejects(() => persistC1KeywordPlanningEvidence(request(repository, {
    producer: () => { throw new Error("producer failed"); }
  })), /producer failed/);
  let stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 31);
  assert.equal(stored.runtime.operationAudit?.length || 0, 0);
  assert.equal(stored.candidates[0].lifecycleV11.c1KeywordPlanningEvidenceV1, undefined);

  await assert.rejects(() => persistC1KeywordPlanningEvidence(request(repository, { expectedRevision: 30 })), /REVISION_CONFLICT/);
  await assert.rejects(() => persistC1KeywordPlanningEvidence(request(repository, {
    serverEvidence: keywordPlanningSourceEvidence({ token: "forbidden" })
  })), /SECRET_FORBIDDEN/);
  stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 31);
});
