import { productionAuthorizationInputFromCard } from './productionAuthorizationInput.js';
import { siblingBatchReview } from './siblingBatchReview.js';

/** Compose a single owner decision from current server preparations only. */
export function siblingBatchAuthorizationInput(parent, candidates, bindingId) {
  const review = siblingBatchReview(parent, candidates);
  if (!review?.ready) return { ready: false, reason: '批次成员还有 A/B/C1/C2 或当前价格、库存缺项。', input: null };
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
    const binding = preparation?.executionBindings?.find(item => item.bindingId === bindingId);
    if (!decision.ready || !commercial || !binding || !commercial.merchantSku ||
        !Number.isSafeInteger(commercial.stock) || commercial.stock < 0) {
      return { ready: false, reason: `${row.color} 的最终卡、经营数据或仓库绑定已变化。`, input: null };
    }
    members.push({ candidateId: candidate.id, ownerInput: { ...decision.input,
      bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
      merchantSku: commercial.merchantSku, confirmExactScope: true } });
  }
  return { ready: true, reason: '', input: { confirmAll: true, excludedOfferIds: [excluded], members } };
}
