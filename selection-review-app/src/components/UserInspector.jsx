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
    const commission = Number(ceiling.commissionRate);
    const freight = Number(ceiling.internationalLogisticsRmb);
    const promotionPricing = Array.isArray(ceiling.promotionPricing)
      ? ceiling.promotionPricing
      : [];
    return (
      <aside className={`purchase-ceiling ${estimated ? "estimated" : "verified"}`} aria-label="含国内邮费采购价区间">
        <span>{estimated ? "含国内邮费建议采购区间" : "含国内邮费采购区间"}</span>
        <strong>{maximum >= 0 ? `¥0–¥${maximum.toFixed(2)}` : "没有可行采购价"}</strong>
        <small>
          {Number.isFinite(referencePrice) ? `Ozon参考售价 ¥${referencePrice.toFixed(2)} · ` : ""}
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

function ProcessingPanel({ candidate, onResume, onDispatch }) {
  const review = candidate.codexReview;
  const profit = review?.profitCalculation;
  const status = candidate.processingStatus || { key: "idle", label: "空闲" };
  const dispatch = candidate.activeDispatch;
  const recoveryOptions = Array.isArray(status.recoveryOptions) ? status.recoveryOptions : [];
  const [recoveryPath, setRecoveryPath] = useState(recoveryOptions[0] || "");
  const [savingRecovery, setSavingRecovery] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const running = status.actualRunning === true && status.key === "running";
  const attempts = Number(candidate.processing?.attempts || 0);
  const error = ["blocked", "stalled", "state_anomaly"].includes(status.key)
    ? String(status.reason || candidate.processing?.lastError || "")
    : "";
  let currentStep = status.currentStep || "当前没有实际任务在运行";
  if (dispatch?.status === "running") currentStep = dispatch.currentStep || currentStep;
  else if (["received", "permission_required"].includes(dispatch?.status)) currentStep = "负责人任务已接收，等待登记真实执行步骤";
  else if (["queued", "waiting_assignee", "delivering"].includes(dispatch?.status)) currentStep = "已派发一次，等待负责人空闲并领取";
  if (status.key === "blocked") currentStep = "系统动作已停止，等待总控确认恢复方式";
  else if (status.key === "queued" && !dispatch) currentStep = "恢复方式已确认，但尚未创建真实派发";
  else if (status.key === "idle" || status.key === "state_anomaly") currentStep = "当前没有实际任务在运行";
  const statusTitle = dispatch?.status === "running"
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
          ? "需要总控确认 · 已停止重试"
          : status.key === "state_anomaly"
            ? "状态异常 · 当前无人运行"
            : status.key === "stalled"
              ? "运行超时 · 无法确认仍在运行"
              : "无人运行 · 等待明确指令";
  const listingPaused = ["paused_user_stopped", "blocked"].includes(candidate.listingHandoff?.state);
  const canDirectDispatch = !dispatch && (
    (candidate.workflowStatus === "codex_processing" && status.key === "queued" && candidate.processing?.manualHold !== true) ||
    (candidate.workflowStatus === "ready_to_list" && !listingPaused)
  );
  const directAssignee = candidate.workflowStatus === "ready_to_list" ? "上架任务" : "选品任务";

  useEffect(() => {
    setRecoveryPath(recoveryOptions[0] || "");
    setSavingRecovery(false);
  }, [candidate.id, candidate.dataRevision]);

  async function confirmRecovery(event) {
    event.preventDefault();
    if (!recoveryPath.trim()) return;
    setSavingRecovery(true);
    try {
      await onResume(recoveryPath.trim());
    } finally {
      setSavingRecovery(false);
    }
  }

  async function dispatchCurrent() {
    setDispatching(true);
    try {
      await onDispatch();
    } finally {
      setDispatching(false);
    }
  }

  return (
    <>
      <section className="workflow-card processing-card">
        <span className={`processing-mark ${running ? "running" : ""}`} aria-hidden="true" />
        <div>
          <h3>{statusTitle}</h3>
          <p>{currentStep}</p>
          {candidate.activeDispatch?.id && status.estimatedStart ? <small className="processing-attempts">派发状态：{status.estimatedStart}</small> : null}
          {status.dispatchRequestedAt ? <small className="processing-attempts">用户操作触发：{new Date(status.dispatchRequestedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {dispatch ? <small className="processing-attempts">一次性派发：{dispatch.id} · 负责人：{dispatch.assigneeTitle || dispatch.assigneeRole}</small> : null}
          {dispatch?.deliveryDetail ? <small className="processing-attempts">派发状态：{dispatch.deliveryDetail}</small> : null}
          {dispatch?.error ? <small className="processing-error">派发失败层：{dispatch.failureLayer || "未知"} · {dispatch.error}</small> : null}
          {status.lastAttemptAt ? <small className="processing-attempts">最近尝试：{new Date(status.lastAttemptAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {status.lastProgressAt ? <small className="processing-attempts">最近实质进展：{new Date(status.lastProgressAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}
          {attempts ? <small className="processing-attempts">累计历史尝试 {attempts} 次；新规则下同轮同层同目标只允许一次。</small> : null}
          {error ? <small className="processing-error">卡点：{error}</small> : null}
          {status.userAction ? <small className="processing-error">下一步：{status.userAction}</small> : null}
          {status.key === "blocked" && status.recoveryOptions?.length ? <small className="processing-error">可选恢复：{status.recoveryOptions.join("；")}</small> : null}
          {status.key === "blocked" && candidate.processing?.manualHold === true ? (
            <form className="recovery-confirmation" onSubmit={confirmRecovery}>
              <label htmlFor={`recovery-${candidate.id}`}>选择本次恢复方式</label>
              {recoveryOptions.length ? (
                <select
                  id={`recovery-${candidate.id}`}
                  value={recoveryPath}
                  onChange={(event) => setRecoveryPath(event.target.value)}
                >
                  {recoveryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input
                  id={`recovery-${candidate.id}`}
                  value={recoveryPath}
                  onChange={(event) => setRecoveryPath(event.target.value)}
                  placeholder="写明这一次采用的唯一恢复路径"
                />
              )}
              <button className="button primary" disabled={savingRecovery || !recoveryPath.trim()}>
                {savingRecovery ? "确认并派发中…" : "确认并派发当前SKU一次"}
              </button>
              <small>只派发当前SKU一次；不会开启连续自动化，也不会执行未经精确确认的店铺写入。</small>
            </form>
          ) : null}
          {canDirectDispatch ? (
            <div className="direct-dispatch">
              <button className="button primary" disabled={dispatching} onClick={dispatchCurrent}>
                {dispatching ? "正在派发…" : `派发当前SKU给${directAssignee}`}
              </button>
              <small>只派发当前商品这一次；不会领取下一条，也不会开启连续自动化。</small>
            </div>
          ) : null}
        </div>
      </section>
      <section className="result-preview" aria-label="审核结果预览">
        <div><span>利润</span><strong>{profit?.status === "verified" ? `¥${profit.unitProfitRmb} / ${(profit.marginRate * 100).toFixed(1)}%` : "未验证"}</strong></div>
        <div><span>市场证据</span><strong>{review?.marketEvidence?.comparableCount || 0}/5</strong></div>
        <div><span>你要做什么</span><strong>{status.userAction || (dispatch ? "已派发，等待负责人处理" : canDirectDispatch ? `点击上方按钮派发给${directAssignee}` : "当前状态没有要求你操作")}</strong></div>
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
    targetMarginRate: 0.15
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
        <p className="wb-threshold">通过门槛：单件利润≥{rule.minimumUnitProfitRmb} RMB，或利润率≥{Math.round(rule.targetMarginRate * 100)}%，满足任一项即可。</p>
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

function ReadyPanel({ candidate, rules, onMarkListed }) {
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
  const profit = candidate.codexReview?.profitCalculation;
  const wb = candidate.wbAssessment || { status: "notSuitable", reason: "尚无完整WB复算依据" };
  const wbView = wbPresentation(candidate);
  const wbCurrent = wbView.current;
  const listingPaused = candidate.listingHandoff?.state === "paused_user_stopped";
  useEffect(() => {
    setShowListedForm(false);
    setForm(emptyForm());
  }, [candidate.id, candidate.dataRevision]);
  return (
    <>
      <section className="workflow-card ready-card">
        <div>
          <h3>已通过，进入待上架</h3>
          {profit?.status === "verified" ? (
            <p>单件利润 ¥{profit.unitProfitRmb} · 利润率 {(Number(profit.marginRate) * 100).toFixed(1)}% · 目标售价 {profit.targetPriceRub ? `${profit.targetPriceRub} RUB` : `¥${profit.targetPriceRmb || "?"}`}</p>
          ) : <p>旧利润结论已失效或尚未验证，不显示伪精确数值。</p>}
          <small className="handoff-owner">
            负责人：上架任务 · {listingPaused ? "用户已停止，等待最终图片组" : candidate.listingHandoff?.state === "handed_off" ? "已交接" : "已进入交接队列"}
          </small>
        </div>
        <span className={`wb-result wb-${wbView.kind}`} title={wbView.detail || wb.reason || ""}>{wbView.label}</span>
      </section>
      <WbMarketSummary candidate={candidate} presentation={wbView} />
      {wbCurrent && wb.status === "notSuitable" ? <WbNotSuitableDetails candidate={candidate} rules={rules} /> : null}
      <section className="listing-confirmation">
        <div className="automatic-listing-note">
          <strong>正常流程：上架任务回读后自动移入“已上架”</strong>
          <span>系统会保存平台、店铺、商品ID、商家货号、审核与销售状态；不会根据聊天记录推断。</span>
        </div>
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

function ListedPanel({ candidate }) {
  const record = candidate.listingRecord || {};
  const automatic = record.method === "automatic_readback";
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
        </dl>
        {automatic && record.readback?.checkedAt ? <p className="readback-evidence">最近回读：{new Date(record.readback.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {record.readback.evidenceRef}</p> : null}
        {record.productUrl ? <a href={record.productUrl} target="_blank" rel="noreferrer">打开已上架商品</a> : null}
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

  async function send(requestReview) {
    if (!comment.trim()) return;
    setSaving(true);
    try {
      await onComment(comment, requestReview);
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
          <button className="button secondary" onClick={() => send(false)} disabled={!comment.trim() || saving}>仅记录</button>
          {!['ready_to_list', 'listed'].includes(candidate.workflowStatus) ? <button className="button primary" onClick={() => send(true)} disabled={!comment.trim() || saving}>{saving ? "发送中…" : "发送并交给Codex"}</button> : null}
        </div>
      </div>
    </details>
  );
}

export default function UserInspector({ candidate, rules, onUpdate, onEvaluate, onComment, onMarkListed, onResume, onDispatch }) {
  return (
    <section className="workflow-region">
      {candidate.workflowStatus === "awaiting_user_direction" ? <DirectionPanel candidate={candidate} onEvaluate={onEvaluate} /> : null}
      {["codex_processing", "ready_to_list"].includes(candidate.workflowStatus) ? (
        <ProcessingPanel candidate={candidate} onResume={onResume} onDispatch={onDispatch} />
      ) : null}
      {candidate.workflowStatus === "needs_user_data" ? <NeedsDataPanel candidate={candidate} onUpdate={onUpdate} /> : null}
      {candidate.workflowStatus === "ready_to_list" ? <ReadyPanel candidate={candidate} rules={rules} onMarkListed={onMarkListed} /> : null}
      {candidate.workflowStatus === "listed" ? <ListedPanel candidate={candidate} /> : null}
      {candidate.workflowStatus === "eliminated" ? <EliminatedPanel candidate={candidate} onComment={onComment} /> : null}
      <Activity candidate={candidate} onComment={onComment} />
    </section>
  );
}
