import test from 'node:test';
import assert from 'node:assert/strict';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { buildProductionOwnerPreparationView } from '../lib/production-owner-preparation.mjs';
import { prepareProductionCommercialDraft } from '../lib/production-commercial-draft.mjs';
import { siblingBatchAuthorizationInput } from '../src/siblingBatchAuthorizationInput.js';

test('one current final card yields one batch authorization request and excludes the previous import', () => {
  const source = productionOwnerDecisionFixture();
  const prepared = prepareProductionCommercialDraft({ candidate: source.candidate,
    merchantSku: 'MERCHANT-CHILD', stock: 37, savedByUserId: 'synthetic-owner',
    savedAt: source.args.serverClock(), merchantSkuClaims: [] });
  const child = prepared.candidate;
  child.productionOwnerPreparation = buildProductionOwnerPreparationView({ candidate: child,
    configuration: source.configuration, evidencePacks: source.evidencePacks,
    currentCommissionCatalogs: source.currentCommissionCatalogs, observedAt: source.args.serverClock() });
  assert.equal(child.productionOwnerPreparation.ready, true);
  // This tests browser payload composition; the server revalidates sibling grouping and color.
  child.siblingSourceV1 = { parentCandidateId: 'candidate:synthetic-parent', supplierSkuId: child.lifecycleV11.skuPackage.supplierSkuId };
  const parent = { id: 'candidate:synthetic-parent', dataRevision: 10,
    sourceCapture: { selectedSkuIds: ['PARENT-SKU', child.lifecycleV11.skuPackage.supplierSkuId],
      skuChoices: [{ sourceSkuId: child.lifecycleV11.skuPackage.supplierSkuId,
        attributes: { 颜色: '黑色' } }] },
    lifecycleV11: { skuPackage: { supplierSkuId: 'PARENT-SKU', technicalStatus: 'unknown_outcome',
      productionAuthorization: { lockedScope: { merchantSku: 'MERCHANT-PREVIOUS' } } } } };
  const decision = siblingBatchAuthorizationInput(parent, [child], source.args.input.bindingId);
  assert.equal(decision.ready, true);
  assert.deepEqual(decision.input.excludedOfferIds, ['MERCHANT-PREVIOUS']);
  assert.equal(decision.input.members[0].ownerInput.merchantSku, 'MERCHANT-CHILD');
  assert.equal(decision.input.members[0].ownerInput.confirmExactScope, true);
  const stale = structuredClone(child);
  stale.productionOwnerPreparation.source.dataRevision -= 1;
  assert.equal(siblingBatchAuthorizationInput(parent, [stale], source.args.input.bindingId).ready, false);
});
