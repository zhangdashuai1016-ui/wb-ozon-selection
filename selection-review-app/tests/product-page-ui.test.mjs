import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

// The product page renders synthetic display data only: no saved records, no services, no requests.
let renderer;
async function pageModule() {
  if (!renderer) {
    const entry = fileURLToPath(new URL('./product-page-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/ProductPage.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), { name: 'product-page-ui-test',
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Page, {stepNotice, thresholdBasisLine, captureStatusLine, captureNeedsOwnerReview, captureReviewPayload,
        captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload, CAPTURE_RECAPTURE_REASONS,
        currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice, skuChoiceHeadline, skuChoiceSwing,
        skuChoiceSummary, selectAllState, skuChoicePayload, skuWeightGapNotice, foldedStepLine, foldedStepState} from ${JSON.stringify(component)};
      export {stepNotice, thresholdBasisLine, captureStatusLine, captureNeedsOwnerReview, captureReviewPayload,
        captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload, CAPTURE_RECAPTURE_REASONS,
        currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice, skuChoiceHeadline, skuChoiceSwing,
        skuChoiceSummary, selectAllState, skuChoicePayload, skuWeightGapNotice, foldedStepLine, foldedStepState};
      export const render=props=>renderToStaticMarkup(<Page {...props}/>);` : null }],
      ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(value => value.type === 'chunk' && value.isEntry);
    assert.ok(chunk);
    renderer = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer;
}
async function render(props) {
  return (await pageModule()).render(props);
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
  const connected = await render(props({ extensionStatus: { code: 'connected', label: '插件已连接 · 等待采集任务' },
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

test('商品页顶上写明自己在哪一层，选品台和我选的商品都能点回去，返回按钮还在', async () => {
  const html = await render(props({ titleZh: '合成收纳盒' }));
  assert.match(html, /<nav class="product-breadcrumb" aria-label="位置">/u);
  assert.match(html, /<button[^>]*class="product-breadcrumb-link"[^>]*>选品台<\/button>/u);
  assert.match(html, /<button[^>]*class="product-breadcrumb-link"[^>]*>我选的商品<\/button>/u);
  assert.match(html, /<span class="product-breadcrumb-current">合成收纳盒<\/span>/u);
  assert.match(html, /›/u);
  assert.match(html, />返回<\/button>/u);
  // Without a way back the breadcrumb still says where the page sits, but offers no dead link.
  const noBack = await render({ ...props({ titleZh: '合成收纳盒' }), onBack: undefined });
  assert.match(noBack, /product-breadcrumb/u);
  assert.doesNotMatch(noBack, /product-breadcrumb-link/u);
  assert.doesNotMatch(noBack, />返回<\/button>/u);
});

test('保存之后留在本页，并且只强调下一步：过线强调申请采集，没过线或缺资料强调表单', async () => {
  const passing = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.match(passing, /<div class="product-capture product-next" aria-label="插件采集">/u);
  assert.match(passing, /下一步：点下面的「申请插件采集」，让插件去读这个1688页面。/u);
  assert.match(passing, /<button[^>]*class="button primary"[^>]*>申请插件采集<\/button>/u);
  assert.doesNotMatch(passing, /<div class="product-form product-next">/u);
  const blocked = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: blockedEstimate, marketSnapshot } }));
  assert.match(blocked, /<div class="product-form product-next">/u);
  assert.match(blocked, /下一步：把上面缺的资料补齐，再保存一次。/u);
  assert.doesNotMatch(blocked, /product-capture product-next/u);
  const thin = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, profitAtDeclaredPurchase: { ...okEstimate.profitAtDeclaredPurchase, passes: false } } } }));
  assert.match(thin, /<div class="product-form product-next">/u);
  assert.match(thin, /下一步：这件没到本店利润门槛，改上面的货价或目标成交价再保存一次。/u);
  // Before anything is saved there is no "next step" to shout about, only the form itself.
  const fresh = await render(props());
  assert.match(fresh, /<div class="product-form product-next">/u);
  assert.doesNotMatch(fresh, /下一步：/u);
});

test('采集这一步自己说出来的那句话占用本页原有的提示位，没有具体的话才回落到通用句', async () => {
  const { stepNotice } = await pageModule();
  const rejected = '这个标签页里没有采集插件：请用 http://127.0.0.1:4317 打开页面（不是 localhost）';
  assert.equal(stepNotice(rejected, '已申请插件采集，采到后这里会显示结果。'), rejected);
  // 保存找货方案返回的是视图对象，不是话；这类步骤仍旧显示它自己的通用句。
  assert.equal(stepNotice({ supplierDraftV1: draft }, '已保存你填的找货方案'), '已保存你填的找货方案');
  assert.equal(stepNotice(undefined, '已保存你填的找货方案'), '已保存你填的找货方案');
  assert.equal(stepNotice('   ', '已申请插件采集'), '已申请插件采集');
  // 提示位就是找货这一节里已有的那一个，没有新增第二处说话的地方。
  const html = await render(props({ view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot } }));
  assert.equal(html.match(/class="product-notice"/gu), null, '没有提示时不占位');
  assert.equal((html.match(/role="status"/gu) ?? []).length, 0);
});

test('商品页的申请插件采集走专用处理：写操作不经读取守卫，排队回执后必须发开始信号', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /onRequestCapture=\{payload => requestProductCapture\(payload\)\}/u);
  assert.doesNotMatch(app, /onRequestCapture=\{payload => runProductStep\(/u,
    '走 runProductStep 就只调接口、永远不发开始信号，插件后台不轮询作业，主人只会空等到超时');
  const handler = app.match(/async function requestProductCapture\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '商品页采集必须有自己的处理函数');
  assert.match(handler[0], /runMutation\(\(\)=>api\.confirmRealAStage\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    '写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null');
  assert.match(handler[0], /startQueuedSupplierCapture\(result\)/u);
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
  // 旧 A 卡仍然自己调用同一个信号与同一套文案映射，没有被改成另一条路径。
  assert.match(app, /const captureStart = await startQueuedSupplierCapture\(result\);/u);
  assert.match(app, /\$\{captureStart\.message\}/u);
  assert.match(app, /import \{ startQueuedSupplierCapture \} from "\.\/captureStart\.js";/u);
});

// 定价指引 (owner question 2026-09-11). Synthetic guidance only: the page shows what the saved estimate carries.
const guidance = {
  status: 'ok', rubPerCny: 12.5637, allInPurchaseRmb: 45, nonPurchaseFixedRmb: 14.61,
  minimumUnitProfitRmb: 20, targetMarginRate: 0.15, thresholdPolicy: 'either',
  breakEven: { priceRub: 986, commissionRate: 0.12, commissionTier: 'le1500', revenueCny: 78.48, unitProfitRmb: 0.03, marginRate: 0.0004 },
  threshold: { priceRub: 1228, commissionRate: 0.12, commissionTier: 'le1500', revenueCny: 97.74, unitProfitRmb: 14.67, marginRate: 0.1501, basis: 'margin' },
  market: { priceRub: 1666, commissionRate: 0.14, commissionTier: '1500_5000', revenueCny: 132.6, unitProfitRmb: 38.51, marginRate: 0.2904 },
  ladder: [
    { label: '保本价', priceRub: 986, commissionRate: 0.12, unitProfitRmb: 0.03, marginRate: 0.0004 },
    { label: '达标价', priceRub: 1228, commissionRate: 0.12, unitProfitRmb: 14.67, marginRate: 0.1501 },
    { label: '整数价位', priceRub: 1600, commissionRate: 0.14, unitProfitRmb: 34.62, marginRate: 0.2718 },
    { label: '同款市场价', priceRub: 1666, commissionRate: 0.14, unitProfitRmb: 38.51, marginRate: 0.2904 }
  ]
};

test('保存找货资料后，商品页自己把保本价、达标价、市场价利润和价格阶梯算给主人看', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, pricingGuidance: guidance } } }));
  assert.match(html, /定价指引/u);
  assert.match(html, /保本价<\/dt><dd>986 卢布（佣金 12%）/u);
  assert.match(html, /达标最低售价<\/dt><dd>1228 卢布（佣金 12%） · 按「利润率 ≥ 15%」先达到/u);
  assert.match(html, /同款市场价<\/dt><dd>1666 卢布 · 按这个价单件利润 ¥38\.51 · 利润率 29%/u);
  // The ladder shows the rate of each price's own band, which is why 1600 carries 14% and 1228 carries 12%.
  assert.match(html, /价格阶梯：每个售价能落下多少/u);
  assert.match(html, /<td>1600 卢布<\/td><td>14%<\/td><td>¥34\.62<\/td><td>27%<\/td><td>整数价位<\/td>/u);
  assert.match(html, /<td>1228 卢布<\/td><td>12%<\/td>/u);
  assert.match(html, /超过档位分界线会换一档费率/u);
  assert.match(html, /1 元 ≈ 12\.5637 卢布/u);
  assert.match(html, /你填的到手总价 ¥45\.00/u);
  // 目标成交价 starts at the market price and says so; the owner no longer types a number out of thin air.
  assert.match(html, /id="supply-target-price"[^>]*value="1850"/u, '已经填过找货方案时按方案里的价预填');
  const fresh = await render(props({ view: { supplierDraftV1: null, marketSnapshot, supplierDraftEstimateV1: null } }));
  assert.match(fresh, /id="supply-target-price"[^>]*value="1850"/u, '还没填过时默认就是同款市场价');
  assert.match(fresh, /默认就是同款现在的市场价；它也是以后上架时的起价/u);
  assert.doesNotMatch(fresh, /定价指引/u, '还没保存找货方案时不显示定价指引');
});

test('算不出定价指引时直说缺什么，不给一个猜出来的价', async () => {
  const html = await render(props({ view: { supplierDraftV1: draft, marketSnapshot,
    supplierDraftEstimateV1: { ...okEstimate, pricingGuidance: null } } }));
  assert.match(html, /定价指引/u);
  assert.match(html, /还算不出来：需要官方汇率、官方佣金和一条可行运费线路都齐了才有这几个价。/u);
  assert.doesNotMatch(html, /卢布（佣金/u);
  const { thresholdBasisLine } = await pageModule();
  assert.equal(thresholdBasisLine(null), null);
  assert.equal(thresholdBasisLine({ threshold: null }), null);
  assert.equal(thresholdBasisLine({ ...guidance, threshold: { ...guidance.threshold, basis: 'unit_profit' } }),
    '按「单件利润 ≥ ¥20.00」先达到');
  assert.equal(thresholdBasisLine({ ...guidance, threshold: { ...guidance.threshold, basis: 'both' } }),
    '单件利润 ≥ ¥20.00 和利润率 ≥ 15% 同时达到');
});

// 结果未知：插件领走了作业，服务端没有收到结果。守卫会挡住之后的每一次采集申请，页面必须把这件事和出路一起说出来。
const unknownOutcomeCapture = {
  captureId: 'SCJ-synthetic-unknown-outcome', status: 'failed', jobStatus: 'unknown_outcome', failureCode: 'unknown_outcome',
  reason: '插件领取作业后中断，当前采集结果未知', mode: 'a_supplier_capture', attempt: 1, writeOccurred: false
};
const savedFind = { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot };

test('结果未知又没核实：页面说清被挡住了并给出唯一出路，「申请插件采集」当场就不可用', async () => {
  const { captureNeedsOwnerReview, captureReviewPayload, captureStatusLine } = await pageModule();
  const stuck = candidate({ sourceCapture: unknownOutcomeCapture });
  const settled = candidate({ sourceCapture: { ...unknownOutcomeCapture, jobStatus: 'failed',
    reviewedAt: '2026-09-11T09:00:00.000Z', reviewedBy: 'owner', acknowledgement: 'no_result_received' } });
  assert.equal(captureNeedsOwnerReview(stuck), true);
  assert.deepEqual(captureReviewPayload(stuck), { dataRevision: 4, acknowledgement: 'no_result_received' });
  // 核实过的同一条记录不再挡路，也就不再需要这个按钮；没采集过的商品从来不需要。
  assert.equal(captureNeedsOwnerReview(settled), false);
  assert.equal(captureReviewPayload(settled), null);
  assert.equal(captureNeedsOwnerReview(candidate()), false);
  assert.equal(captureNeedsOwnerReview(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);
  assert.equal(captureStatusLine(stuck), '上一次采集的结果未知：插件领取作业后中断，当前采集结果未知。');
  assert.equal(captureStatusLine(settled), '上一次采集的结果未知：插件领取作业后中断，当前采集结果未知。你已确认这次没有结果，可以重新申请采集。');

  const blocked = await render(props({ candidate: stuck, view: savedFind, onReviewCaptureAndRequest: forbidden }));
  assert.match(blocked, /插件领走了上一次采集，但一直没有把结果传回来，服务端只能记成「结果未知」。/u);
  assert.match(blocked, /在你确认之前，这件商品不能再申请采集。/u);
  assert.match(blocked, /<p class="product-capture-blocked" role="alert">/u);
  assert.match(blocked, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/u, '被挡住时不能让主人点了才收到 409');
  assert.match(blocked, /在你确认这条「结果未知」的记录之前，「申请插件采集」不可用/u);
  assert.match(blocked, /<button[^>]*class="button primary"[^>]*>这次采集没有结果，我确认并重新申请<\/button>/u);
  assert.match(blocked, /确认只是记下你的判断，不会替你补一份采集结果。/u);
  // 「下一步」不能再指向一个点不动的按钮。
  assert.match(blocked, /下一步：先确认下面那条「结果未知」的采集记录，才能重新申请采集。/u);
  assert.doesNotMatch(blocked, /下一步：点下面的「申请插件采集」/u);

  const after = await render(props({ candidate: settled, view: savedFind }));
  assert.doesNotMatch(after, /这次采集没有结果，我确认并重新申请/u);
  assert.doesNotMatch(after, /product-capture-blocked/u);
  assert.match(after, /<button[^>]*class="button primary"[^>]*>申请插件采集<\/button>/u);
  assert.doesNotMatch(after, /<button[^>]*disabled[^>]*>申请插件采集<\/button>/u);
  assert.match(after, /下一步：点下面的「申请插件采集」/u);
});

test('确认并重新申请是两步：先调核实接口，成功再走原有的申请采集链路，哪一步失败就说哪一步', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /reviewSourceCapture: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /source-capture\/review/u);
  assert.match(app, /onReviewCaptureAndRequest=\{payload => reviewCaptureAndRequest\(payload\)\}/u);
  const handler = app.match(/async function reviewCaptureAndRequest\(\{review,capture\}\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '确认并重新申请必须有自己的处理函数');
  assert.match(handler[0], /api\.reviewSourceCapture\(candidateId,review\)/u);
  assert.match(handler[0], /requestProductCapture\(\{\.\.\.capture,dataRevision:reviewed\.candidate\.dataRevision/u,
    '核实会推进修订号，第二步必须带服务端刚返回的那个修订号');
  assert.match(handler[0], /没能记下你的确认，这次也没有重新申请采集/u);
  assert.match(handler[0], /已记下你的确认（这条记录不再挡路），但这次重新申请采集没有成功/u);
  // 第二步就是原来的那条链路：核实自己既不建作业，也不发开始信号。
  assert.doesNotMatch(handler[0], /startQueuedSupplierCapture/u);
  assert.doesNotMatch(handler[0], /confirmRealAStage/u);
});

test('商品页头部也能淘汰这件商品，已经淘汰的只说明在哪里恢复', async () => {
  const live = await render(props({ onEliminateCandidate: forbidden }));
  assert.match(live, /product-header-actions/u);
  assert.match(live, /class="button secondary eliminate-button"[^>]*>淘汰</u);
  const dropped = await render(props({ candidate: candidate({ workflowStatus: 'eliminated' }), onEliminateCandidate: forbidden }));
  assert.match(dropped, /已淘汰 · 在选品台的「已淘汰」里可以恢复/u);
  assert.doesNotMatch(dropped, /eliminate-button/u);
});

/* ── 选规格 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * Synthetic display data only. The numbers below are the shape the server sends, not a second calculation: the money
 * itself is proved against the saved GUOO table in tests/sku-choice-estimate.test.mjs.
 */
const choiceRow = (id, colour, size, priceCny, freightRmb, unitProfitRmb, marginRate, weightKg, stock, extra = {}) => ({
  order: 0, sourceSkuId: id, propPath: null, attributes: { 颜色: colour, 尺码: size }, values: [colour, size],
  label: `${colour} · ${size}`, imageUrl: null, priceCny, stock, inStock: stock > 0, weightKg,
  weightSource: weightKg === null ? null : 'detailDescription.freightInfo.skuWeight',
  chargeableKg: weightKg, route: weightKg === null ? null : 'GUOO Economy Extra Small', freightRmb,
  allInPurchaseRmb: priceCny === null ? null : priceCny + 3.5, unitProfitRmb, marginRate,
  passes: unitProfitRmb !== null, status: weightKg === null ? 'weight_missing' : 'ok',
  missing: weightKg === null ? ['规格重量'] : [], ...extra
});
const choiceTable = (extra = {}) => ({
  schemaVersion: 'sku-choice-table-v1', builtAt: '2026-09-13T01:00:01.000Z', columns: ['颜色', '尺码'],
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468),
    choiceRow('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, null, null, null, null, 479)
  ],
  total: 3, pricedCount: 2, weightMissingCount: 1,
  best: choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
  worst: choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468),
  profitDropRate: 0.4179, selectedSkuIds: [],
  sources: {
    targetSalePriceRub: 1600, rubPerCny: 12.5637, fxRateDate: '2026-09-12', fxSourceRef: 'cbr-xml-daily:R01375:2026-09-12',
    commissionRate: 0.14, commissionTier: '1500_5000', commissionSourceRef: 'ozon-official-commission:2026-09-01:sha256:synthetic',
    routes: ['GUOO Economy Extra Small'], tariffRuleVersion: 'guoo-2026-08-19', domesticShippingRmb: 3.5,
    packagingRmbDefault: 3, labelCostRmb: 1.5,
    reserveParts: { advertisingReserveRate: 0, returnOpsReserveRate: 0.05, damageLossReserveRate: 0.05, withdrawalFeeRate: 0.02 },
    reserveRate: 0.12, dimensionsCm: { length: 25, width: 22, height: 2.5 }
  },
  ...extra
});
const waitingCapture = (extra = {}) => ({
  captureId: 'SCJ-synthetic-choice', status: 'captured_waiting_owner_selection', mode: 'a_supplier_capture',
  jobStatus: 'completed', offerId: '943009939489', sourceUrl: 'https://detail.1688.com/offer/943009939489.html',
  observedAt: '2026-09-13T00:30:00.000Z', selectedSkuIds: [], writeOccurred: false,
  skuChoices: [{ sourceSkuId: 'sku-xl-yellow' }, { sourceSkuId: 'sku-8xl-yellow' }, { sourceSkuId: 'sku-8xl-beige' }], ...extra
});
const choosingProps = (extra = {}, captureExtra = {}, tableExtra = {}) => props({
  candidate: candidate({ sourceCapture: waitingCapture(captureExtra) }),
  view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: choiceTable(tableExtra) },
  onChooseSkus: forbidden, ...extra
});

test('插件采回来之后，商品页停在「选定」，这一步展开成规格选择表', async () => {
  const { currentProductStep, skuChoiceReady, skuChoiceSaved, showsSkuChoice } = await pageModule();
  const waiting = candidate({ sourceCapture: waitingCapture() });
  assert.equal(skuChoiceReady(waiting), true);
  assert.equal(skuChoiceSaved(waiting), false);
  assert.equal(currentProductStep(waiting), 'select');
  assert.equal(showsSkuChoice(waiting), true);
  // 没采过、采失败、或者根本没有规格，这一步都不该打开。
  assert.equal(skuChoiceReady(candidate()), false);
  assert.equal(currentProductStep(candidate()), 'find');
  assert.equal(skuChoiceReady(candidate({ sourceCapture: waitingCapture({ skuChoices: [] }) })), false);
  assert.equal(skuChoiceReady(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);

  const html = await render(choosingProps());
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">1<\/span>选定/u);
  assert.match(html, /<section class="product-section product-sku-choice" aria-label="选规格">/u);
  assert.match(html, /<h3>选哪个规格上架<\/h3>/u);
  assert.match(html, /插件已经把这件1688货源的 3 个规格采回来了/u);
  assert.match(html, /货源 1688 \/ 943009939489 · 目标售价 1600 卢布 · 2026-09-13 采到/u);
  // 找货 folds away below it, complete, because those inputs still drive every row.
  assert.match(html, /<details class="product-folded" aria-label="找货"><summary>找货<span class="product-folded-state">已保存<\/span><\/summary>/u);
  assert.match(html, /id="supply-target-price"[^>]*value="1850"/u);
  // 选定 is no longer one of the folded "未开始" steps.
  assert.doesNotMatch(html, /<summary>选定/u);
  assert.equal((html.match(/未开始/gu) ?? []).length, 4);
  // 采回来之后，找货里那句「去申请采集」已经过去了：不再出现，也不再是被高亮的下一步。
  assert.doesNotMatch(html, /下一步：/u);
  assert.doesNotMatch(html, /product-capture product-next/u);
  assert.doesNotMatch(html, /product-form product-next/u);
});

test('顶上一行结论用表里自己的两个数字：最赚和最少各自的单件利润', async () => {
  const { skuChoiceHeadline, skuChoiceSwing } = await pageModule();
  assert.equal(skuChoiceHeadline(choiceTable()), '同一件货，选错规格少赚 42%');
  assert.equal(skuChoiceHeadline({ profitDropRate: null }), '同一件货，不同规格赚的不一样');
  assert.equal(skuChoiceHeadline({ profitDropRate: 0 }), '同一件货，不同规格赚的不一样');
  assert.deepEqual(skuChoiceSwing(choiceTable()).best, { label: '黄色 · XL（背长35cm）', unitProfitRmb: 59.47 });
  assert.deepEqual(skuChoiceSwing(choiceTable()).worst, { label: '黄色 · 8XL（背长72cm）', unitProfitRmb: 34.62 });
  assert.deepEqual(skuChoiceSwing({ best: null, worst: null }), { best: null, worst: null });

  const html = await render(choosingProps());
  assert.match(html, /<h4>同一件货，选错规格少赚 42%<\/h4>/u);
  assert.match(html, /最赚 · 黄色 · XL（背长35cm）<\/span><strong>¥59\.47<\/strong>/u);
  assert.match(html, /最少 · 黄色 · 8XL（背长72cm）<\/span><strong>¥34\.62<\/strong>/u);
});

test('表按单件利润从高到低列出九列，页面没给重量的那一行运费和利润写待补', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<h4>3 个规格 · 按单件利润从高到低<\/h4>/u);
  assert.match(html, /可以多选：同一件货源的不同尺码可以一起上架 · 表头方框是全选/u);
  for (const header of ['颜色', '尺码', '货价', '计费重', '运费', '单件利润', '利润率', '库存']) {
    assert.match(html, new RegExp(`<th scope="col">${header}</th>`, 'u'));
  }
  assert.match(html, /<td>黄色<\/td><td>XL（背长35cm）<\/td><td>¥20\.50<\/td><td>0\.103 公斤<\/td><td>¥6\.26<\/td><td class="product-sku-profit">¥59\.47<\/td><td>47%<\/td><td>494<\/td>/u);
  assert.match(html, /<td>黄色<\/td><td>8XL（背长72cm）<\/td><td>¥41\.50<\/td><td>0\.24 公斤<\/td><td>¥10\.11<\/td><td class="product-sku-profit">¥34\.62<\/td><td>27%<\/td><td>468<\/td>/u);
  // 页面没给重量：运费和利润留空写「待补」，绝不借另一条尺码的重量。
  assert.match(html, /<td>米色<\/td><td>8XL（背长72cm）<\/td><td>¥41\.50<\/td><td>待补<\/td><td>待补<\/td><td class="product-sku-pending">待补<\/td><td>待补<\/td><td>479<\/td>/u);
  assert.equal((html.match(/aria-label="选 /gu) ?? []).length, 3);
});

test('表头第一个方框是全选，全选、全不选、半选三种状态都如实写出来', async () => {
  const { selectAllState } = await pageModule();
  const rows = choiceTable().rows;
  assert.equal(selectAllState([], rows), 'none');
  assert.equal(selectAllState(['sku-xl-yellow'], rows), 'some');
  assert.equal(selectAllState(rows.map(row => row.sourceSkuId), rows), 'all');
  assert.equal(selectAllState(['sku-xl-yellow'], []), 'none');

  const html = await render(choosingProps());
  assert.match(html, /<input type="checkbox" id="sku-choice-all"[^>]*aria-checked="false"[^>]*aria-label="全选这 3 个规格"/u);
  const saved = await render(choosingProps({}, { selectedSkuIds: ['sku-xl-yellow'] }, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.match(saved, /id="sku-choice-all"[^>]*aria-checked="mixed"/u);
  const all = await render(choosingProps({},
    { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige'] },
    { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige'] }));
  assert.match(all, /id="sku-choice-all"[^>]*aria-checked="true"[^>]*checked=""/u);
});

test('底下一行说清已选几个、单件利润多少，没选时按钮点不动', async () => {
  const { skuChoiceSummary, skuChoicePayload } = await pageModule();
  const table = choiceTable();
  assert.equal(skuChoiceSummary(table, []), '还没选。点一行前面的方框就行。');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow']), '已选 1 个规格 · 单件利润 ¥59.47 · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow', 'sku-8xl-yellow']),
    '已选 2 个规格 · 单件利润 ¥34.62 – ¥59.47 · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-xl-yellow', 'sku-8xl-yellow', 'sku-8xl-beige']),
    '已选 全部 3 个规格 · 单件利润 ¥34.62 – ¥59.47（其中 1 个待补） · 按 1600 卢布售价算');
  assert.equal(skuChoiceSummary(table, ['sku-8xl-beige']), '已选 1 个规格 · 单件利润待补 · 按 1600 卢布售价算');
  // 提交的是封闭输入：当前修订号，加上按表里顺序排好的规格。
  assert.deepEqual(skuChoicePayload(table, ['sku-8xl-yellow', 'sku-xl-yellow'], 4),
    { dataRevision: 4, sourceSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] });
  assert.deepEqual(skuChoicePayload(table, ['sku-not-here'], 4), { dataRevision: 4, sourceSkuIds: [] });

  const html = await render(choosingProps());
  assert.match(html, /<p class="product-sku-summary">还没选。点一行前面的方框就行。<\/p>/u);
  assert.match(html, /<button[^>]*disabled[^>]*>选定这些规格<\/button>/u);
  const picked = await render(choosingProps({}, { selectedSkuIds: ['sku-xl-yellow'] }, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.match(picked, /已选 1 个规格 · 单件利润 ¥59\.47 · 按 1600 卢布售价算/u);
  assert.match(picked, /<button[^>]*class="button primary"[^>]*>选定这些规格<\/button>/u);
  assert.doesNotMatch(picked, /<button[^>]*disabled[^>]*>选定这些规格<\/button>/u);
  assert.match(picked, /已经选定过 1 个规格，它们在这件商品的供货方案里/u);
});

test('数字来源那一栏照实给出这一轮真正用到的输入，没有写死的值', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<dl class="product-pricing-facts product-sku-sources" aria-label="数字来源">/u);
  assert.match(html, /<dt>目标售价<\/dt><dd>1600 卢布 · 你填的<\/dd>/u);
  assert.match(html, /<dt>央行汇率<\/dt><dd>1 元 ≈ 12\.5637 卢布 · 2026-09-12<\/dd>/u);
  assert.match(html, /<dt>Ozon 官方佣金<\/dt><dd>14% · 按你填的售价所在档<\/dd>/u);
  assert.match(html, /<dt>物流线路<\/dt><dd>GUOO Economy Extra Small · guoo-2026-08-19 资费<\/dd>/u);
  assert.match(html, /<dt>国内运费<\/dt><dd>¥3\.50 · 你填的<\/dd>/u);
  assert.match(html, /<dt>包装 \+ 贴标<\/dt><dd>¥3\.00 \+ ¥1\.50<\/dd>/u);
  assert.match(html, /<dt>店铺预留<\/dt><dd>12% · 退货5% 破损5% 提现2%<\/dd>/u);
  assert.match(html, /<dt>规格重量<\/dt><dd>来自采集到的页面 · 每个规格各自的重量（有 1 个规格页面没给，运费和利润留空）<\/dd>/u);
  // 官方输入缺一样就直说未取得，不给一个猜出来的数。
  const bare = await render(choosingProps({}, {}, { sources: { ...choiceTable().sources, rubPerCny: null, commissionRate: null, routes: [] } }));
  assert.match(bare, /<dt>央行汇率<\/dt><dd>未取得<\/dd>/u);
  assert.match(bare, /<dt>Ozon 官方佣金<\/dt><dd>未取得 · 按你填的售价所在档<\/dd>/u);
  assert.match(bare, /<dt>物流线路<\/dt><dd>未取得<\/dd>/u);
});

test('「选完会发生什么」把边界说全：锁进供货方案、进度条前进，不下单、不联系供应商、不写 Ozon', async () => {
  const html = await render(choosingProps());
  assert.match(html, /<strong>选完之后会发生什么：<\/strong>软件把你选中的规格锁进这件商品的供货方案，商品页的进度条从「选定」走到「算利润」。/u);
  assert.match(html, /这一步<strong>不会<\/strong>下单、不会联系供应商、也不会向 Ozon 写任何东西。/u);
  assert.match(html, /货价与库存来自这次采到的1688页面，运费按各规格自己的重量查国欧资费表，佣金取自 Ozon 官方表，汇率取自央行。/u);
  // 内部词不出现在主人看的界面上。
  for (const word of ['SKU', '批次', '修订', '作业', 'dataRevision']) assert.doesNotMatch(html, new RegExp(word, 'u'));
});

test('选定之后进度条走到「算利润」，选定这一步记成已完成', async () => {
  const { currentProductStep, skuChoiceSaved, foldedStepLine, foldedStepState } = await pageModule();
  const chosen = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }) });
  assert.equal(skuChoiceSaved(chosen), true);
  assert.equal(currentProductStep(chosen), 'profit');
  assert.equal(foldedStepState('select', 'profit', chosen), '已完成');
  assert.equal(foldedStepLine('select', 'profit', chosen), '已选定 2 个规格，已经锁进这件商品的供货方案。');
  assert.equal(foldedStepState('copy', 'profit', chosen), '未开始');
  assert.equal(foldedStepLine('copy', 'profit', chosen), '等前面的步骤完成后再开始。');
  assert.equal(foldedStepLine('profit', 'profit', chosen), '这一步的详细界面还在旧版页面里，先用「打开旧版A卡」查看。');

  const html = await render(choosingProps({ candidate: chosen }, {}, { selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] }));
  assert.match(html, /aria-current="step"[^>]*>[^<]*<span class="product-step-index">3<\/span>算利润/u);
  // 表还在，主人随时能改主意；A确认之后才收起来。
  assert.match(html, /<section class="product-section product-sku-choice" aria-label="选规格">/u);
  const confirmed = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow'] }),
    lifecycleV11: { aConfirmationReceipt: { decision: 'confirm' } } });
  assert.equal(currentProductStep(confirmed), 'profit');
  const after = await render(choosingProps({ candidate: confirmed }, {}, { selectedSkuIds: ['sku-xl-yellow'] }));
  assert.doesNotMatch(after, /选哪个规格上架/u);
  assert.match(after, /<summary>选定<span class="product-folded-state">已完成<\/span><\/summary>/u);
  assert.match(after, /已选定 1 个规格，已经锁进这件商品的供货方案。/u);
});

test('还没保存找货资料就采回来了：直说算不出来该先做什么，不给一张假的表', async () => {
  const html = await render(props({ candidate: candidate({ sourceCapture: waitingCapture() }),
    view: { supplierDraftV1: null, supplierDraftEstimateV1: null, marketSnapshot, skuChoiceTableV1: null } }));
  assert.match(html, /<h3>选哪个规格上架<\/h3>/u);
  assert.match(html, /但现在还算不出每个规格的运费和利润：/u);
  assert.match(html, /先把下面「找货」里的资料填好保存一次，这里就会按每个规格自己的重量算给你看。/u);
  assert.doesNotMatch(html, /按单件利润从高到低/u);
  assert.doesNotMatch(html, /选定这些规格/u);
  // 找货已经填过、但官方输入还缺一样：说的是缺哪一类，不是让主人再填一次表。
  const saved = await render(props({ candidate: candidate({ sourceCapture: waitingCapture() }),
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: null } }));
  assert.match(saved, /汇率、佣金、资费表或本店成本规则里还缺东西/u);
  assert.doesNotMatch(saved, /先把下面「找货」里的资料填好保存一次/u);
});

test('采集刚刚回来时商品页会自己重读这一步，不停在「还没有规格」上', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /const productRevision=view==='product'/u);
  assert.match(app, /\[view,accountOwnerId,selectedId,productDraftRefresh,productRevision\]/u,
    '保存记录的修订号一变，这一步就重读一次服务端');
});

test('选规格走商品页原有的那条保存通道，只发规格和当前修订号，不触发任何派发', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /chooseSourceSkus: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /lifecycle\/sku-choice/u);
  assert.match(app, /onChooseSkus=\{payload => runProductStep\(api\.chooseSourceSkus, payload\)\}/u);
  // 旧的 select-sku 接口（它会派发C阶段）没有被商品页接上。
  assert.doesNotMatch(app, /onChooseSkus=\{payload => runProductStep\(api\.selectSourceCaptureSku/u);
  // 保存走的是商品页原有的那条通道：保存完留在本页，本页的提示位说结果。
  assert.match(app, /async function runProductStep\(action,payload\)\{/u);
});

/* ── 重新采集 ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * 采到之后，「申请插件采集」不会再建新的采集（服务端认得同一个链接已经采过），所以重读同一个1688页面必须自己有一个入口。
 * 2026-09-13 第一件商品正是因为没有这个入口，被钉死在一次没有重量的采集结果上，整列运费和利润只能显示「待补」。
 */
test('只有已采到、等你选规格时才有「重新采集」，点之前先说清楚会作废哪几样', async () => {
  const { captureRecaptureReady, captureRecaptureConfirmLine, captureRecapturePayload,
    CAPTURE_RECAPTURE_REASONS } = await pageModule();
  const waiting = candidate({ sourceCapture: waitingCapture() });
  const picked = candidate({ sourceCapture: waitingCapture({ selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'],
    skuSelection: { schemaVersion: 'source-capture-sku-selection-v1', selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] } }) });
  assert.equal(captureRecaptureReady(waiting), true);
  // 还在排队、正在读、读失败、根本没采过：都没有可以作废的东西，也就没有这个按钮。
  assert.equal(captureRecaptureReady(candidate()), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } })), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: { status: 'capturing', jobStatus: 'claimed' } })), false);
  assert.equal(captureRecaptureReady(candidate({ sourceCapture: unknownOutcomeCapture })), false);
  assert.equal(captureRecaptureConfirmLine(candidate()), null);
  assert.equal(captureRecapturePayload(candidate()), null);

  // 确认这句话用的是记录里真实的条数，不是「一些规格」。
  assert.equal(captureRecaptureConfirmLine(waiting),
    '确定重新去读一次这个1688页面？现在这 3 个规格会作废。重新读一次不会下单、不会联系供应商、也不会向 Ozon 写任何东西。');
  assert.equal(captureRecaptureConfirmLine(picked),
    '确定重新去读一次这个1688页面？现在这 3 个规格会作废，连你已经选定的那 2 个也一起作废，要重新选一次。重新读一次不会下单、不会联系供应商、也不会向 Ozon 写任何东西。');
  // 封闭输入：当前修订号，外加一个只能来自这张表的理由；自由文本永远不会被发出去。
  assert.deepEqual(captureRecapturePayload(waiting), { dataRevision: 4 });
  assert.deepEqual(captureRecapturePayload(waiting, 'weight_missing'), { dataRevision: 4, reason: 'weight_missing' });
  assert.deepEqual(captureRecapturePayload(waiting, '因为重量没采到'), { dataRevision: 4 });
  assert.deepEqual(CAPTURE_RECAPTURE_REASONS.map(item => item.code),
    ['weight_missing', 'page_changed', 'wrong_specifications']);
});

const fullWeightTable = (extra = {}) => choiceTable({
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, 6.26, 59.47, 0.467, 0.103, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, 10.11, 34.62, 0.2718, 0.24, 468)
  ],
  total: 2, pricedCount: 2, weightMissingCount: 0, ...extra
});
/** 2026-09-13 线上那件狗雨衣的形状：采到了规格，但一个重量都没采到。 */
const noWeightTable = () => choiceTable({
  rows: [
    choiceRow('sku-xl-yellow', '黄色', 'XL（背长35cm）', 20.5, null, null, null, null, 494),
    choiceRow('sku-8xl-yellow', '黄色', '8XL（背长72cm）', 41.5, null, null, null, null, 468),
    choiceRow('sku-8xl-beige', '米色', '8XL（背长72cm）', 41.5, null, null, null, null, 479)
  ],
  total: 3, pricedCount: 0, weightMissingCount: 3, best: null, worst: null, profitDropRate: null
});

test('「重新采集」是次要按钮，一次点击只是打开确认，主按钮仍旧是那张选规格表', async () => {
  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  assert.match(html, /<button[^>]*class="button secondary product-recapture-button"[^>]*>重新采集<\/button>/u);
  // 确认要等主人点了才出现：它不能一点就把这次采到的规格作废掉。
  assert.doesNotMatch(html, /product-recapture-confirm/u);
  assert.doesNotMatch(html, /确定重新去读一次这个1688页面/u);
  assert.match(html, /这些规格是上一次读到的。页面改了、或者规格不对，就重新读一遍这个1688页面。/u);
  // 主按钮仍旧是选规格；重读只是采得不对时的退路。
  assert.match(html, /<button type="button" class="button primary"[^>]*>选定这些规格<\/button>/u);
  // 还没采到过的商品不给这个按钮。
  const fresh = await render(props({ view: savedFind, onRecaptureSource: forbidden }));
  assert.doesNotMatch(fresh, /重新采集/u);
  assert.doesNotMatch(fresh, /product-recapture-button/u);
});

/* ── 重新采集看得见 ───────────────────────────────────────────────────────────────────────────────────────────────
 * 采到之后，「1688 采集」那一块会被折进「找货」的 <details> 里，主人要先展开才看得见里面的「重新采集」。规格表才是
 * 他这时候看着的东西，所以重读的入口必须在规格表这一步就露出来 —— 尤其是采到的规格根本没有重量、整列运费和利润
 * 都算不出来的时候（2026-09-13 首件狗雨衣，24 个规格全部无重量）。
 */
test('规格表这一步就能看见「重新采集」，不必先展开「找货」', async () => {
  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  const table = html.indexOf('product-sku-table');
  const folded = html.indexOf('<details class="product-folded" aria-label="找货">');
  const button = html.indexOf('product-recapture-button');
  assert.ok(table > 0 && folded > 0 && button > 0);
  assert.ok(button < folded, '重新采集必须在折起来的「找货」之前就出现');
  // 同一件商品只有一个重新采集入口：规格表在场时，「1688 采集」块里那个不再重复出现。
  assert.equal((html.match(/product-recapture-button/gu) ?? []).length, 1);
  assert.match(html, /这些规格要重新读一次，用上面「选哪个规格上架」里的「重新采集」。/u);
  assert.doesNotMatch(html, /上面这些规格是上一次读到的。页面改了、规格不对，或者这次没采到重量/u);

  // 规格表不在场时（采到了，却一个规格都没解析出来），它还留在「1688 采集」块里，不能凭空消失。
  const noRows = await render(props({
    candidate: candidate({ sourceCapture: waitingCapture({ skuChoices: [] }) }),
    view: { supplierDraftV1: draft, supplierDraftEstimateV1: okEstimate, marketSnapshot, skuChoiceTableV1: null },
    onRecaptureSource: forbidden
  }));
  assert.doesNotMatch(noRows, /product-sku-choice/u);
  assert.equal((noRows.match(/product-recapture-button/gu) ?? []).length, 1);
  assert.match(noRows, /上面这些规格是上一次读到的。页面改了、规格不对，或者这次没采到重量/u);
});

test('采到的规格没有重量时，页面直说算不出运费和利润，并把「重新采集」放在这句话旁边', async () => {
  const { skuWeightGapNotice } = await pageModule();
  // 一个规格都没有重量：整列算不出来。
  const all = skuWeightGapNotice(noWeightTable());
  assert.equal(all.all, true);
  assert.deepEqual([all.total, all.missing], [3, 3]);
  assert.equal(all.heading, '这些规格没有重量，运费和利润算不出来');
  assert.match(all.message, /这 3 个规格是早先采的/u);
  assert.match(all.message, /运费、单件利润、利润率整列都是「待补」/u);
  assert.match(all.message, /点「重新采集」/u);
  // 只有一部分没有重量：说清楚是几个，也说清楚其余的照常。
  const some = skuWeightGapNotice(choiceTable());
  assert.equal(some.all, false);
  assert.deepEqual([some.total, some.missing], [3, 1]);
  assert.equal(some.heading, '有 1 个规格没有重量，运费和利润算不出来');
  assert.match(some.message, /另外 2 个照常/u);
  // 规格齐全就没有这句话。
  assert.equal(skuWeightGapNotice(fullWeightTable()), null);
  assert.equal(skuWeightGapNotice(null), null);
  assert.equal(skuWeightGapNotice({ total: 0, weightMissingCount: 0 }), null);

  const html = await render(choosingProps({ onRecaptureSource: forbidden }, {}, noWeightTable()));
  assert.match(html, /<div class="product-sku-weight-gap" role="status">/u);
  assert.match(html, /<h4>这些规格没有重量，运费和利润算不出来<\/h4>/u);
  assert.match(html, /这 3 个规格是早先采的/u);
  // 这句话和重读的按钮在同一个框里，并且排在表前面。
  const banner = html.indexOf('product-sku-weight-gap');
  assert.ok(banner > 0 && banner < html.indexOf('product-sku-table'));
  assert.ok(html.indexOf('product-recapture-button') > banner);
  assert.ok(html.indexOf('product-recapture-button') < html.indexOf('product-sku-table'));
  // 一个规格都算不出利润时，「最赚 / 最少」只会是两个「待补」，那不是结论，就不显示；开头那句也不再许诺「按利润挑」。
  assert.doesNotMatch(html, /product-sku-verdict/u);
  assert.match(html, /这一次没有采到重量，所以现在还挑不了利润/u);
  assert.doesNotMatch(html, /这一步就是让你按利润挑/u);
  assert.doesNotMatch(html, /最赚 · /u);
  // 表本身照旧：每一行的运费和利润写「待补」，不借用别的规格的重量。
  assert.equal((html.match(/待补/gu) ?? []).length > 0, true);
  assert.match(html, /有 3 个规格页面没给，运费和利润留空/u);

  // 缺一部分时，同一个框只报缺的那几个，其余照常显示。
  const partial = await render(choosingProps({ onRecaptureSource: forbidden }));
  assert.match(partial, /<h4>有 1 个规格没有重量，运费和利润算不出来<\/h4>/u);
  assert.match(partial, /product-sku-verdict/u);
  assert.equal((partial.match(/product-recapture-button/gu) ?? []).length, 1);
  // 规格齐全时它是不显眼的次要动作，没有这条黄框。
  const complete = await render(choosingProps({ onRecaptureSource: forbidden }, {}, fullWeightTable()));
  assert.doesNotMatch(complete, /product-sku-weight-gap/u);
  assert.match(complete, /product-sku-recapture/u);
});

test('重新采集有自己的处理函数：写操作不经读取守卫，拿到回执后复用今天那条开始信号', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  const apiClient = await readFile(fileURLToPath(new URL('../src/api.js', import.meta.url)), 'utf8');
  assert.match(apiClient, /recaptureSourceCapture: \(candidateId, payload\) =>/u);
  assert.match(apiClient, /source-capture\/recapture/u);
  assert.match(app, /onRecaptureSource=\{payload => recaptureProductSource\(payload\)\}/u);
  assert.doesNotMatch(app, /onRecaptureSource=\{payload => runProductStep\(/u,
    '走 runProductStep 就只调接口、永远不发开始信号，插件后台不轮询作业，主人只会空等到超时');
  const handler = app.match(/async function recaptureProductSource\(payload\)\{[\s\S]*?\n  \}/u);
  assert.ok(handler, '重新采集必须有自己的处理函数');
  assert.match(handler[0], /runMutation\(\(\)=>api\.recaptureSourceCapture\(candidateId,payload\)/u);
  assert.doesNotMatch(handler[0], /productDraftReads\.current\.run\(/u,
    '写操作经过“只保留最新读取”的守卫会把服务端的真实回答丢成 null');
  // 开始信号只有 captureStart.js 里那一个，重新采集没有另写一套。
  assert.match(handler[0], /const start=await startQueuedSupplierCapture\(result\);/u);
  assert.doesNotMatch(handler[0], /postMessage|CAPTURE_REQUEST|addEventListener/u);
  assert.match(handler[0], /await load\(true\);setProductDraftRefresh\(value=>value\+1\);/u);
});
