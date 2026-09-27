const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Read-only family projection. It never turns shared evidence into a child conclusion. */
export function siblingBatchReview(parent, candidates) {
  const capture = parent?.sourceCapture;
  const selected = capture?.selectedSkuIds;
  const choices = capture?.skuChoices;
  if (!Array.isArray(selected) || !Array.isArray(choices) || !Array.isArray(candidates)) return null;
  const parentSkuId = parent.lifecycleV11?.skuPackage?.supplierSkuId;
  const siblings = candidates.filter(candidate => candidate.siblingSourceV1?.parentCandidateId === parent.id);
  const rows = selected.filter(id => id !== parentSkuId).map(sourceSkuId => {
    const matches = choices.filter(choice => choice.sourceSkuId === sourceSkuId);
    const children = siblings.filter(candidate => candidate.siblingSourceV1.supplierSkuId === sourceSkuId);
    const choice = matches.length === 1 ? matches[0] : null;
    const child = children.length === 1 ? children[0] : null;
    const sku = child?.lifecycleV11?.skuPackage;
    const gaps = [];
    if (!choice || !text(choice.attributes?.颜色)) gaps.push('供应颜色身份待核验');
    if (!child) gaps.push('内部规格记录未建立');
    else {
      if (!sku?.selectedSupplySnapshot?.ownerSupplyConfirmation ||
          sku.selectedSupplySnapshot.ownerSupplyConfirmation.status !== 'confirmed') gaps.push('A 供应规格及数量 1 证据待确认');
      const profit = sku?.profitModels?.find(model => model.profitModelVersion === sku.activeProfitModelVersion);
      if (profit?.result !== 'passed' || !['exact', 'official_reference'].includes(profit?.commissionMode)) {
        gaps.push('B 当前店铺正式利润待完成');
      }
      if (!['facts_checked', 'seo_draft_ready'].includes(sku?.c1ProductPlan?.status)) {
        gaps.push('C1 本规格事实及官方颜色属性待确认');
      }
      if (!Array.isArray(sku?.c2FinalAssets?.productionAuthorizationPreparation?.finalUploads) ||
          sku.c2FinalAssets.productionAuthorizationPreparation.finalUploads.length === 0) {
        gaps.push('C2 本色最终素材及主图待确认');
      }
      if (sku?.productionConfirmationCard?.status !== 'awaiting_owner_business_confirmation') {
        gaps.push('最终商品确认卡待生成');
      }
      if (child.productionOwnerPreparation?.ready !== true) {
        const preparation = child.productionOwnerPreparation?.gaps;
        if (Array.isArray(preparation) && preparation.length > 0) {
          gaps.push(...preparation.map(item => item.message).filter(Boolean));
        } else gaps.push('生产价格、库存及店铺绑定待核验');
      }
    }
    return { sourceSkuId, color: text(choice?.attributes?.颜色) || text(choice?.variantName) || '颜色待核验',
      candidateId: child?.id ?? null, status: gaps.length === 0 ? 'ready_for_batch_owner_review' : 'blocked', gaps,
      buyerPriceRub: child?.productionOwnerPreparation?.scope?.buyerTargetPrice?.amount ?? null,
      writePriceCny: child?.productionOwnerPreparation?.scope?.platformWritePrice?.amount ?? null,
      stock: child?.productionOwnerPreparation?.scope?.stock ?? null };
  });
  return { parentCandidateId: parent.id, sourceRevision: parent.dataRevision,
    excludedSourceSkuIds: parentSkuId ? [parentSkuId] : [], rows,
    ready: rows.length > 0 && rows.every(row => row.status === 'ready_for_batch_owner_review') };
}
