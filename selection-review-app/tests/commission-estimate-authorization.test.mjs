import test from 'node:test';
import assert from 'node:assert/strict';

import {
  B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED, OZON_EVIDENCE_COMMISSION_UNAVAILABLE, commissionEstimateProposal,
  exactCommissionUnavailable, officialCommissionTableGaps, remoteEvidenceReasonCode
} from '../lib/commission-estimate-authorization.mjs';

// 2026-09-14 现场那一次的原话，从最里面一层往外抄：证据服务 → 只读读取器 → 证据提供器 → a-confirm 的 422。
// 这是证据服务还会把「店里没有同类商品」回成 HTTP 500 的那一代。
const REMOTE = `${OZON_EVIDENCE_COMMISSION_UNAVAILABLE}: 店铺当前没有同 description category 和 type 的商品可读取 RFBS 佣金`;
const READER = `OZON_LOCAL_EVIDENCE_FAILED: HTTP 500: ${REMOTE}`;
const PROVIDER = `B_EVIDENCE_PROVIDER_READ_FAILED: ${READER}`;

// 证据服务修好之后的那一代：它回 HTTP 200 + 一份合格的 data_unavailable 证据，OZON_ 那个码在这条路径上再也
// 不出现，缺授权时由消费方 lib/lifecycle-b-real-evidence-readers.mjs 抛出下面这一句。整句逐字取自那边的实跑。
const FIXED_READER = `${B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED}: 缺少当前候选、revision和精确范围的单次估算授权`;
const FIXED_PROVIDER = `B_EVIDENCE_PROVIDER_READ_FAILED: ${FIXED_READER}`;
/** 同一句话后面接上官方佣金表这一次卡在哪几处；服务端用「、」串，用「；」起头。 */
const withOfficialGaps = (...gaps) => `${FIXED_PROVIDER}；官方佣金表未能成交：${gaps.join('、')}`;
/** 浏览器里 api.js 抛的那一个：message 是服务端的 message，body 是整份回体。 */
const httpFailure = (reason, message = `A确认后的B系统证据准备已停止：${reason}`) => Object.assign(new Error(message), {
  status: 422,
  body: {
    message,
    evidencePreparation: {
      status: 'failed',
      failure: { layer: 'provider:commission', reason },
      providerCalls: [{ kind: 'commission', attempt: 1, status: 'failed', reason }]
    },
    guooRouteComparison: null
  }
});

test('机器可读的那个前缀认得出来，中文说明变了也不影响', () => {
  assert.equal(remoteEvidenceReasonCode(REMOTE), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode(`${OZON_EVIDENCE_COMMISSION_UNAVAILABLE}: 换一句完全不同的中文`), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode(OZON_EVIDENCE_COMMISSION_UNAVAILABLE), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode('OZON_EVIDENCE_STORE_UNAUTHORIZED: 别的失败'), 'OZON_EVIDENCE_STORE_UNAUTHORIZED');
  // 没有机器可读前缀的话就是没有，不要从中文里猜一个出来。
  assert.equal(remoteEvidenceReasonCode('店铺当前没有同类商品'), null);
  assert.equal(remoteEvidenceReasonCode('HTTP 500'), null);
  assert.equal(remoteEvidenceReasonCode(''), null);
  assert.equal(remoteEvidenceReasonCode(null), null);
  assert.equal(remoteEvidenceReasonCode({ code: OZON_EVIDENCE_COMMISSION_UNAVAILABLE }), null);
});

test('「精确佣金读不到」这一类，从 a-confirm 那个 422 的原话里认出来', () => {
  // 页面手上就是这一个：422 的整份回体，原话被包了三层。
  assert.equal(exactCommissionUnavailable(httpFailure(PROVIDER)), true);
  // 只拿到那句话本身，或者只拿到 message，也要认得出来。
  assert.equal(exactCommissionUnavailable(PROVIDER), true);
  assert.equal(exactCommissionUnavailable(new Error(READER)), true);
  // 服务端抛的那个错误对象自己已经标好了，就用它标的。
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('无关的话'), { exactCommissionUnavailable: true })), true);

  // 别的失败不能顺带把这一块摆出来：这一块是「店里还没有这条类目的商品」专用的。
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 500')), false);
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 401: OZON_EVIDENCE_STORE_UNAUTHORIZED: 凭据过期')), false);
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('商品资料已变化，请刷新后重新确认A阶段'), { status: 409 })), false);
  assert.equal(exactCommissionUnavailable(null), false);
  assert.equal(exactCommissionUnavailable(undefined), false);
  assert.equal(exactCommissionUnavailable({}), false);
  assert.equal(exactCommissionUnavailable(42), false);
});

test('证据服务修好之后，「只差主人授权」那个码同样认得出来，旧信号也不丢', () => {
  // 修好之后这条路上根本不会再出现 OZON_ 那个码：认不出 B_ 这个，那一块就永远不出现，主人永远看不到出路。
  assert.equal(FIXED_PROVIDER.includes(OZON_EVIDENCE_COMMISSION_UNAVAILABLE), false, '修好之后旧码确实不在场');
  assert.equal(exactCommissionUnavailable(httpFailure(FIXED_PROVIDER)), true);
  assert.equal(exactCommissionUnavailable(FIXED_PROVIDER), true);
  assert.equal(exactCommissionUnavailable(new Error(FIXED_READER)), true);
  // 官方佣金表的缺口接在后面时照样认得出来。
  assert.equal(exactCommissionUnavailable(httpFailure(withOfficialGaps('TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH'))), true);
  // 同一个码的另一个抛出点：带上来的 commissionEstimate 本身不成形。中文不一样，码一样，照认。
  assert.equal(exactCommissionUnavailable(httpFailure(
    `B_EVIDENCE_PROVIDER_READ_FAILED: ${B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED}: 估算佣金必须由主人对当前SKU明确授权`)), true);

  // 旧的那一代还在跑的机器上，旧信号必须继续认——证据服务是单独部署的。
  assert.equal(exactCommissionUnavailable(httpFailure(PROVIDER)), true);

  // 相邻的几个码不能被顺带认成这一类：它们说的不是「现在就差你授权」。
  for (const reason of [
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_ESTIMATE_EXPIRED: 估算授权不在明确有效时间窗内',
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_ESTIMATE_INVALID: 估算佣金率必须在0到1之间',
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_UNAVAILABLE_INVALID: 不可用必须是本轮同范围明确结果，不能保留佣金数值',
    'B_EVIDENCE_PROVIDER_ESTIMATE_SCOPE_MISMATCH: 估算授权不属于本轮候选与修订'
  ]) assert.equal(exactCommissionUnavailable(httpFailure(reason)), false, reason);

  // 跟这件事无关的失败一律不摆这一块：版本冲突、店铺没绑、网络断了。
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('商品资料已变化，请刷新后重新确认A阶段'), { status: 409 })), false);
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 403: OZON_EVIDENCE_STORE_NOT_BOUND: 这个店还没有绑定')), false);
  assert.equal(exactCommissionUnavailable(new TypeError('fetch failed')), false);
});

test('官方佣金表这一次卡在哪几处，原样捡出来；服务端没说就一个字都不造', () => {
  // 有缺口：逐字，顺序照服务端说的，重复的那几层只算一次。
  const gaps = httpFailure(withOfficialGaps('TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH'));
  assert.deepEqual(officialCommissionTableGaps(gaps), ['TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH']);
  // 官方费表读取本身抛了异常时，消费方给的是 OFFICIAL_TABLE_ 前缀那一个，照样原样上来。
  assert.deepEqual(officialCommissionTableGaps(httpFailure(withOfficialGaps('OFFICIAL_TABLE_CATALOG_UNREADABLE'))),
    ['OFFICIAL_TABLE_CATALOG_UNREADABLE']);
  // 一个字都不许改：大小写、下划线、中文说明，服务端写成什么样就是什么样。
  assert.deepEqual(officialCommissionTableGaps(withOfficialGaps('official_table_Rate_Unusable', '版本状态 status=stale')),
    ['official_table_Rate_Unusable', '版本状态 status=stale']);
  // 只拿到那一句话本身，或者只拿到 Error，也要捡得出来。
  assert.deepEqual(officialCommissionTableGaps(new Error(withOfficialGaps('TYPE_NOT_FOUND'))), ['TYPE_NOT_FOUND']);

  // 服务端没提官方佣金表（这台机器上压根没配）：空的，页面也就不说那一句。
  assert.deepEqual(officialCommissionTableGaps(httpFailure(FIXED_PROVIDER)), []);
  assert.deepEqual(officialCommissionTableGaps(httpFailure(PROVIDER)), []);
  assert.deepEqual(officialCommissionTableGaps(Object.assign(new Error('商品资料已变化'), { status: 409 })), []);
  for (const empty of [null, undefined, {}, 42, '']) assert.deepEqual(officialCommissionTableGaps(empty), [], String(empty));
  // 「未能成交：」后面什么都没有时不要造出一个空缺口来。
  assert.deepEqual(officialCommissionTableGaps(`${FIXED_PROVIDER}；官方佣金表未能成交：`), []);
  assert.deepEqual(officialCommissionTableGaps(`${FIXED_PROVIDER}；官方佣金表未能成交：、 、`), []);
  // 缺口后面又接了别的一句时，到那里为止，不把后半句当成缺口。
  assert.deepEqual(officialCommissionTableGaps(`${withOfficialGaps('TYPE_NOT_FOUND')}；证据准备：{"status":"failed"}`), ['TYPE_NOT_FOUND']);
});

test('替代费率整份取自那份解析结果，缺一样就不提议', () => {
  // 2026-09-14 反光雨衣那一件的真实取值。
  const sources = {
    targetSalePriceRub: 1455,
    commissionRate: 0.12,
    commissionTier: 'le1500',
    commissionSourceRef: 'ozon-official-commission:2025-12-01:sha256:be7832ff9dbd09ee7021aaefe9018a02287332bc22e4c6b470d6cfe0b3649cf0'
  };
  assert.deepEqual(commissionEstimateProposal(sources), {
    commissionRate: 0.12,
    commissionTier: 'le1500',
    commissionSourceRef: sources.commissionSourceRef,
    targetSalePriceRub: 1455
  });
  // 跨过档位分界线的是另一份解析结果，这里照它给的说，自己不记一个旧数。
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: 1666, commissionRate: 0.14, commissionTier: 'le5000' }).commissionRate, 0.14);
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: 1666, commissionRate: 0.14, commissionTier: 'le5000' }).commissionTier, 'le5000');

  // 费率、档位、来源引用缺任何一样，软件都不提议——证据含糊的地方不替主人签字。
  for (const missing of ['commissionRate', 'commissionTier', 'commissionSourceRef']) {
    assert.equal(commissionEstimateProposal({ ...sources, [missing]: null }), null, missing);
    assert.equal(commissionEstimateProposal({ ...sources, [missing]: undefined }), null, missing);
  }
  assert.equal(commissionEstimateProposal({ ...sources, commissionTier: '   ' }), null);
  assert.equal(commissionEstimateProposal({ ...sources, commissionSourceRef: '' }), null);
  // 不成其为费率的数字不是费率。
  for (const rate of [0, 1, 1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.12']) {
    assert.equal(commissionEstimateProposal({ ...sources, commissionRate: rate }), null, String(rate));
  }
  // 目标成交价拿不到时照样可以提议，只是那一句不说价格；别的都不能少。
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: null }).targetSalePriceRub, null);
  assert.equal(commissionEstimateProposal(null), null);
  assert.equal(commissionEstimateProposal([]), null);
  assert.equal(commissionEstimateProposal('12%'), null);
});
