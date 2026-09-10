import test from "node:test";
import assert from "node:assert/strict";
import { createSavedConditionalBFixture, currentOtherCosts } from "./fixtures/real-a-b-flow-fixture.mjs";
import { prepareSavedConditionalBExactInputs, BExactCommissionRecalculationError } from "../lib/real-a-b-c1-flow.mjs";
import { createBExactCommissionRecalculationUseCase } from "../lib/b-exact-commission-recalculation-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentActor, createActorContext } from "../lib/runtime-identity.mjs";
import { openExceptionCase } from "../lib/software-execution-state.mjs";

async function fixture(options = {}) {
  const { candidate, original, document, at } = await createSavedConditionalBFixture(options);
  const repository = createMemoryBusinessStateRepository(document);
  const owner = createActorContext({ userId: "owner-b", sessionId: "owner-session-b", actorType: "human", roles: ["owner"],
    source: "authenticated_identity_provider", authenticatedAt: at });
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, skuPackageId: original.skuPackage.skuPackageId,
    failureId: "failure:b-exact", idempotencyKey: "b-recalculate:1", auditEventId: "audit:b-recalculate:1" };
  const usecase = createBExactCommissionRecalculationUseCase({ repository, runtimeMode: "local_development", serverClock: () => at });
  return { repository, candidate, original, owner, input, usecase, document, at };
}

test("saved conditional B uses exact evidence once, preserves A and history, and creates one C1 atomically", async () => {
  const f = await fixture();
  const before = await f.repository.readSnapshot();
  const ready = prepareSavedConditionalBExactInputs({ candidate: f.candidate, evidencePacks: before.evidencePacks, otherCosts: currentOtherCosts(f.candidate), processedAt: f.at });
  assert.equal(ready.skuPackage.businessPhase, "B");
  assert.deepEqual(await f.repository.readSnapshot(), before);
  const results = await Promise.all([f.usecase.recalculate({ actor: f.owner, input: f.input }), f.usecase.recalculate({ actor: f.owner, input: f.input })]);
  assert.deepEqual(results.map(item => item.status).sort(), ["committed", "idempotent_replay"]);
  const saved = await f.repository.readSnapshot(), candidate = saved.candidates[0], life = candidate.lifecycleV11;
  assert.equal(results[0].result.status, "passed");
  assert.equal(candidate.dataRevision, f.input.expectedRevision + 1);
  assert.deepEqual(life.opportunityPackage, f.original.opportunityPackage);
  assert.deepEqual(life.ownerSupplyConfirmation, f.original.ownerSupplyConfirmation);
  assert.deepEqual(life.aConfirmationReceipt, before.candidates[0].lifecycleV11.aConfirmationReceipt);
  assert.deepEqual(life.skuPackage.selectedSupplySnapshot, f.original.skuPackage.selectedSupplySnapshot);
  assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), f.original.skuPackage.profitModels);
  assert.equal(life.skuPackage.profitModels.at(-1).calculationType, "formal");
  assert.equal(life.skuPackage.businessPhase, "C1");
  assert.equal(life.c1Handoffs.length, 1);
  assert.equal(candidate.executionRuntime.technicalFailure, null);
  assert.deepEqual(results[0].result.priorTechnicalFailure, before.candidates[0].executionRuntime.technicalFailure);
  assert.deepEqual(results[0].result.priorSystemEvidenceBundle, f.original.systemEvidenceBundle);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  assert.deepEqual(results[0].result.externalAccesses, []);
  assert.equal(saved.runtime.operationAudit.length, 1);
  await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input: { ...f.input, idempotencyKey: "b-recalculate:2", auditEventId: "audit:2" } }), /REVISION_CONFLICT/);
  assert.deepEqual(await f.repository.readSnapshot(), saved);
  const restartedRepository = createMemoryBusinessStateRepository(saved);
  const restarted = createBExactCommissionRecalculationUseCase({ repository: restartedRepository, runtimeMode: "local_development", serverClock: () => f.at });
  assert.equal((await restarted.recalculate({ actor: f.owner, input: f.input })).status, "idempotent_replay");
  assert.deepEqual(await restartedRepository.readSnapshot(), saved);
});

test("formal rejected recalculation saves a new profit version and no C1", async () => {
  const f = await fixture({ rejected: true });
  const result = await f.usecase.recalculate({ actor: f.owner, input: f.input });
  assert.equal(result.result.status, "rejected");
  const candidate = (await f.repository.readSnapshot()).candidates[0];
  assert.equal(candidate.lifecycleV11.status, "b_rejected");
  assert.equal(candidate.lifecycleV11.skuPackage.profitModels.at(-1).calculationType, "formal");
  assert.equal(candidate.lifecycleV11.skuPackage.c1ProductPlan, null);
  assert.deepEqual(candidate.lifecycleV11.c1Handoffs, []);
  assert.equal(candidate.executionRuntime.technicalFailure, null);
});

test("missing, old, estimated or mismatched evidence and source drift cannot save or advance B", async () => {
  const mutations = [
    d => { d.candidates[0].lifecycleV11.skuPackage.dSoftwareExecution = { status: "unknown_outcome" }; },
    d => { d.candidates[0].lifecycleV11.skuPackage.dHandoff = { status: "queued" }; },
    d => { d.evidencePacks = d.evidencePacks.filter(p => p.kind !== "commission"); },
    d => { d.evidencePacks[0].expiresAt = "2026-08-18T02:30:00.000Z"; },
    d => { d.evidencePacks[0].scope.storeRef.platformStoreId = "wrong-store"; },
    d => { d.evidencePacks[0].evidenceData.commissionEvidenceMode = "estimated"; },
    d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.weight.value += 1; },
    d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.actualPurchaseCost += 1; },
    d => { d.candidates[0].executionRuntime.technicalFailure.evidenceRefs = ["wrong-ref"]; },
    d => { d.candidates[0].lifecycleV11.ownerSupplyConfirmation.supplierSkuId = "wrong-sku"; },
    d => { const c=d.candidates[0]; c.executionRuntime=openExceptionCase(c.executionRuntime, { exceptionId:"unknown:b", reasonCode:"system_failure", failureLayer:"test", evidenceRefs:["test:unknown"], at:"2026-08-18T02:30:00.000Z" }); }
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    await f.repository.transact(document => { mutate(document); return { document, changed: true, result: null }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input: f.input }), BExactCommissionRecalculationError);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

test("closed input and wrong failure identity reject before mutation", async () => {
  const f = await fixture(), before = await f.repository.readSnapshot();
  await assert.rejects(() => f.usecase.recalculate({ actor: createLocalDevelopmentActor({ at: f.at }), input: f.input }), /AUTHENTICATED_OWNER_REQUIRED/);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  for (const input of [{ ...f.input, commissionRate: 0 }, { ...f.input, failureId: "other" }, { ...f.input, skuPackageId: "other" }]) {
    await assert.rejects(() => f.usecase.recalculate({ actor: f.owner, input }), BExactCommissionRecalculationError);
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});

 test('exact recalculation uses current transaction rules instead of cached commission costs and preserves frozen history', async () => {
  const baseline = await fixture();
  await baseline.usecase.recalculate({ actor: baseline.owner, input: baseline.input });
  const baselineLife = (await baseline.repository.readSnapshot()).candidates[0].lifecycleV11;
  const f = await fixture();
  const stalePage = await f.repository.readSnapshot();
  await f.repository.transact(document => {
    document.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value = 8;
    document.evidencePacks.find(pack => pack.kind === 'commission').evidenceData.otherCosts.packagingRmb = 999;
    return { document, changed: true };
  });
  const before = await f.repository.readSnapshot();
  assert.equal(stalePage.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb.value, 0);
  const result = await f.usecase.recalculate({ actor: f.owner, input: f.input });
  const saved = await f.repository.readSnapshot(), life = saved.candidates[0].lifecycleV11;
  assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.otherCosts.fixedOtherRmb, 8);
  assert.equal(life.bSystemEvidenceBundle.platformFeeEvidence.otherCosts.packagingRmb, before.candidates[0].packagingCostRmb);
  assert.equal(Number((baselineLife.skuPackage.profitModels.at(-1).unitProfitRmb - life.skuPackage.profitModels.at(-1).unitProfitRmb).toFixed(2)), 8);
  assert.equal(JSON.stringify(life.skuPackage.profitModels.slice(0, -1)), JSON.stringify(before.candidates[0].lifecycleV11.skuPackage.profitModels));
  for (const field of ['opportunityPackage', 'ownerSupplyConfirmation', 'aConfirmationReceipt']) {
    assert.equal(JSON.stringify(life[field]), JSON.stringify(before.candidates[0].lifecycleV11[field]));
  }
  assert.deepEqual(saved.evidencePacks, before.evidencePacks);
  assert.deepEqual(result.result.externalAccesses, []);
});

test('missing current rules stop exact recalculation atomically despite complete cached otherCosts', async () => {
  for (const [mutate, expectedCode] of [[document => { delete document.rules; }, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [document => { delete document.rules.ozonDandanshu; }, "B_EVIDENCE_COST_POLICY_INCOMPLETE"], [document => { delete document.rules.ozonDandanshu.costPolicySnapshot.items.fixedOtherRmb; }, "B_COST_POLICY_INVALID"]]) {
    const f = await fixture();
    await f.repository.transact(document => { mutate(document); return { document, changed: true }; });
    const before = await f.repository.readSnapshot();
    await assert.rejects(f.usecase.recalculate({ actor: f.owner, input: f.input }), { code: expectedCode });
    assert.deepEqual(await f.repository.readSnapshot(), before);
  }
});
