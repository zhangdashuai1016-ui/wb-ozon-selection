const RIGHTS_CHOICES = Object.freeze({
  owned: { status: "verified", basis: "owned" },
  licensed: { status: "verified", basis: "licensed" },
  no_third_party_rights_identified: { status: "verified", basis: "no_third_party_rights_identified" },
  unknown: { status: "unknown", basis: null },
  blocked: { status: "blocked", basis: null },
  requires_authorization: { status: "requires_authorization", basis: null }
});

export function c1RightsReviewRequiresReplacement(plan) {
  return plan.status !== "inputs_ready" || Object.hasOwn(plan.inputSnapshots, "skuRightsReview");
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`请填写${label}的准确时间`);
  }
  if (new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`请填写${label}的真实日期`);
  }
  return new Date(value).toISOString();
}

export function buildC1RightsReviewInput({ candidate, form, sourceRevision }) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  if (!sku || sku.businessPhase !== "C1" || !plan || candidate.dataRevision !== sourceRevision ||
      form.c1PlanId !== plan.c1PlanId || form.skuPackageId !== sku.skuPackageId) {
    throw new Error("当前商品资料已变化，请核对后载入新版再保存声明");
  }
  if (!form.confirmed) throw new Error("请明确确认本次声明对应当前商品与供应规格");
  if (!["branded", "unbranded", "unknown"].includes(form.brandStatus) || !Object.hasOwn(RIGHTS_CHOICES, form.rightsChoice)) {
    throw new Error("请选择品牌识别和权利情况；未确定时请选择尚未核实");
  }
  const brandName = form.brandStatus === "branded" ? form.brandName.trim() : null;
  if (form.brandStatus === "branded" && !brandName) throw new Error("请填写当前商品的准确品牌名称");
  if (form.rightsChoice === "no_third_party_rights_identified" && form.brandStatus !== "unbranded") {
    throw new Error("未发现第三方权利仅适用于明确无品牌的商品");
  }
  const reviewedAt = timestamp(form.reviewedAt, "核对");
  const expiresAt = timestamp(form.expiresAt, "有效期截止");
  if (Date.parse(expiresAt) <= Date.parse(reviewedAt)) throw new Error("有效期截止时间必须晚于核对时间");
  if (!plan.inputSnapshots || typeof plan.inputSnapshots !== "object" || Array.isArray(plan.inputSnapshots)) {
    throw new Error("当前C1保存资料损坏，请先处理资料错误");
  }
  const frozen = c1RightsReviewRequiresReplacement(plan);
  if (frozen && !form.replaceFrozenPlan) throw new Error("旧C1计划已经冻结，请明确确认生成替代版本");
  return {
    candidateId: candidate.id, skuPackageId: sku.skuPackageId, expectedRevision: sourceRevision,
    idempotencyKey: `c1-rights-submit:${candidate.id}:${sourceRevision}`, expectedC1PlanId: plan.c1PlanId,
    replacesC1PlanId: frozen ? plan.c1PlanId : null,
    brand: { status: form.brandStatus, name: brandName }, rights: { ...RIGHTS_CHOICES[form.rightsChoice] },
    reviewedAt, expiresAt
  };
}
