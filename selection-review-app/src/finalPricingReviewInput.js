const FACTS = ['exactProduct', 'exactSpecification', 'sameMarket', 'currentlyForSale'];
export const FINAL_PRICING_FACT_LABELS = Object.freeze({ exactProduct: '精确同款', exactSpecification: '相同规格', sameMarket: '相同市场', currentlyForSale: '当前在售' });
export function newFinalPricingReview(snapshotId) {
  return { snapshotId, ...Object.fromEntries(FACTS.map(key => [key, { value: '', evidenceRef: '' }])), salesWindow: null, anomaly: null };
}
function reference(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(value) || ['unknown', 'null', 'undefined'].includes(value.trim())) throw new Error(`请填写${label}的精确来源引用。`);
  return value.trim();
}
function number(value, label, integer = false) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || (integer && !Number.isSafeInteger(Number(value)))) throw new Error(`请填写有效${label}。`);
  return Number(value);
}
export function buildFinalPricingReviewInput({ candidate, sourceRevision, selectedPriceRub, reviews }) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const reviewable = sku?.businessPhase === 'C2' || (sku?.businessPhase === 'B' && candidate.lifecycleV11.finalPricingReviewStatus === 'profit_rejected');
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || sourceRevision !== candidate.dataRevision || !reviewable || sku.productionAuthorization || sku.productionRecord || sku.dHandoff) throw new Error('当前商品不处于可提交最终定价比较的修订。');
  const price = number(selectedPriceRub, '最终成交价');
  if (price <= 0) throw new Error('最终成交价必须大于0。');
  if (!Array.isArray(reviews) || reviews.length < 1 || reviews.length > 20 || new Set(reviews.map(item => item.snapshotId)).size !== reviews.length) throw new Error('请选择1至20条不重复的已保存样本；不足多个有效样本不能完成最终比较。');
  const saved = candidate.salesSnapshotsV11 || [];
  const normalized = reviews.map(review => {
    if (saved.filter(snapshot => snapshot.snapshotId === review.snapshotId).length !== 1) throw new Error('样本不属于当前已保存资料。');
    const facts = Object.fromEntries(FACTS.map(key => {
      const fact = review[key];
      if (![true, false, 'true', 'false'].includes(fact?.value)) throw new Error(`请明确核对${FINAL_PRICING_FACT_LABELS[key]}，不能默认确认。`);
      return [key, { value: fact.value === true || fact.value === 'true', evidenceRef: reference(fact.evidenceRef, FINAL_PRICING_FACT_LABELS[key]) }];
    }));
    let salesWindow = null;
    if (review.salesWindow !== null) {
      const value = review.salesWindow;
      if (!value || !['official_actual', 'third_party_estimate'].includes(value.provenance) || !['current', 'expired', 'unknown'].includes(value.validityStatus)) throw new Error('请明确销量来源类型和时效状态。');
      for (const key of ['startDate', 'endDate']) if (!/^\d{4}-\d{2}-\d{2}$/.test(value[key]) || !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString().slice(0, 10) !== value[key]) throw new Error('请填写真实销量周期日期。');
      if (number(value.dayCount, '来源明确的统计天数', true) !== 30) throw new Error('统计来源必须明确为30天，不能按日期猜测。');
      salesWindow = { count: number(value.count, '销量', true), startDate: value.startDate, endDate: value.endDate, dayCount: 30,
        provenance: value.provenance, evidenceRef: reference(value.evidenceRef, '销量'), validityStatus: value.validityStatus, validityEvidenceRef: reference(value.validityEvidenceRef, '销量时效') };
    }
    let anomaly = null;
    if (review.anomaly !== null) {
      if (!['brand_difference', 'promotion', 'specification_difference', 'anomalous_price'].includes(review.anomaly?.reason)) throw new Error('请明确异常原因。');
      anomaly = { reason: review.anomaly.reason, evidenceRef: reference(review.anomaly.evidenceRef, '异常') };
    }
    return { snapshotId: review.snapshotId, ...facts, salesWindow, anomaly };
  });
  return { candidateId: candidate.id, expectedRevision: sourceRevision, skuPackageId: sku.skuPackageId, selectedPriceRub: price, reviews: normalized,
    idempotencyKey: `final-pricing:${candidate.id}:${sourceRevision}`, auditEventId: `final-pricing-audit:${candidate.id}:${sourceRevision}` };
}
