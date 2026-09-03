import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import {
  assertC1KeywordPlanningSoftwareClientInput,
  runC1KeywordPlanningEvidenceProduction
} from "../lib/c1-keyword-planning-software-use-case.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";
import { KEYWORD_NOW, keywordPlanningCandidate, keywordPlanningSourceRecord } from "./fixtures/c1-keyword-planning-fixture.mjs";

function actor() {
  return createActorContext({
    userId: "selection-review-software",
    sessionId: "test:c1-keyword-planning",
    actorType: "software",
    roles: ["operator"],
    source: "test_state_machine",
    authenticatedAt: KEYWORD_NOW
  });
}

function document({ withSource = true } = {}) {
  const candidate = keywordPlanningCandidate();
  if (withSource) candidate.lifecycleV11.c1KeywordPlanningSourceRecordV1 = keywordPlanningSourceRecord(candidate);
  return { candidates: [candidate, { id: "OTHER", dataRevision: 4, workflowStatus: "selection_processing" }] };
}

function request(repository, overrides = {}) {
  return {
    repository,
    runtimeMode: "local_development",
    actor: actor(),
    candidateId: "CX-MUSIC-BOX-014",
    expectedRevision: 31,
    producedAt: KEYWORD_NOW,
    codexOffline: true,
    ...overrides
  };
}

test("CODEX_OFFLINE下由软件解析并原子保存planning evidence，零外部调用和零作业", async () => {
  const repository = createMemoryBusinessStateRepository(document());
  const result = await runC1KeywordPlanningEvidenceProduction(request(repository));
  assert.equal(result.status, "committed");
  assert.equal(result.candidate.dataRevision, 32);
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningProductionV1.status, "ready");
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningEvidenceV1.binding.candidateRevision, 32);
  assert.deepEqual(Object.values(result.sideEffects), [0, 0, 0, 0, 0, 1]);
  const stored = await repository.readSnapshot();
  assert.deepEqual(stored.candidates[1], document().candidates[1]);
  assert.equal(stored.runtime.softwareJobs?.length ?? 0, 0);
});

test("来源缺失时自动进入本地原料生产，不伪造完整SourceRecord", async () => {
  const initial = document({ withSource: false });
  const repository = createMemoryBusinessStateRepository(initial);
  const result = await runC1KeywordPlanningEvidenceProduction(request(repository));
  assert.equal(result.status, "committed");
  assert.equal(result.stage, "local_material");
  assert.equal(result.sourceResolution.gaps[0].code, "planning_source_record_missing");
  assert.equal(result.candidate.dataRevision, 32);
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1.status, "not_ready");
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1.gaps[0].code, "c1_facts_not_ready");
  assert.equal(result.candidate.lifecycleV11.c1KeywordPlanningEvidenceV1, undefined);
  assert.equal(result.candidate.lifecycleV11.skuPackage.businessPhase, "C1");
  const stored = await repository.readSnapshot();
  assert.deepEqual(stored.candidates[1], initial.candidates[1]);
  assert.equal(stored.runtime.softwareJobs?.length ?? 0, 0);
  const replay = await runC1KeywordPlanningEvidenceProduction(request(repository, { expectedRevision: 32 }));
  assert.equal(replay.status, "already_current");
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 32);
});

test("同一输入并发只提交一次，另一调用幂等收口", async () => {
  const repository = createMemoryBusinessStateRepository(document());
  const [left, right] = await Promise.all([
    runC1KeywordPlanningEvidenceProduction(request(repository)),
    runC1KeywordPlanningEvidenceProduction(request(repository))
  ]);
  assert.equal([left.status, right.status].filter((status) => status === "committed").length, 1);
  assert.ok([left.status, right.status].some((status) => status === "idempotent_replay" || status === "already_current"));
  const stored = await repository.readSnapshot();
  assert.equal(stored.candidates[0].dataRevision, 32);
  assert.equal(stored.runtime.operationAudit.length, 1);
});

test("revision漂移不写入；软件用例没有客户端serverEvidence入口", async () => {
  const repository = createMemoryBusinessStateRepository(document());
  await assert.rejects(() => runC1KeywordPlanningEvidenceProduction(request(repository, { expectedRevision: 30 })), /REVISION_CONFLICT/);
  assert.equal((await repository.readSnapshot()).candidates[0].dataRevision, 31);
  assert.deepEqual(assertC1KeywordPlanningSoftwareClientInput({ dataRevision: 31 }), { dataRevision: 31 });
  assert.throws(() => assertC1KeywordPlanningSoftwareClientInput({ dataRevision: 31, serverEvidence: {} }), /CLIENT_INPUT_REJECTED/);
});

test("真实软件用例在CODEX_OFFLINE下只走正式resolver和事务且不产生Codex依赖", async () => {
  const repository = createMemoryBusinessStateRepository(document());
  const result = await runC1KeywordPlanningEvidenceProduction(request(repository));
  assert.equal(result.status, "committed");
  assert.equal(result.sideEffects.codexDispatchesPerformed, 0);
  assert.equal(result.sideEffects.softwareJobsCreated, 0);
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.softwareJobs?.length ?? 0, 0);
  assert.equal(stored.runtime.dispatches?.length ?? 0, 0);
});
