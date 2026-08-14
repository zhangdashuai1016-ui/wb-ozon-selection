import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPhase2ATechnicalFailure,
  ensurePhase2AC1Handoff,
  phase2ADemoCard,
  phase2AResultSummary,
  runPhase2AConfirmation
} from "../lib/phase-2a-simulation.mjs";

function submission(overrides = {}) {
  const card = phase2ADemoCard();
  return {
    decision: "confirm",
    supplierConfirmation: {
      ...structuredClone(card.supplierConfirmation),
      ...overrides,
      dimensionsCm: {
        ...structuredClone(card.supplierConfirmation.dimensionsCm),
        ...(overrides.dimensionsCm || {})
      }
    }
  };
}

test("2A一张A确认卡同时锁定方向、供应链接、SKU、价格运费成本和包装后自动运行B", () => {
  const result = runPhase2AConfirmation(submission());
  const summary = phase2AResultSummary(result);
  assert.equal(result.status, "c1_handed_off");
  assert.equal(result.ownerSupplyConfirmation.status, "confirmed");
  assert.equal(result.ownerSupplyConfirmation.confirmedBy, "owner");
  assert.equal(result.bExecution.autoStarted, true);
  assert.deepEqual(result.bExecution.externalPlatformAccessCounts, { ozon: 0, wb: 0, "1688": 0, pinduoduo: 0 });
  assert.equal(result.bExecution.supplierResearchCount, 0);
  assert.deepEqual(result.bExecution.repeatedQuestionFields, []);
  assert.equal(result.bExecution.profitModel.inputSnapshotRefs.length, 5);
  assert.equal(summary.recommendedSalePriceRub, 1831);
  assert.equal(summary.suggestedListPricesRub.length, 3);
  assert.equal(summary.actualPurchaseCostCny, 41);
  assert.equal(summary.unitProfitRmb, 44.95);
  assert.equal(summary.profitMargin, 0.2962);
  assert.equal(summary.formulaCheck, summary.unitProfitRmb);
  assert.equal(result.sharedCandidatesAffected, 0);
  assert.equal(result.realTaskDispatches, 0);
  assert.equal(result.platformWrites, 0);
});

for (const [name, overrides, label] of [
  ["采购成本", { actualPurchaseCost: "" }, "实际采购成本"],
  ["重量", { weightKg: "" }, "重量"],
  ["尺寸", { dimensionsCm: { width: "" } }, "宽度"]
]) {
  test(`2A缺${name}时明确停在A且不启动B`, () => {
    const result = runPhase2AConfirmation(submission(overrides));
    assert.equal(result.status, "a_input_gap");
    assert.equal(result.statusLines.businessPhase, "A");
    assert.equal(result.statusLines.businessResult, "pending");
    assert.equal(result.bExecution, null);
    assert.ok(result.missing.some((item) => item.label === label));
  });
}

test("2A淘汰在同一张卡完成且不创建SKU、B或C1", () => {
  const result = runPhase2AConfirmation({ decision: "reject", supplierConfirmation: phase2ADemoCard().supplierConfirmation });
  assert.equal(result.status, "eliminated");
  assert.equal(result.statusLines.businessResult, "rejected");
  assert.equal(result.bExecution, null);
  assert.deepEqual(result.c1Handoffs, []);
});

test("2A cross_border_cn和可比unknown均可进入B，unknown不会被改写身份", () => {
  const crossBorder = runPhase2AConfirmation(submission(), { sellerType: "cross_border_cn" });
  const unknown = runPhase2AConfirmation(submission(), { sellerType: "unknown" });
  assert.equal(crossBorder.status, "c1_handed_off");
  assert.equal(unknown.status, "c1_handed_off");
  assert.equal(unknown.opportunityPackage.salesSnapshots[0].sellerType, "unknown");
  assert.deepEqual(unknown.bExecution.profitModel.marketSellerTypesUsed, ["unknown"]);
});

test("2A unknown证据不足留在A，local_ru只能作背景", () => {
  const incomparable = runPhase2AConfirmation(submission(), { sellerType: "unknown", comparability: "not_comparable" });
  assert.equal(incomparable.status, "a_evidence_gap");
  assert.equal(incomparable.reason, "销售证据不足或商品可比性不足");
  assert.equal(incomparable.bExecution, null);

  const local = runPhase2AConfirmation(submission(), { sellerType: "local_ru" });
  assert.equal(local.status, "a_evidence_gap");
  assert.equal(local.opportunityPackage.marketAssessment.containsLocalRuBackground, true);
  assert.deepEqual(local.opportunityPackage.marketAssessment.primarySampleIds, []);
});

test("2A B通过后自动进入C1、唯一负责人切换且交接严格幂等", () => {
  const result = runPhase2AConfirmation(submission());
  assert.deepEqual(result.statusLines, {
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none"
  });
  assert.equal(result.uniqueOwner, "listing_task");
  assert.equal(result.c1Handoffs.length, 1);
  assert.equal(result.c1Handoff.fromOwner, "selection_task");
  assert.equal(result.c1Handoff.toOwner, "listing_task");
  assert.equal(result.c1Handoff.selectionTaskStopped, true);
  assert.equal(result.proof.sameParentOpportunityId, true);
  assert.equal(result.proof.noDualOwnership, true);

  const replay = ensurePhase2AC1Handoff(result.c1Handoffs, {
    skuPackage: result.skuPackage,
    opportunityPackage: result.opportunityPackage,
    profitModel: result.bExecution.profitModel
  });
  assert.equal(replay.created, false);
  assert.equal(replay.records.length, 1);
  assert.equal(replay.handoff.handoffId, result.c1Handoff.handoffId);
});

test("2A技术失败只改变技术状态，不改变业务阶段和结论", () => {
  const result = runPhase2AConfirmation(submission());
  const failed = applyPhase2ATechnicalFailure(result, "system_error");
  assert.equal(failed.statusLines.businessPhase, result.statusLines.businessPhase);
  assert.equal(failed.statusLines.businessResult, result.statusLines.businessResult);
  assert.equal(failed.statusLines.ownerAction, result.statusLines.ownerAction);
  assert.equal(failed.statusLines.technicalStatus, "system_error");
  assert.equal(failed.technicalFailureEffect, "business_state_unchanged");
});

test("2A利润模型只追加版本且不覆盖历史", () => {
  const first = runPhase2AConfirmation(submission());
  const history = structuredClone(first.skuPackage.profitModels);
  assert.equal(history.length, 1);
  assert.equal(history[0].profitModelVersion, "profit-v1");
  assert.equal(first.proof.profitHistoryAppendOnly, true);
});
