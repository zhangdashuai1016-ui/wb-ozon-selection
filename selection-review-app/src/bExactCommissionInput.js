export function buildBExactCommissionInput({ candidate, sourceRevision }) {
  const view = candidate.bExactCommissionRuntimeView;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || candidate.dataRevision !== sourceRevision ||
      view?.expectedRevision !== sourceRevision || view.candidateId !== candidate.id || view.canRecalculate !== true ||
      typeof view.skuPackageId !== "string" || !view.skuPackageId || typeof view.failureId !== "string" || !view.failureId) {
    throw new Error("当前精确费用或商品记录不可复算，请刷新核对；未提交旧资料。");
  }
  return { candidateId: candidate.id, expectedRevision: sourceRevision, skuPackageId: view.skuPackageId, failureId: view.failureId,
    idempotencyKey: `b-exact-recalculation:${candidate.id}:${sourceRevision}`,
    auditEventId: `b-exact-recalculation-audit:${candidate.id}:${sourceRevision}` };
}
