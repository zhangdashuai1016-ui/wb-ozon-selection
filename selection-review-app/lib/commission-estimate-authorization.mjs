/**
 * 「这条类目在这个店里还没有商品，精确佣金读不到」——认出这一类失败，和这一类失败下软件敢提议的那一个费率。
 *
 * 软件算佣金的规矩是：从主人自己店里已经上着的、同一个 description_category_id + type_id 的商品上，读出平台
 * 实际收的那个费率。一个店在一条类目的第一件商品必然撞上这一下：店里没有同类商品，读不到，重试多少次都一样。
 *
 * 这个模块只做三件事，三件都不碰网络、不碰记录：
 *   一、从服务端那句失败原话里认出这一类。认的是机器可读的码，不是那句中文——中文会改，码不会。失败的话被
 *       层层包过（422 的 evidencePreparation.failure.reason 里是 provider 的包装，再里面才是原话），所以
 *       这里在整句里找那些码。
 *   二、把服务端顺带说出来的「官方佣金表这一次卡在哪」逐字捡出来交给页面。软件不概括、不改写：主人有权知道
 *       那张表本来可以自己成交、这一次为什么没成。服务端没说的时候这里就是空的，页面也就不说那一句。
 *   三、给出替代费率的提议。费率、档位、来源引用只从页面已经有的那份解析结果里取，三样缺一样就不提议——
 *       证据含糊的地方软件不替主人签字。它也不缓存任何一个数：目标成交价跨过档位分界线，同一份解析结果会
 *       给出另一档，这里跟着走。
 *
 * 两个码要一起认，因为它们是同一件事在两代证据服务下的两种说法：
 *   · 旧的本地只读证据服务把「店里没有同类商品可读 RFBS 佣金」回成 HTTP 500，原话里带 OZON_ 那个码；
 *   · 修好之后它回 HTTP 200 + 一份合格的 data_unavailable 证据，那个码在这条路径上再也不出现，改由消费方
 *     lib/lifecycle-b-real-evidence-readers.mjs 的 assertEstimateScopeAndValidity 抛出 B_ 那个码。
 * 证据服务是单独部署的，主人机器上可能还是旧的，所以旧信号也得继续认。
 */

/** 本地只读证据服务对「店里没有同类商品可读 RFBS 佣金」的稳定说法，它的机器可读前缀（HTTP 500 那一代）。 */
export const OZON_EVIDENCE_COMMISSION_UNAVAILABLE = 'OZON_EVIDENCE_COMMISSION_UNAVAILABLE';

/**
 * 证据服务已经好好地回了「读不到」之后，消费方在缺主人授权时抛的那个码，逐字取自
 * lib/lifecycle-b-real-evidence-readers.mjs。那边有两个地方抛它，两个地方说的都是「这一次差的是主人的
 * 授权」：assertEstimateScopeAndValidity（只在 data_unavailable 这一条分支上跑，缺授权或范围对不上）和
 * normalizeCommissionEstimate（带上来的授权本身不成形）。两种都该把那一块摆出来让主人重新勾一次。
 */
export const B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED = 'B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED';

/** 认出这一类失败的那两个码。别的码一律不算——这一块是「店里还没有这条类目的商品」专用的。 */
const AUTHORIZATION_REQUIRED_CODES = Object.freeze([
  OZON_EVIDENCE_COMMISSION_UNAVAILABLE,
  B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED
]);

/**
 * 消费方把官方佣金表的缺口接在授权缺失那句话后面时用的那个连接词和分隔号，逐字取自同一个文件：
 * `throw new Error(`${error.message}；官方佣金表未能成交：${officialGaps.join("、")}`)`。
 */
const OFFICIAL_GAPS_MARKER = '；官方佣金表未能成交：';
const OFFICIAL_GAPS_SEPARATOR = '、';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

/** 一句 `CODE: 说明` 最前面那个机器可读的码；没有这样的前缀就是 null。 */
export function remoteEvidenceReasonCode(value) {
  const match = /^([A-Z][A-Z0-9_]{2,79})(?::|$)/u.exec(text(value) ?? '');
  return match === null ? null : match[1];
}

/** 一次失败里所有可能带着原话的地方，全部收上来当字符串看。 */
function failureReasons(cause) {
  if (typeof cause === 'string') return [cause];
  if (!isObject(cause)) return [];
  const body = isObject(cause.body) ? cause.body : cause;
  const preparation = isObject(body.evidencePreparation) ? body.evidencePreparation : null;
  const calls = Array.isArray(preparation?.providerCalls) ? preparation.providerCalls : [];
  return [
    cause.message, cause.remoteError, body.message, preparation?.failure?.reason,
    ...calls.map(call => call?.reason)
  ].filter(value => typeof value === 'string' && value.length > 0);
}

/**
 * 这一次 A 确认的失败，是不是「精确佣金读不到、只差主人授权」那一类。
 * 手上直接拿着证据读取器抛的那个错误对象时，它自己已经标好了；只拿到 HTTP 回体时，就在原话里找那两个码。
 */
export function exactCommissionUnavailable(cause) {
  if (isObject(cause) && cause.exactCommissionUnavailable === true) return true;
  return failureReasons(cause).some(reason => AUTHORIZATION_REQUIRED_CODES.some(code => reason.includes(code)));
}

/**
 * 服务端这一次说的「官方佣金表未能成交」卡在哪几处，逐字。
 *
 * 会走到这一步，说明官方费率表没能自己把这件商品的证据立起来——立起来了，消费方直接返回那份真证据，主人
 * 根本看不到授权那一块。所以这几个缺口是主人应得的交代：那张表本来可以自己成交，这一次为什么没成。
 *
 * 只做拆分和去重，一个字都不改。服务端根本没提这件事（比如这台机器上压根没配官方费率表）时返回空数组，
 * 由页面照实地什么都不说，不在这里替它造一句。
 */
export function officialCommissionTableGaps(cause) {
  const gaps = [];
  for (const reason of failureReasons(cause)) {
    const marker = reason.indexOf(OFFICIAL_GAPS_MARKER);
    if (marker < 0) continue;
    // 缺口是用「、」串起来的，「；」只可能是后面又接了别的一句，到那里为止。
    const tail = reason.slice(marker + OFFICIAL_GAPS_MARKER.length).split('；')[0];
    for (const piece of tail.split(OFFICIAL_GAPS_SEPARATOR)) {
      const gap = text(piece);
      if (gap !== null && !gaps.includes(gap)) gaps.push(gap);
    }
  }
  return gaps;
}

/**
 * 精确佣金读不到时，软件按官方费率表提议的那一个费率，整份取自已经解析好的 `skuChoiceTableV1.sources`。
 * 费率、档位、来源引用任意一样拿不出来就返回 null：那种时候软件什么也不提议，由页面照实说。
 */
export function commissionEstimateProposal(sources) {
  if (!isObject(sources)) return null;
  const commissionRate = finite(sources.commissionRate);
  const commissionTier = text(sources.commissionTier);
  const commissionSourceRef = text(sources.commissionSourceRef);
  if (commissionRate === null || commissionRate <= 0 || commissionRate >= 1) return null;
  if (commissionTier === null || commissionSourceRef === null) return null;
  return Object.freeze({
    commissionRate,
    commissionTier,
    commissionSourceRef,
    targetSalePriceRub: finite(sources.targetSalePriceRub)
  });
}
