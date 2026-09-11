import { useMemo, useState } from "react";
import { errorMessage } from "../formState.js";
import { storeLabel } from "../selectionDeskView.js";
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

/** The step the owner is actually on. Supply is confirmed only once the lifecycle froze an A confirmation. */
export function currentProductStep(candidate) {
  if (candidate?.workflowStatus === "listed") return "readback";
  const phase = typeof candidate?.executionRuntime?.businessPhase === "string" ? candidate.executionRuntime.businessPhase : "";
  if (phase.startsWith("E")) return "readback";
  if (phase.startsWith("D")) return "publish";
  if (phase.startsWith("C")) return "copy";
  if (phase.startsWith("B")) return "profit";
  if (candidate?.lifecycleV11?.aConfirmationReceipt?.decision === "confirm") return "profit";
  return "find";
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
  onSaveDraft, onRequestCapture, onReviewCaptureAndRequest, onOpenLegacyCard, onBack, onEliminateCandidate,
  loadingLabel = "正在读取这件商品的找货资料…"
}) {
  const draft = view?.supplierDraftV1 ?? null;
  const marketSnapshot = view?.marketSnapshot ?? null;
  // The form follows the saved draft: when the server returns a newer declaration, the fields show that declaration.
  const prefillKey = `${candidate?.id ?? ""}:${candidate?.dataRevision ?? ""}:${draft?.declaredAt ?? "none"}`;
  const [form, setForm] = useState(() => draftFormState({ draft, candidate, marketSnapshot }));
  const [prefilled, setPrefilled] = useState(prefillKey);
  if (prefilled !== prefillKey) {
    setPrefilled(prefillKey);
    setForm(draftFormState({ draft, candidate, marketSnapshot }));
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const errors = useMemo(() => supplierDraftFormErrors(form), [form]);
  const invalid = Object.keys(errors).length > 0;
  const step = currentProductStep(candidate);
  const next = nextProductAction(view);
  const estimate = estimateLines(view?.supplierDraftEstimateV1 ?? null);
  const reviewRequired = captureNeedsOwnerReview(candidate);
  // 被挡住的时候，「下一步」不能再指向一个点不动的按钮。
  const nextHint = reviewRequired && next.key === "capture"
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

  if (!candidate) return <div className="page-panel"><p role="status">{loadingLabel}</p></div>;

  const extensionCode = extensionStatus?.code ?? "disconnected";
  const extensionConnected = extensionCode === "connected";
  const title = textOf(titleZh) || textOf(candidate.productName) || candidate.id;

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

    {step === "find" ? <section className="product-section" aria-label="找货">
      <h3>找货</h3>
      <p className="product-section-hint">把1688上找到的这件货填进来。下面每个数字都算你自己填的，软件只按它们算钱，不会替你猜。</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status" className="product-notice">{notice}</p> : null}
      <div className={`product-form${next.key === "form" ? " product-next" : ""}`}>
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

      <div className={`product-capture${next.key === "capture" ? " product-next" : ""}`} aria-label="插件采集">
        <h4>1688 采集</h4>
        <p className="product-capture-extension">插件状态：{extensionStatus?.label ?? "插件未安装或未连接"}</p>
        {extensionConnected ? null : <p className="product-capture-hint">还没连上插件：打开 Chrome 的 chrome://extensions，开启开发者模式，点「加载已解压的扩展程序」，选择本项目的 extension/1688-capture 目录。</p>}
        <p className="product-capture-status">{captureStatusLine(candidate)}</p>
        {/* 被挡住的时候必须先说清楚「为什么不能再申请」，再给出唯一的出路，而不是等主人点了才收到一个 409。 */}
        {reviewRequired ? <p className="product-capture-blocked" role="alert">{CAPTURE_REVIEW_BLOCKED_MESSAGE}</p> : null}
        <button type="button" className={`button ${next.key === "capture" && !reviewRequired ? "primary" : "secondary"}`}
          disabled={saving || draft === null || reviewRequired}
          onClick={() => run(onRequestCapture, captureSubmissionFromDraft({ candidate, draft, marketSnapshot }), "已申请插件采集，采到后这里会显示结果。")}>申请插件采集</button>
        {reviewRequired ? <button type="button" className="button primary" disabled={saving || draft === null}
          onClick={() => run(onReviewCaptureAndRequest, {
            review: captureReviewPayload(candidate),
            capture: captureSubmissionFromDraft({ candidate, draft, marketSnapshot })
          }, "已记下你的确认，并重新申请了一次采集。")}>{CAPTURE_REVIEW_ACTION_LABEL}</button> : null}
        {draft === null ? <span className="product-actions-note">先保存上面的找货方案，才能申请采集。</span> : null}
        {reviewRequired ? <span className="product-actions-note">
          在你确认这条「结果未知」的记录之前，「申请插件采集」不可用；确认只是记下你的判断，不会替你补一份采集结果。
        </span> : null}
      </div>
    </section> : null}

    {PRODUCT_STEPS.filter(item => item.key !== "find").map(item => <details key={item.key} className="product-folded">
      <summary>{item.title}<span className="product-folded-state">{item.key === step ? "进行中" : "未开始"}</span></summary>
      <p>{item.key === step ? "这一步的详细界面还在旧版页面里，先用「打开旧版A卡」查看。" : "等前面的步骤完成后再开始。"}</p>
    </details>)}
  </div>;
}
