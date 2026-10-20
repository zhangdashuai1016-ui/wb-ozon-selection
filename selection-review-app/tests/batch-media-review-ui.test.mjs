import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readyAuthorizationFamily } from './fixtures/sibling-batch-final-fixture.mjs';
import { createDBatchMediaReviewFixture } from './helpers/d-batch-media-review-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { projectDBatchEMediaReview, confirmDBatchEMediaReview } from '../lib/d-batch-e-media-review.mjs';
import { projectDBatchExecutionView } from '../lib/d-batch-execution-view.mjs';

let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./batch-media-review-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/SiblingBatchPreparation.jsx', import.meta.url));
    const state = fileURLToPath(new URL('../src/siblingPreparationState.js', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), {
      name: 'batch-media-review-ui-test', resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import SiblingBatchPreparation from ${JSON.stringify(component)};
        import {createPreparationSaveState} from ${JSON.stringify(state)};
        export const render=props=>renderToStaticMarkup(<SiblingBatchPreparation
          preparationSaveState={createPreparationSaveState()} {...props}/>);` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false,
      rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const actions = { onAuthorize: forbidden, onConfirmA: forbidden, onConfirmC1: forbidden,
  onConfirmC2: forbidden, onRefreshExecution: forbidden, onResumeStock: forbidden, onConfirmMedia: forbidden };

function executionProps(fixture, document = fixture.document) {
  const { parent } = readyAuthorizationFamily();
  const child = structuredClone(document.candidates[0]);
  const sourceSkuId = child.lifecycleV11.skuPackage.supplierSkuId;
  parent.sourceCapture.selectedSkuIds = [parent.lifecycleV11.skuPackage.supplierSkuId, sourceSkuId];
  parent.sourceCapture.skuChoices = [{ sourceSkuId, attributes: { 颜色: '合成颜色' } }];
  child.siblingSourceV1 = { parentCandidateId: parent.id, supplierSkuId: sourceSkuId };
  return { parent, siblings: [child], ...actions,
    executionView: projectDBatchExecutionView(document, fixture.batchId) };
}

test('family final card renders before execution without dereferencing a missing result view', async () => {
  const { parent, child } = readyAuthorizationFamily();
  const html = await render({ parent, siblings: [child], executionView: null, ...actions });
  assert.match(html, /整批最终清单/u);
  assert.match(html, /确认上架（含创建和库存）/u);
  assert.match(html, /MERCHANT-CHILD/u);
  assert.doesNotMatch(html, /aria-label="本批逐项执行结果"|aria-label="图片核对 /u);
  assert.doesNotMatch(html, /确认本款图片匹配|在售名单读取：已使用/u);
});

test('the actual execution branch exposes ordered source and platform images with confirmation disabled until loaded', async () => {
  const fixture = createDBatchMediaReviewFixture();
  const props = executionProps(fixture), review = props.executionView.members[0].mediaReview;
  const html = await render(props);
  assert.match(html, /aria-label="本批逐项执行结果"/u);
  assert.ok(html.includes(`aria-label="图片核对 ${fixture.candidateId}"`));
  assert.match(html, /等待主人并排核图/u);
  assert.match(html, /在售名单读取：已使用 1 \/ 3 次/u);
  assert.match(html, /本批目标已在官方在售名单中命中/u);
  assert.match(html, /1 · 首图/u);
  const images = [...html.matchAll(/<img\b[^>]*alt="(?:已批准原图|平台回读图) [12]"[^>]*>/gu)].map(match => match[0]);
  assert.equal(images.length, 4);
  const expected = review.pairs.flatMap(pair => [pair.expected.previewSrc, pair.observed.previewSrc]);
  images.forEach((image, index) => {
    assert.ok(image.includes(`src="${expected[index]}"`), image);
    assert.match(image, /referrerPolicy="no-referrer"/u);
  });
  assert.match(html, /等待两侧图片完整显示/u);
  for (const label of ['图片内容与批准原图一致', '首图一致', '图片数量及顺序一致']) {
    assert.ok(html.includes(`<input type="checkbox" disabled=""/>${label}`), label);
  }
  assert.match(html, /<button[^>]*disabled=""[^>]*>确认本款图片匹配<\/button>/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>图片不一致，停止验证<\/button>/u);
  assert.doesNotMatch(html, /整批最终清单|确认上架（含创建和库存）|E 已独立核验通过/u);
});

test('saved owner decisions remain visible in the parent view while unknown moderation and missing sale evidence block E', async () => {
  for (const decision of ['matches', 'mismatch']) {
    const fixture = createDBatchMediaReviewFixture({ inSale: false, observation: { moderationStatus: 'unknown' } });
    const repository = createMemoryBusinessStateRepository(fixture.document);
    const review = projectDBatchEMediaReview(fixture);
    const confirmedAt = '2026-10-18T14:00:00.000Z';
    const actor = createActorContext({ userId: 'synthetic-media-owner', sessionId: 'synthetic-media-session',
      actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: confirmedAt });
    await confirmDBatchEMediaReview({ repository, runtimeMode: 'local_development', serverClock: () => confirmedAt,
      actor, input: { scope: review.scope, decision, confirmContent: true, confirmHero: true, confirmOrder: true } });
    const props = executionProps(fixture, await repository.readSnapshot());
    assert.equal(props.executionView.members[0].listedVerified, false);
    const html = await render(props);
    assert.match(html, /aria-label="本批逐项执行结果"/u);
    assert.match(html, /moderation_not_approved/u);
    assert.match(html, /in_sale_not_observed/u);
    assert.match(html, decision === 'matches' ? /已保存主人核图确认/u : /主人已标记图片不一致，E 验证未通过/u);
    assert.doesNotMatch(html, /确认本款图片匹配|图片不一致，停止验证|E 已独立核验通过/u);
  }
});
