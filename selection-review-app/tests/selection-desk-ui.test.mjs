import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// The desk renders synthetic display data only: no saved records, no services, no requests.
let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./selection-desk-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/SelectionDesk.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'selection-desk-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Desk from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Desk {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const product = (productId, extra = {}) => ({ productId, title: `Explicitly synthetic ${productId}`,
  productUrl: `https://www.ozon.ru/product/${productId}`, imageUrl: `https://ir.ozone.ru/s3/synthetic/${productId}.jpg`,
  price: 900, salesCount: 12, revenue: 4000, reviewCount: 4, reviewRating: 4.5,
  categoryPath: { cnTitlePath: '家居 > 收纳' }, ...extra });

const estimate = (outcome, extra = {}) => ({
  status: outcome === 'selectable' ? 'ok' : outcome === 'excluded_negative' ? 'negative' : 'incomplete',
  outcome, summary: '合成估算摘要', maximumAllInPurchaseRmb: null,
  freight: { route: null, chargeableKg: null, freightRmb: null, oversize: false }, commissionRate: 0.14, ...extra });

const view = ({ products = [], importedCandidates = [], declines = [], selections = [] } = {}) => ({
  schemaVersion: 'a-discovery-view-v1', targetStores: ['miska', 'dandanshu'],
  batches: [{ batch: { batchId: 'a-discovery-batch:synthetic', revision: 0, targetStore: 'miska',
    createdAt: '2026-09-09T04:00:00.000Z', plan: { provider: 'seerfar', direction: '普通非电桌面整理小件（合成）' } },
  jobs: [{ job: { status: 'completed', scopeBinding: { request: { method: 'category_detail' } } },
    receipt: { steps: [{ method: 'category_detail', result: { products } }] } }],
  selections, importedCandidates, declines }] });

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const props = (discoveryView, extra = {}) => ({ discoveryView, candidates: [], store: 'miska',
  onSelectProduct: forbidden, onDeclineProduct: forbidden, onLaterProduct: forbidden, onEstimate: forbidden,
  onTranslate: forbidden, onOpenCandidate: forbidden, onFindNewRound: forbidden, onOpenBoard: forbidden,
  onOpenInbox: forbidden, ...extra });

test('选品台先要求登录，再显示本店方向、查询时间和一件件商品卡', async () => {
  const locked = await render(props(null, { ownerReady: false }));
  assert.match(locked, /请先登录主人身份后查看选品台/);
  assert.doesNotMatch(locked, /待你决定/);
  const loading = await render(props(null));
  assert.match(loading, /正在读取本店的查询结果/);
  const html = await render(props(view({ products: [product('2107989735', { titleZh: '合成收纳盒' })] })));
  assert.match(html, /待你决定/);
  assert.match(html, /Miska · 普通非电桌面整理小件（合成） · 查询于 2026-09-0\d/u);
  assert.match(html, /合成收纳盒/);
  assert.match(html, /Explicitly synthetic 2107989735/);
  assert.match(html, /售价 900 卢布 · 月销 12 · 评价 4 · 评分 4\.5/);
  assert.match(html, /类目：家居 &gt; 收纳/);
  assert.match(html, /<img[^>]*src="https:\/\/ir\.ozone\.ru\/s3\/synthetic\/2107989735\.jpg"[^>]*width="132"/);
  assert.match(html, /找一轮新品/);
  assert.match(html, /J 下一件 · K 上一件 · Y 要 · N 不要/);
});

test('没算过的商品明说要先算，算过的商品显示四格利润框和标记', async () => {
  const plain = await render(props(view({ products: [product('2107989735')] })));
  assert.match(plain, /点「算利润区间」后显示/);
  assert.match(plain, /待估算/);
  const html = await render(props(view({ products: [product('2107989735', {
    estimate: estimate('selectable', { maximumAllInPurchaseRmb: 120.5,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 37.64, oversize: true } }) })] })));
  assert.match(html, /建议采购区间/);
  assert.match(html, /到手总价 ≤ ¥120\.50/);
  assert.match(html, /刚好达到本店利润门槛/);
  assert.match(html, /GUOO Economy Small · 计费 0\.7kg · ¥37\.64 · 超抛 · 占比 24%/);
  assert.match(html, /佣金<\/b><span>14%/);
  assert.doesNotMatch(html, /点「算利润区间」后显示/);
  const gap = await render(props(view({ products: [product('2107989735', { estimate: estimate('needs_data') })] })));
  assert.match(gap, /待补尺寸/);
  assert.match(gap, /资料不全，暂不能判断/);
  assert.match(gap, /待补尺寸重量/);
});

test('预估负利润不进入待决定，只留一条折叠记录，你排除过的也一样', async () => {
  const html = await render(props(view({ products: [
    product('2107989735'),
    product('2107989736', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -3.2 }) }),
    product('2107989737')
  ], declines: [{ marketProductId: '2107989737', reason: '尺寸太大' }] })));
  assert.match(html, /已自动排除 1 条（预估负利润）/);
  assert.match(html, /你已排除 1 条/);
  assert.match(html, /你的理由：尺寸太大/);
  assert.equal(html.match(/>要</gu).length, 1, '只有还没被排除的商品有「要」');
  assert.equal(html.match(/预估负利润，不建议做/gu), null, '被排除的商品不再占用主列表');
});

test('每张卡片给出要、不要的固定理由和稍后；已建卡的商品只给查看', async () => {
  const html = await render(props(view({ products: [product('2107989735')] })));
  assert.match(html, /<summary>不要<\/summary>/);
  assert.match(html, /选一个原因：/);
  for (const reason of ['尺寸太大', '利润太薄', '品牌风险', '不想做这类', '其他', '返回']) {
    assert.match(html, new RegExp(`>${reason}<`, 'u'));
  }
  assert.match(html, />稍后</);
  const imported = await render(props(view({ products: [product('2107989735')],
    importedCandidates: [{ marketProductId: '2107989735', candidateId: 'candidate:synthetic' }] })));
  assert.match(imported, /已在评审台/);
  assert.match(imported, />查看</);
  assert.equal(imported.match(/>要</gu), null);
  assert.equal(imported.match(/<summary>不要<\/summary>/gu), null);
});

test('右栏说明等你处理、进行中和本轮方向，空的时候直说没有', async () => {
  const empty = await render(props(view({ products: [] })));
  assert.match(empty, /本店当前没有等你决定的商品/);
  assert.match(empty, /现在没有等你处理的商品/);
  assert.match(empty, /本店暂时没有在做的商品/);
  const candidates = [
    { id: 'candidate:a', productName: '合成商品甲', targetStore: 'miska', workflowStatus: 'codex_processing',
      displayStatus: 'codex_processing', imageUrl: '', needsFromUser: ['补一个1688链接'],
      updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z' },
    { id: 'candidate:b', productName: '合成商品乙', targetStore: 'dandanshu', workflowStatus: 'codex_processing',
      displayStatus: 'codex_processing', imageUrl: '', needsFromUser: ['别的店的缺口'],
      updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z' }
  ];
  const html = await render(props(view({ products: [product('2107989735')] }), { candidates }));
  assert.match(html, /需要你处理（1）/);
  assert.match(html, /合成商品甲/);
  assert.match(html, /补一个1688链接/);
  assert.doesNotMatch(html, /合成商品乙/, '店铺切换后不显示别的店的商品');
  assert.match(html, /打开进行中/);
  assert.match(html, /普通非电桌面整理小件（合成）/);
});
