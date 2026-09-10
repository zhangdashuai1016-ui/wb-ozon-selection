// The server resolves current configuration and frozen price evidence. This view never creates authority.
export function productionAuthorizationInputFromCard(candidate, card) {
  const gap = reason => ({ ready: false, reason, input: null });
  const sku = candidate.lifecycleV11?.skuPackage;
  if (sku?.productionAuthorization) return gap(sku.productionAuthorization.schemaVersion === "production-authorization-v1.2"
    ? "主人精确生产授权已保存，软件将按该授权检查执行条件。" : "历史生产授权只读；不能自动转成新版授权或继续执行。");
  if (!card || card.status !== "awaiting_owner_business_confirmation" || card.ownerDecision !== null) return gap("历史主人决定只读；需要基于完整当前方案重新取得精确生产确认。");
  const prepared = candidate.productionOwnerPreparation;
  if (!prepared || prepared.contractVersion !== "production-authorization-v1.2") return gap("当前商品的生产确认资料尚未取得。");
  if (prepared.ready !== true) return gap(prepared.gaps?.map(item => item.message).filter(Boolean).join("；") || "生产确认资料不完整，请查看当前商品的配置与证据缺口。");
  const source = prepared.source;
  const frozen = sku?.c2FinalAssets?.productionAuthorizationPreparation;
  if (!source || source.dataRevision !== candidate.dataRevision || source.skuRevision !== sku?.dataRevision ||
      source.cardId !== card.cardId || source.cardRevision !== card.cardRevision ||
      source.sourcePreparationFingerprint !== frozen?.preparationFingerprint || source.sourceFinalCardInputFingerprint !== frozen?.finalCardInputFingerprint) {
    return gap("商品、确认卡或冻结价格已更新，请载入当前确认资料。");
  }
  const scope = prepared.scope;
  if (!prepared.store?.displayName || !Array.isArray(prepared.executionBindings) || prepared.executionBindings.length === 0 ||
      prepared.executionBindings.some(binding => !binding.bindingId || !binding.configurationVersion || !binding.warehouseName) ||
      !Number.isFinite(scope?.buyerTargetPrice?.amount) || scope.buyerTargetPrice.amount <= 0 || scope.buyerTargetPrice.currency !== "RUB" ||
      !Number.isFinite(scope?.platformWritePrice?.amount) || scope.platformWritePrice.amount <= 0 || scope.platformWritePrice.currency !== "CNY" ||
      !Number.isFinite(scope?.priceConversion?.rubPerCny) || scope.priceConversion.rubPerCny <= 0 ||
      !scope.priceConversion.evidenceRef || !Number.isFinite(Date.parse(scope.priceConversion.checkedAt)) ||
      !Number.isInteger(scope.stock) || scope.stock < 0 || !Array.isArray(scope.allowedWriteFields) || !scope.allowedWriteFields.length ||
      !Array.isArray(scope.exclusions) || !["create_draft_only", "create_and_allow_validation_moderation"].includes(scope.publishScope)) {
    return gap("服务端确认资料不完整，不能补默认值形成生产授权。");
  }
  return { ready: true, reason: "请核对本件商品、已配置仓库、价格、库存和最终素材；一次确认后保存精确生产授权。",
    input: { contractVersion: prepared.contractVersion, ...source } };
}
