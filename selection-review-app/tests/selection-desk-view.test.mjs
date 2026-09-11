import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_COLUMNS, DECLINE_REASONS, FEED_SORTS, boardColumnKey, boardColumns, deskCounts, feedRows,
  formatInstant, freightShare, inboxItems, newRoundPlan, pointsLine, sortFeedRows, storeLabel } from '../src/selectionDeskView.js';

// Everything below is synthetic display data written in this file: no saved records, no services, no requests.
const product = (productId, extra = {}) => ({ productId, title: `Explicitly synthetic ${productId}`,
  productUrl: `https://www.ozon.ru/product/${productId}`, imageUrl: `https://ir.ozone.ru/s3/synthetic/${productId}.jpg`,
  price: 900, salesCount: 12, revenue: 4000, reviewCount: 4, reviewRating: 4.5,
  categoryPath: { cnTitlePath: '家居 > 收纳' }, ...extra });

const estimate = (outcome, extra = {}) => ({
  status: outcome === 'selectable' ? 'ok' : outcome === 'excluded_negative' ? 'negative' : 'incomplete',
  outcome, summary: '合成估算摘要', maximumAllInPurchaseRmb: null,
  freight: { route: null, chargeableKg: null, freightRmb: null, oversize: false }, commissionRate: 0.14, ...extra });

const batchEntry = ({ batchId = 'a-discovery-batch:synthetic', revision = 0, targetStore = 'miska', products = [],
  selections = [], importedCandidates = [], declines = [], createdAt = '2026-09-09T04:00:00.000Z',
  direction = '普通非电桌面整理小件（合成）', jobStatus = 'completed', remainingPoints = null } = {}) => ({
  batch: { batchId, revision, targetStore, createdAt, plan: { provider: 'seerfar', direction } },
  jobs: [
    { job: { status: jobStatus, scopeBinding: { request: { method: 'category_detail' } } },
      receipt: { steps: [{ method: 'category_detail', result: { products } }] } },
    ...(remainingPoints === null ? [] : [{ job: { status: 'completed', scopeBinding: { request: { method: 'quota' } } },
      receipt: { steps: [{ method: 'quota', result: { remainingPoints } }] } }])
  ],
  selections, importedCandidates, declines });

const viewOf = (...batches) => ({ schemaVersion: 'a-discovery-view-v1', batches, targetStores: ['miska', 'dandanshu'] });

const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska',
  workflowStatus: 'codex_processing', displayStatus: 'codex_processing', imageUrl: '', needsFromUser: [],
  updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z', ...extra });

test('本店的待决定商品、自动排除和你已排除分成三份，已建卡的商品只给查看入口', () => {
  const view = viewOf(batchEntry({ products: [
    product('2107989735', { estimate: estimate('selectable', { maximumAllInPurchaseRmb: 120.5 }) }),
    product('2107989736', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -3.2 }) }),
    product('2107989737', { estimate: estimate('needs_data') }),
    product('2107989738')
  ], importedCandidates: [{ marketProductId: '2107989738', candidateId: 'candidate:synthetic' }],
    declines: [{ marketProductId: '2107989737', reason: '尺寸太大' }] }));
  const feed = feedRows(view, 'miska');
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989735', '2107989738']);
  assert.deepEqual(feed.excluded.map(row => row.marketProductId), ['2107989736']);
  assert.deepEqual(feed.declined.map(row => ({ id: row.marketProductId, reason: row.declineReason })),
    [{ id: '2107989737', reason: '尺寸太大' }]);
  assert.equal(feed.rows[1].importedCandidateId, 'candidate:synthetic');
  assert.equal(feed.direction, '普通非电桌面整理小件（合成）');
  assert.equal(feed.storeLabel, storeLabel('miska'));
  assert.equal(feed.estimable, 4);
  // Only the untranslated titles are counted; the button label uses this number.
  assert.equal(feed.pendingTranslations, 4);
  assert.equal(feedRows(view, 'miska').rows[0].titleZh, null);
});

test('中文标题、图片和事实只来自已保存结果，缺的就留空', () => {
  const view = viewOf(batchEntry({ products: [
    product('2107989735', { titleZh: '合成收纳盒', imageUrl: 'https://images.example.test/blocked.png' }),
    product('2107989736', { salesCount: null, reviewCount: null, reviewRating: null, categoryPath: null })
  ] }));
  const [first, second] = feedRows(view, 'miska').rows;
  assert.equal(first.titleZh, '合成收纳盒');
  assert.equal(first.imageUrl, '', '只有 Ozon 图片来源会被显示');
  assert.equal(first.categoryZh, '家居 > 收纳');
  assert.equal(second.titleZh, null);
  assert.deepEqual([second.salesCount, second.reviewCount, second.reviewRating, second.categoryZh], [null, null, null, null]);
  assert.deepEqual(second.chips, ['待估算', '类目未知']);
  assert.equal(feedRows(view, 'miska').pendingTranslations, 1);
});

test('三种排序都把没有数字的商品放在最后', () => {
  const rows = feedRows(viewOf(batchEntry({ products: [
    product('2107989735', { salesCount: 5, estimate: estimate('selectable', { maximumAllInPurchaseRmb: 50,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 50, oversize: false } }) }),
    product('2107989736', { salesCount: 90, estimate: estimate('selectable', { maximumAllInPurchaseRmb: 300,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 100, oversize: true } }) }),
    product('2107989737', { salesCount: null })
  ] })), 'miska').rows;
  const ids = sort => sortFeedRows(rows, sort).map(row => row.marketProductId);
  assert.deepEqual(ids('profit'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(ids('sales'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(ids('freight'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(FEED_SORTS.map(option => option.value), ['profit', 'sales', 'freight']);
  assert.equal(freightShare({ maximumAllInPurchaseRmb: 300, freight: { freightRmb: 100 } }), 0.25);
  assert.equal(freightShare({ maximumAllInPurchaseRmb: null, freight: { freightRmb: 100 } }), null);
  assert.equal(freightShare(null), null);
  assert.deepEqual(rows.find(row => row.marketProductId === '2107989736').chips, ['超抛']);
});

test('店铺切换同时过滤查询结果和商品，未完成的查询不进入待决定', () => {
  const view = viewOf(
    batchEntry({ products: [product('2107989735')] }),
    batchEntry({ batchId: 'a-discovery-batch:other', targetStore: 'dandanshu', products: [product('2107989736')] }),
    batchEntry({ batchId: 'a-discovery-batch:running', products: [product('2107989739')], jobStatus: 'queued' })
  );
  assert.deepEqual(feedRows(view, 'miska').rows.map(row => row.marketProductId), ['2107989735']);
  assert.deepEqual(feedRows(view, 'dandanshu').rows.map(row => row.marketProductId), ['2107989736']);
  assert.deepEqual(feedRows(view, 'wb').rows, []);
  assert.equal(feedRows(null, 'miska').direction, null);
  const candidates = [candidate('candidate:1'), candidate('candidate:2', { targetStore: 'dandanshu' })];
  assert.deepEqual(deskCounts({ discoveryView: view, candidates, store: 'miska' }), { desk: 1, board: 1, inbox: 0 });
  assert.deepEqual(deskCounts({ discoveryView: view, candidates, store: 'wb' }), { desk: 0, board: 0, inbox: 0 });
});

test('五列进行中按业务阶段归位，已淘汰不出现，等你一行来自已保存的缺口', () => {
  const candidates = [
    candidate('candidate:a', { executionRuntime: { businessPhase: 'A' }, needsFromUser: ['补一个1688链接', '补重量'] }),
    candidate('candidate:b', { executionRuntime: { businessPhase: 'B' } }),
    candidate('candidate:c', { executionRuntime: { businessPhase: 'C1' }, workflowStatus: 'listing_preparation' }),
    candidate('candidate:d', { executionRuntime: { businessPhase: 'D' }, workflowStatus: 'ready_to_list' }),
    candidate('candidate:e', { workflowStatus: 'listed', displayStatus: 'listed' }),
    candidate('candidate:x', { workflowStatus: 'eliminated' })
  ];
  const columns = boardColumns(candidates, 'miska');
  assert.deepEqual(columns.map(column => column.title), BOARD_COLUMNS.map(column => column.title));
  assert.deepEqual(columns.map(column => column.cards.map(card => card.id)),
    [['candidate:a'], ['candidate:b'], ['candidate:c'], ['candidate:d'], ['candidate:e']]);
  assert.equal(columns[0].cards[0].waitingLine, '补一个1688链接');
  assert.equal(columns[1].cards[0].waitingLine, null);
  assert.equal(columns[0].cards[0].statusLine, '选品处理');
  // A candidate that never carried a saved phase still lands somewhere the owner can find it.
  assert.equal(boardColumnKey(candidate('candidate:n', { workflowStatus: 'needs_user_data' })), 'find');
  assert.equal(boardColumnKey(candidate('candidate:l', { workflowStatus: 'listed', executionRuntime: { businessPhase: 'B' } })), 'live');
});

test('需要你处理只列出真的在等你的商品，并保留其余缺口数量', () => {
  const candidates = [
    candidate('candidate:a', { needsFromUser: ['补一个1688链接', '补重量'] }),
    candidate('candidate:b', { needsFromUser: [] }),
    candidate('candidate:c', { needsFromUser: ['确认最终素材'], workflowStatus: 'listing_preparation', displayStatus: 'listing_preparation' }),
    candidate('candidate:x', { workflowStatus: 'eliminated', needsFromUser: ['已淘汰不该出现'] })
  ];
  const items = inboxItems(candidates, 'miska');
  assert.deepEqual(items.map(item => item.id), ['candidate:a', 'candidate:c']);
  assert.deepEqual(items[0], { id: 'candidate:a', title: '合成商品 candidate:a', storeLabel: 'Miska',
    statusLine: '选品处理', need: '补一个1688链接', moreNeeds: 1 });
  assert.equal(items[1].moreNeeds, 0);
  assert.equal(items[1].statusLine, '待上架准备');
});

test('点数一行和查询时间只在已保存结果里有时才出现，不要的理由固定五个', () => {
  assert.equal(pointsLine(viewOf(batchEntry({ products: [product('2107989735')], remainingPoints: 85 })), 'miska'), '本店查询点数还剩 85');
  assert.equal(pointsLine(viewOf(batchEntry({ products: [product('2107989735')] })), 'miska'), null);
  assert.equal(pointsLine(null, 'miska'), null);
  assert.equal(formatInstant('not-a-time'), null);
  assert.equal(formatInstant(null), null);
  assert.match(feedRows(viewOf(batchEntry({ products: [product('2107989735')] })), 'miska').queriedAt, /^2026-09-0\d \d{2}:\d{2}$/u);
  assert.deepEqual(DECLINE_REASONS, ['尺寸太大', '利润太薄', '品牌风险', '不想做这类', '其他']);
  assert.equal(DECLINE_REASONS.every(reason => reason.length <= 40), true);
});

test('newRoundPlan explains one click before anything is created and refuses when a round is running or unconfigured', async () => {
  const { newRoundPlan } = await import('../src/selectionDeskView.js');
  const plan = { planId: 'plan:x', version: 'version:1', direction: '宠物躺床', budget: { maxCredits: 20, estimatedPointsByStep: { quota_before: 0, category_detail: 13, quota_after: 0 } } };
  const binding = { bindingId: 'binding:x', configurationVersion: 'version:1' };
  const base = { canPrepare: true, plans: [plan], bindings: [binding], batches: [] };
  const ready = newRoundPlan(base, 'miska', Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(ready.ready, true); assert.equal(ready.estimatedPoints, 13); assert.equal(ready.maxCredits, 20); assert.equal(ready.warning, null); assert.equal(ready.direction, '宠物躺床');
  const recent = { ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-10T06:15:00Z', batchId: 'b', revision: 0, plan }, jobs: [{ job: { status: 'completed', completedAt: '2026-09-10T06:15:56Z', scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] };
  assert.match(newRoundPlan(recent, 'miska', Date.parse('2026-09-11T00:00:00Z')).warning, /再查会再扣一次点数/);
  assert.equal(newRoundPlan(recent, 'miska', Date.parse('2026-09-13T00:00:00Z')).warning, null);
  const running = { ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-11T00:00:00Z', batchId: 'b', revision: 0, plan }, jobs: [{ job: { status: 'claimed', completedAt: null, scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] };
  assert.equal(newRoundPlan(running, 'miska').ready, false); assert.match(newRoundPlan(running, 'miska').reason, /在进行/);
  assert.equal(newRoundPlan({ ...base, canPrepare: false }, 'miska').ready, false);
  assert.equal(newRoundPlan({ ...base, bindings: [] }, 'miska').ready, false);
});

const orphanEntry = ({ batchId = 'a-discovery-batch:orphan', createdAt = '2026-09-10T04:00:00.000Z',
  direction = '刚点的方向（合成）', targetStore = 'miska', canAuthorize = true, plan = { provider: 'seerfar', direction } } = {}) =>
  ({ batch: { batchId, revision: 0, targetStore, createdAt, plan }, jobs: [], canAuthorize,
    selections: [], importedCandidates: [], declines: [] });

test('最新一轮排在最前，历史轮次没处理的收进折叠，同一件商品跨轮只出现一次', () => {
  const older = batchEntry({ batchId: 'a-discovery-batch:older', createdAt: '2026-09-08T04:00:00.000Z', direction: '旧方向（合成）',
    products: [product('2107989730'), product('2107989731'), product('2107989732'),
      product('2107989733', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -1 }) }), product('2107989734')],
    importedCandidates: [{ marketProductId: '2107989732', candidateId: 'candidate:old' }],
    declines: [{ marketProductId: '2107989734', reason: '利润太薄' }] });
  const newer = batchEntry({ batchId: 'a-discovery-batch:newer', createdAt: '2026-09-10T04:00:00.000Z', direction: '新方向（合成）',
    products: [product('2107989735'), product('2107989731')] });
  const feed = feedRows(viewOf(older, newer), 'miska');
  assert.equal(feed.direction, '新方向（合成）');
  assert.equal(feed.current.batchId, 'a-discovery-batch:newer');
  // The newest round comes first in its own sort order; an older round keeps only what the owner already acted on.
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989731', '2107989735', '2107989732']);
  assert.equal(feed.rows[2].importedCandidateId, 'candidate:old');
  // A product returned by both rounds shows once, under the newest round it came back in.
  assert.equal(feed.rows.filter(row => row.marketProductId === '2107989731').length, 1);
  assert.equal(feed.rows[0].batchId, 'a-discovery-batch:newer');
  assert.deepEqual(feed.history.map(row => row.marketProductId), ['2107989730']);
  assert.equal(feed.history[0].batchId, 'a-discovery-batch:older');
  assert.deepEqual(feed.excluded.map(row => row.marketProductId), ['2107989733']);
  assert.deepEqual(feed.declined.map(row => row.marketProductId), ['2107989734']);
  // The two batch buttons act on the newest round, so they count that round only.
  assert.equal(feed.estimable, 2);
  assert.equal(feed.pendingTranslations, 2);
  assert.deepEqual(deskCounts({ discoveryView: viewOf(older, newer), candidates: [], store: 'miska' }), { desk: 3, board: 0, inbox: 0 });
});

test('还没有结果的新批次不抢走本轮标题，待决定仍来自最近一次真的查完的轮次', () => {
  const finished = batchEntry({ batchId: 'a-discovery-batch:finished', createdAt: '2026-09-08T04:00:00.000Z',
    direction: '已经查完（合成）', products: [product('2107989735')] });
  const queued = batchEntry({ batchId: 'a-discovery-batch:queued', createdAt: '2026-09-09T04:00:00.000Z',
    direction: '正在查（合成）', products: [product('2107989736')], jobStatus: 'queued' });
  const feed = feedRows(viewOf(finished, queued, orphanEntry()), 'miska');
  assert.equal(feed.direction, '已经查完（合成）');
  assert.equal(feed.queriedAt, formatInstant('2026-09-08T04:00:00.000Z'));
  assert.equal(feed.current.batchId, 'a-discovery-batch:finished');
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989735']);
  assert.deepEqual(feed.history, []);
  assert.equal(feed.estimable, 1);
});

test('上一次点了却没开始的那一轮可以直接续上，两种"刚查过"分别说清是不是同一个方向', () => {
  const budget = { maxCredits: 20, estimatedPointsByStep: { quota_before: 0, category_detail: 13, quota_after: 0 } };
  const plan = { planId: 'plan:clothing', version: 'version:1', direction: '宠物服装', budget };
  const previous = { planId: 'plan:bed', version: 'version:1', direction: '宠物躺床', budget };
  const base = { canPrepare: true, plans: [plan], bindings: [{ bindingId: 'binding:x', configurationVersion: 'version:1' }], batches: [] };
  assert.equal(newRoundPlan(base, 'miska').resume, null);
  const resumable = newRoundPlan({ ...base, batches: [orphanEntry({ plan, createdAt: '2026-09-11T09:00:00Z' })] },
    'miska', Date.parse('2026-09-11T10:00:00Z'));
  assert.equal(resumable.ready, true);
  assert.equal(resumable.resume.batchId, 'a-discovery-batch:orphan');
  assert.equal(resumable.resume.expectedRevision, 0);
  assert.equal(resumable.resume.direction, '宠物服装');
  assert.equal(resumable.resume.createdAt, formatInstant('2026-09-11T09:00:00Z'));
  // A saved batch the server says it can no longer authorize is never offered as something to continue.
  assert.equal(newRoundPlan({ ...base, batches: [orphanEntry({ plan, canAuthorize: false })] }, 'miska').resume, null);
  const round = savedPlan => ({ ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-10T06:15:00Z',
    batchId: 'a-discovery-batch:done', revision: 0, plan: savedPlan },
    jobs: [{ job: { status: 'completed', completedAt: '2026-09-10T06:15:56Z', scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] });
  const same = newRoundPlan(round(plan), 'miska', Date.parse('2026-09-11T00:00:00Z')).warning;
  assert.match(same, /刚查过同一方向「宠物服装」/u);
  assert.match(same, /再查会再扣一次点数/u);
  const different = newRoundPlan(round(previous), 'miska', Date.parse('2026-09-11T00:00:00Z')).warning;
  assert.doesNotMatch(different, /同一方向/u);
  assert.match(different, /刚查过「宠物躺床」/u);
  assert.match(different, /这一轮是「宠物服装」/u);
  assert.match(different, /会再扣一次点数/u);
  assert.equal(newRoundPlan(round(previous), 'miska', Date.parse('2026-09-13T00:00:00Z')).warning, null);
});
