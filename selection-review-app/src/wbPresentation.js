export function wbPresentation(candidate) {
  const wb = candidate?.wbAssessment || {};
  if (wb.currentRoundScope === "not_in_scope") {
    return {
      kind: "not-in-scope",
      current: false,
      label: "本轮仅上 Ozon",
      heading: "WB未纳入评估（非阻塞）",
      detail: wb.currentRoundScopeReason || "本轮只执行Ozon上架测试，未进行WB独立市场、佣金与CEL利润复算。"
    };
  }
  const current = candidate?.wbAssessmentGate?.passed === true;
  const riskAccepted = !current && wb.riskAcceptance?.accepted === true;
  const paused = !current && wb.listingTestHandoff?.state === "paused_user_stopped";
  const profit = wb.profitCalculation || {};
  const conditional = !current && profit.status === "conditional_unverified" &&
    Number.isFinite(Number(profit.recommendedPriceRub)) &&
    Number.isFinite(Number(profit.unitProfitRmb)) &&
    Number.isFinite(Number(profit.marginRate))
    ? {
        recommendedPriceRub: Number(profit.recommendedPriceRub),
        unitProfitRmb: Number(profit.unitProfitRmb),
        marginRate: Number(profit.marginRate)
      }
    : null;
  return {
    kind: current ? wb.status : "recheck",
    current,
    label: current
      ? wb.status === "suitable" ? "WB也适合上架" : "WB不适合上架"
      : paused ? "WB上架测试已暂停" : riskAccepted ? "WB风险测试已授权" : "WB结论未验证",
    heading: current
      ? ""
      : paused ? "用户已停止DD-H1操作，等待最终图片组" : riskAccepted ? "用户已接受风险，允许进入WB上架测试" : "WB结论当前未验证",
    detail: current
      ? ""
      : wb.reason || "WB市场、当前佣金或完整利润仍有证据缺口，不能生成伪结论。",
    nextStep: current ? "" : wb.nextStep || "补齐评估证据后再形成WB适合/不适合结论。",
    conditional,
    riskAccepted,
    paused,
    handoff: riskAccepted ? wb.listingTestHandoff || null : null
  };
}
