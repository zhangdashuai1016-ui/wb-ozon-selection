import test from 'node:test';
import assert from 'node:assert/strict';
import { siblingBatchReview } from '../src/siblingBatchReview.js';

function family(count) {
  const first = '6222816678021';
  const selected = Array.from({ length: count }, (_, index) => String(6222816678021 + index));
  const parent = { id: 'candidate:synthetic-family', dataRevision: 12,
    lifecycleV11: { skuPackage: { supplierSkuId: first, technicalStatus: 'unknown_outcome' } },
    sourceCapture: { selectedSkuIds: selected, skuChoices: selected.map((sourceSkuId, index) => ({
      sourceSkuId, variantName: `颜色 ${index}`, attributes: { 颜色: `颜色 ${index}` }
    })) } };
  const children = selected.slice(1).map(sourceSkuId => ({ id: `candidate:${sourceSkuId}`,
    siblingSourceV1: { parentCandidateId: parent.id, supplierSkuId: sourceSkuId } }));
  return { parent, children };
}

test('one selected 32-variant family projects 31 internal rows and never includes the unknown first import', () => {
  const { parent, children } = family(32);
  const before = structuredClone({ parent, children });
  const review = siblingBatchReview(parent, [parent, ...children]);
  assert.equal(review.rows.length, 31);
  assert.deepEqual(review.excludedSourceSkuIds, ['6222816678021']);
  assert.equal(review.rows.every(row => row.candidateId !== parent.id && row.status === 'blocked'), true);
  assert.equal(review.rows.every(row => row.gaps.includes('B 当前店铺正式利润待完成')), true);
  assert.deepEqual({ parent, children }, before);
});

test('current three selected colors show their own missing evidence and leave the unselected color out', () => {
  const { parent, children } = family(4);
  parent.sourceCapture.selectedSkuIds = [parent.sourceCapture.selectedSkuIds[0],
    ...parent.sourceCapture.selectedSkuIds.slice(1, 4)];
  parent.sourceCapture.skuChoices.push({ sourceSkuId: '6222816679000', attributes: { 颜色: '未选颜色' } });
  children[0].lifecycleV11 = { skuPackage: { selectedSupplySnapshot: { ownerSupplyConfirmation: { status: 'confirmed' } },
    profitModels: [{ profitModelVersion: 'profit:synthetic', result: 'passed', commissionMode: 'exact' }],
    activeProfitModelVersion: 'profit:synthetic' } };
  const review = siblingBatchReview(parent, children);
  assert.equal(review.rows.length, 3);
  assert.equal(review.rows.some(row => row.sourceSkuId === '6222816679000'), false);
  assert.equal(review.rows[0].gaps.includes('A 供应规格及数量 1 证据待确认'), false);
  assert.equal(review.rows[0].gaps.includes('B 当前店铺正式利润待完成'), false);
  assert.equal(review.rows[0].gaps.includes('C1 本规格事实及官方颜色属性待确认'), true);
  assert.equal(review.rows[1].gaps.includes('A 供应规格及数量 1 证据待确认'), true);
});
