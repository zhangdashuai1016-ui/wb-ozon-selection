import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// The product page renders synthetic display data only: no saved records, no services, no requests.
let renderer;
async function render(props) {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./product-page-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'product-page-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Page from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Page {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}

const forbidden = () => { throw new Error('RENDER_MUST_NOT_START_WORK'); };
const candidate = (extra = {}) => ({
  id: 'candidate:synthetic-product-page', dataRevision: 4, targetStore: 'miska', targetPlatform: 'ozon',
  productName: 'Explicitly synthetic organizer', imageUrl: 'https://images.example.test/synthetic-organizer.png',
  storeRef: { stableStoreId: 'miska', platformStoreId: 'synthetic-seller', mappingVersion: 'synthetic-stores-v1' },
  workflowStatus: 'codex_processing', sourceUrl: '', purchasePriceRmb: 18.86, domesticShippingRmb: 2.96,
  packedWeightKg: 1.3, dimensionsCm: { length: 75, width: 21, height: 4 }, ...extra
});
const marketSnapshot = {
  schemaVersion: 'sales-snapshot-v1.1', snapshotId: 'sales-snapshot:seerfar_category_detail:synthetic',
  source: 'seerfar_category_detail', currentPrice: 1850, currency: 'RUB', collectedAt: '2026-09-10T06:30:00.000Z',
  marketMetrics: { salesCount: 330, salesWindow: null, revenue: 610500, reviewCount: 371, reviewRating: 4.7 }
};
const draft = {
  schemaVersion: 'supplier-draft-v1', declaredBy: 'owner', declaredAt: '2026-09-11T02:00:00.000Z',
  sourceUrl: 'https://detail.1688.com/offer/876240928352.html', sourceUrlType: 'detail', offerId: '876240928352',
  goodsPriceRmb: 15.9, domesticShippingRmb: 2.96, allInPurchaseRmb: 18.86, packedWeightKg: 1.3,
  dimensionsCm: { length: 75, width: 21, height: 4 }, targetSalePriceRub: 1850, note: null, provenance: 'owner_declared'
};
const blockedEstimate = {
  schemaVersion: 'supplier-draft-estimate-v1', estimatedAt: '2026-09-11T02:00:01.000Z',
  estimate: { status: 'incomplete', missing: ['可行物流线路'], freight: { status: 'no_feasible_route' }, commission: { rate: 0.14 }, ceiling: null },
  profitAtDeclaredPurchase: null,
  routeBlock: { code: 'no_feasible_route', message: '当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米，或按大件重量（≥2.001 公斤）重新申报。',
    foldSideMaxCm: 60, bigParcelMinKg: 2.001,
    routes: [{ route: 'GUOO Economy Small', reason: 'side_outside_limit', detail: '单边最大 60 厘米，当前最长边 75 厘米' },
      { route: 'GUOO Economy Big', reason: 'weight_outside_limit', detail: '可走 2.001-30 公斤，当前 1.3 公斤' }] }
};
const okEstimate = {
  schemaVersion: 'supplier-draft-estimate-v1', estimatedAt: '2026-09-11T02:00:01.000Z',
  estimate: { status: 'ok', missing: [], commission: { rate: 0.14 },
    freight: { status: 'quoted', oversize: false, chosen: { route: 'GUOO Economy Small', chargeableKg: 1.3, freightRmb: 54.5 } },
    ceiling: { maximumAllInPurchaseRmb: 60.12 } },
  profitAtDeclaredPurchase: { allInPurchaseRmb: 18.86, unitProfitRmb: 41.26, marginRate: 0.284, passes: true,
    thresholdPolicy: 'either', meetsMinimumUnitProfit: true, meetsTargetMargin: true, withinPurchaseCeiling: true },
  routeBlock: null
};
const props = (extra = {}) => ({ candidate: candidate(), view: null, extensionStatus: { code: 'disconnected', label: '插件未安装或未连接' },
  onSaveDraft: forbidden, onRequestCapture: forbidden, onOpenLegacyCard: forbidden, onBack: forbidden, ...extra });

test('商品页显示中文标题、店铺和六步导航，当前停在找货', async () => {
  const html = await render(props({ titleZh: '合成收纳盒' }));
  assert.match(html, /合成收纳盒/);
  assert.match(html, /Miska/);
  assert.match(html, /Explicitly synthetic organizer/);
  for (const step of ['选定', '找货', '算利润', '文案素材', '上架', '回读']) assert.match(html, new RegExp(step));
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">2<\/span>找货/);
  assert.match(html, /<img[^>]*src="https:\/\/images\.example\.test\/synthetic-organizer\.png"[^>]*width="88"/);
  // Every other step stays folded and says so plainly.
  assert.equal((html.match(/未开始/gu) ?? []).length, 5);
  assert.doesNotMatch(html, /保存A卡并等待插件自动采集/);
});

test('找货表单先按已保存的逐项资料预填，有找货方案后按方案预填', async () => {
  const prefilledFromFields = await render(props());
  assert.match(prefilledFromFields, /1688 商品链接/);
  assert.match(prefilledFromFields, /id="supply-source-url"[^>]*value=""/);
  // The all-in purchase price minus the saved domestic shipping is the goods price the owner had declared.
  assert.match(prefilledFromFields, /id="supply-goods-price"[^>]*value="15\.9"/);
  assert.match(prefilledFromFields, /id="supply-domestic-shipping"[^>]*value="2\.96"/);
  assert.match(prefilledFromFields, /id="supply-weight"[^>]*value="1\.3"/);
  assert.match(prefilledFromFields, /id="supply-length"[^>]*value="75"/);
  assert.match(prefilledFromFields, /id="supply-width"[^>]*value="21"/);
  assert.match(prefilledFromFields, /id="supply-height"[^>]*value="4"/);
  assert.match(prefilledFromFields, /请粘贴1688商品详情链接或分享短链/);
  const saved = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(saved, /id="supply-source-url"[^>]*value="https:\/\/detail\.1688\.com\/offer\/876240928352\.html"/);
  assert.match(saved, /id="supply-target-price"[^>]*value="1850"/);
  assert.doesNotMatch(saved, /请粘贴1688商品详情链接或分享短链/);
  assert.match(saved, /市场快照：Seerfar 2026-09-10 · 售价 1850 卢布 · 30 天销量 330 · 评价 371/);
  assert.match(saved, /按你填的到手总价 ¥18\.86：单件利润 ¥41\.26 · 利润率 28% · 达到本店利润门槛/);
  assert.match(saved, /采购上限 ¥60\.12 · GUOO Economy Small · 计费 1\.3 公斤 · 运费 ¥54\.50 · 佣金 14%/);
});

test('没有可走线路时按资费表原话给出折叠或按大件的提示', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: blockedEstimate, marketSnapshot } }));
  assert.match(html, /当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米，或按大件重量（≥2\.001 公斤）重新申报。/);
  assert.match(html, /GUOO Economy Small：单边最大 60 厘米，当前最长边 75 厘米/);
  assert.match(html, /GUOO Economy Big：可走 2\.001-30 公斤，当前 1\.3 公斤/);
  assert.match(html, /还不能算利润：缺可行物流线路。/);
  assert.match(html, /role="alert"/);
});

test('插件没连上时给一句安装提示，连上后不再显示', async () => {
  const absent = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(absent, /插件状态：插件未安装或未连接/);
  assert.match(absent, /还没连上插件：打开 Chrome 的 chrome:\/\/extensions，开启开发者模式，点「加载已解压的扩展程序」，选择本项目的 extension\/1688-capture 目录。/);
  assert.match(absent, /申请插件采集/);
  assert.match(absent, /还没有申请过插件采集。/);
  const connected = await render(props({ extensionStatus: { code: 'authentication_unverified', label: '已检测到插件v1.2.7' },
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot },
    candidate: candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } }) }));
  assert.doesNotMatch(connected, /还没连上插件/);
  assert.match(connected, /已排队，等插件领取本次采集。/);
});

test('没有找货方案时不能申请采集，也不显示假的市场快照或利润', async () => {
  const html = await render(props());
  assert.match(html, /市场快照：还没有本商品的查询结果快照。/);
  assert.match(html, /填好上面的资料并保存后，这里显示采购上限和利润。/);
  assert.match(html, /先保存上面的找货方案，才能申请采集。/);
  assert.match(html, /申请插件采集<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/);
  assert.match(html, /保存只记录你填的方案，不会确认供货，也不会开始采购。/);
});
