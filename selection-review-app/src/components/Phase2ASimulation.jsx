import { useEffect, useState } from "react";
import { api } from "../api.js";

const SELLER_LABELS = {
  cross_border_cn: "中国跨境卖家",
  other_cross_border: "其他跨境卖家",
  unknown: "卖家身份未确认",
  local_ru: "俄罗斯本土卖家（仅背景）"
};

const OWNER_LABELS = {
  owner: "主人",
  selection_task: "选品任务",
  listing_task: "上架任务",
  none: "无"
};

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function Field({ label, children, className = "" }) {
  return <label className={className}><span>{label}</span>{children}</label>;
}

export default function Phase2ASimulation({ onClose }) {
  const [card, setCard] = useState(null);
  const [form, setForm] = useState(null);
  const [result, setResult] = useState(null);
  const [profitSummary, setProfitSummary] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.getPhase2ASimulation()
      .then(({ card: next }) => {
        if (!active) return;
        setCard(next);
        setForm(structuredClone(next.supplierConfirmation));
      })
      .catch((requestError) => active && setError(requestError.message));
    return () => { active = false; };
  }, []);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDimension(field, value) {
    setForm((current) => ({
      ...current,
      dimensionsCm: { ...current.dimensionsCm, [field]: value }
    }));
  }

  async function submit(decision) {
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      const response = await api.confirmPhase2ASimulation({
        decision,
        supplierConfirmation: form
      });
      setResult(response.result);
      setProfitSummary(response.profitSummary);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  if (!card || !form) return <main className="phase2a-page"><p>正在准备第2A模拟卡…</p></main>;
  const missing = result?.missing || [];
  const handoff = result?.c1Handoff || null;

  return (
    <main className="phase2a-page" data-testid="phase2a-simulation">
      <header className="phase2a-header">
        <div>
          <b>第2A整体收口验收</b>
          <h2>{card.productName}</h2>
          <p>模拟SKU，不在真实52条候选中；不派发任务、不访问平台、不写店。</p>
        </div>
        <button className="button secondary" onClick={onClose}>返回今日选品评审</button>
      </header>

      <section className="phase2a-proof-banner">
        <span>模拟编号 {card.simulationId}</span>
        <span>共享候选影响 {card.sharedCandidatesAffected}</span>
        <span>当前负责人 {OWNER_LABELS[result?.uniqueOwner || card.initialStatus.uniqueOwner]}</span>
      </section>

      <section className="phase2a-card">
        <div className="phase2a-card-heading">
          <div>
            <small>A阶段完整确认卡 · 一张卡一次提交</small>
            <h3>方向、供应链接、SKU与成本包装资料</h3>
          </div>
          <span className="simulation-pill">模拟数据</span>
        </div>

        <div className="phase2a-sales-snapshot">
          <b>A销售快照</b>
          <span>版本：{card.salesSnapshot.schemaVersion} / {card.salesSnapshot.sourceVersion}</span>
          <span>来源：{card.salesSnapshot.source} · 有效至 {new Date(card.salesSnapshot.validUntil).toLocaleString("zh-CN")}</span>
          <span>卖家：{SELLER_LABELS[card.salesSnapshot.sellerType]} · 身份证据未确认 · 商品可比 · 可信度有限</span>
          <span>当前价：{card.salesSnapshot.currentPriceRub} RUB · 证据：{card.salesSnapshot.evidenceRef}</span>
        </div>

        <div className="phase2a-form-grid">
          <Field label="准确1688供应链接" className="span-2"><input value={form.productUrl} onChange={(event) => update("productUrl", event.target.value)} /></Field>
          <Field label="具体供应SKU"><input value={form.supplierSkuId} onChange={(event) => update("supplierSkuId", event.target.value)} /></Field>
          <Field label="规格/变体"><input value={form.variantKey} onChange={(event) => update("variantKey", event.target.value)} /></Field>
          <Field label="商品价（元/件）"><input type="number" step="0.01" value={form.unitProductPrice} onChange={(event) => update("unitProductPrice", event.target.value)} /></Field>
          <Field label="国内运费（元/件）"><input type="number" step="0.01" value={form.unitDomesticFreight} onChange={(event) => update("unitDomesticFreight", event.target.value)} /></Field>
          <Field label="实际采购成本（元/件）"><input type="number" step="0.01" value={form.actualPurchaseCost} onChange={(event) => update("actualPurchaseCost", event.target.value)} /></Field>
          <Field label="重量（kg）"><input type="number" step="0.01" value={form.weightKg} onChange={(event) => update("weightKg", event.target.value)} /></Field>
          <Field label="长（cm）"><input type="number" step="0.1" value={form.dimensionsCm.length} onChange={(event) => updateDimension("length", event.target.value)} /></Field>
          <Field label="宽（cm）"><input type="number" step="0.1" value={form.dimensionsCm.width} onChange={(event) => updateDimension("width", event.target.value)} /></Field>
          <Field label="高（cm）"><input type="number" step="0.1" value={form.dimensionsCm.height} onChange={(event) => updateDimension("height", event.target.value)} /></Field>
        </div>

        {missing.length ? <div className="phase2a-missing" role="alert">缺少或不一致：{missing.map((item) => item.label).join("、")}。B尚未启动。</div> : null}
        {error ? <div className="phase2a-missing" role="alert">{error}</div> : null}

        <div className="phase2a-actions">
          <button className="button secondary" disabled={saving} onClick={() => submit("reject")}>淘汰商品</button>
          <button className="button primary" data-testid="phase2a-confirm" disabled={saving} onClick={() => submit("confirm")}>
            {saving ? "正在模拟…" : card.actionLabel}
          </button>
        </div>
      </section>

      {result ? (
        <section className="phase2a-result" data-testid="phase2a-result">
          <div className="phase2a-status-grid">
            <span><small>业务阶段</small><b>{result.statusLines.businessPhase}</b></span>
            <span><small>业务结果</small><b>{result.statusLines.businessResult}</b></span>
            <span><small>技术状态</small><b>{result.statusLines.technicalStatus}</b></span>
            <span><small>主人操作</small><b>{result.statusLines.ownerAction}</b></span>
          </div>
          {profitSummary ? (
            <>
              <div className="phase2a-profit-grid">
                <span><small>B利润版本</small><b>{result.bExecution.profitModel.profitModelVersion}</b></span>
                <span><small>建议成交价</small><b>{profitSummary.recommendedSalePriceRub} RUB / ¥{profitSummary.recommendedSalePriceCny}</b></span>
                <span><small>卖家结算收入</small><b>¥{profitSummary.settlementRevenueCny}</b></span>
                <span><small>采购/物流/其他</small><b>¥{profitSummary.actualPurchaseCostCny} / ¥{profitSummary.internationalFreightCny} / ¥{profitSummary.otherCostsCny}</b></span>
                <span><small>单件利润</small><b>¥{profitSummary.unitProfitRmb}</b></span>
                <span><small>利润率</small><b>{percent(profitSummary.profitMargin)}</b></span>
              </div>
              <div className="phase2a-list-prices">
                {profitSummary.suggestedListPricesRub.map((scenario) => <span key={scenario.discountRate}>促销{scenario.discountRate * 100}%：建议标价 {scenario.suggestedListPriceRub} RUB</span>)}
              </div>
              <p className="phase2a-formula">{profitSummary.formula}；算式回读利润 ¥{profitSummary.formulaCheck}。</p>
              <div className="phase2a-zero-access">B自动开始 · Ozon 0次 · WB 0次 · 1688 0次 · 拼多多 0次 · 未重新询问已有字段</div>
            </>
          ) : null}
          {handoff ? (
            <div className="phase2a-handoff">
              <b>B通过，已自动进入C1</b>
              <span>交接编号：{handoff.handoffId}</span>
              <span>运行责任：A/B软件 → C1软件；Codex选品/上架任务均未被正常流程唤醒</span>
              <span>继承：{handoff.parentOpportunityId} / {handoff.skuPackageId} / 修订 {handoff.inheritedOpportunityRevision}:{handoff.inheritedSkuRevision}</span>
              <span>同一交接重复调用只返回原记录；真实任务派发 {result.realTaskDispatches} 次。</span>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
