import { productionAuthorizationInputFromCard } from './productionAuthorizationInput.js';
import { siblingBatchReview } from './siblingBatchReview.js';

/** Unsettled work remains occupied even when its evidence is no longer the current selection. */
export function siblingBatchAccountReadBlocker(candidates) {
  const reads = candidates.flatMap(candidate => candidate?.ozonAccountReadPreparation?.runtime ?? []);
  if (reads.some(read => read.status === 'unknown_outcome')) return '本批账户请求结果待核对，不能确认新的上架批次。';
  if (reads.some(read => ['queued', 'claimed', 'waiting_platform'].includes(read.status))) {
    return '本批账户核验尚未结束，请等待已授权读取完成后再核对最终上架。';
  }
  return null;
}

/** Compose a single owner decision from current server preparations only. */
export function siblingBatchAuthorizationInput(parent, candidates, bindingId, options = {}) {
  if (typeof parent?.id !== 'string' || parent.id.trim() === '' ||
      !Number.isSafeInteger(parent.dataRevision) || parent.dataRevision < 1) {
    return { ready: false, reason: '父卡身份或当前版本缺失，请刷新批次清单。', input: null };
  }
  const review = siblingBatchReview(parent, candidates);
  if (!review?.ready) return { ready: false, reason: '批次成员还有 A/B/C1/C2 或当前价格、库存缺项。', input: null };
  const accountReadBlocker = siblingBatchAccountReadBlocker(review.rows.map(row => candidates.find(candidate => candidate.id === row.candidateId)));
  if (accountReadBlocker !== null) return { ready: false, reason: accountReadBlocker, input: null };
  if (!['create_only', 'write_authorized_stock'].includes(options.inventoryAction)) {
    return { ready: false, reason: '请选择仅创建商品或写入已授权库存的明确范围。', input: null };
  }
  const commonBinding = review.executionBindings.find(item => item.bindingId === bindingId);
  if (!commonBinding) return { ready: false, reason: '请选择本批所有规格共同有效的仓库绑定。', input: null };
  const excluded = parent.lifecycleV11?.skuPackage?.productionAuthorization?.lockedScope?.merchantSku;
  if (typeof excluded !== 'string' || excluded.trim() === '') {
    return { ready: false, reason: '首件历史商家货号缺失，不能证明该商品已从本批排除。', input: null };
  }
  const members = [];
  for (const row of review.rows) {
    const candidate = candidates.find(item => item.id === row.candidateId);
    const preparation = candidate?.productionOwnerPreparation;
    const decision = productionAuthorizationInputFromCard(candidate, candidate?.lifecycleV11?.skuPackage?.productionConfirmationCard);
    const commercial = preparation?.commercialDraft;
    const binding = preparation?.executionBindings?.find(item => item.bindingId === commonBinding.bindingId &&
      item.configurationVersion === commonBinding.configurationVersion &&
      item.warehouseName === commonBinding.warehouseName);
    if (!decision.ready || !commercial || !binding || !commercial.merchantSku ||
        !Number.isSafeInteger(commercial.stock) || commercial.stock < 0) {
      return { ready: false, reason: `${row.color} 的最终卡、经营数据或仓库绑定已变化。`, input: null };
    }
    members.push({ candidateId: candidate.id, ownerInput: { ...decision.input,
      bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
      merchantSku: commercial.merchantSku, confirmExactScope: true } });
  }
  if (options.eVerificationMode !== undefined && options.eVerificationMode !== 'owner_media_review_in_sale') {
    return {ready:false,reason:'E 核验范围无效，请刷新最终确认卡。',input:null};
  }
  const currentE=options.eVerificationMode==='owner_media_review_in_sale';
  return { ready: true, reason: '', input: { confirmAll: true,
    parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    excludedOfferIds: [excluded], members,
    ...(currentE?{importLimitUse:{schemaVersion:'ozon-product-import-batch-limit-use-input-v1',
      evidenceRef:'official:ozon-product-import-batch-limit:20261018',decision:'use_for_this_batch_once'}}:{}),
    postImportScope: { schemaVersion: currentE?'d-batch-post-import-scope-v2':'d-batch-post-import-scope-v1', inventoryAction: options.inventoryAction,
      eReadbackOfferIds: members.map(member => member.ownerInput.merchantSku),
      ...(currentE?{inSaleList:{schemaVersion:'ozon-in-sale-list-authorization-v1',
        decision:'read_store_in_sale_list_for_batch',officialEvidenceRef:'official:ozon-in-sale-list:20261018',
        policy:{pageSize:1000,maxPages:3,requestTimeoutMs:30000,durationMs:90000}}}:{}) } } };
}
