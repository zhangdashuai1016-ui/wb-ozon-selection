export const D_E_STATUS_LABELS = Object.freeze({
  not_applicable: "尚未进入生产阶段",
  awaiting_production_authorization: "等待主人生产授权",
  authorization_not_runnable: "授权不能生成生产计划",
  not_ready: "D/E能力尚未就绪",
  ready_for_explicit_execution: "已具备单SKU执行准备条件",
  awaiting_e_readback: "等待E阶段独立回读",
  listed_verified: "已完成E阶段验证"
});

export function dESoftwareRuntimeDisplay(view) {
  if (!view?.available) return null;
  return {
    statusLabel: D_E_STATUS_LABELS[view.status] || view.status,
    gaps: Array.isArray(view.gaps) ? view.gaps : [],
    assetTransport: {
      status: view.assetTransportStatus || "not_started",
      evidenceRef: view.assetTransportEvidenceRef || null,
      resolvedCount: Number(view.assetTransportResolvedCount || 0)
    },
    tone: view.status === "listed_verified"
      ? "completed"
      : view.status === "ready_for_explicit_execution"
        ? "ready"
        : "waiting"
  };
}
