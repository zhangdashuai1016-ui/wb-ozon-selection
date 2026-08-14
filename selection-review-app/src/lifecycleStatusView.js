export const PHASE4_SINGLE_SKU_ID = "CX-20260803-010";
export const LIFECYCLE_STATUS_LABELS = Object.freeze({
  businessPhase: Object.freeze({ B: "B", C1: "C1", C2: "C2", D: "D", E: "E" }),
  businessResult: Object.freeze({ passed: "passed", rejected: "rejected", unknown: "unknown" }),
  technicalStatus: Object.freeze({
    completed: "completed",
    data_acquisition_failed: "data_acquisition_failed",
    system_error: "system_error"
  }),
  ownerAction: Object.freeze({ none: "none", unknown: "unknown" })
});

function unavailable(reason) {
  return Object.freeze({ available: false, reason });
}

export function mapPhase4SingleSkuLifecycle(candidate) {
  if (!candidate || candidate.id !== PHASE4_SINGLE_SKU_ID) {
    return unavailable("not_phase4_single_sku");
  }
  const lifecycle = candidate.lifecycleV11?.skuPackage;
  if (!lifecycle) return unavailable("lifecycle_package_missing");

  return Object.freeze({
    available: true,
    schemaVersion: "product-lifecycle-v1.1",
    projectionMode: "current-lifecycle-package",
    sourceCandidateId: candidate.id,
    sourceDataRevision: candidate.dataRevision,
    sourceProfitModel: lifecycle.activeProfitModelVersion,
    businessPhase: lifecycle.businessPhase,
    businessResult: lifecycle.businessResult,
    technicalStatus: lifecycle.technicalStatus,
    ownerAction: lifecycle.ownerAction,
    productFailed: false,
    failureLayer: null,
    explanation: lifecycle.eVerificationRecord?.outcome === "externally_verified"
      ? "平台商品由外部发现并完成E阶段独立验证；没有伪造ProductionRecord。"
      : lifecycle.eVerificationRecord?.outcome === "listed_verified"
        ? "系统创建商品已基于ProductionRecord完成E阶段独立验证。"
        : "显示当前SKU生命周期包中的四条独立状态线。"
  });
}

export function withTechnicalFailureDisplay(status, {
  technicalStatus = "data_acquisition_failed",
  failureLayer = "test_evidence_reader"
} = {}) {
  if (!status?.available) return status;
  if (!LIFECYCLE_STATUS_LABELS.technicalStatus[technicalStatus] || technicalStatus === "completed") {
    throw new Error("技术失败展示必须使用明确的失败技术状态");
  }
  return Object.freeze({
    ...status,
    technicalStatus,
    productFailed: false,
    failureLayer,
    explanation: `技术获取失败只改变技术状态；业务阶段仍为${status.businessPhase}、业务结果仍为${status.businessResult}，不得显示为商品失败。`
  });
}
