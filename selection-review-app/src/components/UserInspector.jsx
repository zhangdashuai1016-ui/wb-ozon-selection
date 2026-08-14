import { useEffect, useMemo, useState } from "react";
import { STORE_LABELS } from "../constants";
import { wbPresentation } from "../wbPresentation";
import { MessageIcon } from "./Icons";

function optionalNumber(value) {
  return value === "" ? null : Number(value);
}

function formFromCandidate(candidate) {
  const dimensions = candidate.dimensionsCm || {};
  return {
    productUrl: candidate.productUrl || "",
    sourceUrl: candidate.sourceUrl || "",
    purchasePriceRmb: candidate.purchasePriceRmb ?? "",
    packagingCostRmb: candidate.packagingCostRmb ?? 1.5,
    packedWeightKg: candidate.packedWeightKg ?? "",
    length: dimensions.length ?? "",
    width: dimensions.width ?? "",
    height: dimensions.height ?? "",
    powered: candidate.powered === true ? "true" : candidate.powered === false ? "false" : "unknown",
    complianceStatus: "clear",
    authorizationStatus: "clear",
    expectedPriceRub: candidate.expectedPriceRub ?? "",
    notes: candidate.notes || ""
  };
}

function DirectionPanel({ candidate, onEvaluate }) {
  const [reason, setReason] = useState(candidate.userEvaluation?.reason || "");
  const [saving, setSaving] = useState("");
  const dimensions = candidate.dimensionsCm || {};
  const includedPurchasePrice =
    candidate.purchasePriceRmb === null || candidate.purchasePriceRmb === undefined
      ? ""
      : Number(candidate.purchasePriceRmb);
  const [showProfitInputs, setShowProfitInputs] = useState(false);
  const [profitInputs, setProfitInputs] = useState({
    productName: candidate.productName && !/^(用户添加的待识别商品|Codex新增候选|待确认方向)$/i.test(candidate.productName)
      ? candidate.productName
      : "",
    sourceUrl: candidate.sourceUrl || "",
    purchasePriceRmb: includedPurchasePrice,
    packedWeightKg: candidate.packedWeightKg ?? "",
    length: dimensions.length ?? "",
    width: dimensions.width ?? "",
    height: dimensions.height ?? ""
  });

  useEffect(() => {
    const nextDimensions = candidate.dimensionsCm || {};
    const nextIncludedPurchasePrice =
      candidate.purchasePriceRmb === null || candidate.purchasePriceRmb === undefined
        ? ""
        : Number(candidate.purchasePriceRmb);
    setReason(candidate.userEvaluation?.reason || "");
    setShowProfitInputs(false);
    setProfitInputs({
      productName: candidate.productName && !/^(用户添加的待识别商品|Codex新增候选|待确认方向)$/i.test(candidate.productName)
        ? candidate.productName
        : "",
      sourceUrl: candidate.sourceUrl || "",
      purchasePriceRmb: nextIncludedPurchasePrice,
      packedWeightKg: candidate.packedWeightKg ?? "",
      length: nextDimensions.length ?? "",
      width: nextDimensions.width ?? "",
      height: nextDimensions.height ?? ""
    });
  }, [candidate.id, candidate.dataRevision]);

  async function decide(decision) {
    setSaving(decision);
    try {
      await onEvaluate({ decision, reason });
    } finally {
      setSaving("");
    }
  }

  function updateProfitInput(field, value) {
    setProfitInputs((current) => ({ ...current, [field]: value }));
  }

  async function submitProfitCheck(event) {
    event.preventDefault();
    setSaving("unsure");
    try {
      await onEvaluate({
        decision: "unsure",
        reason,
        candidateData: {
          productName: profitInputs.productName.trim(),
          ...(profitInputs.sourceUrl.trim() ? { sourceUrl: profitInputs.sourceUrl.trim() } : {}),
          purchasePriceRmb: Number(profitInputs.purchasePriceRmb),
          domesticShippingRmb: 0,
          packedWeightKg: Number(profitInputs.packedWeightKg),
          dimensionsCm: {
            length: Number(profitInputs.length),
            width: Number(profitInputs.width),
            height: Number(profitInputs.height)
          }
        }
      });
    } finally {
      setSaving("");
    }
  }

  return (
    <section className="workflow-card direction-card">
      <div>
        <h3>只需判断方向</h3>
        <p>不行会立即淘汰；可做或待确认都由Codex继续核算利润和风险。</p>
      </div>
      {candidate.sourceReview?.status === "mismatch" ? (
        <div className="source-review-notice">
          <strong>C阶段来源不一致（只拦当前SKU，不是方向淘汰）</strong>
          <span>{candidate.sourceReview.reason}</span>
          <small>{candidate.sourceReview.nextAction}</small>
        </div>
      ) : null}
      <PurchaseCeiling ceiling={candidate.purchaseCeiling} />
      <textarea
        aria-label="判断理由"
        rows="2"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="理由可选，不填写也可以"
      />
      <div className="direction-actions">
        <button className="decision viable" disabled={Boolean(saving)} onClick={() => decide("viable")}>{saving === "viable" ? "提交中…" : "可做"}</button>
        <button className="decision reject" disabled={Boolean(saving)} onClick={() => decide("reject")}>{saving === "reject" ? "淘汰中…" : "不行"}</button>
        <button className="decision unsure" disabled={Boolean(saving)} onClick={() => setShowProfitInputs(true)}>待确认 · 看利润</button>
      </div>
      {showProfitInputs ? (
        <form className="direction-profit-form" onSubmit={submitProfitCheck}>
          <div className="direction-profit-heading">
            <strong>填完直接交给Codex算利润</strong>
            <span>先填明确SKU/款式、含邮采购总价、打包重量和包装尺寸；货源链接后续复核</span>
          </div>
          <label className="span-2">
            明确目标SKU/款式
            <input required type="text" value={profitInputs.productName} onChange={(event) => updateProfitInput("productName", event.target.value)} placeholder="例如：木质机械火车 320片套装" />
          </label>
          <label className="span-2">
            货源链接（可选，后续做一致性复核）
            <input type="url" value={profitInputs.sourceUrl} onChange={(event) => updateProfitInput("sourceUrl", event.target.value)} placeholder="现在没有也不阻断利润核算" />
            <small>1688页面读取不是A方向初筛或B利润核算前置；C阶段采购/上架前才核对精确SKU、权利/IP、合规、带电与最终包装。不一致只拦当前SKU。</small>
          </label>
          <label>
            采购价（含国内邮费，RMB）
            <input required type="text" inputMode="decimal" value={profitInputs.purchasePriceRmb} onChange={(event) => updateProfitInput("purchasePriceRmb", event.target.value)} />
            <small>这里填你实际付给供应商的含邮总价；系统将国内运费记为0元，避免重复计费。</small>
          </label>
          <label>打包重量（kg）<input required type="text" inputMode="decimal" value={profitInputs.packedWeightKg} onChange={(event) => updateProfitInput("packedWeightKg", event.target.value)} /></label>
          <fieldset className="dimensions span-2">
            <legend>包装长宽高（cm）</legend>
            {["length", "width", "height"].map((field, index) => (
              <input key={field} required aria-label={["长", "宽", "高"][index]} placeholder={["长", "宽", "高"][index]} type="text" inputMode="decimal" value={profitInputs[field]} onChange={(event) => updateProfitInput(field, event.target.value)} />
            ))}
          </fieldset>
          <div className="direction-profit-actions span-2">
            <button type="button" className="button secondary" onClick={() => setShowProfitInputs(false)}>取消</button>
            <button className="button primary" disabled={Boolean(saving)}>{saving === "unsure" ? "提交中…" : "提交并计算利润"}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PurchaseCeiling({ ceiling }) {
  if (["verified", "estimated"].includes(ceiling?.status)) {
    const maximum = Number(ceiling.maximumAllInPurchaseRmb);
    const estimated = ceiling.status === "estimated";
    const referencePrice = Number(ceiling.sellerRevenueRmb);
    const referencePriceRub = Number(ceiling.marketReferenceRub);
    const exchangeRate = Number(ceiling.exchangeRateRubPerCny);
    const commission = Number(ceiling.commissionRate);
    const freight = Number(ceiling.internationalLogisticsRmb);
    const marketPriceLabel = ceiling.marketAvailability === "sold_out"
      ? "精确商品已售罄，上次可见价"
      : "Ozon保守参考价";
    const promotionPricing = Array.isArray(ceiling.promotionPricing)
      ? ceiling.promotionPricing
      : [];
    return (
      <aside className={`purchase-ceiling ${estimated ? "estimated" : "verified"}`} aria-label="含国内邮费采购价区间">
        <span>{estimated ? "含国内邮费建议采购区间" : "含国内邮费采购区间"}</span>
        <strong>{maximum >= 0 ? `¥0–¥${maximum.toFixed(2)}` : "没有可行采购价"}</strong>
        <small>
          {Number.isFinite(referencePriceRub) && Number.isFinite(referencePrice)
            ? `${marketPriceLabel} ${referencePriceRub.toFixed(0)}₽≈¥${referencePrice.toFixed(2)} · `
            : Number.isFinite(referencePrice) ? `Ozon参考售价 ¥${referencePrice.toFixed(2)} · ` : ""}
          {Number.isFinite(exchangeRate) ? `央行汇率 1¥=${exchangeRate.toFixed(4)}₽ · ` : ""}
          {Number.isFinite(commission) ? `佣金 ${(commission * 100).toFixed(1)}%${estimated ? "(方向参考)" : ""} · ` : ""}
          {Number.isFinite(freight) ? `${ceiling.route || "GUOO"}运费约 ¥${freight.toFixed(2)}。` : ""}
          {estimated ? ceiling.caveat || "这是找货上限；找到1688精确SKU后按最终包装重算。" : "已按最终规格验证。"}
        </small>
        {promotionPricing.length ? (
          <PromotionPricingTable scenarios={promotionPricing} />
        ) : (
          <em className="legacy-profit-note">历史利润模型未按当前促销口径重算；旧二次扣费结论不再沿用。</em>
        )}
      </aside>
    );
  }
  const missing = (ceiling?.missing || []).slice(0, 4);
  return (
    <aside className="purchase-ceiling unverified" aria-label="采购上限未验证">
      <span>含国内邮费采购区间</span>
      <strong>Codex反算中</strong>
      <small>{missing.length ? `Codex当前缺口：${missing.join("、")}` : "你无需补资料，完成取证后会自动更新。"}</small>
    </aside>
  );
}

function PromotionPricingTable({ scenarios }) {
  if (!Array.isArray(scenarios) || !scenarios.length) return null;
  return (
    <div className="advertising-scenarios">
      {scenarios.map((scenario) => (
        <div key={scenario.key} className={`advertising-scenario scenario-${scenario.key}`}>
          <span>{scenario.label || scenario.key}</span>
          <b>建议标价 ¥{Number(scenario.suggestedListPriceRmb).toFixed(2)}</b>
          <small>目标折后成交价 ¥{Number(scenario.targetTransactionPriceRmb).toFixed(2)}</small>
        </div>
      ))}
    </div>
  );
}

function ProcessingPanel({ candidate, onRecoveryAction }) {
  const review = candidate.codexReview;
  const profit = review?.profitCalculation;
  const status = candidate.processingStatus || { key: "idle", label: "空闲" };
  const activeDispatch = candidate.activeDispatch;
  const latestDispatch = candidate.latestDispatch;
  const dispatch = activeDispatch || latestDispatch;
  const recoverableTerminal = !activeDispatch &&
    ["failed", "blocked", "needs_decision", "responded_unverified"].includes(latestDispatch?.status) &&
    (latestDispatch?.status !== "blocked" || candidate.processing?.manualHold === true);
  const returnPathFailed = latestDispatch?.status === "responded_unverified" ||
    latestDispatch?.failureLayer === "missing_business_readback";
  const businessBlocker = candidate.selectionStage?.nextAction || candidate.profitReviewGate?.blockers?.[0] || "";
  const recoveryDecision = candidate.processing?.recoveryDecision || null;
  const recoveryActions = Array.isArray(recoveryDecision?.actions) ? recoveryDecision.actions : [];
  const [savingRecovery, setSavingRecovery] = useState("");
  const running = status.actualRunning === true && status.key === "running";
  const attempts = Number(candidate.processing?.attempts || 0);
  const error = ["blocked", "stalled", "state_anomaly"].includes(status.key)
    ? String(status.reason || candidate.processing?.lastError || "")
    : "";
  let currentStep = status.currentStep || "当前没有实际任务在运行";
  if (recoverableTerminal) {
    currentStep = latestDispatch.status === "responded_unverified"
      ? "任务确实已经运行并回复；卡在结果回传，评审台没有收到可验收的结构化结果"
      : `最近一次派发已停止：${latestDispatch.error || latestDispatch.agentReply || "等待明确恢复方式"}`;
  } else if (dispatch?.status === "running") currentStep = dispatch.currentStep || currentStep;
  else if (["received", "permission_required"].includes(dispatch?.status)) currentStep = "负责人任务已接收，等待登记真实执行步骤";
  else if (["queued", "waiting_assignee", "delivering"].includes(dispatch?.status)) currentStep = "已派发一次，等待负责人空闲并领取";
  if (!recoverableTerminal) {
    if (status.key === "blocked") currentStep = "本次处理已停止；系统不会自动重试";
    else if (status.key === "queued" && !dispatch) currentStep = "候选已进入A/B处理，但尚未取得真实派发记录";
    else if (status.key === "idle" || status.key === "state_anomaly") currentStep = "当前没有实际任务在运行";
  }
  const statusTitle = recoverableTerminal
    ? latestDispatch.status === "responded_unverified"
      ? "任务已回复 · 结果未验证"
      : "派发已停止 · 等待明确恢复"
    : dispatch?.status === "running"
    ? "运行中 · 有实际任务"
    : ["received", "permission_required"].includes(dispatch?.status)
      ? "负责人已接收"
      : ["queued", "waiting_assignee", "delivering"].includes(dispatch?.status)
        ? "已派发 · 等待负责人领取"
    : running
    ? "运行中 · 有实际任务"
    : status.key === "queued"
      ? "已确认 · 尚未派发"
      : status.key === "blocked"
          ? "处理失败 · 已停止重试"
          : status.key === "state_anomaly"
            ? "状态异常 · 当前无人运行"
            : status.key === "stalled"
              ? "运行超时 · 无法确认仍在运行"
              : "无人运行 · 等待明确指令";
  const canRecover = candidate.workflowStatus === "codex_processing" && recoveryActions.length > 0;

  useEffect(() => {
    setSavingRecovery("");
  }, [candidate.id, candidate.dataRevision]);

  async function confirmRecovery(actionId) {
    setSavingRecovery(actionId);
    try {
      await onRecoveryAction(actionId);
    } finally {
      setSavingRecovery("");
    }
  }

  return (
    <>
      <section className="workflow-card processing-card">
        <span className={`processing-mark ${running ? "running" : ""}`} aria-hidden="true" />
        <div>
          <h3>{statusTitle}</h3>
          <p>{currentStep}</p>
          {status.dispatchRequestedAt ? <small className="processing-attempts">用户操作触发：{new Date(status.dispatchRequestedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {dispatch ? <small className="processing-attempts">一次性派发：{dispatch.id} · 负责人：{dispatch.assigneeTitle || dispatch.assigneeRole}</small> : null}
          {dispatch?.runId ? <small className="processing-attempts">真实运行编号：{dispatch.runId}</small> : null}
          {dispatch?.deliveryDetail ? <small className="processing-attempts">派发状态：{dispatch.deliveryDetail}</small> : null}
          {dispatch?.error ? <small className="processing-error">派发失败层：{dispatch.failureLayer || "未知"} · {dispatch.error}</small> : null}
          {returnPathFailed ? <small className="processing-error">系统卡点：执行任务无法把结构化结果交回评审台；这不等于商品审核失败。</small> : null}
          {businessBlocker ? <small className="processing-attempts">商品当前业务卡点：{businessBlocker}</small> : null}
          {status.lastAttemptAt ? <small className="processing-attempts">最近尝试：{new Date(status.lastAttemptAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {status.lastProgressAt ? <small className="processing-attempts">最近实质进展：{new Date(status.lastProgressAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {attempts ? <small className="processing-attempts">累计历史尝试 {attempts} 次；新规则下同轮同层同目标只允许一次。</small> : null}
          {error ? <small className="processing-error">卡点：{error}</small> : null}
          {!canRecover && status.userAction ? <small className="processing-error">下一步：{status.userAction}</small> : null}
          {canRecover ? (
            <div className="recovery-confirmation">
              <b>{recoveryDecision.summary || "请选择当前SKU的处理方式"}</b>
              <div className="recovery-actions">
                {recoveryActions.map((action) => (
                  <button
                    type="button"
                    className={`button ${action.id === "keep_stopped" ? "secondary" : "primary"}`}
                    disabled={Boolean(savingRecovery)}
                    onClick={() => confirmRecovery(action.id)}
                    key={action.id}
                  >
                    {savingRecovery === action.id ? "正在处理…" : action.label}
                  </button>
                ))}
              </div>
              <small>无需手写建议。系统错误会自动纠正；这里只处理真实技术失败或必须由你决定的事项。</small>
            </div>
          ) : null}
        </div>
      </section>
      <section className="result-preview" aria-label="审核结果预览">
        <div><span>利润</span><strong>{profit?.status === "verified" ? `¥${profit.unitProfitRmb} / ${(profit.marginRate * 100).toFixed(1)}%` : "未验证"}</strong></div>
        <div><span>市场证据</span><strong>{review?.marketEvidence?.comparableCount || 0}条</strong></div>
        <div><span>你要做什么</span><strong>{canRecover ? "选择一个明确处理方式" : activeDispatch ? "无需操作，等待负责人处理" : "当前状态没有要求你操作"}</strong></div>
      </section>
    </>
  );
}

function MissingField({ field, form, update }) {
  if (field === "dimensionsCm") {
    return (
      <fieldset className="dimensions span-2">
        <legend>包装长宽高（cm）</legend>
        {["length", "width", "height"].map((key, index) => (
          <input key={key} aria-label={["长", "宽", "高"][index]} placeholder={["长", "宽", "高"][index]} type="text" inputMode="decimal" value={form[key]} onChange={(event) => update(key, event.target.value)} />
        ))}
      </fieldset>
    );
  }
  if (field === "powered") {
    return <label>是否带电<select value={form.powered} onChange={(event) => update("powered", event.target.value)}><option value="unknown">不确定</option><option value="false">否，完全非电</option><option value="true">是，交给Codex核验平台和线路</option></select></label>;
  }
  const definitions = {
    productUrl: ["商品链接", "url", ""],
    sourceUrl: ["1688/拼多多货源链接", "url", ""],
    purchasePriceRmb: ["采购到手总价（含国内运费，RMB）", "decimal"],
    packedWeightKg: ["真实打包重量（kg）", "decimal"],
    expectedPriceRub: ["预期俄区售价（RUB）", "numeric"]
  };
  const definition = definitions[field];
  if (field === "notes") {
    return <label className="span-2">补充说明<textarea rows="3" value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="例如：玻璃厚度、防碎包装方式" /></label>;
  }
  if (!definition) return null;
  return <label>{definition[0]}<input type="text" inputMode={definition[1]} value={form[field]} onChange={(event) => update(field, event.target.value)} /></label>;
}

function NeedsDataPanel({ candidate, onUpdate }) {
  const [form, setForm] = useState(() => formFromCandidate(candidate));
  const [saving, setSaving] = useState(false);
  const fields = (candidate.neededFieldKeys || []).filter(
    (field) => !["domesticShippingRmb", "packagingCostRmb", "complianceStatus", "authorizationStatus"].includes(field)
  );

  useEffect(() => setForm(formFromCandidate(candidate)), [candidate.id, candidate.dataRevision]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    const payload = {
      packagingCostRmb: candidate.packagingCostRmb ?? 1.5,
      complianceStatus: "clear",
      authorizationStatus: "clear"
    };
    for (const field of fields) {
      if (["purchasePriceRmb", "packagingCostRmb", "packedWeightKg", "expectedPriceRub"].includes(field)) {
        payload[field] = optionalNumber(form[field]);
      } else if (field === "dimensionsCm") {
        payload.dimensionsCm = {
          length: optionalNumber(form.length),
          width: optionalNumber(form.width),
          height: optionalNumber(form.height)
        };
      } else if (field === "powered") {
        payload.powered = form.powered === "false" ? false : form.powered === "true" ? true : "unknown";
      } else {
        payload[field] = form[field];
      }
    }
    setSaving(true);
    try {
      await onUpdate(payload);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow-card needs-card">
      <div>
        <h3>只需你完成这一项</h3>
        <ul>{candidate.needsFromUser.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      <form className="missing-form" onSubmit={submit}>
        {fields.map((field) => <MissingField key={field} field={field} form={form} update={update} />)}
        <button className="button primary span-2" disabled={saving}>{saving ? "保存中…" : "保存并重新交给Codex"}</button>
      </form>
    </section>
  );
}

function numeric(value) {
  return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

function money(value) {
  return Number.isFinite(value) ? `¥${value.toFixed(2)}` : "未取得";
}

function WbNotSuitableDetails({ candidate, rules }) {
  const wb = candidate.wbAssessment || {};
  const market = wb.marketEvidence || {};
  const profit = wb.profitCalculation || {};
  const rule = rules?.wbCrossListing || {
    advertisingReserveRate: 0,
    returnOpsReserveRate: 0.05,
    damageLossReserveRate: 0.05,
    labelCostRmb: 1.5,
    minimumUnitProfitRmb: 20,
    targetMarginRate: 0.25
  };
  const sellerRevenue = numeric(profit.targetPriceRmb);
  const purchase = numeric(candidate.purchasePriceRmb);
  const packaging = numeric(candidate.packagingCostRmb ?? 1.5);
  const freight = numeric(wb.logistics?.freightRmb);
  const commissionRate = numeric(wb.commission?.rate);
  const promotionPricing = Array.isArray(profit.promotionPricing) ? profit.promotionPricing : [];
  const advertisingRate = Number(profit.advertisingReserveRate ?? rule.advertisingReserveRate ?? 0);
  const fixedComplete = [sellerRevenue, purchase, packaging, freight, commissionRate].every(Number.isFinite);
  const reserveRate =
    advertisingRate +
    Number(rule.returnOpsReserveRate || 0) +
    Number(rule.damageLossReserveRate || 0);
  const totalVariableRate = commissionRate + reserveRate;
  const variableCost = fixedComplete ? sellerRevenue * totalVariableRate : null;
  const calculatedProfit = fixedComplete
    ? sellerRevenue - purchase - packaging - freight - Number(rule.labelCostRmb || 1.5) - variableCost
    : null;
  const calculatedMargin = fixedComplete && sellerRevenue > 0 ? calculatedProfit / sellerRevenue : null;
  const blockers = candidate.wbAssessmentGate?.blockers || [];

  return (
    <section className="wb-not-suitable-details">
      <h4>WB不适合上架 · 详细原因</h4>
      <p>{wb.reason || "当前WB市场和完整成本未通过门槛。"}</p>
      {market.exactMatchStatus === "found" ? (
        <p>
          已核到 {market.exactMatchCount || market.competitors?.length || 0} 个WB同款，
          买家可见中位价 <b>{market.medianPriceRub} RUB</b>；以下利润按该中位价计算，不使用Ozon售价。
        </p>
      ) : null}
      {blockers.length ? <ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      <dl className="wb-cost-grid">
        <div><dt>WB卖家收入</dt><dd>{money(sellerRevenue)}</dd></div>
        <div><dt>采购到手总价（含国内运费）</dt><dd>{money(purchase)}</dd></div>
        <div><dt>包材</dt><dd>{money(packaging)}</dd></div>
        <div><dt>CEL运费</dt><dd>{money(freight)}</dd></div>
        <div><dt>WB佣金</dt><dd>{Number.isFinite(commissionRate) ? `${(commissionRate * 100).toFixed(1)}%` : "未取得"}</dd></div>
      </dl>
      <div className="wb-formula">
        <strong>计算公式</strong>
        <p>单件利润 = WB折后卖家收入 − 采购到手总价（含国内运费）− 包材 − CEL运费 − 贴标费 − WB折后卖家收入 ×（佣金率＋广告{(advertisingRate * 100).toFixed(0)}%＋退货/运营5%＋破损/丢失5%）。促销折扣只反推标价，不再扣一次。</p>
        {fixedComplete ? (
          <p>
            = {money(sellerRevenue)} − {money(purchase)} − {money(packaging)} − {money(freight)} − {money(rule.labelCostRmb)} − {money(sellerRevenue)} × {(totalVariableRate * 100).toFixed(1)}% = <b>{money(calculatedProfit)}</b>
          </p>
        ) : <p>当前存在未取得项，不能生成数值代入结果。</p>}
        <p>利润率 = 单件利润 ÷ WB卖家收入 × 100%{calculatedMargin !== null ? ` = ${(calculatedMargin * 100).toFixed(2)}%` : ""}</p>
        <p className="wb-threshold">通过门槛：单件利润≥{rule.minimumUnitProfitRmb} RMB，且利润率≥{Math.round(rule.targetMarginRate * 100)}%，两项必须同时满足。</p>
      </div>
      {promotionPricing.length ? <PromotionPricingTable scenarios={promotionPricing} /> : <p className="legacy-profit-note">历史利润模型未按当前促销口径重算。</p>}
      {profit.stressScenario ? <p className="wb-stress">压力/补充情景：{profit.stressScenario}</p> : null}
    </section>
  );
}

function WbMarketSummary({ candidate, presentation }) {
  const wb = candidate.wbAssessment || {};
  const market = wb.marketEvidence || {};
  const profit = wb.profitCalculation || {};
  if (presentation.kind === "not-in-scope") {
    return (
      <section className="wb-market-summary wb-not-in-scope">
        <strong>{presentation.heading}</strong>
        <p>{presentation.detail}</p>
        <small>历史WB记录仍保留在完整审核依据中，但不代表本轮正在计算或等待处理。</small>
      </section>
    );
  }
  if (!candidate.wbAssessmentGate?.passed) {
    return (
      <section className="wb-market-summary wb-recheck">
        <strong>{presentation.heading}</strong>
        {presentation.riskAccepted ? (
          <div className="wb-risk-handoff">
            <b>{presentation.paused ? "当前暂停，不进行任何WB上架操作" : "不等于WB已验证通过"}</b>
            <span>{presentation.paused ? "恢复后负责人：上架任务" : "下一阶段负责人：上架任务"}</span>
            <span>{presentation.paused ? "恢复条件：重新提供并确认最终图片附件清单。" : "正式写入前仍须确认：店铺、价格、库存、图片、发布范围。"}</span>
          </div>
        ) : null}
        <p>{presentation.detail}</p>
        {presentation.conditional ? (
          <p>
            条件测算（非最终）：建议价 <b>{presentation.conditional.recommendedPriceRub} RUB</b>，
            单件利润约 <b>¥{presentation.conditional.unitProfitRmb.toFixed(2)}</b>，
            利润率约 <b>{(presentation.conditional.marginRate * 100).toFixed(2)}%</b>。
          </p>
        ) : null}
        {presentation.nextStep ? <small>下一步：{presentation.nextStep}</small> : null}
      </section>
    );
  }
  if (market.exactMatchStatus === "not_found") {
    return (
      <section className="wb-market-summary">
        <strong>WB未发现完全同款，默认可上架</strong>
        <p>建议售价 {profit.recommendedPriceRub} RUB；该售价按WB佣金、CEL运费和完整成本反算。</p>
      </section>
    );
  }
  return (
    <section className="wb-market-summary">
      <strong>WB已发现完全同款</strong>
      <p>同款中位价 {market.medianPriceRub} RUB；利润按该中位价判断。</p>
    </section>
  );
}

function ListingPreparationPanel({ candidate, onRecoveryAction, onCapture, onSelectSku, onLifecycleProductionAuthorization }) {
  const handoff = candidate.listingHandoff || {};
  const preparation = candidate.listingPreparation || {};
  const sourceCapture = candidate.sourceCapture || {};
  const dispatch = candidate.activeDispatch || candidate.latestDispatch;
  const waiting = handoff.state === "awaiting_user_start";
  const needsOwnerDecision = handoff.state === "needs_decision" || preparation.status === "needs_decision";
  const stopped = ["blocked", "needs_decision", "paused_user_stopped"].includes(handoff.state) ||
    ["blocked", "needs_decision"].includes(preparation.status);
  const decisionItems = Array.isArray(handoff.decisionItems) && handoff.decisionItems.length
    ? handoff.decisionItems
    : Array.isArray(preparation.decisionItems) ? preparation.decisionItems : [];
  const capturing = sourceCapture.status === "waiting_extension" || handoff.state === "capturing_source";
  const choosingSku = sourceCapture.status === "needs_sku_selection";
  const suggestedSkuKey = Array.isArray(sourceCapture.suggestedSkuIds) ? sourceCapture.suggestedSkuIds.join("|") : "";
  const is1688 = /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#]|$)/i.test(candidate.sourceUrl || "");
  const dimensions = candidate.dimensionsCm || {};
  const inheritedDimensions = [dimensions.length, dimensions.width, dimensions.height].every((value) => Number(value) > 0)
    ? `${dimensions.length} × ${dimensions.width} × ${dimensions.height} cm`
    : "未填写";
  const requiredSkills = (dispatch?.requiredSkills || []).map((skill) => skill.name).filter(Boolean);
  const attachedSkills = Array.isArray(dispatch?.attachedSkills) ? dispatch.attachedSkills : [];
  const lifecycle = candidate.lifecycleV11 || null;
  const lifecycleSku = lifecycle?.skuPackage || null;
  const c1Plan = lifecycleSku?.c1ProductPlan || null;
  const c2Assets = lifecycleSku?.c2FinalAssets || null;
  const activeProfit = lifecycleSku?.profitModels?.find((model) => model.profitModelVersion === lifecycleSku.activeProfitModelVersion) || null;
  const finalCard = lifecycleSku?.productionConfirmationCard || null;
  const productionScope = lifecycleSku?.productionAuthorization?.lockedScope || null;
  const localFinalAssets = (productionScope?.finalUploads || []).some((asset) => !/^https:\/\//i.test(asset.assetRef || ""));
  const [selectedSkuIds, setSelectedSkuIds] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelectedSkuIds(suggestedSkuKey ? suggestedSkuKey.split("|") : []);
    setSaving(false);
  }, [candidate.id, candidate.dataRevision, suggestedSkuKey]);

  function toggleSku(sourceSkuId) {
    setSelectedSkuIds((current) => current.includes(sourceSkuId)
      ? current.filter((id) => id !== sourceSkuId)
      : [...current, sourceSkuId]);
  }

  async function run(action) {
    setSaving(true);
    try {
      if (action === "capture") await onCapture("");
      else if (action === "select-sku") await onSelectSku(selectedSkuIds);
      else if (action === "authorize-production") await onLifecycleProductionAuthorization();
      else await onRecoveryAction(action);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow-card listing-preparation-card">
      <div>
        <h3>{capturing ? "正在读取1688商品" : choosingSku ? "请选择一个或多个1688 SKU" : waiting ? "待上架准备" : lifecycleSku?.businessPhase === "C2" && c2Assets?.status === "awaiting_final_uploads" ? "C1商品方案完成 · 等待C2最终素材" : needsOwnerDecision ? "C阶段核验完成 · 等待你确认" : stopped ? "C阶段已停止" : handoff.state === "running" ? "上架任务正在做C阶段" : "C阶段已派发"}</h3>
        <p>
          {capturing
            ? "本机Chrome正在处理当前商品一次；尚未派发上架任务。"
            : choosingSku
              ? "商品页面中的全部SKU已经列出。勾选本次要核验的一个或多个规格后，才会向上架任务派发当前商品的C阶段。"
              : waiting
            ? "这是旧流程遗留状态。本阶段不改变商品状态，也不再提供人工启动C的旧按钮。"
            : stopped
              ? sourceCapture.reason || handoff.blockReason || preparation.reason || "本次核验已停止；系统不会自动重试。"
              : handoff.currentStep || "等待上架任务领取当前SKU。"}
        </p>
        {needsOwnerDecision ? (
          <div className="recovery-confirmation owner-decision-card">
            <b>现在只需要确认这些真实缺口</b>
            {decisionItems.length ? (
              <ol>
                {decisionItems.map((item) => <li key={item}>{item}</li>)}
              </ol>
            ) : null}
            <p>{handoff.userAction || "确认前不会重新采集、重新核算或继续上架。"}</p>
            <small>这不是1688采集失败，也不需要再次点击采集；确认结果会继续留在当前SKU的C阶段。</small>
          </div>
        ) : null}
        {lifecycleSku ? (
          <div className="capability-receipt lifecycle-c1-receipt">
            <b>新版生命周期 · C1已完成</b>
            <span>精确SKU：{lifecycleSku.supplierSkuId} · 当前阶段：{lifecycleSku.businessPhase} · 技术状态：{lifecycleSku.technicalStatus}</span>
            <span>商品事实：无品牌 · DVP · {lifecycle?.ownerFactConfirmation?.pieceCount || "?"}件 · 机械发条 · 非电无电池</span>
            {activeProfit ? <span>建议成交价：{activeProfit.recommendedSalePriceRub} RUB · 单件利润 ¥{activeProfit.unitProfitRmb} · 利润率 {(activeProfit.profitMargin * 100).toFixed(2)}%</span> : null}
            {c1Plan?.seoTitleDraft?.text ? <span>俄语标题草稿：{c1Plan.seoTitleDraft.text}</span> : null}
            <span>关键词证据：当前冻结事实词，无搜索量声明，Seerfar 0点；草稿仍待主人审阅。</span>
            <span>最终素材：{c2Assets?.assets?.finalUploads?.length || 0}个 · 生产授权：{lifecycleSku.productionAuthorization ? "已生成" : "未生成"} · 平台写入：0</span>
            {finalCard ? (
              <div className="lifecycle-final-card">
                <b>最终商品方案确认卡 · {lifecycleSku.productionAuthorization ? "已生成生产授权" : "等待主人商业确认"}</b>
                <span>标题：{finalCard.seoDraft?.title?.text}</span>
                <span>精确SKU：{finalCard.productInformation?.sku?.value?.supplierSkuId} · 建议售价：{finalCard.profitResult?.recommendedSalePrice?.value?.rub} RUB</span>
                <span>利润：¥{finalCard.profitResult?.unitProfitRmb?.value} · 利润率 {(Number(finalCard.profitResult?.profitMargin?.value || 0) * 100).toFixed(2)}%</span>
                <span>最终上传顺序：{(finalCard.c2Assets?.finalUploads || []).map((asset) => asset.fileName || asset.assetId).join(" → ")}</span>
                {finalCard.riskAndUnknowns?.marketReferenceMismatch ? <span>风险：A阶段价格参考为320片，当前精确供应SKU为282件；只作为有限市场参考。</span> : null}
                {lifecycleSku.productionAuthorization ? (
                  <>
                    <span>买家目标成交价：{productionScope?.buyerTargetPrice?.amount ?? finalCard.profitResult?.recommendedSalePrice?.value?.rub} {productionScope?.buyerTargetPrice?.currency || "RUB"}</span>
                    <span>Ozon后台实际写入价：{productionScope?.platformWritePrice ? `${productionScope.platformWritePrice.amount} ${productionScope.platformWritePrice.currency}` : "旧授权待修复，禁止生产"}</span>
                    <span>上架最短路径：Seller API自动填写类目、属性、价格、包装并独立回读；{localFinalAssets ? "本机素材只保留一次人工多选" : "素材也可由API直接处理"}。</span>
                    <small>浏览器不再承担逐字段填表；后台价格字段只允许CNY。新品库存100仍按精确生产范围单独写入。</small>
                  </>
                ) : (
                  <>
                    <small>通过后只生成“仅创建草稿”的锁定授权，不派发上架任务，也不创建Ozon商品。</small>
                    <button className="button primary" disabled={saving} onClick={() => run("authorize-production")}>{saving ? "正在锁定…" : "通过并生成生产授权"}</button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <small>负责人：上架任务 · C1只继承A阶段确认的供应SKU和B利润结果，核对材质/带电/IP/合规、Schema与SEO；不得重新寻找或替换供应SKU。</small>
        <div className="inherited-input-card">
          <b>前期继承资料 · 不需要重新填写</b>
          <div className="inherited-input-grid">
            <span><small>目标店铺</small>{STORE_LABELS[candidate.targetStore] || candidate.targetStore || "未填写"}</span>
            <span><small>采购到手总价</small>{candidate.purchasePriceRmb === null || candidate.purchasePriceRmb === undefined ? "未填写" : `¥${candidate.purchasePriceRmb}（含国内运费）`}</span>
            <span><small>真实打包重量</small>{candidate.packedWeightKg ? `${candidate.packedWeightKg} kg` : "未填写"}</span>
            <span><small>包装尺寸</small>{inheritedDimensions}</span>
            <span className="inherited-source"><small>精确货源链接</small>{candidate.sourceUrl ? <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">打开已保存链接</a> : "未填写"}</span>
            <span><small>数据修订号</small>{candidate.dataRevision}</span>
          </div>
        </div>
        {sourceCapture.offerId ? (
          <div className={`source-capture-summary capture-${sourceCapture.status || "unknown"}`}>
            <b>1688只读证据 · offer {sourceCapture.offerId}</b>
            {sourceCapture.title ? <span>{sourceCapture.title}</span> : null}
            {(sourceCapture.selectedSkus || (sourceCapture.selectedSku ? [sourceCapture.selectedSku] : [])).map((sku) => (
              <span key={sku.sourceSkuId}>
                SKU {sku.sourceSkuId} · {sku.priceCny ? `页面直接价格 ¥${sku.priceCny}` : "页面直接价格未取得"}
                {sku.stock === null || sku.stock === undefined ? " · 库存未取得" : ` · 库存${sku.stock}`}
              </span>
            ))}
            {sourceCapture.observedAt ? <small>取得时间：{new Date(sourceCapture.observedAt).toLocaleString("zh-CN")}</small> : null}
          </div>
        ) : null}
        {dispatch ? (
          <div className="capability-receipt">
            <b>本轮能力包</b>
            <span>派发编号：{dispatch.id}{dispatch.runId ? ` · 运行编号：${dispatch.runId}` : ""}</span>
            <span>1688采集：{dispatch.capabilityPlan?.sourceCapture?.status === "attached" ? `已附加 ${dispatch.capabilityPlan.sourceCapture.captureId}` : is1688 ? "尚未附加" : "当前链接无需插件"}</span>
            <span>必需Skill：{requiredSkills.length ? requiredSkills.join("、") : "无"}</span>
            <span>实际注入：{dispatch.skillsAttachedAt ? attachedSkills.join("、") || "无" : "尚未取得真实运行编号"}</span>
          </div>
        ) : (
          <div className="capability-receipt planned">
            <b>启动C阶段时将自动准备</b>
            <span>1688采集结果＋前期继承资料＋ozon-wb-pricing＋optimize-ecommerce-seo</span>
          </div>
        )}
        {choosingSku && candidate.supplyConfirmation?.stage === "A" ? (
          <div className="source-sku-selector">
            <div className="source-sku-selector-heading">
              <b>本次要采购/上架的SKU（可多选）</b>
              <span>已选 {selectedSkuIds.length}/{(sourceCapture.skuChoices || []).length}</span>
            </div>
            <details className="source-sku-dropdown" open>
              <summary>展开/收起全部 {(sourceCapture.skuChoices || []).length} 个SKU</summary>
              <div className="source-sku-options">
                {(sourceCapture.skuChoices || []).map((sku) => {
                  const attributes = Object.entries(sku.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
                  return (
                    <label className={`source-sku-option ${selectedSkuIds.includes(sku.sourceSkuId) ? "selected" : ""}`} key={sku.sourceSkuId}>
                      <input
                        type="checkbox"
                        checked={selectedSkuIds.includes(sku.sourceSkuId)}
                        onChange={() => toggleSku(sku.sourceSkuId)}
                      />
                      <span className="source-sku-option-main">
                        <b>{attributes || sku.propPath || `SKU ${sku.sourceSkuId}`}</b>
                        <small>SKU ID：{sku.sourceSkuId}</small>
                      </span>
                      <span className={sku.priceCny ? "source-sku-price" : "source-sku-price missing"}>
                        {sku.priceCny ? `¥${sku.priceCny}` : "直接价格未取得"}
                      </span>
                      <small>{sku.stock === null || sku.stock === undefined ? "库存未取得" : `库存 ${sku.stock}`}</small>
                    </label>
                  );
                })}
              </div>
            </details>
            <button className="button primary" disabled={saving || !selectedSkuIds.length} onClick={() => run("select-sku")}>
              {saving ? "正在确认…" : `确认${selectedSkuIds.length ? ` ${selectedSkuIds.length} 个` : ""}供应SKU并进入B`}
            </button>
            <button className="button secondary" disabled={saving} onClick={() => run("capture")}>重新采集全部SKU</button>
            <small>所有采到的SKU都会显示；商品价、国内运费、实际采购成本、重量和尺寸未齐全时不得进入B。</small>
          </div>
        ) : null}
        {waiting ? <small>新流程将在A阶段确认供应SKU、B通过后自动进入C1；这条历史记录等待后续受控迁移。</small> : null}
        {is1688 && candidate.supplyConfirmation?.stage === "A" && !capturing && !choosingSku && (waiting || (stopped && !needsOwnerDecision)) ? (
          <div className="recovery-confirmation">
            <button className="button primary" disabled={saving} onClick={() => run("capture")}>
              {saving ? "正在连接Chrome…" : "打开1688并采集，然后开始上架准备"}
            </button>
            <small>只处理当前商品一次；选择SKU后才派发上架任务，失败立即停止。</small>
          </div>
        ) : null}
        {stopped && !is1688 ? (
          <div className="recovery-confirmation">
            <b>{handoff.recoveryDecision?.summary || "本次C阶段已停止"}</b>
            <div className="recovery-actions">
              {(handoff.recoveryDecision?.actions || []).map((action) => (
                <button
                  type="button"
                  className={`button ${action.id === "keep_stopped" ? "secondary" : "primary"}`}
                  disabled={saving}
                  onClick={() => run(action.id)}
                  key={action.id}
                >
                  {saving ? "正在处理…" : action.label}
                </button>
              ))}
            </div>
            <small>无需手写建议；再次真实失败仍立即停止，也不会触发店铺写入。</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReadyPanel({ candidate, rules, onMarkListed, onProductionAuthorization }) {
  const [showListedForm, setShowListedForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const emptyForm = () => ({
    platform: candidate.targetStore === "wb" ? "wb" : "ozon",
    productId: "",
    merchantSku: "",
    productUrl: "",
    moderationStatus: "",
    saleStatus: "",
    confirmedAt: ""
  });
  const [form, setForm] = useState(emptyForm);
  const preparation = candidate.listingPreparation || {};
  const productionDefaults = () => ({
    platform: candidate.targetStore === "wb" ? "WB" : "Ozon",
    store: STORE_LABELS[candidate.targetStore] || candidate.targetStore || "",
    product: candidate.productName || "",
    sku: preparation.exactSourceSku || candidate.sku || candidate.id,
    price: String(preparation.finalPrice || candidate.codexReview?.profitCalculation?.targetPriceRub || ""),
    stock: "100",
    assets: Array.isArray(preparation.assets) ? preparation.assets.join("\n") : "",
    publishScope: "创建商品、写入已确认字段与素材、提交审核，并完成独立回读",
    exclusions: "不得改动未列明的其他商品、SKU、价格、库存或素材",
    confirmed: false
  });
  const [production, setProduction] = useState(productionDefaults);
  const [productionSaving, setProductionSaving] = useState(false);
  const profit = candidate.codexReview?.profitCalculation;
  const wb = candidate.wbAssessment || { status: "notSuitable", reason: "尚无完整WB复算依据" };
  const wbView = wbPresentation(candidate);
  const wbCurrent = wbView.current;
  useEffect(() => {
    setShowListedForm(false);
    setForm(emptyForm());
    setProduction(productionDefaults());
  }, [candidate.id, candidate.dataRevision]);
  const preparationComplete = preparation.status === "prepared" && Boolean(candidate.cCompletedAt);
  if (!preparationComplete) {
    return (
      <section className="workflow-card listing-preparation-card">
        <div>
          <h3>历史待上架 · 需补做C阶段</h3>
          <p>这条旧记录没有当前精确货源SKU、佣金/物流、带电/IP/合规、Schema和素材的完整C阶段完成证据，不能直接开始上架。</p>
          <small>这是历史兼容记录。本阶段不迁移业务状态，也不恢复旧的人工启动C按钮。</small>
        </div>
      </section>
    );
  }
  return (
    <>
      <section className="workflow-card ready-card">
        <div>
          <h3>C阶段通过 · 可上架</h3>
          {profit?.status === "verified" ? (
            <p>单件利润 ¥{profit.unitProfitRmb} · 利润率 {(Number(profit.marginRate) * 100).toFixed(1)}% · 目标售价 {profit.targetPriceRub ? `${profit.targetPriceRub} RUB` : `¥${profit.targetPriceRmb || "?"}`}</p>
          ) : <p>旧利润结论已失效或尚未验证，不显示伪精确数值。</p>}
          <small className="handoff-owner">负责人：上架任务 · 当前尚未获得生产写入授权</small>
        </div>
        <span className={`wb-result wb-${wbView.kind}`} title={wbView.detail || wb.reason || ""}>{wbView.label}</span>
      </section>
      <WbMarketSummary candidate={candidate} presentation={wbView} />
      {wbCurrent && wb.status === "notSuitable" ? <WbNotSuitableDetails candidate={candidate} rules={rules} /> : null}
      <section className="listing-confirmation">
        <div className="automatic-listing-note">
          <strong>确认当前SKU的生产范围</strong>
          <span>确认后才会启动D阶段；库存统一100。完成写入后，上架任务必须执行E阶段独立回读。</span>
        </div>
        <form className="production-confirmation-form" onSubmit={async (event) => {
          event.preventDefault();
          setProductionSaving(true);
          try {
            await onProductionAuthorization({
              ...production,
              assets: production.assets.split("\n").map((item) => item.trim()).filter(Boolean)
            });
          } finally {
            setProductionSaving(false);
          }
        }}>
          <label>平台<input value={production.platform} readOnly /></label>
          <label>店铺<input value={production.store} readOnly /></label>
          <label className="span-2">商品<input value={production.product} onChange={(event) => setProduction((current) => ({ ...current, product: event.target.value }))} /></label>
          <label>精确SKU<input value={production.sku} onChange={(event) => setProduction((current) => ({ ...current, sku: event.target.value }))} /></label>
          <label>价格<input value={production.price} onChange={(event) => setProduction((current) => ({ ...current, price: event.target.value }))} /></label>
          <label>库存<input value="100" readOnly /></label>
          <label className="span-2">素材清单（每行一个）<textarea rows="4" value={production.assets} onChange={(event) => setProduction((current) => ({ ...current, assets: event.target.value }))} /></label>
          <label className="span-2">发布范围<textarea rows="2" value={production.publishScope} onChange={(event) => setProduction((current) => ({ ...current, publishScope: event.target.value }))} /></label>
          <label className="span-2">排除项<textarea rows="2" value={production.exclusions} onChange={(event) => setProduction((current) => ({ ...current, exclusions: event.target.value }))} /></label>
          <label className="production-check span-2"><input type="checkbox" checked={production.confirmed} onChange={(event) => setProduction((current) => ({ ...current, confirmed: event.target.checked }))} />我确认只按以上平台、店铺、SKU、价格、库存100、素材和发布范围执行</label>
          <button className="button primary span-2" disabled={productionSaving || !production.confirmed || !production.product.trim() || !production.sku.trim() || !production.price.trim() || !production.assets.trim() || !production.publishScope.trim()}>
            {productionSaving ? "正在启动…" : "确认并开始上架"}
          </button>
        </form>
        <hr />
        <button className="button secondary" onClick={() => setShowListedForm((value) => !value)}>无法自动回读？手动标记</button>
        <small>仅作兜底：确定上架任务无法取得当前回读时使用。</small>
        {showListedForm ? (
          <form onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            try {
              await onMarkListed({
                ...form,
                confirmedAt: form.confirmedAt ? new Date(form.confirmedAt).toISOString() : new Date().toISOString()
              });
            } finally {
              setSaving(false);
            }
          }}>
            <label>平台<select value={form.platform} onChange={(event) => setForm((current) => ({ ...current, platform: event.target.value }))}><option value="ozon">Ozon</option><option value="wb">WB</option></select></label>
            <label>店铺<input value={STORE_LABELS[candidate.targetStore] || candidate.targetStore} readOnly /></label>
            <label>商品ID<input value={form.productId} onChange={(event) => setForm((current) => ({ ...current, productId: event.target.value }))} placeholder="平台商品ID" /></label>
            <label>商家货号<input value={form.merchantSku} onChange={(event) => setForm((current) => ({ ...current, merchantSku: event.target.value }))} placeholder="offer_id / vendorCode" /></label>
            <label className="span-2">商品链接<input type="url" value={form.productUrl} onChange={(event) => setForm((current) => ({ ...current, productUrl: event.target.value }))} placeholder="商品ID和链接至少填一个" /></label>
            <label>审核状态<input value={form.moderationStatus} onChange={(event) => setForm((current) => ({ ...current, moderationStatus: event.target.value }))} placeholder="例如：审核通过" /></label>
            <label>销售状态<input value={form.saleStatus} onChange={(event) => setForm((current) => ({ ...current, saleStatus: event.target.value }))} placeholder="例如：可销售/无库存" /></label>
            <label className="span-2">确认时间<input type="datetime-local" value={form.confirmedAt} onChange={(event) => setForm((current) => ({ ...current, confirmedAt: event.target.value }))} /></label>
            <button className="button primary span-2" disabled={saving || (!form.productId.trim() && !form.productUrl.trim())}>{saving ? "保存中…" : "确认并移入已上架"}</button>
          </form>
        ) : null}
      </section>
    </>
  );
}

function ListedPanel({ candidate, onCapture, onSelectSku }) {
  const record = candidate.listingRecord || {};
  const sourceCapture = candidate.sourceCapture || {};
  const automatic = record.method === "automatic_readback";
  const listedRecoveryAllowed = record.stateOnly === true &&
    candidate.listingPreparation?.status === "queued" &&
    /^https:\/\/detail\.1688\.com\/offer\/\d+\.html(?:[?#]|$)/i.test(candidate.sourceUrl || "") &&
    sourceCapture.status !== "verified";
  const suggestedSkuKey = Array.isArray(sourceCapture.suggestedSkuIds) ? sourceCapture.suggestedSkuIds.join("|") : "";
  const [selectedSkuIds, setSelectedSkuIds] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelectedSkuIds(suggestedSkuKey ? suggestedSkuKey.split("|") : []);
    setSaving(false);
  }, [candidate.id, candidate.dataRevision, suggestedSkuKey]);

  function toggleSku(sourceSkuId) {
    setSelectedSkuIds((current) => current.includes(sourceSkuId)
      ? current.filter((id) => id !== sourceSkuId)
      : [...current, sourceSkuId]);
  }

  async function captureOnce() {
    setSaving(true);
    try {
      await onCapture("", "listed_evidence_recovery");
    } finally {
      setSaving(false);
    }
  }

  async function saveSelection() {
    setSaving(true);
    try {
      await onSelectSku(selectedSkuIds);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow-card listed-card">
      <div>
        <div className="listed-heading">
          <h3>已上架</h3>
          <span>{automatic ? "上架任务自动回读" : "手动兜底记录"}</span>
        </div>
        <dl className="listed-record-grid">
          <div><dt>平台 / 店铺</dt><dd>{String(record.platform || "").toUpperCase()} · {STORE_LABELS[record.store] || record.store || "未记录"}</dd></div>
          <div><dt>商品ID</dt><dd>{record.productId || "未记录"}</dd></div>
          <div><dt>商家货号</dt><dd>{record.merchantSku || "未记录"}</dd></div>
          <div><dt>确认时间</dt><dd>{record.confirmedAt ? new Date(record.confirmedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未记录"}</dd></div>
          <div><dt>审核状态</dt><dd>{record.moderationStatus || "未记录"}</dd></div>
          <div><dt>销售状态</dt><dd>{record.saleStatus || "未记录"}</dd></div>
          {record.eVerificationOutcome ? <div><dt>E阶段结果</dt><dd>{record.eVerificationOutcome === "externally_verified" ? "外部发现并验证" : "系统创建并验证"}</dd></div> : null}
          {record.eVerificationOutcome ? <div><dt>是否本轮创建</dt><dd>{record.createdByCurrentRun ? "是" : "否"}</dd></div> : null}
          {record.currentPrice ? <div><dt>当前价格</dt><dd>{record.currentPrice.amount} {record.currentPrice.currency}</dd></div> : null}
          {record.currentStock !== undefined ? <div><dt>当前库存</dt><dd>{record.currentStock === "unknown" ? "未验证" : record.currentStock}</dd></div> : null}
          {record.imageCount !== undefined ? <div><dt>图片数量</dt><dd>{record.imageCount === "unknown" ? "未验证" : record.imageCount}</dd></div> : null}
          {record.validationStatus ? <div><dt>校验状态</dt><dd>{record.validationStatus}</dd></div> : null}
          {record.errors !== undefined ? <div><dt>单品错误</dt><dd>{record.errors === "unknown" ? "未验证" : `${record.errors.length}条`}</dd></div> : null}
        </dl>
        {record.ownerPriceDecision?.decision === "keep_current_live_price" ? (
          <p className="readback-evidence">主人最终价格决定：保留 {record.ownerPriceDecision.price.amount} {record.ownerPriceDecision.price.currency}</p>
        ) : null}
        {automatic && record.readback?.checkedAt ? <p className="readback-evidence">最近回读：{new Date(record.readback.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {record.readback.evidenceRef}</p> : null}
        {record.productUrl ? <a href={record.productUrl} target="_blank" rel="noreferrer">打开已上架商品</a> : null}
        {sourceCapture.status === "waiting_extension" && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-capture-summary">
            <b>正在补采1688只读证据</b>
            <span>Chrome只处理当前商品一次；原“已上架”记录保持不变。</span>
          </div>
        ) : null}
        {sourceCapture.status === "needs_sku_selection" && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-sku-selector">
            <div className="source-sku-selector-heading">
              <b>选择DD-H1对应的1688规格</b>
              <span>已选 {selectedSkuIds.length}/{(sourceCapture.skuChoices || []).length}</span>
            </div>
            <div className="source-sku-options">
              {(sourceCapture.skuChoices || []).map((sku) => {
                const attributes = Object.entries(sku.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
                return (
                  <label className={`source-sku-option ${selectedSkuIds.includes(sku.sourceSkuId) ? "selected" : ""}`} key={sku.sourceSkuId}>
                    <input type="checkbox" checked={selectedSkuIds.includes(sku.sourceSkuId)} onChange={() => toggleSku(sku.sourceSkuId)} />
                    <span className="source-sku-option-main">
                      <b>{attributes || sku.propPath || `SKU ${sku.sourceSkuId}`}</b>
                      <small>SKU ID：{sku.sourceSkuId}</small>
                    </span>
                    <span className={sku.priceCny ? "source-sku-price" : "source-sku-price missing"}>{sku.priceCny ? `¥${sku.priceCny}` : "直接价格未取得"}</span>
                    <small>{sku.stock === null || sku.stock === undefined ? "库存未取得" : `库存 ${sku.stock}`}</small>
                  </label>
                );
              })}
            </div>
            <button className="button primary" disabled={saving || !selectedSkuIds.length} onClick={saveSelection}>
              {saving ? "正在保存…" : "确认规格并保存证据"}
            </button>
            <small>只保存1688证据，不退回选品、不自动派发，也不修改Ozon。</small>
          </div>
        ) : null}
        {sourceCapture.status === "verified" && sourceCapture.mode === "listed_evidence_recovery" ? (
          <div className="source-capture-summary">
            <b>1688精确证据已补齐</b>
            {(sourceCapture.selectedSkus || []).map((sku) => (
              <span key={sku.sourceSkuId}>SKU {sku.sourceSkuId} · {Object.values(sku.attributes || {}).join(" · ") || sku.propPath || "规格已锁定"}</span>
            ))}
          </div>
        ) : null}
        {listedRecoveryAllowed && !["waiting_extension", "needs_sku_selection"].includes(sourceCapture.status) ? (
          <div className="recovery-confirmation">
            {sourceCapture.status === "failed" ? <b>{sourceCapture.reason || "上次采集已停止"}</b> : null}
            <button className="button primary" disabled={saving} onClick={captureOnce}>
              {saving ? "正在连接Chrome…" : "重新采集1688证据（一次）"}
            </button>
            <small>仅补当前商品的精确SKU和页面事实；原已上架记录保持不变。</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EliminatedPanel({ candidate, onComment }) {
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveFeedback(event) {
    event.preventDefault();
    if (!feedback.trim()) return;
    setSaving(true);
    try {
      await onComment(feedback, false, "elimination_feedback");
      setFeedback("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow-card eliminated-card">
      <div><h3>已淘汰</h3><p>{candidate.eliminationReason || "该商品不符合当前选品门槛"}</p></div>
      {candidate.codexReview?.profitCalculation?.status === "scenario" ? (
        <div className="conditional-profit">
          <strong>已按你填写的采购到手总价先算</strong>
          <span>参考卖家收入 ¥{candidate.codexReview.profitCalculation.targetPriceRmb} · 单件利润 ¥{candidate.codexReview.profitCalculation.unitProfitRmb} · 利润率 {(Number(candidate.codexReview.profitCalculation.marginRate) * 100).toFixed(1)}%</span>
          <small>{candidate.codexReview.profitCalculation.stressScenario}</small>
        </div>
      ) : null}
      <form className="elimination-feedback" onSubmit={saveFeedback}>
        <label>
          告诉Codex为什么不想做
          <textarea
            rows="2"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="例如：售价太低、体积太大、风格不适合蛋蛋鼠"
          />
        </label>
        <button className="button secondary" disabled={!feedback.trim() || saving}>
          {saving ? "保存中…" : "保存淘汰原因"}
        </button>
        <small>仅记录为后续选品避坑条件，不会把商品重新送审。</small>
      </form>
    </section>
  );
}

function Activity({ candidate, onComment }) {
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const entries = useMemo(() => [
    ...(candidate.comments || []).map((item) => ({ ...item, kind: "comment", message: item.message })),
    ...(candidate.history || []).map((item) => ({ ...item, message: item.detail }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-16), [candidate.comments, candidate.history]);

  async function send() {
    if (!comment.trim()) return;
    setSaving(true);
    try {
      await onComment(comment, false);
      setComment("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="activity-disclosure">
      <summary>双方记录与留言 <small>{entries.length}条</small></summary>
      <div className="timeline">
        {entries.map((entry) => (
          <div className={`timeline-item actor-${entry.actor}`} key={entry.id}>
            <span>{entry.actor === "codex" ? "C" : entry.actor === "user" ? "我" : "系"}</span>
            <p>
              {entry.message}
              {entry.kind === "comment" &&
              (entry.requiresResponse === true || entry.status === "responded") ? (
                <small className={`comment-state ${entry.status === "responded" ? "responded" : "pending"}`}>
                  {entry.status === "responded" ? "已回复" : "待Codex回复"}
                </small>
              ) : null}
            </p>
            <time>{new Date(entry.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        ))}
      </div>
      <div className="comment-box">
        <MessageIcon />
        <textarea rows="2" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="补充说明给Codex" />
        <div className="comment-actions">
          <button className="button secondary" onClick={send} disabled={!comment.trim() || saving}>{saving ? "保存中…" : "仅留言"}</button>
          <small>普通留言不会启动任务；真实失败或业务决定请使用状态卡里的固定选项。</small>
        </div>
      </div>
    </details>
  );
}

function OzonSalesCapturePanel({ candidate, onStart }) {
  const capture = candidate.salesCapture || {};
  const canShow = /^https:\/\/(?:www\.)?ozon\.ru\/product\//i.test(candidate.productUrl || "") &&
    ["awaiting_user_direction", "codex_processing", "needs_user_data"].includes(candidate.workflowStatus) &&
    !candidate.lifecycleV11?.skuPackage;
  const [saving, setSaving] = useState(false);
  if (!canShow) return null;

  async function start() {
    setSaving(true);
    try {
      await onStart();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow-card">
      <div>
        <h3>销售端快照</h3>
        <p>由本机Chrome读取当前Ozon商品的结构化标题、价格、图片、属性和卖家身份证据。只保存证据，不推进业务阶段。</p>
        {capture.status === "waiting_extension" ? (
          <div className="source-capture-summary">
            <b>Ozon只读采集中</b>
            <span>仅处理当前商品一次；失败后立即停止，不自动重试。</span>
          </div>
        ) : null}
        {capture.status === "verified" ? (
          <div className="source-capture-summary">
            <b>当前Ozon快照已保存</b>
            <span>{capture.currentPrice} {capture.currency} · 图片 {capture.imageCount} 张 · 卖家身份 {capture.sellerType === "unknown" ? "未验证" : capture.sellerType}</span>
            <span>商品ID {capture.productId} · {capture.observedAt ? new Date(capture.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</span>
          </div>
        ) : null}
        {capture.status === "failed" ? (
          <div className="source-capture-summary capture-failed">
            <b>Ozon采集已停止</b>
            <span>{capture.reason || "未取得结构化销售快照"}</span>
            <span>技术状态：{capture.technicalStatus || "未验证"}；商品业务状态未改变。</span>
          </div>
        ) : null}
        {capture.status !== "waiting_extension" ? (
          <button className="button primary" disabled={saving} onClick={start}>
            {saving ? "正在连接Chrome…" : capture.status === "failed" ? "按当前页面重试一次" : "用Chrome采集当前Ozon快照（一次）"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function UserInspector({ candidate, rules, onUpdate, onEvaluate, onComment, onMarkListed, onRecoveryAction, onStartSourceCapture, onStartOzonSalesCapture, onSelectSourceCaptureSku, onProductionAuthorization, onLifecycleProductionAuthorization }) {
  return (
    <section className="workflow-region">
      <OzonSalesCapturePanel candidate={candidate} onStart={onStartOzonSalesCapture} />
      {candidate.workflowStatus === "awaiting_user_direction" ? <DirectionPanel candidate={candidate} onEvaluate={onEvaluate} /> : null}
      {candidate.workflowStatus === "codex_processing" ? <ProcessingPanel candidate={candidate} onRecoveryAction={onRecoveryAction} /> : null}
      {candidate.workflowStatus === "listing_preparation" ? (
        <ListingPreparationPanel candidate={candidate} onRecoveryAction={onRecoveryAction} onCapture={onStartSourceCapture} onSelectSku={onSelectSourceCaptureSku} onLifecycleProductionAuthorization={onLifecycleProductionAuthorization} />
      ) : null}
      {candidate.workflowStatus === "needs_user_data" ? <NeedsDataPanel candidate={candidate} onUpdate={onUpdate} /> : null}
      {candidate.workflowStatus === "ready_to_list" ? <ReadyPanel candidate={candidate} rules={rules} onMarkListed={onMarkListed} onProductionAuthorization={onProductionAuthorization} /> : null}
      {candidate.workflowStatus === "listed" ? <ListedPanel candidate={candidate} onCapture={onStartSourceCapture} onSelectSku={onSelectSourceCaptureSku} /> : null}
      {candidate.workflowStatus === "eliminated" ? <EliminatedPanel candidate={candidate} onComment={onComment} /> : null}
      <Activity candidate={candidate} onComment={onComment} />
    </section>
  );
}
