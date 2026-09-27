import { createFormalC1DraftFixture } from './formal-c1-flow-fixture.mjs';
import { createC1SkuRightsReviewRecord } from '../../lib/c1-sku-rights-review.mjs';

function siblingCandidate({ candidateId, frozen }) {
  const fixture = createFormalC1DraftFixture({ candidateId, variantKey: '颜色:黑cp',
    skuAttributes: { 颜色: '黑cp' } });
  const candidate = structuredClone(fixture.candidate);
  candidate.productName = frozen ? '合成黑cp已冻结缺映射' : '合成黑cp未冻结可映射';
  candidate.workflowStatus = 'listing_preparation';
  candidate.lifecycleV11.skuPackage = structuredClone(frozen ? fixture.checked.skuPackage : fixture.created.skuPackage);
  const sku = candidate.lifecycleV11.skuPackage;
  if (!frozen) sku.c1RightsReviewRecord = createC1SkuRightsReviewRecord({
    plan: sku.c1ProductPlan, sourceIdentity: sku.g1Identity,
    sourceCandidateRevision: candidate.dataRevision - 1,
    declaredByUserId: 'synthetic-owner', declaredAt: fixture.at,
    ownerDeclaration: { brand: { status: 'unbranded', name: null },
      rights: { status: 'verified', basis: 'no_third_party_rights_identified' },
      reviewedAt: fixture.at, expiresAt: '2099-01-01T00:00:00.000Z' }
  });
  sku.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes = [
    { fieldKey: '10096', label: 'Цвет товара', labelZh: '商品颜色', required: false, complexId: 0, dictionaryId: 1494 },
    { fieldKey: '10097', label: 'Название цвета', labelZh: '颜色名称', required: false, complexId: 0, dictionaryId: 0 }
  ];
  candidate.sourceCapture = { status: 'captured_waiting_owner_selection',
    selectedSkuIds: [sku.supplierSkuId], skuChoices: [{ sourceSkuId: sku.supplierSkuId,
      attributes: { 颜色: '黑cp' } }] };
  candidate.siblingSourceV1 = { supplierSkuId: sku.supplierSkuId,
    parentCandidateId: 'candidate:synthetic-parent', parentCardBinding: {
      descriptionCategoryId: 17028665, typeId: 92935, model: 'synthetic-model', brand: 'synthetic-brand',
      parentImageSha256s: ['a'.repeat(64)] } };
  return candidate;
}

/** Synthetic state for isolated API and browser review. No account or production data. */
export function siblingColorState() {
  const frozen = siblingCandidate({ candidateId: 'SYNTHETIC-COLOR-FROZEN', frozen: true });
  const editable = siblingCandidate({ candidateId: 'SYNTHETIC-COLOR-EDITABLE', frozen: false });
  return { meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [frozen, editable], dispatches: [], runtime: {}, evidencePacks: [] };
}
