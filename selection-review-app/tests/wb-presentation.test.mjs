import test from "node:test";
import assert from "node:assert/strict";
import { wbPresentation } from "../src/wbPresentation.js";

test("Ozon-only handoff shows WB as out of scope and non-blocking", () => {
  const result = wbPresentation({
    wbAssessmentGate: { passed: false },
    wbAssessment: {
      status: "notSuitable",
      currentRoundScope: "not_in_scope",
      currentRoundScopeReason: "本轮仅执行Ozon上架测试。"
    }
  });
  assert.deepEqual(result, {
    kind: "not-in-scope",
    current: false,
    label: "本轮仅上 Ozon",
    heading: "WB未纳入评估（非阻塞）",
    detail: "本轮仅执行Ozon上架测试。"
  });
});

test("WB evidence gap shows the real reason and next step", () => {
  const result = wbPresentation({
    wbAssessmentGate: { passed: false },
    wbAssessment: {
      status: "unverified",
      reason: "WB搜索只加载页面框架，未取得同款市场价。",
      nextStep: "真实成功读取WB同款搜索并刷新当前类目佣金。",
      profitCalculation: {
        status: "conditional_unverified",
        recommendedPriceRub: 3900,
        unitProfitRmb: 20.24,
        marginRate: 0.0614
      }
    }
  });
  assert.equal(result.label, "WB结论未验证");
  assert.equal(result.detail, "WB搜索只加载页面框架，未取得同款市场价。");
  assert.equal(result.nextStep, "真实成功读取WB同款搜索并刷新当前类目佣金。");
  assert.deepEqual(result.conditional, {
    recommendedPriceRub: 3900,
    unitProfitRmb: 20.24,
    marginRate: 0.0614
  });
});

test("accepted WB test risk remains unverified and hands off to listing task", () => {
  const result = wbPresentation({
    wbAssessmentGate: { passed: false },
    wbAssessment: {
      status: "unverified",
      reason: "市场和实时佣金仍有证据缺口。",
      riskAcceptance: { accepted: true, acceptedBy: "user" },
      listingTestHandoff: {
        state: "authorized_pending_final_confirmation",
        owner: "listing_task"
      }
    }
  });
  assert.equal(result.current, false);
  assert.equal(result.label, "WB风险测试已授权");
  assert.equal(result.heading, "用户已接受风险，允许进入WB上架测试");
  assert.equal(result.riskAccepted, true);
  assert.equal(result.handoff.owner, "listing_task");
});

test("stopped WB listing test is shown as paused without erasing risk history", () => {
  const result = wbPresentation({
    wbAssessmentGate: { passed: false },
    wbAssessment: {
      status: "unverified",
      riskAcceptance: { accepted: true, acceptedBy: "user" },
      listingTestHandoff: {
        state: "paused_user_stopped",
        owner: "listing_task"
      }
    }
  });
  assert.equal(result.current, false);
  assert.equal(result.riskAccepted, true);
  assert.equal(result.paused, true);
  assert.equal(result.label, "WB上架测试已暂停");
  assert.equal(result.heading, "用户已停止DD-H1操作，等待最终图片组");
});
