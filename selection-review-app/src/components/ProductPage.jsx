import { useMemo, useState } from "react";
import { errorMessage } from "../formState.js";
import { storeLabel } from "../selectionDeskView.js";
import { toggleLocalSupplierSkuSelection } from "../aSupplierCaptureSelection.js";
import { profitStepGaps, profitStepSubmission } from "../../lib/profit-step-review.mjs";
import { commissionEstimateProposal } from "../../lib/commission-estimate-authorization.mjs";
import { buildBExactCommissionInput, buildBEvidenceRefreshInput } from "../bExactCommissionInput.js";
import EliminateControl from "./EliminateControl.jsx";

/**
 * One product page for the owner: the six steps of a product, with only the step that is actually open expanded.
 * Every number shown here is either the owner's own declaration (labelled 主人填写) or a figure that already exists in
 * the saved records. The page computes no price, no freight and no profit; it only shows what the server saved.
 */
export const PRODUCT_STEPS = Object.freeze([
  { key: "select", title: "选定" },
  { key: "find", title: "找货" },
  { key: "profit", title: "算利润" },
  { key: "copy", title: "文案素材" },
  { key: "publish", title: "上架" },
  { key: "readback", title: "回读" }
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
const money = value => (finite(value) === null ? null : `¥${value.toFixed(2)}`);
const percent = value => (finite(value) === null ? null : `${Math.round(value * 100)}%`);
const count = value => (finite(value) === null ? "未取得" : String(value));
const dayOf = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null);
const textOf = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");
const numberField = value => (finite(value) === null ? "" : String(value));

/**
 * 选定 is open exactly while the extension has left a set of specifications on this product and the owner has not
 * chosen from it yet. Nothing else opens it: a product with no capture, or a capture that failed, has nothing to pick.
 */
export function skuChoiceReady(candidate) {
  const capture = candidate?.sourceCapture;
  return isObject(capture) && capture.status === "captured_waiting_owner_selection" &&
    Array.isArray(capture.skuChoices) && capture.skuChoices.length > 0;
}

/** The owner already chose, and the chosen specifications are frozen into this product's supply plan. */
export function skuChoiceSaved(candidate) {
  const ids = candidate?.sourceCapture?.selectedSkuIds;
  return skuChoiceReady(candidate) && Array.isArray(ids) && ids.length > 0;
}

/** The step the owner is actually on. Supply is confirmed only once the lifecycle froze an A confirmation. */
export function currentProductStep(candidate) {
  if (candidate?.workflowStatus === "listed") return "readback";
  const phase = typeof candidate?.executionRuntime?.businessPhase === "string" ? candidate.executionRuntime.businessPhase : "";
  if (phase.startsWith("E")) return "readback";
  if (phase.startsWith("D")) return "publish";
  if (phase.startsWith("C")) return "copy";
  if (phase.startsWith("B")) return "profit";
  if (candidate?.lifecycleV11?.aConfirmationReceipt?.decision === "confirm") return "profit";
  // 插件采回来了就轮到主人挑规格；挑完这一步就做完，页面接着往下走。
  if (skuChoiceReady(candidate)) return skuChoiceSaved(candidate) ? "profit" : "select";
  return "find";
}

/** 选定 stays on screen while the chosen specifications are still the owner's to change. */
export function showsSkuChoice(candidate) {
  if (!skuChoiceReady(candidate)) return false;
  if (candidate?.lifecycleV11?.aConfirmationReceipt?.decision === "confirm") return false;
  return ["select", "profit"].includes(currentProductStep(candidate));
}

/**
 * The saved draft, mapped into exactly the A-confirmation submission the existing capture route already expects.
 * Nothing new is confirmed here: ownerSupplyConfirmed stays false and the sales review keeps its unknown judgments,
 * so the request only queues the 1688 capture job the software already runs today.
 */
export function captureSubmissionFromDraft({ candidate, draft, marketSnapshot }) {
  if (!isObject(candidate) || !isObject(draft)) return null;
  return {
    dataRevision: candidate.dataRevision,
    sourceCandidateId: candidate.id,
    sourceDataRevision: candidate.dataRevision,
    targetPlatform: candidate.targetPlatform ?? "ozon",
    storeRef: candidate.storeRef ?? null,
    decision: "confirm",
    salesReview: {
      snapshotId: marketSnapshot?.snapshotId ?? null,
      comparability: "unknown",
      validityStatus: "unknown",
      confidence: "limited"
    },
    supplierConfirmation: { productUrl: draft.sourceUrl, ownerSupplyConfirmed: false }
  };
}

/**
 * 结果未知：插件领走了那次作业，服务端一直没有收到结果。软件不会替主人猜这次采到了什么，所以这条记录会挡住这件商品
 * 之后的每一次采集申请，直到主人自己确认一次。页面必须把「被挡住了」和「出路在哪」都说出来——2026-09-11 主人正是
 * 在这里卡死：页面只写了「上一次采集已停止」，既没说不能再申请，也没有任何地方可以处理这条记录。
 */
export function captureOutcomeUnknown(candidate) {
  const capture = candidate?.sourceCapture;
  return isObject(capture) && (capture.jobStatus === "unknown_outcome" || capture.failureCode === "unknown_outcome");
}

/** 只有还没被主人确认过（没有 reviewedAt）的「结果未知」记录才挡路。 */
export function captureNeedsOwnerReview(candidate) {
  return captureOutcomeUnknown(candidate) && textOf(candidate?.sourceCapture?.reviewedAt) === "";
}

/** 核实这条记录时提交的全部内容：当前修订号和一个固定的确认选项，没有自由文本。 */
export function captureReviewPayload(candidate) {
  return captureNeedsOwnerReview(candidate)
    ? { dataRevision: candidate.dataRevision, acknowledgement: "no_result_received" }
    : null;
}

/**
 * 重新采集 — 让软件再去读一次同一个1688页面。
 *
 * 为什么非有这个按钮不可：采到了之后，「申请插件采集」就不会再建新的采集了（服务端认得同一个链接已经采过），所以这件商品
 * 会被永远钉在那一次读到的内容上。2026-09-13 当天第一件商品就是这样——采到 24 个规格，但那时服务端还在丢掉每个规格的
 * 重量，选规格表里整列运费和利润都是「待补」，而页面上没有任何地方能让主人重读一次。
 *
 * 只有「已采到、等你选规格」这一种状态才给这个按钮：还在排队或正在读的时候没有东西可以作废，读失败的记录走的是另外两条路。
 */
export function captureRecaptureReady(candidate) {
  return candidate?.sourceCapture?.status === "captured_waiting_owner_selection";
}

/** 重新采集会丢掉的东西，按记录里真实的条数说出来。含糊其辞的确认等于没有确认。 */
export function captureRecaptureConfirmLine(candidate) {
  if (!captureRecaptureReady(candidate)) return null;
  const capture = candidate.sourceCapture;
  const choices = Array.isArray(capture.skuChoices) ? capture.skuChoices.length : 0;
  const selected = Array.isArray(capture.selectedSkuIds) ? capture.selectedSkuIds.length : 0;
  const chosen = selected > 0 ? `，连你已经选定的那 ${selected} 个也一起作废，要重新选一次` : "";
  return `确定重新去读一次这个1688页面？现在这 ${choices} 个规格会作废${chosen}。重新读一次不会下单、不会联系供应商、也不会向 Ozon 写任何东西。`;
}

/** 可以顺手记下的理由，只有这几个词；页面从不把自由文本发给服务端。 */
export const CAPTURE_RECAPTURE_REASONS = Object.freeze([
  { code: "weight_missing", label: "没采到重量" },
  { code: "page_changed", label: "页面改了" },
  { code: "wrong_specifications", label: "规格不对" }
]);

/** 提交的全部内容：当前修订号，外加一个可选的固定理由。 */
export function captureRecapturePayload(candidate, reason = null) {
  if (!captureRecaptureReady(candidate)) return null;
  return CAPTURE_RECAPTURE_REASONS.some(item => item.code === reason)
    ? { dataRevision: candidate.dataRevision, reason }
    : { dataRevision: candidate.dataRevision };
}

export const CAPTURE_REVIEW_BLOCKED_MESSAGE =
  "插件领走了上一次采集，但一直没有把结果传回来，服务端只能记成「结果未知」。软件不会替你猜这次采到了什么，所以在你确认之前，这件商品不能再申请采集。";
export const CAPTURE_REVIEW_ACTION_LABEL = "这次采集没有结果，我确认并重新申请";

/** The capture job in the owner's words; a failed run stays visible as history, never as the current state. */
export function captureStatusLine(candidate) {
  const capture = candidate?.sourceCapture;
  if (!isObject(capture)) return "还没有申请过插件采集。";
  if (capture.status === "captured_waiting_owner_selection") return "插件已采到1688页面数据，等你选具体规格。";
  if (capture.jobStatus === "claimed" || capture.status === "extension_running") return "插件已领取本次采集，正在读取1688页面。";
  if (capture.status === "waiting_extension") return "已排队，等插件领取本次采集。";
  const reason = textOf(capture.reason) || textOf(capture.failureCode);
  if (captureNeedsOwnerReview(candidate)) return `上一次采集的结果未知：${reason || "服务端没有收到结果"}。`;
  if (captureOutcomeUnknown(candidate)) return `上一次采集的结果未知：${reason || "服务端没有收到结果"}。你已确认这次没有结果，可以重新申请采集。`;
  if (capture.failureCode) return `上一次采集已停止：${reason}。`;
  return `当前采集状态：${textOf(capture.status) || "未取得"}。`;
}

function marketSnapshotLine(snapshot) {
  if (!isObject(snapshot)) return null;
  const day = dayOf(snapshot.collectedAt);
  const metrics = isObject(snapshot.marketMetrics) ? snapshot.marketMetrics : {};
  const window = isObject(metrics.salesWindow) && metrics.salesWindow.startDate && metrics.salesWindow.endDate
    ? `${metrics.salesWindow.startDate} 至 ${metrics.salesWindow.endDate}`
    : "30 天";
  const price = finite(snapshot.currentPrice) === null ? "未取得" : `${snapshot.currentPrice} ${snapshot.currency === "RUB" ? "卢布" : snapshot.currency}`;
  return `市场快照：Seerfar ${day ?? "时间未取得"} · 售价 ${price} · ${window}销量 ${count(metrics.salesCount)} · 评价 ${count(metrics.reviewCount)}`;
}

function estimateLines(estimateRecord) {
  if (!isObject(estimateRecord)) return { headline: "填好上面的资料并保存后，这里显示采购上限和利润。", detail: null, warning: null };
  const estimate = estimateRecord.estimate ?? {};
  const warning = isObject(estimateRecord.routeBlock) ? estimateRecord.routeBlock : null;
  const chosen = estimate.freight?.chosen ?? null;
  const profit = estimateRecord.profitAtDeclaredPurchase ?? null;
  if (estimate.status === "incomplete") {
    return { headline: `还不能算利润：缺${(estimate.missing ?? []).join("、") || "必要输入"}。`, detail: null, warning };
  }
  const ceiling = money(estimate.ceiling?.maximumAllInPurchaseRmb);
  const freight = chosen === null ? "运费未取得"
    : `${chosen.route} · 计费 ${chosen.chargeableKg} 公斤 · 运费 ${money(chosen.freightRmb)}${estimate.freight?.oversize === true ? "（超抛）" : ""}`;
  const headline = profit === null
    ? `采购上限 ${ceiling ?? "未取得"} · ${freight}`
    : `按你填的到手总价 ${money(profit.allInPurchaseRmb)}：单件利润 ${money(profit.unitProfitRmb)} · 利润率 ${percent(profit.marginRate) ?? "未取得"} · ${profit.passes ? "达到本店利润门槛" : "没到本店利润门槛"}`;
  const detail = `采购上限 ${ceiling ?? "未取得"} · ${freight} · 佣金 ${percent(estimate.commission?.rate) ?? "未取得"}`;
  return { headline, detail: profit === null ? null : detail, warning };
}

/**
 * After a save the owner must see one next thing, not three boxes of equal weight. Owner feedback 2026-09-11: the form
 * was filled, the page was left and the product could not be found again — so the page stays put and says, from the
 * saved estimate alone, whether the next move is 申请插件采集 or the form itself.
 */
export function nextProductAction(view) {
  if (!isObject(view?.supplierDraftV1)) return { key: "form", hint: null };
  const record = view.supplierDraftEstimateV1 ?? null;
  if (!isObject(record) || record.estimate?.status !== "ok") {
    return { key: "form", hint: "下一步：把上面缺的资料补齐，再保存一次。" };
  }
  return record.profitAtDeclaredPurchase?.passes === true
    ? { key: "capture", hint: "下一步：点下面的「申请插件采集」，让插件去读这个1688页面。" }
    : { key: "form", hint: "下一步：这件没到本店利润门槛，改上面的货价或目标成交价再保存一次。" };
}

function draftFormState({ draft, candidate, marketSnapshot }) {
  if (isObject(draft)) {
    return {
      sourceUrl: draft.sourceUrl ?? "",
      goodsPriceRmb: numberField(draft.goodsPriceRmb),
      domesticShippingRmb: numberField(draft.domesticShippingRmb),
      packedWeightKg: numberField(draft.packedWeightKg),
      length: numberField(draft.dimensionsCm?.length),
      width: numberField(draft.dimensionsCm?.width),
      height: numberField(draft.dimensionsCm?.height),
      targetSalePriceRub: numberField(draft.targetSalePriceRub),
      note: draft.note ?? ""
    };
  }
  // No draft yet: prefill from whatever the owner already saved through the older per-field form.
  const shipping = finite(candidate?.domesticShippingRmb);
  const allIn = finite(candidate?.purchasePriceRmb);
  const goods = allIn === null ? null : shipping === null ? allIn : Math.round((allIn - shipping) * 100) / 100;
  return {
    sourceUrl: textOf(candidate?.sourceUrl),
    goodsPriceRmb: numberField(goods === null || goods < 0 ? null : goods),
    domesticShippingRmb: numberField(shipping),
    packedWeightKg: numberField(candidate?.packedWeightKg),
    length: numberField(candidate?.dimensionsCm?.length),
    width: numberField(candidate?.dimensionsCm?.width),
    height: numberField(candidate?.dimensionsCm?.height),
    // Owner question 2026-09-11: the target price should not be typed out of thin air, so it starts at what the same
    // product sells for today; the saved per-field figure only fills in when this round has no snapshot price.
    targetSalePriceRub: numberField(finite(marketSnapshot?.currentPrice) ?? finite(candidate?.expectedPriceRub)),
    note: ""
  };
}

const RUB = value => (finite(value) === null ? "未取得" : `${value} 卢布`);

/** Which of the store's two thresholds this price reached first, in the store rule's own numbers. */
export function thresholdBasisLine(guidance) {
  if (!isObject(guidance) || guidance.threshold === null) return null;
  const unit = money(guidance.minimumUnitProfitRmb);
  const margin = percent(guidance.targetMarginRate);
  const basis = guidance.threshold.basis;
  if (basis === "both") return `单件利润 ≥ ${unit ?? "未取得"} 和利润率 ≥ ${margin ?? "未取得"} 同时达到`;
  if (basis === "margin") return `按「利润率 ≥ ${margin ?? "未取得"}」先达到`;
  if (basis === "unit_profit") return `按「单件利润 ≥ ${unit ?? "未取得"}」先达到`;
  return null;
}

/**
 * Owner question 2026-09-11: "目标成交价应该平台算给我看，我怎么知道卖多少钱是赚钱的."
 * Four answers, all read from the estimate the server saved beside the 找货 declaration: the price that breaks even,
 * the cheapest price that clears this store's own threshold, what the same product sells for today and what that
 * would earn, and a short ladder. The commission rate on each line is the official one for that price band, which is
 * why a line above the band edge carries a different rate; the page computes none of it.
 */
function PricingGuidance({ guidance }) {
  if (!isObject(guidance)) {
    return <div className="product-pricing" aria-label="定价指引">
      <h4>定价指引</h4>
      <p className="product-pricing-empty">还算不出来：需要官方汇率、官方佣金和一条可行运费线路都齐了才有这几个价。</p>
    </div>;
  }
  const basis = thresholdBasisLine(guidance);
  return <div className="product-pricing" aria-label="定价指引">
    <h4>定价指引</h4>
    <dl className="product-pricing-facts">
      <div><dt>保本价</dt><dd>{guidance.breakEven === null ? "未取得"
        : `${RUB(guidance.breakEven.priceRub)}（佣金 ${percent(guidance.breakEven.commissionRate) ?? "未取得"}）`}</dd></div>
      <div><dt>达标最低售价</dt><dd>{guidance.threshold === null ? "未取得"
        : `${RUB(guidance.threshold.priceRub)}（佣金 ${percent(guidance.threshold.commissionRate) ?? "未取得"}）${basis === null ? "" : ` · ${basis}`}`}</dd></div>
      <div><dt>同款市场价</dt><dd>{guidance.market === null ? "未取得本轮查询的同款售价"
        : `${RUB(guidance.market.priceRub)} · 按这个价单件利润 ${money(guidance.market.unitProfitRmb) ?? "未取得"} · 利润率 ${percent(guidance.market.marginRate) ?? "未取得"}`}</dd></div>
    </dl>
    <div className="product-pricing-scroll">
    <table className="product-pricing-ladder">
      <caption>价格阶梯：每个售价能落下多少</caption>
      <thead><tr><th scope="col">售价</th><th scope="col">佣金</th><th scope="col">单件利润</th><th scope="col">利润率</th><th scope="col">这是什么价</th></tr></thead>
      <tbody>
        {guidance.ladder.map(entry => <tr key={entry.priceRub}>
          <td>{RUB(entry.priceRub)}</td>
          <td>{percent(entry.commissionRate) ?? "未取得"}</td>
          <td>{money(entry.unitProfitRmb) ?? "未取得"}</td>
          <td>{percent(entry.marginRate) ?? "未取得"}</td>
          <td>{entry.label}</td>
        </tr>)}
      </tbody>
    </table>
    </div>
    <p className="product-pricing-provenance">
      口径：成交收入按已保存的官方汇率 1 元 ≈ {finite(guidance.rubPerCny) === null ? "未取得" : guidance.rubPerCny} 卢布折算，
      扣官方佣金（超过档位分界线会换一档费率）、退货运营和破损丢失储备、提现费，再扣国际运费、包材、贴标，
      最后扣你填的到手总价 {money(guidance.allInPurchaseRmb) ?? "未取得"}（其余固定成本合计 {money(guidance.nonPurchaseFixedRmb) ?? "未取得"}）。
    </p>
  </div>;
}

/* ── 选规格 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * The table the owner picks from. Every number in it was worked out on the server, by the same engine and the same
 * official inputs as the 找货 estimate above; this file only decides how to say it. 待补 means the captured page never
 * declared that specification's weight — the software leaves the freight and the profit empty instead of borrowing
 * another specification's weight.
 */
const PENDING = "待补";
const yuanOr = value => money(value) ?? PENDING;

/** The one-line conclusion, in the table's own two numbers. */
export function skuChoiceHeadline(table) {
  const drop = finite(table?.profitDropRate);
  return drop === null || drop <= 0
    ? "同一件货，不同规格赚的不一样"
    : `同一件货，选错规格少赚 ${Math.round(drop * 100)}%`;
}

/** 最赚 / 最少, each named by its own specification. */
export function skuChoiceSwing(table) {
  const point = row => (isObject(row) && finite(row.unitProfitRmb) !== null
    ? { label: textOf(row.label) || String(row.sourceSkuId ?? ""), unitProfitRmb: row.unitProfitRmb } : null);
  return { best: point(table?.best), worst: point(table?.worst) };
}

/** 全选 is a three-state box: all, none, or part of the list. */
export function selectAllState(chosen, rows) {
  const ids = (Array.isArray(rows) ? rows : []).map(row => String(row.sourceSkuId));
  const picked = ids.filter(id => (Array.isArray(chosen) ? chosen : []).map(String).includes(id)).length;
  if (picked === 0 || ids.length === 0) return "none";
  return picked === ids.length ? "all" : "some";
}

/** What is chosen right now, and what that earns per item. */
export function skuChoiceSummary(table, chosen) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const ids = (Array.isArray(chosen) ? chosen : []).map(String);
  const picked = rows.filter(row => ids.includes(String(row.sourceSkuId)));
  if (picked.length === 0) return "还没选。点一行前面的方框就行。";
  const head = `已选 ${picked.length === rows.length && rows.length > 1 ? "全部 " : ""}${picked.length} 个规格`;
  const price = finite(table?.sources?.targetSalePriceRub) === null ? "" : ` · 按 ${table.sources.targetSalePriceRub} 卢布售价算`;
  const profits = picked.map(row => finite(row.unitProfitRmb)).filter(value => value !== null);
  if (profits.length === 0) return `${head} · 单件利润${PENDING}${price}`;
  const low = Math.min(...profits);
  const high = Math.max(...profits);
  const range = low === high ? money(low) : `${money(low)} – ${money(high)}`;
  const pending = picked.length - profits.length;
  return `${head} · 单件利润 ${range}${pending > 0 ? `（其中 ${pending} 个${PENDING}）` : ""}${price}`;
}

/**
 * 采回来的规格里缺不缺重量，用表自己的两个数字说出来。
 *
 * 没有重量的规格，运费、单件利润、利润率整行都算不出来，表里只能写「待补」。这不是页面算错了，是那一次采集根本没读到
 * 重量，所以唯一的出路是重新读一次这个1688页面。2026-09-13 当天第一件商品（狗雨衣）24 个规格全部没有重量，整张表
 * 三列空着，而「重新采集」当时只藏在折起来的「1688 采集」块里 —— 主人要先展开「找货」才看得见。
 */
export function skuWeightGapNotice(table) {
  const total = Number.isInteger(table?.total) ? table.total : 0;
  const missing = Number.isInteger(table?.weightMissingCount) ? table.weightMissingCount : 0;
  if (total <= 0 || missing <= 0) return null;
  const all = missing >= total;
  return {
    total,
    missing,
    all,
    heading: all ? "这些规格没有重量，运费和利润算不出来" : `有 ${missing} 个规格没有重量，运费和利润算不出来`,
    message: all
      ? `这 ${total} 个规格是早先采的，那一次没有读到每个规格的重量，所以运费、单件利润、利润率整列都是「${PENDING}」，现在没法按利润挑。点「重新采集」把这个1688页面重新读一遍，就能按每个规格自己的重量算给你看。`
      : `这 ${total} 个规格里有 ${missing} 个是早先采的，没有重量，它们那几行的运费和利润是「${PENDING}」；另外 ${total - missing} 个照常。点「重新采集」重新读一遍这个1688页面，就能把缺的那几个补上。`
  };
}

/** Closed submission: the current revision and the specifications the owner ticked, in the order they are listed. */
export function skuChoicePayload(table, chosen, dataRevision) {
  const ids = (Array.isArray(chosen) ? chosen : []).map(String);
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  return { dataRevision, sourceSkuIds: rows.map(row => String(row.sourceSkuId)).filter(id => ids.includes(id)) };
}

/* ── 算利润 ───────────────────────────────────────────────────────────────────────────────────────────────────────
 * The owner's rule, 2026-09-13: the software does not pick the one variant that earns most. Every variant over the
 * line is one he intends to sell, so this step checks the whole chosen set at once, lets him name the one that goes
 * up first to prove the route, and leaves the rest queued for the same Ozon card. Every number below was worked out
 * on the server by the same engine as 找货 and 选定; this file only decides how to say it.
 */

/** 算利润 is open once the owner has chosen his specifications and the server could price them. */
export function profitStepOpen(candidate, view) {
  return currentProductStep(candidate) === "profit" && isObject(view?.profitStepV1);
}

/** The variant that goes up first: the owner's own pick while it is still one of the priced ones, else the suggestion. */
export function profitStepFirstSkuId(review, picked) {
  const ids = (review?.specifications ?? []).map(item => item.sourceSkuId);
  const chosen = picked === null || picked === undefined ? null : String(picked);
  if (chosen !== null && ids.includes(chosen)) return chosen;
  return typeof review?.suggestedSkuId === "string" && ids.includes(review.suggestedSkuId) ? review.suggestedSkuId : null;
}

/** This store's own line, in the store rule's own two numbers — never a figure written into this page. */
export function profitStepThresholdLine(review) {
  const threshold = review?.threshold ?? null;
  if (!isObject(threshold)) return "本店利润门槛还没取到。";
  const unit = money(threshold.minimumUnitProfitRmb);
  const margin = percent(threshold.targetMarginRate);
  if (unit === null && margin === null) return "本店利润门槛还没取到。";
  const both = threshold.thresholdPolicy === "both";
  const parts = [unit === null ? null : `单件利润 ≥ ${unit}`, margin === null ? null : `利润率 ≥ ${margin}`].filter(Boolean);
  return `本店门槛：${parts.join(both ? " 且 " : " 或 ")}${parts.length < 2 ? "" : both ? "，两个都要到" : "，先达者算过"}`;
}

/** 过线的有几个，说的是这一套里真实的两个数字。 */
export function profitStepCohortHeadline(review) {
  const total = finite(review?.total) ?? 0;
  const pass = finite(review?.passCount) ?? 0;
  return pass === total
    ? `这一套 ${total} 个变体，全部过线`
    : `这一套 ${total} 个变体，${pass} 个过线，${total - pass} 个没到本店门槛`;
}

/** Why a variant was left out, in its own numbers; a variant nobody could price says that instead. */
export function profitStepExcludedLine(entry) {
  const label = textOf(entry?.label) || "这个变体";
  if (entry?.kind === "not_priced") {
    return `${label}：算不出利润，缺${(entry.missing ?? []).join("、") || "必要资料"}`;
  }
  const profit = money(entry?.unitProfitRmb);
  const margin = percent(entry?.marginRate);
  const shortProfit = money(entry?.unitProfitShortRmb);
  const shortMargin = finite(entry?.marginShortRate) === null ? null : `${Math.round(entry.marginShortRate * 1000) / 10} 个百分点`;
  const gaps = [shortProfit === null ? null : `差 ${shortProfit}`, shortMargin === null ? null : `差 ${shortMargin}`].filter(Boolean);
  return `${label}：单件利润 ${profit ?? "未取得"} · 利润率 ${margin ?? "未取得"}${gaps.length === 0 ? "" : `（${gaps.join("，")}）`}`;
}

/**
 * Why the software suggests this one first. The benchmark product names a size in its own title, so the variant that
 * proves the route is the one at that size. When the title names no size the page says so and suggests nothing —
 * a guessed variant would be the software making the owner's decision for him.
 */
export function profitStepSuggestionLine(review) {
  const benchmark = review?.benchmark ?? null;
  if (!isObject(benchmark) || textOf(benchmark.matchedValue) === "") {
    return "对标那款商品的标题里没写规格，软件判断不出该先上哪一个，你自己定。";
  }
  const price = finite(benchmark.currentPrice) === null ? "" : `，售价 ${benchmark.currentPrice} 卢布`;
  const same = finite(benchmark.sameAttributeCount) ?? 0;
  const rest = same > 1
    ? `这一套里同规格的有 ${same} 个，建议里挑的是其中最赚的一个，具体哪个你自己定。`
    : "这一套里同规格的只有这一个。";
  return `对标那款 Ozon 商品的标题里写着 ${benchmark.matchedValue}${price}，所以先上同规格的这一个，可比性站得住。${rest}`;
}

/**
 * Owner ruling 2026-09-13: 以采集到的页面价为准，但要把它和「找货」里填的货价的差额标出来。
 * 两者相同就没有差额可说，这句话也就不出现。
 */
export function profitStepPriceDeltaLine(spec) {
  const delta = spec?.priceDelta ?? null;
  if (!isObject(delta)) return null;
  const direction = delta.deltaRmb > 0 ? "贵" : "便宜";
  return `你在「找货」里填的货价是 ${money(delta.declaredRmb)}；这一步按这个规格自己的页面价 ${money(delta.pageRmb)} 算，` +
    `页面价比你填的${direction} ${money(Math.abs(delta.deltaRmb))}。`;
}

/** Where the official rate ladder changes gear, read from the official table itself. */
export function profitStepCommissionLine(review) {
  const current = review?.commission?.current ?? null;
  const next = review?.commission?.next ?? null;
  if (!isObject(current) || !isObject(next) || finite(current.maxRub) === null) {
    return "售价跨过官方佣金的档位分界线，费率会换一档；分界线取自 Ozon 官方费率表。";
  }
  return `售价跨过 ${current.maxRub} 卢布，官方佣金就从 ${percent(current.rate) ?? "未取得"} 跳到 ${percent(next.rate) ?? "未取得"}，` +
    `小尺码压在 ${current.maxRub} 卢布以下更划算。分界线和费率都取自 Ozon 官方表。`;
}

/* ── 运输属性 ──────────────────────────────────────────────────────────────────────────────────────────────────────
 * Before 算利润 can be confirmed the owner has to say what this product is for transport: whether it carries a
 * battery, whether it is ordinary goods, whether it ships as a personal single piece, whether it is an odd shape.
 * The server proposes those four from the capture it holds and shows what it read them from; the owner signs, or
 * changes any of them. Where the software could not tell, it says why and asks instead of guessing.
 *
 * All the wording below comes from the server's step record. The page only lays it out and assembles the closed
 * payload, exactly as the specification table and the profit step already do.
 */

/** The five values the form starts on: what is already saved, else what the software proposes, else nothing. */
export function cargoFactsFormState(step) {
  const source = isObject(step?.declaration?.facts) ? step.declaration.facts : (step?.proposal ?? {});
  return {
    batteryType: typeof source.batteryType === "string" ? source.batteryType : null,
    batteryEnergyWh: finite(source.batteryEnergyWh) === null ? "" : String(source.batteryEnergyWh),
    generalCargo: typeof source.generalCargo === "boolean" ? source.generalCargo : null,
    personalUse: typeof source.personalUse === "boolean" ? source.personalUse : null,
    irregularShape: typeof source.irregularShape === "boolean" ? source.irregularShape : null
  };
}

/** Closed submission: the current revision and the five values, nothing else. An empty 瓦时 box means「没填」. */
export function cargoFactsPayload(form, dataRevision) {
  const energy = String(form?.batteryEnergyWh ?? "").trim();
  return {
    dataRevision,
    batteryType: typeof form?.batteryType === "string" ? form.batteryType : "unknown",
    batteryEnergyWh: energy === "" || !NUMBER_PATTERN.test(energy) || Number(energy) <= 0 ? null : Number(energy),
    generalCargo: typeof form?.generalCargo === "boolean" ? form.generalCargo : null,
    personalUse: typeof form?.personalUse === "boolean" ? form.personalUse : null,
    irregularShape: typeof form?.irregularShape === "boolean" ? form.irregularShape : null
  };
}

/**
 * Why 算利润 cannot be confirmed yet, when the reason is the transport declaration. The server works out the same
 * verdict; saying it here keeps the owner from clicking a button that would only come back with a 422.
 */
export function cargoFactsStepGaps(step) {
  if (isObject(step) && step.gate?.ready === true) return [];
  // 读不到这一块的时候也算没确认：宁可按钮不亮，也不能让主人点了才吃服务端那个 422。
  return [{ field: "cargoFacts", label: "运输属性", why: textOf(step?.gate?.reason)
    || "这件商品的运输属性还没有你的确认。软件要先知道它带不带电、是不是普货，才能核验线路收不收这件货。" }];
}

/* ── 类目从哪儿来 ──────────────────────────────────────────────────────────────────────────────────────────────────
 * 算利润这一步要用的类目，服务端只认真实打开过的 Ozon 商品页读回来的那一份。Seerfar 接口给的那条类目它不认，
 * 于是主人点下「确认，进入文案素材」只会收到一句 B_EVIDENCE_CONTEXT_INCOMPLETE: 当前类目 —— 2026-09-14 第一件
 * 真货就卡在这里。所以判断提前到按钮之前：按钮不给点，旁边说清楚为什么，并且给出唯一的出路。
 *
 * 判断本身来自服务端那份记录（ozonCategoryReadStepV1），页面不自己算。
 */

/** 类目还不是真实页面读来的时候，算利润就不能确认；读不到这一块也按「没确认」算，宁可按钮不亮。 */
export function ozonCategoryStepGaps(step) {
  if (isObject(step) && step.ready === true) return [];
  return [{ field: "ozonCategory", label: "当前类目", why: textOf(step?.why)
    || "算利润要用的类目，必须来自真实打开过的 Ozon 商品页；这件商品现在还没有这样一条类目。" }];
}

/** 上一次读这个页面读成了什么，一句话。没读过就不说。 */
export function ozonPageReadOutcomeLine(step) {
  const record = isObject(step) ? step.lastRead : null;
  if (!isObject(record)) return null;
  if (step.inFlight === true) return "这次读页面已经交给插件，还没有结果；读完这里会显示读到了什么。";
  if (record.status === "verified") return "上一次已经读到了这个页面。";
  if (record.status === "failed") {
    return `上一次没读成：${textOf(record.reason) || "软件没有收到可验证的结果"}。软件不会自动重试。`;
  }
  return null;
}

/** 一行人话：已经确认过就说存档的那句，还没确认就说软件提议的那句。两句都判断不出来时不说。 */
export function cargoFactsHeadline(step) {
  if (step?.declared === true) return textOf(step.declaration?.headline) || null;
  return textOf(step?.headline) || null;
}

/**
 * Whether this step can be submitted, and when it cannot, exactly what is missing.
 * The two judgments are the owner's; everything else has to already exist in the saved records. A gap is reported as
 * the fact it is — never filled in with a plausible number so the button can light up.
 */
export function profitStepSubmitState({ review, firstSkuId, comparabilityConfirmed, supplyConfirmed, gaps }) {
  const list = Array.isArray(gaps) ? gaps : [];
  const spec = (review?.specifications ?? []).find(item => item.sourceSkuId === firstSkuId) ?? null;
  if (list.length > 0) {
    return { ready: false, gaps: list, hint: "资料还缺东西，先补齐下面列出的这几项才能确认。" };
  }
  if (spec === null) return { ready: false, gaps: [], hint: "先在上面指定一个变体先上架。" };
  if (!comparabilityConfirmed || !supplyConfirmed) {
    return { ready: false, gaps: [], hint: "两件都确认后才能进入下一步。" };
  }
  const rest = (finite(review?.passCount) ?? 0) - 1;
  return { ready: true, gaps: [],
    hint: `${spec.label} 先上，其余 ${rest} 个变体排队等同一张卡追加。` };
}

/**
 * What actually happened when this step was confirmed, read off the state the server saved.
 *
 * The route this step uses does four different things behind one 200: it queues a fresh capture instead of confirming
 * when it cannot match the link, it replays a confirmation that already exists, it confirms and passes the profit
 * calculation, and it confirms and then eliminates the product because the profit did not clear the line. Reporting
 * all four as "已确认" would be the page telling the owner something the records do not say.
 */
export function profitStepOutcomeLine(result) {
  if (result?.status === "supplier_capture_job_queued") {
    return "没有确认成功：服务端认为这个1688链接还要重新读一次，已经排了一次采集。等它采完，再回到这一步。";
  }
  if (result?.idempotentReplay === true) {
    return "这一步之前已经确认过了，服务端没有再确认一次；下面显示的是它现在保存的状态。";
  }
  const saved = isObject(result?.candidate) ? result.candidate : null;
  if (saved === null) return "已提交这一步的确认；下面显示的是服务端现在保存的状态。";
  if (saved.workflowStatus === "eliminated") {
    return `已确认，但软件按这一套算完利润没有过本店门槛，这件商品已经淘汰：${
      textOf(saved.eliminationReason) || "服务端没有给出原因"}。可以在选品台的「已淘汰」里恢复。`;
  }
  if (saved.workflowStatus === "listing_preparation") {
    return "已确认，利润也算过了，这件商品走到了「文案素材」。没有下单、没有联系供应商、也没有向 Ozon 写任何东西。";
  }
  const needed = Array.isArray(saved.neededFields) ? textOf(saved.neededFields[0]) : "";
  return `已确认，但利润还没有算完：${needed || "服务端保存了这一轮核算，但没有形成正式结论"}。`;
}

/** The sentence a finished step shows once it is folded away. */
export function foldedStepLine(stepKey, step, candidate) {
  if (stepKey === "select" && skuChoiceSaved(candidate)) {
    return `已选定 ${candidate.sourceCapture.selectedSkuIds.length} 个规格，已经锁进这件商品的供货方案。`;
  }
  return stepKey === step
    ? "这一步的详细界面还在旧版页面里，先用「打开旧版A卡」查看。"
    : "等前面的步骤完成后再开始。";
}

export function foldedStepState(stepKey, step, candidate) {
  if (stepKey === "select" && skuChoiceSaved(candidate)) return "已完成";
  return stepKey === step ? "进行中" : "未开始";
}

/** Where every number in the table came from, in the owner's words and the records' own values. */
function SkuChoiceSources({ table }) {
  const source = table.sources;
  const parts = source.reserveParts;
  return <dl className="product-pricing-facts product-sku-sources" aria-label="数字来源">
    <div><dt>目标售价</dt><dd>{RUB(source.targetSalePriceRub)} · 你填的</dd></div>
    <div><dt>央行汇率</dt><dd>{finite(source.rubPerCny) === null ? "未取得"
      : `1 元 ≈ ${source.rubPerCny} 卢布${textOf(source.fxRateDate) ? ` · ${source.fxRateDate}` : ""}`}</dd></div>
    <div><dt>Ozon 官方佣金</dt><dd>{percent(source.commissionRate) ?? "未取得"} · 按你填的售价所在档</dd></div>
    <div><dt>物流线路</dt><dd>{source.routes.length === 0 ? "未取得"
      : `${source.routes.join(" / ")}${textOf(source.tariffRuleVersion) ? ` · ${source.tariffRuleVersion} 资费` : ""}`}</dd></div>
    <div><dt>国内运费</dt><dd>{money(source.domesticShippingRmb) ?? "未取得"} · 你填的</dd></div>
    <div><dt>包装 + 贴标</dt><dd>{money(source.packagingRmbDefault) ?? "未取得"} + {money(source.labelCostRmb) ?? "未取得"}</dd></div>
    <div><dt>店铺预留</dt><dd>{percent(source.reserveRate) ?? "未取得"} · 退货{percent(parts.returnOpsReserveRate)}
      {" "}破损{percent(parts.damageLossReserveRate)} 提现{percent(parts.withdrawalFeeRate)}</dd></div>
    <div><dt>规格重量</dt><dd>来自采集到的页面 · 每个规格各自的重量{table.weightMissingCount > 0
      ? `（有 ${table.weightMissingCount} 个规格页面没给，运费和利润留空）` : ""}</dd></div>
  </dl>;
}

/**
 * The 选定 step itself.
 * The owner ticks specifications and presses one button. Nothing here starts work, contacts anyone, or reaches a
 * platform; the checkboxes are local until that button is pressed.
 */
function SkuChoiceSection({ candidate, table, chosen, saving, recapturable = false, onRecapture, onToggle, onToggleAll, onSubmit }) {
  const capture = candidate.sourceCapture;
  const swing = skuChoiceSwing(table);
  const allState = selectAllState(chosen, table.rows);
  const columns = table.columns.length > 0 ? table.columns : ["规格"];
  const savedIds = Array.isArray(capture.selectedSkuIds) ? capture.selectedSkuIds : [];
  const gap = skuWeightGapNotice(table);
  return <section className="product-section product-sku-choice" aria-label="选规格">
    <h3>选哪个规格上架</h3>
    {/* 一个重量都没采到时，「按利润挑」这句话就是假的，不能照说。 */}
    <p className="product-section-hint">{`插件已经把这件1688货源的 ${table.total} 个规格采回来了。${gap?.all === true
      ? "它们货价不同、重量也不同，但这一次没有采到重量，所以现在还挑不了利润。"
      : "它们货价不同、重量不同，所以运费和利润也不同——这一步就是让你按利润挑，而不是自己去1688页面上对着表格数。"}`}</p>
    <p className="product-sku-offer">货源 1688 / {textOf(capture.offerId) || "未取得"}
      {` · 目标售价 ${RUB(table.sources.targetSalePriceRub)}`}
      {dayOf(capture.observedAt) ? ` · ${dayOf(capture.observedAt)} 采到` : ""}</p>

    {/* 缺重量就在表前面直说，并且把唯一的出路放在这句话旁边——不能让主人先去展开「找货」才找得到它。 */}
    {gap === null ? null : <div className="product-sku-weight-gap" role="status">
      <div className="product-sku-weight-gap-words">
        <h4>{gap.heading}</h4>
        <p>{gap.message}</p>
      </div>
      {recapturable
        ? <RecaptureControl candidate={candidate} disabled={saving} onRecapture={onRecapture} />
        : <span className="product-actions-note">这件商品当前的采集状态不能重读；先看下面「找货」里的采集状态。</span>}
    </div>}

    {/* 一个规格都算不出利润时，「最赚 / 最少」只会显示两个「待补」，那不是结论，就不显示。 */}
    {table.pricedCount > 0 ? <div className="product-sku-verdict">
      <div className="product-sku-verdict-lede">
        <h4>{skuChoiceHeadline(table)}</h4>
        <p>每个规格的货价和重量都不一样，运费按各自的重量算，落到手里的利润也就不一样。</p>
      </div>
      <div className="product-sku-swing">
        <div className="product-sku-swing-high"><span>最赚 · {swing.best === null ? "未取得" : swing.best.label}</span>
          <strong>{swing.best === null ? PENDING : money(swing.best.unitProfitRmb)}</strong></div>
        <div className="product-sku-swing-low"><span>最少 · {swing.worst === null ? "未取得" : swing.worst.label}</span>
          <strong>{swing.worst === null ? PENDING : money(swing.worst.unitProfitRmb)}</strong></div>
      </div>
    </div> : null}

    <div className="product-sku-table-head">
      <h4>{table.total} 个规格 · 按单件利润从高到低</h4>
      <span>可以多选：同一件货源的不同尺码可以一起上架 · 表头方框是全选</span>
    </div>
    <div className="product-pricing-scroll">
      <table className="product-pricing-ladder product-sku-table">
        <thead>
          <tr>
            <th scope="col">
              <input type="checkbox" id="sku-choice-all" checked={allState === "all"} disabled={saving}
                aria-checked={allState === "all" ? "true" : allState === "some" ? "mixed" : "false"}
                aria-label={`全选这 ${table.total} 个规格`}
                ref={node => { if (node) node.indeterminate = allState === "some"; }}
                onChange={event => onToggleAll(event.target.checked)} />
            </th>
            {columns.map(key => <th scope="col" key={key}>{key}</th>)}
            <th scope="col">货价</th><th scope="col">计费重</th><th scope="col">运费</th>
            <th scope="col">单件利润</th><th scope="col">利润率</th><th scope="col">库存</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map(row => {
            const picked = chosen.includes(String(row.sourceSkuId));
            return <tr key={row.sourceSkuId} className={picked ? "product-sku-row product-sku-row-on" : "product-sku-row"}>
              <td>
                <input type="checkbox" checked={picked} disabled={saving} aria-label={`选 ${row.label}`}
                  onChange={event => onToggle(row.sourceSkuId, event.target.checked)} />
              </td>
              {table.columns.length > 0
                ? table.columns.map((key, index) => <td key={key}>{textOf(row.values[index]) || "—"}</td>)
                : <td>{row.label}</td>}
              <td>{yuanOr(row.priceCny)}</td>
              <td>{finite(row.chargeableKg) === null ? PENDING : `${row.chargeableKg} 公斤`}</td>
              <td>{yuanOr(row.freightRmb)}</td>
              {/* 待补 is not a profit, so it never wears the profit's colour. */}
              <td className={row.unitProfitRmb === null ? "product-sku-pending" : "product-sku-profit"}>{yuanOr(row.unitProfitRmb)}</td>
              <td>{percent(row.marginRate) ?? PENDING}</td>
              <td>{row.stock === null ? "未取得" : String(row.stock)}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <div className="product-sku-chosen">
      <p className="product-sku-summary">{skuChoiceSummary(table, chosen)}</p>
      <button type="button" className="button primary" disabled={saving || chosen.length === 0}
        onClick={onSubmit}>选定这些规格</button>
    </div>
    {savedIds.length > 0
      ? <p className="product-sku-saved">已经选定过 {savedIds.length} 个规格，它们在这件商品的供货方案里；再点一次「选定这些规格」就按你现在勾的改。</p>
      : null}

    {/* 规格齐全时重读只是退路，所以它留在这里，是一个不显眼的次要动作。 */}
    {gap === null && recapturable ? <div className="product-sku-recapture">
      <span>这些规格是上一次读到的。页面改了、或者规格不对，就重新读一遍这个1688页面。</span>
      <RecaptureControl candidate={candidate} disabled={saving} onRecapture={onRecapture} />
    </div> : null}

    <SkuChoiceSources table={table} />

    <p className="product-sku-foot">
      <strong>选完之后会发生什么：</strong>{"软件把你选中的规格锁进这件商品的供货方案，商品页的进度条从「选定」走到「算利润」。这一步"}
      <strong>不会</strong>{"下单、不会联系供应商、也不会向 Ozon 写任何东西。"}
    </p>
    <p className="product-result-provenance">{"表里每个数字都能追到来源：货价与库存来自这次采到的1688页面，运费按各规格自己的重量查国欧资费表，佣金取自 Ozon 官方表，汇率取自央行。"}</p>
  </section>;
}

/**
 * 运输属性 — one sentence, one button, and the evidence the sentence rests on.
 *
 * The owner's ruling, 2026-09-13: 「能默认，不能替他签」. So the normal case is a single line the software could
 * work out, the reason it could, and 确认 — not four dropdowns. What the software could not work out is shown as a
 * choice with the reason it declined, because a guessed 「不带电」 would be the software signing for him. Every
 * value stays editable under 逐项修改, and once it is saved this block shows the sentence that went into the record.
 */
/**
 * 「这条类目是哪儿来的」这一小块，就放在确认按钮上面。
 *
 * 类目已经是真实读过的页面给的，这一块就不出现——没有事要主人做。不是的时候它说三件事：为什么不能用现在这条、
 * 这一次读页面会做什么和不会做什么、以及那个唯一的按钮。点下去之后成败都按服务端和插件实际回的话显示，
 * 包括插件自己的拒绝码；这里不替它们总结，也不承诺重试。
 */
function OzonCategoryReadBlock({ step, saving, onRead }) {
  if (!isObject(step) || step.ready === true) return null;
  const action = isObject(step.action) ? step.action : { label: "读一次这个 Ozon 页面", available: false, reason: "" };
  const target = isObject(step.target) ? step.target : null;
  const lastLine = ozonPageReadOutcomeLine(step);

  return <div className="product-profit-category" role="group" aria-label="这条类目是哪儿来的">
    <div className="product-sku-table-head">
      <h4>这条类目还不是从 Ozon 页面上读来的</h4>
      <span>读一次就能补上，这一步不改这件商品的任何别的东西</span>
    </div>
    <p className="product-profit-category-why">{textOf(step.why)}</p>
    <p className="product-result-provenance">{textOf(step.scopeLine)}</p>
    {target === null ? null : <p className="product-result-provenance">{`要读的页面：${target.productUrl}`}</p>}
    {step.blocked === null || step.blocked === undefined ? null
      : <p role="alert" className="product-result-warning">{textOf(step.blocked.reason)}</p>}
    {lastLine === null ? null : <p className="product-capture-status">{lastLine}</p>}
    <div className="product-actions">
      {/* 成败都由页面上方那一个提示位说，说的是服务端和插件实际回的话（含插件自己的拒绝码）。这一块读完就会
          随商品修订号重建，所以结果不能记在它自己身上，否则一刷新就没了。 */}
      <button type="button" className="button primary" disabled={saving || action.available !== true}
        onClick={() => onRead?.()}>{textOf(action.label) || "读一次这个 Ozon 页面"}</button>
      {action.available === true ? null : <span className="product-actions-note">{textOf(action.reason)}</span>}
    </div>
  </div>;
}

function CargoFactsBlock({ step, dataRevision, saving, onDeclare }) {
  const [form, setForm] = useState(() => cargoFactsFormState(step));
  const [editing, setEditing] = useState(false);
  const undecided = Array.isArray(step?.undecided) ? step.undecided : [];
  const basis = Array.isArray(step?.basis) ? step.basis : [];
  const fields = Array.isArray(step?.fields) ? step.fields : [];
  const declared = step?.declared === true;
  const headline = cargoFactsHeadline(step);
  const change = (field, value) => setForm(current => ({ ...current, [field]: value }));
  const choice = field => fields.find(item => item.field === field) ?? null;
  const battery = form.batteryType;
  const declaredBasis = Array.isArray(step?.declaration?.basis) ? step.declaration.basis : [];

  // 一项的选择器。判不定的那几项先说清楚软件为什么不敢提议，再让主人选。
  const picker = field => {
    const item = choice(field);
    if (item === null || item.options === null) return null;
    const open = undecided.find(entry => entry.field === field) ?? null;
    const value = form[field];
    const index = item.options.findIndex(option => option.value === value);
    return <label key={field} className="product-field product-cargo-field" htmlFor={`cargo-${field}`}>
      <span className="product-field-label">{item.label}</span>
      <select id={`cargo-${field}`} name={`cargo-${field}`} value={index < 0 ? "" : String(index)} disabled={saving}
        onChange={event => change(field, event.target.value === "" ? null : item.options[Number(event.target.value)].value)}>
        {index < 0 ? <option value="">请选择</option> : null}
        {item.options.map((option, position) => <option key={String(option.value)} value={String(position)}>{option.label}</option>)}
      </select>
      {open === null ? null : <span className="product-field-hint">{open.why}</span>}
    </label>;
  };

  const energyField = ["installed", "standalone"].includes(battery)
    ? <label className="product-field product-cargo-field" htmlFor="cargo-batteryEnergyWh">
      <span className="product-field-label">{choice("batteryEnergyWh")?.label ?? "电池瓦时（Wh）"}</span>
      <input id="cargo-batteryEnergyWh" name="cargo-batteryEnergyWh" type="number" inputMode="decimal"
        value={form.batteryEnergyWh} disabled={saving} onChange={event => change("batteryEnergyWh", event.target.value)} />
      <span className="product-field-hint">电池写在页面上就填，页面没写就空着；空着的时候受限线路核验不了。</span>
    </label>
    : null;

  return <div className="product-profit-cargo">
    <div className="product-sku-table-head">
      <h4>这件货是什么，运输上得先说清楚</h4>
      <span>{declared ? "已确认" : "软件只按它真看到的东西提议，判断不了的让你选"}</span>
    </div>

    {declared ? <>
      <p className="product-cargo-headline">{headline ?? "这件商品的运输属性已经确认过。"}</p>
      {textOf(step.declaration?.declaredAt)
        ? <p className="product-result-provenance">{`你在 ${dayOf(step.declaration.declaredAt) ?? step.declaration.declaredAt} 确认的，记录里写明是你确认的。`}</p>
        : null}
      {declaredBasis.length === 0
        ? <p className="product-result-provenance">当时软件一项也没敢提议，这几项全是你自己选的。</p>
        : <ul className="product-cargo-basis">{declaredBasis.map(item => <li key={item.field}>{item.because}</li>)}</ul>}
    </> : <>
      {headline === null
        ? <p className="product-cargo-headline">{basis.length === 0
          ? "这件商品软件一项也判断不了，下面这几项要你自己选。"
          : "这几项里有软件判断不了的，下面标出来了，那几项要你自己选。"}</p>
        : <p className="product-cargo-headline">{headline}</p>}
      {basis.length === 0 ? null : <ul className="product-cargo-basis">
        {basis.map(item => <li key={item.field}>{item.because}</li>)}
      </ul>}
      {/* 判不定的那几项才摆出来让主人选；判得出来的已经在上面那一行结论和依据里了。 */}
      {undecided.length === 0 || editing ? null : <div className="product-cargo-ask">
        {undecided.map(item => picker(item.field))}
      </div>}
    </>}

    {/* 逐项修改：五项一起摆出来，主人改哪一项都行。它和上面那几个判不定的选择器互斥，不重复同一个控件。 */}
    {editing ? <div className="product-cargo-edit" aria-label="逐项修改运输属性">
      {fields.filter(item => item.options !== null).map(item => picker(item.field))}
    </div> : null}
    {/* 电池瓦时只有在说了带电之后才有意义，所以它跟着带电与否走，整块里只出现一次。 */}
    {energyField}

    <div className="product-actions">
      <button type="button" className={declared ? "button secondary" : "button primary"} disabled={saving}
        onClick={() => onDeclare(cargoFactsPayload(form, dataRevision))}>{declared ? "改成这样" : "确认"}</button>
      <button type="button" className="button secondary" disabled={saving}
        onClick={() => setEditing(value => !value)}>{editing ? "收起逐项修改" : "逐项修改"}</button>
      <span className="product-actions-note">
        {"确认只是记下你对这件货的说法，不会下单、不会联系供应商、也不会向 Ozon 写任何东西。"}
      </span>
    </div>
  </div>;
}

/**
 * 估算佣金授权 — 只在一种情况下出现：精确佣金读不到。
 *
 * 软件算佣金的规矩是从主人自己店里同一条类目的在售商品上读出平台实际收的费率。一个店在一条类目的第一件
 * 商品必然读不到——店里还没有同类商品。这不是网络卡了，重试多少次都一样，所以这里给一条真正的出路，而不是
 * 一句让人再点一次的错误。
 *
 * 规矩照运输属性那一块：软件按真实证据提议，主人一键确认；证据含糊的地方软件拒绝提议。这里的证据是 Ozon
 * 官方费率表，费率、档位和来源引用整份取自页面已经在显示的那份解析结果，页面自己不写死任何一个数——目标
 * 成交价跨过档位分界线，同一份解析结果给的就是另一档。
 *
 * 措辞要对得上这一块出现时的真实前提。服务端在这条路上是先让官方费率表自己上：立住了就直接返回那份真证据
 * （lib/lifecycle-b-real-evidence-readers.mjs 里的 `if (attempt.pack) return attempt.pack`），主人根本看
 * 不到这一块。所以这一块一旦出现，前提必然是「那张表这一次没能自己立成证据」——要么它有缺口，要么这台机器
 * 上压根没配它。绝不能写成「官方表好好的，只是还要你多签一次字」。服务端说了卡在哪几处的，逐字摆出来；
 * 什么都没说的，就一个字都不说，不替它造一句。
 *
 * 它不常驻，也不是一个随时可勾的高级选项：只有点过确认、服务端在那一次确认里真的停在「精确佣金读不到」
 * 之后才出现。页面加载时不去探测——那会对主人的 Ozon 账户产生一次真实读取。在场与否整份由服务端那条已保存
 * 的记录（`commissionEstimateStepV1`）说了算，页面自己不记，所以硬刷新之后它还在。
 *
 * 那条记录说的可能已经不是当前这一版资料了（主人改过找货资料，或者软件又存过一次别的记录，版本号都会动）。
 * 那种时候这一块不消失，只是把「它说的是哪一版」照实说在最前面：无声消失正是这一块原来的病——资料一动，唯一
 * 那条出路就没了。也正因为动的不一定是主人，这句话只说资料动过，不替他认下是他改的。
 */
export function CommissionEstimateBlock({ estimate, authorized, saving, onAuthorize }) {
  if (!isObject(estimate)) return null;
  const proposal = isObject(estimate.proposal) ? estimate.proposal : null;
  const store = textOf(estimate.storeLabel) || "这个店";
  const category = textOf(estimate.category);
  const rate = proposal === null ? "" : percent(proposal.commissionRate) ?? "未取得";
  const price = finite(proposal?.targetSalePriceRub);
  // 服务端那几个缺口一个字都不改；它没说的时候这里是空的，下面那一整段也就不出现。
  const officialGaps = (Array.isArray(estimate.officialGaps) ? estimate.officialGaps : [])
    .map(value => textOf(value)).filter((value, index, all) => value !== "" && all.indexOf(value) === index);
  // 记录说的那一版和现在这一版；服务端说不清楚版本号的时候就不报数字，但那句话照说。
  const recordedRevision = finite(estimate.recordedRevision);
  const dataRevision = finite(estimate.dataRevision);
  const staleVersions = recordedRevision === null || dataRevision === null
    ? "" : `：它说的是第 ${recordedRevision} 版资料，现在是第 ${dataRevision} 版`;

  return <div className="product-profit-commission" role="group" aria-label="估算佣金授权">
    <div className="product-sku-table-head">
      <h4>{`这条类目在${store}里还没有商品，精确佣金读不到`}</h4>
      <span>{proposal === null
        ? "官方费率表这一次没顶上，软件也拿不出一个能提议的费率"
        : "官方费率表这一次没能自己立成证据，所以要你亲自签这一次"}</span>
    </div>

    {/* 记录说的不是当前这一版资料时，先把这件事说清楚，再说别的；这一块不会因为过期就悄悄消失。 */}
    {estimate.current === false ? <p role="alert" className="product-result-warning">
      {`这一块说的是上一次确认停下来那一刻的事${staleVersions}。这之后这件商品的资料又动过，软件没有因此重新读过佣金。` +
        "照它签一次字，或者直接再点一次下面那个确认，让软件按现在这一版重新读一次，都可以。"}
    </p> : null}

    <p className="product-profit-commission-why">
      {`软件算佣金的规矩是：从${store}里已经上着的、同一条 Ozon 类目的商品上，读出 Ozon 实际收你的那个费率。` +
        `这件是这条类目在${store}的第一件，店里没有同类商品可读，所以读不到。再点几次也还是读不到，这不是网络卡了。`}
    </p>
    {category ? <p className="product-result-provenance">{`这条类目：${category}`}</p> : null}

    {/* 这一块出现时唯一可能的前提，说在最前面：那张表这一次没能自己立成证据。立住了主人根本看不到这一块。 */}
    <p className="product-profit-commission-why">
      {"能替它的只有 Ozon 官方费率表上的公开费率。这一次软件没能靠那张表自己把这件商品的佣金证据立起来——" +
        "立住了你根本不会看见这一块，软件会直接按它算完往下走，用不着你签字。"}
    </p>

    {/* 服务端顺带说了官方佣金表卡在哪几处的，逐字摆出来；没说的时候这一段整个不存在。 */}
    {officialGaps.length === 0 ? null : <>
      <p className="product-profit-commission-why">{"服务端说，官方佣金表这一次卡在这几处（原话照抄）："}</p>
      <ul className="product-profit-commission-basis">
        {officialGaps.map(gap => <li key={gap}>{gap}</li>)}
      </ul>
    </>}

    {/* 费率、档位、来源引用缺任何一样，软件就不提议——这时候只把实话说完，不替主人写一个数上去。 */}
    {proposal === null ? <p role="alert" className="product-result-warning">
      {"页面上这份官方费率表解析也连费率、档位和来源引用都拿不齐，软件不会替你写一个数上去。"}
    </p> : <>
      <p className="product-profit-commission-why">
        {"所以现在要你亲自签一次字。" +
          `${price === null ? "" : `你填的目标成交价 ${RUB(price)}落在这一档，`}` +
          `页面上这份官方费率表解析给出的是 ${rate}。`}
      </p>
      <ul className="product-profit-commission-basis">
        <li>{`费率 ${rate} · 档位 ${proposal.commissionTier}${price === null ? "" : ` · 目标成交价 ${RUB(price)}`}`}</li>
        <li>{`取自 ${proposal.commissionSourceRef}`}</li>
        <li>{"这个数跟着你填的目标成交价走：价格跨过档位分界线就换一档，这里显示的也跟着换，不会留着一个旧数。"}</li>
      </ul>
      <p role="alert" className="product-result-warning">
        {"这一笔会记成估算佣金，不是精确佣金。这件商品的 B 会停在「条件测算」，不算正式通过，也不会进 C1；" +
          "软件会把是你、在哪一版资料上、按哪个费率授权的一起存进记录。"}
      </p>
      <p className="product-profit-note">
        {`等这条类目在${store}里有了第一件在售商品，店里的实收费率就读得到了。到那时打开这件商品的` +
          "「条件测算已保存，等更好的费用证据」那张卡，点「用更好的费用证据重算」，软件把利润重算一次；" +
          "已经确认过的货价和包装不用重填。"}
      </p>
      <label className="product-profit-check" htmlFor="profit-commission-estimate">
        <input type="checkbox" id="profit-commission-estimate" checked={authorized} disabled={saving}
          onChange={event => onAuthorize(event.target.checked)} />
        <span>
          <b>{`先按官方费率表的 ${rate} 算，记成估算佣金`}</b>
          <p>{"不勾就不带这个授权，这一次确认还是会停在同一处。"}</p>
          <p>{"这个授权只管这一件、这一版资料、这一个费率；换了商品、资料动过、或者费率换了档，都要你重新勾一次。"}</p>
        </span>
      </label>
    </>}
  </div>;
}

/**
 * 算利润 — the whole set against the line, one variant named to go up first, the rest queued.
 *
 * Only two things on this screen are the owner's to decide, and both are judgments no record can hold: whether the
 * two products really are the same kind of thing, and whether the link, the specification, the cost and the packing
 * are one purchase plan. Everything else is already saved and is shown beside the tick that relies on it. Nothing is
 * confirmed until both are ticked, and a missing fact disables the button instead of being filled in.
 *
 * Since 2026-09-13 the transport declaration joins them: B's line check answers 「说不准」 without it, so a product
 * with no declaration cannot be confirmed here — the button is disabled and says why, instead of letting the owner
 * click and collect the server's 422.
 */
function ProfitStepSection({ review, cargoStep, categoryStep, commissionEstimate = null, dataRevision, saving,
  onConfirm, onDeclareCargoFacts, onReadOzonPage }) {
  const [firstPick, setFirstPick] = useState(null);
  const [comparabilityConfirmed, setComparability] = useState(false);
  const [supplyConfirmed, setSupply] = useState(false);
  const [commissionEstimateTicked, setCommissionEstimateTicked] = useState(false);
  // 提议不在场（这一次没撞上，或者软件不敢提议）时，之前勾过的那一下不能留着替主人签字。
  const commissionProposal = isObject(commissionEstimate?.proposal) ? commissionEstimate.proposal : null;
  const commissionEstimateAuthorized = commissionProposal !== null && commissionEstimateTicked;
  const firstSkuId = profitStepFirstSkuId(review, firstPick);
  const spec = review.specifications.find(item => item.sourceSkuId === firstSkuId) ?? null;
  const gaps = [...profitStepGaps(review, firstSkuId ?? ""), ...cargoFactsStepGaps(cargoStep),
    ...ozonCategoryStepGaps(categoryStep)];
  const state = profitStepSubmitState({ review, firstSkuId, comparabilityConfirmed, supplyConfirmed, gaps });
  const benchmark = review.benchmark ?? {};
  const supply = review.supply ?? {};
  const breakdown = spec?.breakdown ?? null;
  const queued = (finite(review.passCount) ?? 0) - (spec === null ? 0 : 1);
  const deltaLine = profitStepPriceDeltaLine(spec);
  const dimensions = supply.dimensionsCm ?? {};
  const size = [dimensions.length, dimensions.width, dimensions.height].every(value => finite(value) !== null)
    ? `${dimensions.length}×${dimensions.width}×${dimensions.height} 厘米` : "未取得";

  return <section className="product-section product-profit" aria-label="算利润">
    <h3>算利润</h3>
    <p className="product-section-hint">
      {`规格已经选定了 ${review.total} 个。这一步不再让你挑哪个最赚——它把整套一起核一遍利润，让你确认两件只有你能判断的事，然后指定一个变体先上架跑通，其余排队等同一张卡追加。`}
    </p>

    {/* 一、整套一起核线 */}
    <div className="product-sku-verdict">
      <div className="product-sku-verdict-lede">
        <h4>{profitStepCohortHeadline(review)}</h4>
        <p>{profitStepThresholdLine(review)}</p>
      </div>
      <div className="product-sku-swing">
        <div className="product-sku-swing-high"><span>过线 / 总数</span>
          <strong>{`${review.passCount} / ${review.total}`}</strong></div>
        <div><span>单件利润区间</span><strong>{review.unitProfitRange === null ? PENDING
          : `${money(review.unitProfitRange.low)} – ${money(review.unitProfitRange.high)}`}</strong></div>
        <div><span>利润率区间</span><strong>{review.marginRange === null ? PENDING
          : `${percent(review.marginRange.low)} – ${percent(review.marginRange.high)}`}</strong></div>
        <div className={review.excludedCount > 0 ? "product-sku-swing-low" : undefined}>
          <span>不过线，已排除</span><strong>{String(review.excludedCount)}</strong></div>
      </div>
    </div>
    {review.excluded.length === 0 ? null : <ul className="product-profit-excluded" aria-label="不过线，已排除">
      {review.excluded.map(entry => <li key={entry.sourceSkuId ?? entry.label}>{profitStepExcludedLine(entry)}</li>)}
    </ul>}

    {/* 二、先上这一个 */}
    <div className="product-profit-first">
      <div className="product-sku-table-head">
        <h4>先上这一个，跑通上架通路</h4>
        <span>{`其余 ${queued} 个在同一张卡上追加，内容不重做`}</span>
      </div>
      <p className="product-section-hint">{profitStepSuggestionLine(review)}</p>
      <label className="product-field product-profit-pick" htmlFor="profit-first-variant">
        <span className="product-field-label">先上哪一个</span>
        <select id="profit-first-variant" name="profit-first-variant" value={firstSkuId ?? ""} disabled={saving}
          onChange={event => setFirstPick(event.target.value)}>
          {firstSkuId === null ? <option value="">请指定一个变体</option> : null}
          {review.specifications.map(item => <option key={item.sourceSkuId} value={item.sourceSkuId}>
            {`${item.label}　货价 ${money(item.priceCny) ?? PENDING} · 单件利润 ${money(item.unitProfitRmb) ?? PENDING}`}
            {item.isSuggested ? "（建议）" : ""}
          </option>)}
        </select>
      </label>
      {breakdown === null
        ? <p className="product-pricing-empty">选定一个变体后，这里把这一个的算式摊开给你看。</p>
        : <dl className="product-pricing-facts product-profit-calc" aria-label="这一个变体的算式">
          <div><dt>目标成交价</dt><dd>{RUB(supply.targetSalePriceRub)}</dd></div>
          <div><dt>成交收入</dt><dd>{money(breakdown.revenueCny) ?? PENDING}</dd></div>
          <div><dt>官方佣金 {percent(breakdown.commissionRate) ?? "未取得"}</dt>
            <dd>−{money(breakdown.commissionRmb) ?? PENDING}</dd></div>
          <div><dt>国际运费</dt><dd>−{money(breakdown.freightRmb) ?? PENDING}
            {textOf(spec.route) ? ` · ${spec.route} · 计费 ${spec.chargeableKg} 公斤` : ""}</dd></div>
          <div><dt>到手采购</dt><dd>−{money(breakdown.allInPurchaseRmb) ?? PENDING}</dd></div>
          <div><dt>包装 + 贴标</dt><dd>−{money(breakdown.packagingRmb + breakdown.labelCostRmb) ?? PENDING}</dd></div>
          {breakdown.otherFixedRmb === 0 ? null
            : <div><dt>其他固定成本</dt><dd>−{money(breakdown.otherFixedRmb)}</dd></div>}
          <div><dt>店铺预留 {percent(breakdown.storeReserveRate) ?? "未取得"}</dt>
            <dd>−{money(breakdown.storeReserveRmb) ?? PENDING}</dd></div>
          <div><dt>单件利润</dt><dd className="product-sku-profit">{money(breakdown.unitProfitRmb) ?? PENDING}
            {` · 利润率 ${percent(breakdown.marginRate) ?? "未取得"}`}</dd></div>
        </dl>}
      {breakdown === null ? null : <p className="product-result-provenance">
        {"上面每一项都是分开算到分的，最后一行的单件利润是软件按整条算式一次算出来的那个数，两者可能差一两分钱。"}
      </p>}
    </div>

    {/* 三、其余变体排队 */}
    <div className="product-sku-table-head">
      <h4>{`其余 ${queued} 个变体 · 排队`}</h4>
      <span>货价和重量一样的规格，运费和利润也一样，合成一行；先上的那一个也留在表里，标着「先上」</span>
    </div>
    <div className="product-pricing-scroll">
      <table className="product-pricing-ladder product-sku-table">
        <caption>每个规格自己的下探空间：保本价、达标最低售价，以及按当前目标价能落下多少</caption>
        <thead><tr>
          {(review.columns.length > 0 ? review.columns : ["规格"]).map(key => <th scope="col" key={key}>{key}</th>)}
          <th scope="col">货价</th><th scope="col">计费重</th><th scope="col">运费</th>
          <th scope="col">保本价</th><th scope="col">达标最低售价</th>
          <th scope="col">{`按 ${RUB(supply.targetSalePriceRub)}的利润`}</th>
        </tr></thead>
        <tbody>
          {review.queue.map(row => {
            const isFirst = firstSkuId !== null && row.sourceSkuIds.includes(firstSkuId);
            return <tr key={row.key} className={isFirst ? "product-sku-row-on" : undefined}>
              {review.columns.length > 0
                ? review.columns.map((key, index) => <td key={key}>
                  {(row.values[index] ?? []).join(" / ") || "—"}
                  {index === 0 && isFirst ? <b>{" · 先上"}</b> : null}
                </td>)
                : <td>{row.label}{isFirst ? <b>{" · 先上"}</b> : null}</td>}
              <td>{yuanOr(row.priceCny)}</td>
              <td>{finite(row.chargeableKg) === null ? PENDING : `${row.chargeableKg} 公斤`}</td>
              <td>{yuanOr(row.freightRmb)}</td>
              <td>{finite(row.breakEvenRub) === null ? PENDING : RUB(row.breakEvenRub)}</td>
              <td>{finite(row.thresholdRub) === null ? PENDING : RUB(row.thresholdRub)}</td>
              <td className={row.unitProfitRmb === null ? "product-sku-pending" : "product-sku-profit"}>
                {`${yuanOr(row.unitProfitRmb)} · ${percent(row.marginRate) ?? PENDING}`}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <p className="product-result-provenance">{profitStepCommissionLine(review)}</p>

    {/* 四、只有主人能确认的两件事 */}
    <div className="product-profit-judge">
      <div className="product-sku-table-head"><h4>只有你能确认的两件事</h4>
        <span>软件不替你判断，也不替你签字</span></div>
      <label className="product-profit-check" htmlFor="profit-comparable">
        <input type="checkbox" id="profit-comparable" checked={comparabilityConfirmed} disabled={saving}
          onChange={event => setComparability(event.target.checked)} />
        <span>
          <b>这两件商品是可比的同类</b>
          <p>
            {`对标：Ozon ${textOf(benchmark.productNumber) || "编号未取得"}「${textOf(benchmark.title) || "标题未取得"}」`}
            {finite(benchmark.currentPrice) === null ? "" : ` ${benchmark.currentPrice} ${benchmark.currency === "RUB" ? "卢布" : benchmark.currency ?? ""}`}
            {textOf(benchmark.collectedOn) ? `，快照采于 ${benchmark.collectedOn}` : ""}。
          </p>
          <p>{`你的货：1688 ${textOf(supply.offerId) || "编号未取得"}`}
            {spec === null ? "，还没指定变体" : ` ${spec.label}，货价 ${money(spec.priceCny) ?? PENDING}，打包 ${spec.weightKg} 公斤 · ${size}`}。</p>
        </span>
      </label>
      <label className="product-profit-check" htmlFor="profit-supply">
        <input type="checkbox" id="profit-supply" checked={supplyConfirmed} disabled={saving}
          onChange={event => setSupply(event.target.checked)} />
        <span>
          <b>链接、规格、成本、包装是同一套采购方案</b>
          <p>{textOf(supply.productUrl) || "1688 链接未取得"}</p>
          <p>
            {`货价 ${spec === null ? PENDING : money(spec.priceCny)}（这个规格在 1688 页面上自己的价）`}
            {` ＋ 国内运费 ${money(supply.unitDomesticFreight) ?? PENDING}（你填的）`}
            {` ＋ 其他采购费用 ${money(supply.otherPurchaseCosts) ?? PENDING}`}
            {` ＝ 到手 ${spec === null ? PENDING : money(spec.actualPurchaseCost)}`}
            {`；打包 ${spec === null ? PENDING : `${spec.weightKg} 公斤`} · ${size}。`}
          </p>
          {/* 这句话说的是软件替你报了 ¥0；报不出来的时候它就不能说，缺什么由下面那张缺项单说。 */}
          {supply.otherPurchaseCosts !== 0 ? null
            : <p className="product-profit-note">{"其他采购费用按 ¥0.00 算：你在「找货」里只填了货价和国内运费，到手就是这两项相加。"}</p>}
          {deltaLine === null ? null : <p className="product-profit-delta">{deltaLine}</p>}
          {spec === null || textOf(spec.quantityOneEvidenceSourceNote) === "" ? null
            : <p className="product-profit-note">{`会一起记下来的核对说明：${spec.quantityOneEvidenceSourceNote}`}</p>}
        </span>
      </label>
    </div>

    {/* 五、这条类目是哪儿来的 — 也在确认按钮之前：类目不是从 Ozon 页面上读来的，这一步的确认服务端就不收。 */}
    <OzonCategoryReadBlock step={categoryStep} saving={saving} onRead={onReadOzonPage} />

    {/* 六、这件货运输上是什么 — 这一块在确认按钮之前，因为不先说清楚，B 那边的线路核验就判不出适用性。 */}
    {cargoStep === null || cargoStep === undefined ? null : <CargoFactsBlock step={cargoStep}
      dataRevision={dataRevision} saving={saving} onDeclare={onDeclareCargoFacts} />}

    {/* 七、精确佣金读不到时的那一条出路。只有服务端真的这么回过才出现，别的时候这一块根本不存在。 */}
    <CommissionEstimateBlock estimate={commissionEstimate} authorized={commissionEstimateAuthorized}
      saving={saving} onAuthorize={setCommissionEstimateTicked} />

    {/* 凑不齐的东西如实列出来，按钮就不给点；软件不会替主人补一个像样的数字上去。 */}
    {state.gaps.length === 0 ? null : <div className="product-profit-gaps" role="alert">
      <h4>还差这些，现在不能确认</h4>
      <ul>{state.gaps.map(item => <li key={item.field}><b>{item.label}</b>：{item.why}</li>)}</ul>
    </div>}

    <div className="product-actions">
      <button type="button" className="button primary" disabled={saving || !state.ready}
        onClick={() => onConfirm(firstSkuId, { comparabilityConfirmed, supplyConfirmed,
          commissionEstimateAuthorized,
          commissionEstimateRate: commissionEstimateAuthorized ? commissionProposal.commissionRate : null })}>确认，进入文案素材</button>
      <span className="product-actions-note">{state.hint}</span>
    </div>

    <p className="product-sku-foot">
      <strong>确认之后会发生什么：</strong>{"软件把这一套的利润核算冻结下来，商品进入「文案素材」——生成俄文标题、卖点和图片方案给你过目。"}
      <strong>不会</strong>{"下单、不会联系供应商、也不会向 Ozon 写任何东西；真正上架是后面「上架」那一步，另需你批准。"}
    </p>
    <p className="product-result-provenance">
      {"这一步的每个数字都能追到来源：货价与重量来自这次采到的 1688 页面，运费按各规格自己的重量查国欧资费表，佣金与档位分界线取自 Ozon 官方表，汇率取自央行，门槛与预留取自本店成本规则。"}
    </p>
  </section>;
}

const NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;
const positiveInput = value => NUMBER_PATTERN.test(String(value).trim()) && Number(value) > 0;
const nonNegativeInput = value => NUMBER_PATTERN.test(String(value).trim()) && Number(value) >= 0;
const supplyUrlInput = value => /^https:\/\/(?:detail\.1688\.com\/offer\/\d+\.html(?:[?#].*)?|qr\.1688\.com\/s\/[A-Za-z0-9_-]{1,160}\/?)$/i.test(String(value).trim());

export function supplierDraftFormErrors(form) {
  const errors = {};
  if (!supplyUrlInput(form.sourceUrl)) errors.sourceUrl = "请粘贴1688商品详情链接或分享短链";
  if (!positiveInput(form.goodsPriceRmb)) errors.goodsPriceRmb = "请填写大于0的货价";
  if (!nonNegativeInput(form.domesticShippingRmb)) errors.domesticShippingRmb = "请填写国内运费，包邮填0";
  if (!positiveInput(form.packedWeightKg)) errors.packedWeightKg = "请填写大于0的打包重量";
  for (const key of ["length", "width", "height"]) {
    if (!positiveInput(form[key])) errors[key] = "请填写大于0的厘米数";
  }
  if (!positiveInput(form.targetSalePriceRub)) errors.targetSalePriceRub = "请填写大于0的卢布成交价";
  return errors;
}

export function supplierDraftPayload(form, dataRevision) {
  return {
    dataRevision,
    sourceUrl: String(form.sourceUrl).trim(),
    goodsPriceRmb: Number(form.goodsPriceRmb),
    domesticShippingRmb: Number(form.domesticShippingRmb),
    packedWeightKg: Number(form.packedWeightKg),
    dimensionsCm: { length: Number(form.length), width: Number(form.width), height: Number(form.height) },
    targetSalePriceRub: Number(form.targetSalePriceRub),
    ...(textOf(form.note) === "" ? {} : { note: textOf(form.note) })
  };
}

/**
 * A step that has something specific to report — which extension rejection was observed, and what the owner can do
 * next — returns that sentence, and it becomes this page's notice. Anything else keeps the step's generic sentence.
 * The page never invents a second place to speak: this is the same 找货 notice slot that was already there.
 */
export function stepNotice(outcome, successNotice) {
  return typeof outcome === "string" && outcome.trim() !== "" ? outcome : successNotice;
}

/**
 * 重新采集 的按钮本身。一次点击把它打开，一行字说清楚会丢掉什么，第二次点击才真的重读——和「淘汰」同一个形状，永远不是
 * 弹窗套弹窗。它始终是次要按钮：采回来之后该做的事是从里面挑规格，重读是那条采得不对时的退路。
 */
function RecaptureControl({ candidate, disabled = false, onRecapture }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(reason) {
    if (busy || typeof onRecapture !== "function") return;
    setBusy(true);
    // 成败都由本页原有的那一个提示位来说；这里只是别让一次点击变成未处理的 rejection，控件两种情况下都收起来。
    try { await onRecapture(reason); }
    catch { /* reported by the page's own notice slot */ }
    finally { setArmed(false); setBusy(false); }
  }
  if (!armed) {
    return <button type="button" className="button secondary product-recapture-button" disabled={disabled}
      onClick={() => setArmed(true)}>重新采集</button>;
  }
  return <span className="product-recapture-confirm" role="group" aria-label="确认重新采集">
    <span className="product-recapture-line">{captureRecaptureConfirmLine(candidate)}</span>
    <span className="product-recapture-reasons">
      <span className="product-recapture-hint">顺便记个理由（可不选）：</span>
      {CAPTURE_RECAPTURE_REASONS.map(reason => <button key={reason.code} type="button" className="button secondary"
        disabled={busy} onClick={() => submit(reason.code)}>{reason.label}</button>)}
      <button type="button" className="button primary" disabled={busy} onClick={() => submit(null)}>重新读一次</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => setArmed(false)}>取消</button>
    </span>
  </span>;
}

function Field({ id, label, hint, value, error, onChange, type = "text", placeholder = "" }) {
  return <label className="product-field" htmlFor={id}>
    <span className="product-field-label">{label}</span>
    <input id={id} name={id} type={type} value={value} placeholder={placeholder} inputMode={type === "text" ? undefined : "decimal"}
      onChange={event => onChange(event.target.value)} />
    {error ? <span className="product-field-error" role="alert">{error}</span> : hint ? <span className="product-field-hint">{hint}</span> : null}
  </label>;
}

/**
 * 「算利润」停在条件测算之后，这件商品唯一的出路就摆在这一步里。
 *
 * 以前这一步对已确认的商品只剩一句「详细界面还在旧版页面里」，而那条出路的按钮恰恰只长在旧版 A 卡上——
 * 主人在这一页看不到自己还能做什么，只能猜。这一块把服务端那份记录原样摆出来：能不能重算、这一次会用
 * 哪一种费用证据、以及重算完了算不算能上架。
 *
 * 它不探测、不读平台：显示什么全部来自服务端已经保存的 bExactCommissionRuntimeView。
 */
function BetterCommissionEvidenceSection({ candidate, saving, onRecalculate, onOpenLegacyCard }) {
  const recalculation = candidate.bExactCommissionRuntimeView;
  const rate = finite(recalculation.commissionRate) === null ? null
    : `${Number((recalculation.commissionRate * 100).toFixed(2))}%`;
  const ready = recalculation.canRecalculate === true;
  return <section className="product-section" aria-label="用更好的费用证据重算">
    <h3>{ready ? "已经有更好的费用证据，可以重算利润" : "条件测算已保存，等更好的费用证据"}</h3>
    <p>这件商品的利润是按估算佣金算出来的，停在「条件测算」：没有通过正式 B，也没有进「文案素材」。
      已经确认过的货价和包装不用重填。</p>
    <p className="product-profit-note">{recalculation.message}</p>
    {ready ? <>
      <p className="product-profit-note">
        {`这一次会用：${recalculation.commissionEvidenceLabel}${rate === null ? "" : ` ${rate}`}。`}
        {recalculation.commissionEvidenceMode === "official_reference"
          ? "它是公开费率表上写着的数，不是这个店被扣过的钱——重算之后 B 会正式通过，但上架那道闸门只认店里的实收费率，这件商品还是上不了架。"
          : "它就是这个店在这条类目上被实际扣掉的费率，重算通过之后这件商品可以继续往上架走。"}
      </p>
      <button type="button" className="button primary" disabled={saving} onClick={onRecalculate}>
        {saving ? "正在重算正式利润…" : "用更好的费用证据重算"}
      </button>
      <p className="product-actions-note">重算只用已经保存下来的证据，不会打开平台，也不会产生任何费用。</p>
    </> : <p className="product-actions-note">
      {"现在还没有可用的更好证据，软件不会自己重试，也不会替你把估算当成实收。"}
      {typeof onOpenLegacyCard === "function" ? "这一步的其余细节在「打开旧版A卡」里。" : ""}
    </p>}
  </section>;
}

/**
 * 「重新读一次费用证据」——两次点击里的第一次。
 *
 * 上面那一块只会用已经存下来的证据；这件商品现在那份佣金证据挂在旧类目路径上，谁也用不了，
 * 于是上面那一块永远是「还没有可用的更好证据」，而软件按设计不会自己去读。这一块就是那条出路：
 * 主人点一下，去把佣金和 Schema 按这件商品自己的适用范围重读一遍。
 *
 * 它和重算是两个决定，不合并成一次点击：读证据不改结论，改结论要主人自己再按一次。这一块把
 * 「做什么、不做什么、读完还要做什么」三件事都摆在按钮上面，省得主人按完还得猜自己刚才做了什么。
 */
function RefreshFeeEvidenceSection({ candidate, saving, onRefresh }) {
  const ready = candidate.bExactCommissionRuntimeView?.canRecalculate === true;
  return <section className="product-section" aria-label="重新读一次费用证据">
    <h3>{ready ? "也可以重新读一次费用证据" : "重新读一次费用证据"}</h3>
    <p>{ready
      ? "上面那一步已经有证据可用了，这一步不是必须的。想换一份更新的佣金和 Schema，可以再读一次。"
      : "上面那一步只会用已经存下来的证据，而存下来的那份现在用不了——为什么用不了，服务端那句话就在上面。软件不会自己去读；要重新读一次，按下面这个按钮。"}</p>
    <p className="product-profit-note">
      这一步做的事：按这件商品<strong>已经冻结的</strong>店铺、类目和销售模式，重新读一次平台佣金和 Schema（汇率过期的话一起读）。
      佣金和 Schema 走本机的只读证据服务，资费走本机那份资费表，汇率走俄罗斯央行。
    </p>
    <p className="product-profit-note">
      这一步<strong>不做</strong>的事：不碰已经定下来的规格、货价、重量、包装、线路、运费和供货确认，一个都不动；
      不向 Ozon 写任何东西；也不改这件商品的利润结论——读完之后它仍然是原来那份条件测算。
    </p>
    <button type="button" className="button secondary" disabled={saving} onClick={onRefresh}>
      {saving ? "正在重新读取费用证据…" : "重新读一次费用证据"}
    </button>
    <p className="product-actions-note">
      读完之后利润不会自己变。要用新读到的证据把利润换掉，请再点一次上面的「用更好的费用证据重算」——那是第二个决定，由主人自己按。
    </p>
  </section>;
}

export default function ProductPage({
  candidate, view = null, titleZh = null, extensionStatus = null,
  onSaveDraft, onChooseSkus, onRequestCapture, onReviewCaptureAndRequest, onRecaptureSource,
  onConfirmProfitStep, onDeclareCargoFacts, onReadOzonPage, onOpenLegacyCard, onBack, onEliminateCandidate,
  onRecalculateBWithExactCommission = null, onRefreshBFeeEvidence = null,
  loadingLabel = "正在读取这件商品的找货资料…"
}) {
  const draft = view?.supplierDraftV1 ?? null;
  const marketSnapshot = view?.marketSnapshot ?? null;
  const skuTable = view?.skuChoiceTableV1 ?? null;
  const profitReview = view?.profitStepV1 ?? null;
  const cargoStep = view?.cargoFactsStepV1 ?? null;
  const categoryStep = view?.ozonCategoryReadStepV1 ?? null;
  // 「精确佣金读不到」是服务端在上一次确认里真的这么停过一次才知道的事。页面不记它，也不在加载时去探测——
  // 探测会对主人的 Ozon 账户产生一次真实读取。服务端把那一次停在哪存成了记录，这里读的就是那份记录。
  const commissionStep = view?.commissionEstimateStepV1 ?? null;
  // The form follows the saved draft: when the server returns a newer declaration, the fields show that declaration.
  const prefillKey = `${candidate?.id ?? ""}:${candidate?.dataRevision ?? ""}:${draft?.declaredAt ?? "none"}`;
  const [form, setForm] = useState(() => draftFormState({ draft, candidate, marketSnapshot }));
  // The ticks follow the saved choice the same way: a newer revision shows what the server actually holds.
  const [chosen, setChosen] = useState(() => (skuTable?.selectedSkuIds ?? []).map(String));
  const [prefilled, setPrefilled] = useState(prefillKey);
  if (prefilled !== prefillKey) {
    setPrefilled(prefillKey);
    setForm(draftFormState({ draft, candidate, marketSnapshot }));
    setChosen((skuTable?.selectedSkuIds ?? []).map(String));
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const errors = useMemo(() => supplierDraftFormErrors(form), [form]);
  const invalid = Object.keys(errors).length > 0;
  const step = currentProductStep(candidate);
  const next = nextProductAction(view);
  const choosing = showsSkuChoice(candidate);
  const profitOpen = profitStepOpen(candidate, view);
  // 服务端只在这件商品真的停在「条件测算，等更好的费用证据」时才给出这份记录（lib/b-exact-commission-runtime-view.mjs）。
  // 页面不自己判断状态，也不去探测——有这份记录才有这一块。
  const recalculationOpen = !profitOpen && isObject(candidate?.bExactCommissionRuntimeView) &&
    typeof onRecalculateBWithExactCommission === "function";
  const estimate = estimateLines(view?.supplierDraftEstimateV1 ?? null);
  const reviewRequired = captureNeedsOwnerReview(candidate);
  const recapturable = captureRecaptureReady(candidate);
  // 采到之后该看的地方是上面那张规格表，所以重读的入口跟着它走；规格表不在场时它才留在「1688 采集」块里。
  const recaptureInChoice = recapturable && choosing;
  // 采回来之后，下一步就是上面那张表；找货里那句「去申请采集」已经过去了，不能再高亮，也不能再说。
  const highlight = choosing ? null : next.key;
  const nextHint = choosing ? null
    : reviewRequired && next.key === "capture"
      ? "下一步：先确认下面那条「结果未知」的采集记录，才能重新申请采集。"
      : next.hint;
  const snapshotLine = marketSnapshotLine(marketSnapshot);
  const change = key => value => { setForm(current => ({ ...current, [key]: value })); setNotice(null); };

  async function run(action, payload, successNotice) {
    if (saving || typeof action !== "function") return;
    setSaving(true); setError(null); setNotice(null);
    try { setNotice(stepNotice(await action(payload), successNotice)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  /** 同一次重读，无论从规格表旁边点还是从「1688 采集」块里点，走的都是这一条路。 */
  const recapture = reason => run(onRecaptureSource, captureRecapturePayload(candidate, reason),
    "已经让软件重新去读一次这个1688页面，读完这里会显示结果。");
  /**
   * 算利润 的确认。提交的东西整份由已保存的记录组装，主人只补那两个判断；组装不出完整的一份就返回 null，这里也就不发。
   * 回来之后说的是服务端实际保存成什么样，不是「已提交」——同一个 200 底下有四种结果。服务端说不行的时候，原样显示
   * 服务端那句话，用的还是本页原有的那一个提示位。
   */
  /**
   * 运输属性的确认。它自己一条路：只把主人对这件货的说法记下来，不算钱、不派任务、不碰平台。保存成功之后页面重读，
   * 「算利润」那个按钮才会解锁——解锁的理由由服务端那份记录说了算，不是这里自己判断的。
   */
  const declareCargoFacts = payload => run(onDeclareCargoFacts, payload,
    "已记下你对这件货的说法：软件按它核验线路收不收，没有下单、没有联系供应商、也没有向 Ozon 写任何东西。");
  /**
   * 读一次这个 Ozon 商品页。目标地址不从这里传：服务端只认这件商品自己已经保存的那个地址。回来的那句话是服务端
   * 和插件实际说的（含插件自己的拒绝码），页面原样显示，不改写、不概括，也不承诺重试。
   */
  const readOzonPage = () => run(onReadOzonPage, { dataRevision: candidate.dataRevision },
    "已经让软件去读一次这个 Ozon 商品页；读完这里会显示读到了什么。");
  function confirmProfitStep(firstSkuId, judgments) {
    const payload = profitStepSubmission(profitReview, firstSkuId, judgments);
    if (payload === null) { setError("这一份确认还凑不齐，没有提交；请看上面列出的缺项。"); return undefined; }
    // 失败时这里不记任何东西：服务端已经把这一次停在哪存进了记录，页面重读资料时那一块自己就回来了。
    return run(async input => profitStepOutcomeLine(await onConfirmProfitStep(input)), payload,
      "已提交这一步的确认；下面显示的是服务端现在保存的状态。");
  }

  if (!candidate) return <div className="page-panel"><p role="status">{loadingLabel}</p></div>;

  const extensionCode = extensionStatus?.code ?? "disconnected";
  const extensionConnected = extensionCode === "connected";
  const title = textOf(titleZh) || textOf(candidate.productName) || candidate.id;

  /**
   * 找货 — unchanged. It is the open step until the extension comes back with specifications; after that it folds away
   * below 选规格, still complete, because changing the target price or the packing size changes every row of that table.
   */
  const findBody = <>
    <p className="product-section-hint">把1688上找到的这件货填进来。下面每个数字都算你自己填的，软件只按它们算钱，不会替你猜。</p>
    <div className={`product-form${highlight === "form" ? " product-next" : ""}`}>
      <Field id="supply-source-url" label="1688 商品链接" value={form.sourceUrl} error={errors.sourceUrl}
        hint="详情页链接或分享短链都可以" placeholder="https://detail.1688.com/offer/…" onChange={change("sourceUrl")} />
      <Field id="supply-goods-price" label="货价（元）" value={form.goodsPriceRmb} error={errors.goodsPriceRmb} type="number" onChange={change("goodsPriceRmb")} />
      <Field id="supply-domestic-shipping" label="国内运费（元）" value={form.domesticShippingRmb} error={errors.domesticShippingRmb}
        hint="包邮填 0" type="number" onChange={change("domesticShippingRmb")} />
      <Field id="supply-weight" label="打包重量（公斤）" value={form.packedWeightKg} error={errors.packedWeightKg} type="number" onChange={change("packedWeightKg")} />
      <Field id="supply-length" label="包装长（厘米）" value={form.length} error={errors.length} type="number" onChange={change("length")} />
      <Field id="supply-width" label="包装宽（厘米）" value={form.width} error={errors.width} type="number" onChange={change("width")} />
      <Field id="supply-height" label="包装高（厘米）" value={form.height} error={errors.height} type="number" onChange={change("height")} />
      <Field id="supply-target-price" label="目标成交价（卢布）" value={form.targetSalePriceRub} error={errors.targetSalePriceRub}
        hint="默认就是同款现在的市场价；它也是以后上架时的起价，保存后下面会给出保本价和达标价"
        type="number" onChange={change("targetSalePriceRub")} />
      <Field id="supply-note" label="备注（可不填）" value={form.note} onChange={change("note")} />
    </div>
    <div className="product-actions">
      <button type="button" className="button primary" disabled={saving || invalid}
        onClick={() => run(onSaveDraft, supplierDraftPayload(form, candidate.dataRevision), "已保存你填的找货方案，下面的数字按它重新算过了。")}>保存</button>
      <span className="product-actions-note">保存只记录你填的方案，不会确认供货，也不会开始采购。</span>
    </div>

    <div className="product-result" aria-label="找货结果">
      <p className="product-result-market">{snapshotLine ?? "市场快照：还没有本商品的查询结果快照。"}</p>
      {snapshotLine ? <p className="product-result-provenance">销量、评价来自本轮 Seerfar 查询结果原样数值，未再独立回读平台。</p> : null}
      <p className="product-result-estimate">{estimate.headline}</p>
      {estimate.detail ? <p className="product-result-detail">{estimate.detail}</p> : null}
      {estimate.warning ? <p role="alert" className="product-result-warning">{estimate.warning.message}
        {estimate.warning.routes.map(route => <span key={route.route} className="product-result-route">{route.route}：{route.detail}</span>)}
      </p> : null}
      {nextHint ? <p className="product-next-hint">{nextHint}</p> : null}
    </div>

    {draft === null ? null : <PricingGuidance guidance={view?.supplierDraftEstimateV1?.pricingGuidance ?? null} />}

    <div className={`product-capture${highlight === "capture" ? " product-next" : ""}`} aria-label="插件采集">
      <h4>1688 采集</h4>
      <p className="product-capture-extension">插件状态：{extensionStatus?.label ?? "插件未安装或未连接"}</p>
      {extensionConnected ? null : <p className="product-capture-hint">还没连上插件：打开 Chrome 的 chrome://extensions，开启开发者模式，点「加载已解压的扩展程序」，选择本项目的 extension/1688-capture 目录。</p>}
      <p className="product-capture-status">{captureStatusLine(candidate)}</p>
      {/* 被挡住的时候必须先说清楚「为什么不能再申请」，再给出唯一的出路，而不是等主人点了才收到一个 409。 */}
      {reviewRequired ? <p className="product-capture-blocked" role="alert">{CAPTURE_REVIEW_BLOCKED_MESSAGE}</p> : null}
      <button type="button" className={`button ${highlight === "capture" && !reviewRequired ? "primary" : "secondary"}`}
        disabled={saving || draft === null || reviewRequired}
        onClick={() => run(onRequestCapture, captureSubmissionFromDraft({ candidate, draft, marketSnapshot }), "已申请插件采集，采到后这里会显示结果。")}>申请插件采集</button>
      {reviewRequired ? <button type="button" className="button primary" disabled={saving || draft === null}
        onClick={() => run(onReviewCaptureAndRequest, {
          review: captureReviewPayload(candidate),
          capture: captureSubmissionFromDraft({ candidate, draft, marketSnapshot })
        }, "已记下你的确认，并重新申请了一次采集。")}>{CAPTURE_REVIEW_ACTION_LABEL}</button> : null}
      {/* 采到了之后「申请插件采集」不会再建新的采集，所以重读这个页面必须自己有一个入口，否则这件商品就钉死在那一次读到的内容上。
          规格表在场时那个入口在规格表旁边（那里才是主人看着这些规格的地方），这里就不再重复一个同名按钮。 */}
      {recapturable && !recaptureInChoice ? <RecaptureControl candidate={candidate} disabled={saving} onRecapture={recapture} /> : null}
      {draft === null ? <span className="product-actions-note">先保存上面的找货方案，才能申请采集。</span> : null}
      {recapturable && !recaptureInChoice ? <span className="product-actions-note">
        上面这些规格是上一次读到的。页面改了、规格不对，或者这次没采到重量，就点「重新采集」让软件把这个1688页面再读一遍。
      </span> : null}
      {recaptureInChoice ? <span className="product-actions-note">
        这些规格要重新读一次，用上面「选哪个规格上架」里的「重新采集」。
      </span> : null}
      {reviewRequired ? <span className="product-actions-note">
        在你确认这条「结果未知」的记录之前，「申请插件采集」不可用；确认只是记下你的判断，不会替你补一份采集结果。
      </span> : null}
    </div>
  </>;

  return <div className="page-panel product-page">
    {/* Where this page sits: both earlier steps go back to the desk, where 我选的商品 lists this product again. */}
    <nav className="product-breadcrumb" aria-label="位置">
      {typeof onBack === "function"
        ? <><button type="button" className="product-breadcrumb-link" onClick={onBack}>选品台</button>
          <span aria-hidden="true">›</span>
          <button type="button" className="product-breadcrumb-link" onClick={onBack}>我选的商品</button></>
        : <><span>选品台</span><span aria-hidden="true">›</span><span>我选的商品</span></>}
      <span aria-hidden="true">›</span>
      <span className="product-breadcrumb-current">{title}</span>
    </nav>
    <header className="product-header">
      {textOf(candidate.imageUrl)
        ? <img className="product-thumb" src={candidate.imageUrl} alt="" width="88" height="88" loading="lazy" referrerPolicy="no-referrer" />
        : <span className="product-thumb product-thumb-empty">主图</span>}
      <div className="product-headline">
        <h2>{title}</h2>
        <p className="product-subline">{storeLabel(candidate.targetStore)}
          {textOf(candidate.productName) && textOf(candidate.productName) !== title ? ` · ${candidate.productName}` : ""}</p>
      </div>
      <div className="product-header-actions">
        {typeof onBack === "function" ? <button type="button" className="button secondary" onClick={onBack}>返回</button> : null}
        {typeof onOpenLegacyCard === "function"
          ? <button type="button" className="button secondary" onClick={onOpenLegacyCard}>打开旧版A卡</button> : null}
        {/* The same 淘汰 as every list, so a product can be dropped from the page the owner is already looking at. */}
        {candidate.workflowStatus === "eliminated"
          ? <span className="product-eliminated-note">已淘汰 · 在选品台的「已淘汰」里可以恢复</span>
          : <EliminateControl id={candidate.id} dataRevision={candidate.dataRevision} disabled={saving}
            onEliminate={payload => run(onEliminateCandidate, payload, "已淘汰这件商品，可以在选品台的「已淘汰」里恢复。")} />}
      </div>
    </header>
    <ol className="product-stepper" aria-label="商品六步">
      {PRODUCT_STEPS.map((item, index) => <li key={item.key}
        className={`product-step${item.key === step ? " product-step-current" : ""}`}
        aria-current={item.key === step ? "step" : undefined}>
        <span className="product-step-index">{index + 1}</span>{item.title}
      </li>)}
    </ol>

    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status" className="product-notice">{notice}</p> : null}

    {/* 选规格：插件采回来的每个规格，按它自己的重量算出来的运费和利润。这里只勾选，不开始任何工作。 */}
    {choosing ? (skuTable === null
      ? <section className="product-section product-sku-choice" aria-label="选规格">
        <h3>选哪个规格上架</h3>
        <p className="product-section-hint">{`插件已经把这件1688货源的 ${candidate.sourceCapture.skuChoices.length} 个规格采回来了，但现在还算不出每个规格的运费和利润：${
          draft === null
            ? "先把下面「找货」里的资料填好保存一次，这里就会按每个规格自己的重量算给你看。"
            : "汇率、佣金、资费表或本店成本规则里还缺东西，补齐之后这里就会按每个规格自己的重量算给你看。"}`}</p>
        {recapturable ? <div className="product-sku-recapture">
          <span>如果是这一次采集本身采得不对，就重新读一遍这个1688页面。</span>
          <RecaptureControl candidate={candidate} disabled={saving} onRecapture={recapture} />
        </div> : null}
      </section>
      : <SkuChoiceSection candidate={candidate} table={skuTable} chosen={chosen} saving={saving}
        recapturable={recapturable} onRecapture={recapture}
        onToggle={(id, checked) => { setChosen(current => toggleLocalSupplierSkuSelection(current, id, checked)); setNotice(null); }}
        onToggleAll={checked => { setChosen(checked ? skuTable.rows.map(row => String(row.sourceSkuId)) : []); setNotice(null); }}
        onSubmit={() => run(onChooseSkus, skuChoicePayload(skuTable, chosen, candidate.dataRevision),
          `已选定 ${chosen.length} 个规格，它们已经锁进这件商品的供货方案；没有下单、没有联系供应商、也没有向 Ozon 写任何东西。`)} />)
      : null}

    {/* 算利润：整套一起核线、指定先上的那一个、其余排队，这件货运输上是什么，最后那两个只有主人能做的判断。 */}
    {profitOpen ? <ProfitStepSection key={`${candidate.id}:${candidate.dataRevision}`}
      review={profitReview} cargoStep={cargoStep} categoryStep={categoryStep}
      commissionEstimate={commissionStep?.present !== true ? null : {
        // 费率、档位和来源引用每次渲染都从当前这份解析结果里取；跨了档位分界线它自己就是另一档。
        // 提议从来不进记录，所以这里取的永远是现在这份解析结果，不是失败那一刻的旧数。
        proposal: commissionEstimateProposal(skuTable?.sources ?? null),
        storeLabel: storeLabel(candidate.targetStore),
        category: categoryStep?.category ?? null,
        // 服务端这一次说的官方佣金表缺口，原样带下去；它没说就是空的，那一段不出现。
        officialGaps: commissionStep.officialGaps,
        // 这条记录说的还是不是当前这一版资料。不是的话这一块不消失，只照实说它说的是哪一版。
        current: commissionStep.current,
        recordedRevision: commissionStep.recordedRevision,
        dataRevision: commissionStep.dataRevision
      }}
      dataRevision={candidate.dataRevision} saving={saving}
      onConfirm={confirmProfitStep} onDeclareCargoFacts={declareCargoFacts} onReadOzonPage={readOzonPage} /> : null}

    {/* 算利润停在条件测算之后，这一步就只剩这一件事可做；它的按钮不能只长在旧版页面上。 */}
    {recalculationOpen ? <BetterCommissionEvidenceSection candidate={candidate} saving={saving}
      onOpenLegacyCard={onOpenLegacyCard}
      onRecalculate={() => {
        // 这份记录和眼前这一版资料对不上时，buildBExactCommissionInput 自己会拒绝。
        // 拒绝要变成页面上那句话，不是一个没人接的异常——旧资料绝不会被提交出去。
        let payload;
        try { payload = buildBExactCommissionInput({ candidate, sourceRevision: candidate.dataRevision }); }
        catch (cause) { setError(errorMessage(cause)); setNotice(null); return undefined; }
        return run(onRecalculateBWithExactCommission, payload,
          "已经用保存下来的费用证据把这件商品的利润重算了一次；没有打开平台，也没有向 Ozon 写任何东西。");
      }} /> : null}

    {/* 上面那一步只用存下来的证据。存下来的那份用不了时，这一块是唯一的出路，它也只有主人按得动。 */}
    {recalculationOpen && typeof onRefreshBFeeEvidence === "function"
      ? <RefreshFeeEvidenceSection candidate={candidate} saving={saving}
        onRefresh={() => {
          let payload;
          try { payload = buildBEvidenceRefreshInput({ candidate, sourceRevision: candidate.dataRevision }); }
          catch (cause) { setError(errorMessage(cause)); setNotice(null); return undefined; }
          return run(onRefreshBFeeEvidence, payload,
            "已经重新读了一次费用证据；已经定下来的规格、成本、线路和运费都没有动，利润结论也没有变。");
        }} /> : null}

    {step === "find" ? <section className="product-section" aria-label="找货">
      <h3>找货</h3>
      {findBody}
    </section> : null}
    {choosing && step !== "find" ? <details className="product-folded" aria-label="找货">
      <summary>找货<span className="product-folded-state">已保存</span></summary>
      {findBody}
    </details> : null}

    {PRODUCT_STEPS.filter(item => item.key !== "find" && !(choosing && item.key === "select") &&
      !((profitOpen || recalculationOpen) && item.key === "profit"))
      .map(item => <details key={item.key} className="product-folded">
        <summary>{item.title}<span className="product-folded-state">{foldedStepState(item.key, step, candidate)}</span></summary>
        <p>{foldedStepLine(item.key, step, candidate)}</p>
      </details>)}
  </div>;
}
