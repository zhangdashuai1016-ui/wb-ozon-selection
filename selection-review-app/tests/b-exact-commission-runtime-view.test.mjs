import test from "node:test";
import assert from "node:assert/strict";
import { createSavedConditionalBFixture } from "./fixtures/real-a-b-flow-fixture.mjs";
import { buildBExactCommissionRuntimeView } from "../lib/b-exact-commission-runtime-view.mjs";
import { buildBExactCommissionInput } from "../src/bExactCommissionInput.js";

test("B复算视图仅核对保存的来源与精确费用，不计算或改变候选", async () => {
  const f = await createSavedConditionalBFixture();
  const before = structuredClone(f);
  const view = buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: f.candidate, evidencePacks: f.evidencePacks, observedAt: f.at });
  assert.equal(view.canRecalculate, true);
  assert.equal(view.externalRequests, 0);
  assert.equal(view.automaticRetryAllowed, false);
  assert.equal(view.expectedRevision, f.candidate.dataRevision);
  assert.deepEqual(view.evidencePackIds, f.evidencePacks.map(pack => pack.id));
  assert.deepEqual(f, before);
  const candidate = { ...f.candidate, bExactCommissionRuntimeView: view };
  const input = buildBExactCommissionInput({ candidate, sourceRevision: candidate.dataRevision });
  assert.deepEqual(Object.keys(input).sort(), ["candidateId", "expectedRevision", "skuPackageId", "failureId", "idempotencyKey", "auditEventId"].sort());
  assert.equal(input.skuPackageId, candidate.lifecycleV11.skuPackage.skuPackageId);
  assert.throws(() => buildBExactCommissionInput({ candidate, sourceRevision: candidate.dataRevision - 1 }), /未提交旧资料/);
  for (const edit of [value => { value.candidateId = "another"; }, value => { value.failureId = null; },
    value => { value.expectedRevision += 1; }, value => { value.canRecalculate = false; }]) {
    const changed = structuredClone(candidate); edit(changed.bExactCommissionRuntimeView);
    assert.throws(() => buildBExactCommissionInput({ candidate: changed, sourceRevision: candidate.dataRevision }));
  }
});

test("缺失过期费用或来源漂移不显示复算可用，坏时钟不伪装成业务等待", async () => {
  const f = await createSavedConditionalBFixture();
  const missing = buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: f.candidate, evidencePacks: [], observedAt: f.at });
  assert.equal(missing.canRecalculate, false);
  assert.equal(missing.status, "evidence_required");
  const expired = structuredClone(f.evidencePacks); expired[0].expiresAt = f.at;
  assert.equal(buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: f.candidate, evidencePacks: expired, observedAt: f.at }).canRecalculate, false);
  const changed = structuredClone(f.candidate); changed.executionRuntime.technicalFailure.sourceRevision -= 1;
  assert.equal(buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: changed, evidencePacks: f.evidencePacks, observedAt: f.at }).status, "source_conflict");
  assert.throws(() => buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: f.candidate, evidencePacks: f.evidencePacks, observedAt: "invalid" }), /B_RECALCULATION_VIEW_TIME_INVALID/);
  assert.equal(buildBExactCommissionRuntimeView({ rules: f.document.rules, candidate: { lifecycleV11: null }, evidencePacks: [], observedAt: f.at }), null);
});

 test('recalculation view requires current rules and does not adopt legacy cached packaging costs', async () => {
  const f = await createSavedConditionalBFixture();
  f.evidencePacks.find(pack => pack.kind === 'commission').evidenceData.otherCosts.packagingRmb = 999;
  const before = JSON.stringify(f);
  const view = rules => buildBExactCommissionRuntimeView({ candidate: f.candidate, evidencePacks: f.evidencePacks, rules, observedAt: f.at });
  assert.equal(view(f.document.rules).canRecalculate, true);
  for (const [rules, expectedCode] of [[undefined, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [{}, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [{ ...f.document.rules, ozonDandanshu: { ...f.document.rules.ozonDandanshu, costPolicySnapshot: undefined } }, "B_COST_POLICY_INVALID"]]) {
    const blocked = view(rules);
    assert.equal(blocked.canRecalculate, false); assert.equal(blocked.blockReason, expectedCode);
    assert.equal(blocked.externalRequests, 0);
  }
  assert.equal(JSON.stringify(f), before);
});
