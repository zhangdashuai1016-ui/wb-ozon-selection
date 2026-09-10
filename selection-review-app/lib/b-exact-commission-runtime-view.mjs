import { buildLifecycleBExplicitOtherCosts, resolveLifecycleBProfitRule } from "./lifecycle-b-evidence-runtime.mjs";
import { BExactCommissionRecalculationError, prepareSavedConditionalBExactInputs } from "./real-a-b-c1-flow.mjs";

/** Read-only availability for the saved B result; never computes profit or advances a phase. */
export function buildBExactCommissionRuntimeView({ candidate, evidencePacks, currentCommissionCatalogs = [], rules, observedAt }) {
  if (candidate.lifecycleV11?.status !== "b_conditional_awaiting_exact_commission") return null;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new TypeError("B_RECALCULATION_VIEW_TIME_INVALID");
  const base = {
    schemaVersion: "b-exact-commission-runtime-view-v1", candidateId: candidate.id,
    expectedRevision: candidate.dataRevision, skuPackageId: candidate.lifecycleV11.skuPackage?.skuPackageId ?? null,
    failureId: candidate.executionRuntime?.technicalFailure?.failureId ?? null,
    canRecalculate: false, automaticRetryAllowed: false, externalRequests: 0
  };
  try {
    const otherCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, rules), { asOf: observedAt });
    const prepared = prepareSavedConditionalBExactInputs({ candidate, evidencePacks, currentCommissionCatalogs, otherCosts, processedAt: observedAt });
    return { ...base, status: "ready", canRecalculate: true, evidencePackIds: prepared.evidence.sourcePackIds,
      blockReason: null, message: "精确费用证据已齐，可以复算正式利润。沿用已确认的供货方案，不会访问平台或产生费用。" };
  } catch (error) {
    if (error.code === "B_EVIDENCE_COST_POLICY_INCOMPLETE" || error.code?.startsWith("B_COST_POLICY_")) return { ...base, status: "evidence_required", evidencePackIds: [],
      blockReason: error.code, message: "当前商品成本或店铺规则不完整，不能复算正式利润。" };
    if (!(error instanceof BExactCommissionRecalculationError)) throw error;
    const evidenceMissing = ["B_EXACT_RECALCULATION_EXACT_EVIDENCE_REQUIRED", "B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE"].includes(error.code);
    return { ...base, status: evidenceMissing ? "evidence_required" : "source_conflict", evidencePackIds: [],
      blockReason: error.code, message: evidenceMissing
        ? "精确费用证据尚未齐全或已经失效。供货确认和条件测算已保留，不会自动重试。"
        : "已保存的供货、利润或停止记录需要核对，当前不能继续复算。" };
  }
}
