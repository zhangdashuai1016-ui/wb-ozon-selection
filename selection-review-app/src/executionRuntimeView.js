export const EXECUTOR_LABELS = Object.freeze({
  software: "软件执行",
  third_party_ai: "第三方AI执行",
  codex_exception: "Codex技术维护中",
  owner: "主人决策"
});

export const EXECUTION_STATUS_LABELS = Object.freeze({
  not_started: "未开始",
  queued: "等待软件执行",
  running: "执行中",
  completed: "本步骤已完成",
  blocked: "软件已安全停止",
  waiting_owner: "等待主人确认"
});

export function executionRuntimeDisplay(view) {
  if (!view?.available) return null;
  if (view.legacyReadOnly) {
    return {
      executorLabel: "历史Codex记录（只读）",
      statusLabel: "不能推动新版商品",
      detail: "旧M04、Codex处理中和旧派发仅供追溯，不能推动新版商品；新版正常步骤不会从这里继续。",
      tone: "legacy"
    };
  }
  const exception = view.exceptionCase;
  const technicalFailure = view.technicalFailure;
  if (exception?.status === "open") {
    const maintenanceActive = exception.dispatchState === "running" && Boolean(exception.turnId);
    return {
      executorLabel: maintenanceActive ? "Codex技术维护中" : "需要技术维护 / ExceptionCase",
      statusLabel: maintenanceActive ? "维护任务已领取" : "软件已安全停止",
      detail: `异常层：${exception.failureLayer}；原因：${exception.reasonCode}。业务结论未改变，未取得真实维护轮次前不表示Codex已介入。`,
      tone: maintenanceActive ? "codex_exception" : "maintenance_required"
    };
  }
  if (technicalFailure?.status === "stopped") {
    return {
      executorLabel: technicalFailure.kind === "external_dependency" ? "外部服务有问题" : "软件已识别技术问题",
      statusLabel: technicalFailure.kind === "unknown_outcome" ? "结果未知，禁止自动重试" : "软件已安全停止",
      detail: `${technicalFailure.message} 失败层：${technicalFailure.failureLayer}；错误码：${technicalFailure.errorCode}。业务结论未改变。`,
      tone: technicalFailure.kind === "external_dependency" ? "external_dependency" : "known_technical_failure"
    };
  }
  return {
    executorLabel: EXECUTOR_LABELS[view.executorType] || view.executorType,
    statusLabel: EXECUTION_STATUS_LABELS[view.status] || view.status,
    detail: view.executorType === "third_party_ai"
        ? `输入修订 ${view.inputRevision}；输出凭证 ${view.inferenceReceiptId || "等待生成"}。`
        : `输入修订 ${view.inputRevision}${view.outputRevision === null ? "" : `；输出修订 ${view.outputRevision}`}。`,
    tone: view.executorType
  };
}
