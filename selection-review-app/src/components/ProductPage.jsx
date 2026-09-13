import { useMemo, useState } from "react";
import { errorMessage } from "../formState.js";
import { storeLabel } from "../selectionDeskView.js";
import { toggleLocalSupplierSkuSelection } from "../aSupplierCaptureSelection.js";
import { profitStepGaps, profitStepSubmission } from "../../lib/profit-step-review.mjs";
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
 * 算利润 — the whole set against the line, one variant named to go up first, the rest queued.
 *
 * Only two things on this screen are the owner's to decide, and both are judgments no record can hold: whether the
 * two products really are the same kind of thing, and whether the link, the specification, the cost and the packing
 * are one purchase plan. Everything else is already saved and is shown beside the tick that relies on it. Nothing is
 * confirmed until both are ticked, and a missing fact disables the button instead of being filled in.
 */
function ProfitStepSection({ review, saving, onConfirm }) {
  const [firstPick, setFirstPick] = useState(null);
  const [comparabilityConfirmed, setComparability] = useState(false);
  const [supplyConfirmed, setSupply] = useState(false);
  const firstSkuId = profitStepFirstSkuId(review, firstPick);
  const spec = review.specifications.find(item => item.sourceSkuId === firstSkuId) ?? null;
  const gaps = profitStepGaps(review, firstSkuId ?? "");
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

    {/* 凑不齐的东西如实列出来，按钮就不给点；软件不会替主人补一个像样的数字上去。 */}
    {state.gaps.length === 0 ? null : <div className="product-profit-gaps" role="alert">
      <h4>还差这些，现在不能确认</h4>
      <ul>{state.gaps.map(item => <li key={item.field}><b>{item.label}</b>：{item.why}</li>)}</ul>
    </div>}

    <div className="product-actions">
      <button type="button" className="button primary" disabled={saving || !state.ready}
        onClick={() => onConfirm(firstSkuId, { comparabilityConfirmed, supplyConfirmed })}>确认，进入文案素材</button>
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

export default function ProductPage({
  candidate, view = null, titleZh = null, extensionStatus = null,
  onSaveDraft, onChooseSkus, onRequestCapture, onReviewCaptureAndRequest, onRecaptureSource,
  onConfirmProfitStep, onOpenLegacyCard, onBack, onEliminateCandidate,
  loadingLabel = "正在读取这件商品的找货资料…"
}) {
  const draft = view?.supplierDraftV1 ?? null;
  const marketSnapshot = view?.marketSnapshot ?? null;
  const skuTable = view?.skuChoiceTableV1 ?? null;
  const profitReview = view?.profitStepV1 ?? null;
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
  function confirmProfitStep(firstSkuId, judgments) {
    const payload = profitStepSubmission(profitReview, firstSkuId, judgments);
    if (payload === null) { setError("这一份确认还凑不齐，没有提交；请看上面列出的缺项。"); return undefined; }
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

    {/* 算利润：整套一起核线、指定先上的那一个、其余排队，最后那两个只有主人能做的判断。 */}
    {profitOpen ? <ProfitStepSection key={`${candidate.id}:${candidate.dataRevision}`}
      review={profitReview} saving={saving} onConfirm={confirmProfitStep} /> : null}

    {step === "find" ? <section className="product-section" aria-label="找货">
      <h3>找货</h3>
      {findBody}
    </section> : null}
    {choosing && step !== "find" ? <details className="product-folded" aria-label="找货">
      <summary>找货<span className="product-folded-state">已保存</span></summary>
      {findBody}
    </details> : null}

    {PRODUCT_STEPS.filter(item => item.key !== "find" && !(choosing && item.key === "select") &&
      !(profitOpen && item.key === "profit"))
      .map(item => <details key={item.key} className="product-folded">
        <summary>{item.title}<span className="product-folded-state">{foldedStepState(item.key, step, candidate)}</span></summary>
        <p>{foldedStepLine(item.key, step, candidate)}</p>
      </details>)}
  </div>;
}
