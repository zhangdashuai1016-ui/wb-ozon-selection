export const LIFECYCLE_STATUS_LABELS = Object.freeze({
  businessPhase: Object.freeze({ A: "A", B: "B", C1: "C1", C2: "C2", D: "D", E: "E", closed: "closed", unknown: "unknown" }),
  businessResult: Object.freeze({ pending: "pending", passed: "passed", rejected: "rejected", manual_review: "manual_review", unknown: "unknown" }),
  technicalStatus: Object.freeze({
    not_started: "not_started",
    queued: "queued",
    running: "running",
    completed: "completed",
    data_acquisition_failed: "data_acquisition_failed",
    system_error: "system_error",
    permission_required: "permission_required",
    stopped: "stopped",
    unknown: "unknown"
  }),
  ownerAction: Object.freeze({
    none: "none",
    confirm_direction: "confirm_direction",
    confirm_supplier_option: "confirm_supplier_option",
    provide_supply_data: "provide_supply_data",
    review_business_exception: "review_business_exception",
    review_compliance_risk: "review_compliance_risk",
    confirm_c1_plan: "confirm_c1_plan",
    provide_final_assets: "provide_final_assets",
    confirm_final_assets: "confirm_final_assets",
    authorize_production: "authorize_production",
    decide_readback_failure: "decide_readback_failure",
    unknown: "unknown"
  })
});

function unavailable(reason) {
  return Object.freeze({ available: false, reason });
}

export function mapLifecycleStatus(candidate) {
  if (!candidate) return unavailable("candidate_missing");
  const skuPackage = candidate.lifecycleV11?.skuPackage;
  const opportunityPackage = candidate.lifecycleV11?.opportunityPackage;
  const lifecycle = skuPackage || opportunityPackage;
  if (!lifecycle) return unavailable("lifecycle_package_missing");
  if (lifecycle.schemaVersion !== "product-lifecycle-v1.1") return unavailable("unsupported_lifecycle_schema");

  const sourceEntityType = skuPackage ? "SkuLifecyclePackage" : "OpportunityPackage";
  const sourcePackageId = skuPackage?.skuPackageId || opportunityPackage?.parentOpportunityId;

  return Object.freeze({
    available: true,
    schemaVersion: "product-lifecycle-v1.1",
    projectionMode: "current-lifecycle-package",
    sourceCandidateId: candidate.id,
    sourceEntityType,
    sourcePackageId,
    sourceDataRevision: candidate.dataRevision,
    sourceProfitModel: skuPackage?.activeProfitModelVersion || null,
    businessPhase: lifecycle.businessPhase,
    businessResult: lifecycle.businessResult,
    technicalStatus: lifecycle.technicalStatus,
    ownerAction: lifecycle.ownerAction,
    productFailed: false,
    failureLayer: null,
    explanation: skuPackage?.eVerificationRecord?.outcome === "externally_verified"
      ? "平台商品由外部发现并完成E阶段独立验证；没有伪造ProductionRecord。"
      : skuPackage?.eVerificationRecord?.outcome === "listed_verified"
        ? "系统创建商品已基于ProductionRecord完成E阶段独立验证。"
        : skuPackage
          ? "显示当前SKU生命周期包中的四条独立状态线。"
          : opportunityPackage.businessPhase === "A"
            ? "当前处于商品方向A阶段；显示OpportunityPackage中的四条独立状态线。"
            : "显示商品方向OpportunityPackage中的四条独立状态线；历史只读适配的unknown保持未确认，不推断为A。"
  });
}

// 兼容旧测试和调用名称；不再限制单一SKU。
export const mapPhase4SingleSkuLifecycle = mapLifecycleStatus;

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
