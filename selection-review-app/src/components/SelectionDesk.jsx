import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../formState.js";
import { DECLINE_REASONS, FEED_SORTS, boardColumns, feedRows, inboxItems, pointsLine } from "../selectionDeskView.js";

const fact = value => (value === null || value === undefined || value === "unknown" ? "未知" : value);
const money = value => (typeof value === "number" && Number.isFinite(value) ? `¥${value.toFixed(2)}` : null);
const percent = value => (typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : null);

function ProfitBox({ row }) {
  const { estimate } = row;
  if (estimate === null) return <p className="desk-profit-empty">点「算利润区间」后显示</p>;
  const ceiling = money(estimate.maximumAllInPurchaseRmb);
  const freight = estimate.freight ?? {};
  const share = percent(row.freightShare);
  const freightText = freight.route === null || freight.route === undefined ? "待补尺寸重量"
    : [`${freight.route} · 计费 ${freight.chargeableKg}kg`, money(freight.freightRmb),
      freight.oversize === true ? "超抛" : null, share === null ? null : `占比 ${share}`].filter(Boolean).join(" · ");
  return <div className="desk-profit">
    <div><b>建议采购区间</b><span>{ceiling === null ? "待补数据" : `到手总价 ≤ ${ceiling}`}</span></div>
    <div><b>按区间中值</b><span>{estimate.outcome === "excluded_negative" ? "预估负利润，不建议做"
      : estimate.outcome === "needs_data" ? "资料不全，暂不能判断"
      : money(estimate.unitProfitAtMidRmb) === null ? "刚好达到本店利润门槛"
      : `单件利润 ${money(estimate.unitProfitAtMidRmb)} · 利润率 ${percent(estimate.marginAtMid) ?? "—"}`}</span></div>
    <div><b>运费</b><span>{freightText}</span></div>
    <div><b>佣金</b><span>{percent(estimate.commissionRate) ?? "未取得"}</span></div>
  </div>;
}

function FeedCard({ row, active, saving, declining, onDeclining, onSelect, onDecline, onLater, onOpenCandidate }) {
  return <article className={`desk-card${active ? " desk-card-active" : ""}`}>
    {row.imageUrl
      ? <img className="desk-thumb" src={row.imageUrl} alt="" width="132" height="132" loading="lazy" referrerPolicy="no-referrer" />
      : <span className="desk-thumb desk-thumb-empty">主图</span>}
    <div className="desk-card-body">
      <p className="desk-card-title">{row.productUrl
        ? <a href={row.productUrl} target="_blank" rel="noreferrer">{row.titleZh ?? row.title}</a>
        : row.titleZh ?? row.title}</p>
      {row.titleZh === null ? null : <p className="desk-card-original">{row.title}</p>}
      <p className="desk-card-facts">售价 {fact(row.price)} 卢布{money(row.estimate?.revenueCny) === null ? "" : ` ≈ ${money(row.estimate.revenueCny)}`} · 月销 {fact(row.salesCount)} · 评价 {fact(row.reviewCount)} · 评分 {fact(row.reviewRating)}</p>
      <p className="desk-card-category">类目：{row.categoryZh ?? "未知"}</p>
      <ProfitBox row={row} />
      {row.chips.length ? <p className="desk-chips">{row.chips.map(chip => <span key={chip} className="desk-chip">{chip}</span>)}</p> : null}
      {row.failureClass ? <p role="alert">保存失败：{row.failureClass}</p> : null}
      {row.duplicate ? <p className="desk-card-note">这件商品记录里已经有了，没有重复建卡。</p> : null}
      <div className="desk-actions">
        {row.importedCandidateId !== null
          ? <><span>已在评审台</span><button type="button" className="button secondary" onClick={() => onOpenCandidate(row.importedCandidateId)}>查看</button></>
          : <>
            <button type="button" className="button primary" disabled={saving || row.duplicate} onClick={() => onSelect(row)}>要</button>
            <details className="desk-decline" open={declining} onToggle={event => onDeclining(event.currentTarget.open ? row.key : null)}>
              <summary>不要</summary>
              <div className="desk-decline-reasons">
                <span>选一个原因：</span>
                {DECLINE_REASONS.map(reason => <button key={reason} type="button" className="button secondary" disabled={saving}
                  onClick={() => onDecline(row, reason)}>{reason}</button>)}
                <button type="button" className="button secondary" disabled={saving} onClick={() => onDeclining(null)}>返回</button>
              </div>
            </details>
            <button type="button" className="button secondary" disabled={saving} onClick={() => onLater(row)}>稍后</button>
          </>}
      </div>
    </div>
  </article>;
}

/**
 * The owner's home page: one card per product still waiting for a decision, plus a rail with what is waiting on the
 * owner. Every number shown comes from a saved query result or a saved estimate; this page computes none of them.
 */
export default function SelectionDesk({
  discoveryView, candidates, store, ownerReady = true, loadingLabel = "正在读取本店的查询结果…",
  onSelectProduct, onDeclineProduct, onLaterProduct, onEstimate, onTranslate,
  onOpenCandidate, onFindNewRound, onOpenBoard, onOpenInbox, skipped = []
}) {
  const [sort, setSort] = useState("profit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [cursor, setCursor] = useState(0);
  const feed = useMemo(() => feedRows(discoveryView, store, sort), [discoveryView, store, sort]);
  const skippedKeys = useMemo(() => new Set(skipped), [skipped]);
  const rows = useMemo(() => feed.rows.filter(row => !skippedKeys.has(row.key)), [feed, skippedKeys]);
  const board = useMemo(() => boardColumns(candidates, store), [candidates, store]);
  const inbox = useMemo(() => inboxItems(candidates, store), [candidates, store]);
  const points = pointsLine(discoveryView, store);
  const activeKey = rows.length === 0 ? null : rows[Math.min(cursor, rows.length - 1)].key;

  async function run(action, payload) {
    if (saving || typeof action !== "function") return null;
    setSaving(true); setError(null); setNotice(null);
    try {
      const result = await action(payload);
      setDeclining(null);
      return result;
    } catch (cause) { setError(errorMessage(cause)); return null; }
    finally { setSaving(false); }
  }
  async function select(row) {
    const result = await run(onSelectProduct, { batchId: row.batchId, expectedRevision: row.expectedRevision, marketProductId: row.marketProductId });
    if (result !== null) setNotice("已收下，去「进行中」看它的下一步。");
  }
  async function decline(row, reason) {
    const result = await run(onDeclineProduct, { batchId: row.batchId, expectedRevision: row.expectedRevision, marketProductId: row.marketProductId, reason });
    if (result !== null) setNotice(`已记下：${reason}。以后再遇到同类，会先按你的这些理由过一遍。`);
  }
  function later(row) {
    setDeclining(null); setError(null);
    setNotice("已跳过，本次浏览不再显示；没有保存任何记录。");
    if (typeof onLaterProduct === "function") onLaterProduct(row);
  }
  const batchAction = action => run(action, feed.current === null ? null : { ...feed.current });

  // The keyboard shortcuts always act on what the page shows right now, so they read the latest render, not a closure.
  const live = useRef(null);
  live.current = { rows, cursor, select };
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName) || event.target?.isContentEditable) return;
      const key = String(event.key).toLowerCase();
      if (!["j", "k", "y", "n"].includes(key)) return;
      const state = live.current;
      const row = state.rows.length === 0 ? null : state.rows[Math.min(state.cursor, state.rows.length - 1)];
      event.preventDefault();
      if (key === "j") setCursor(value => Math.min(value + 1, Math.max(state.rows.length - 1, 0)));
      else if (key === "k") setCursor(value => Math.max(value - 1, 0));
      else if (row === null) return;
      else if (key === "y") state.select(row);
      else setDeclining(row.key);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!ownerReady) return <div className="page-panel"><p role="status">请先登录主人身份后查看选品台。</p></div>;
  if (discoveryView === null) return <div className="page-panel"><p role="status">{loadingLabel}</p></div>;

  return <div className="page-panel desk-page">
    <div className="desk-layout">
      <section className="desk-feed" aria-label="待你决定">
        <header className="desk-feed-header">
          <div>
            <h2>待你决定</h2>
            <p className="desk-subline">{feed.storeLabel} · {feed.direction ?? "还没有本店的查询结果"}{feed.queriedAt === null ? "" : ` · 查询于 ${feed.queriedAt}`}</p>
          </div>
          <div className="desk-feed-tools">
            <label>排序<select value={sort} onChange={event => setSort(event.target.value)}>
              {FEED_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <button type="button" className="button secondary" disabled={saving || feed.current === null || feed.estimable === 0}
              onClick={() => batchAction(onEstimate)}>算利润区间</button>
            <button type="button" className="button secondary" disabled={saving || feed.current === null || feed.pendingTranslations === 0}
              onClick={() => batchAction(onTranslate)}>翻译标题（{feed.pendingTranslations} 条待翻）</button>
          </div>
        </header>
        <p className="desk-hint">键盘：J 下一件 · K 上一件 · Y 要 · N 不要。运费占比＝运费 ÷（采购上限 ＋ 运费），只用已保存的估算数字。</p>
        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status" className="desk-notice">{notice}</p> : null}
        {rows.length === 0 ? <p role="status">本店当前没有等你决定的商品。点右上角「找一轮新品」再找一批。</p> : null}
        {rows.map(row => <FeedCard key={row.key} row={row} active={activeKey === row.key} saving={saving}
          declining={declining === row.key} onDeclining={setDeclining}
          onSelect={select} onDecline={decline} onLater={later} onOpenCandidate={onOpenCandidate} />)}
        {feed.excluded.length ? <details className="desk-folded"><summary>已自动排除 {feed.excluded.length} 条（预估负利润）</summary>
          <ul>{feed.excluded.map(row => <li key={row.key}>{row.titleZh ?? row.title} · 售价 {fact(row.price)} 卢布 · {row.estimate?.summary ?? "预估负利润"}</li>)}</ul>
        </details> : null}
        {feed.declined.length ? <details className="desk-folded"><summary>你已排除 {feed.declined.length} 条</summary>
          <ul>{feed.declined.map(row => <li key={row.key}>{row.titleZh ?? row.title} · 你的理由：{row.declineReason}</li>)}</ul>
        </details> : null}
      </section>
      <aside className="desk-rail" aria-label="本店概览">
        <section className="desk-rail-block">
          <h3>需要你处理（{inbox.length}）</h3>
          {inbox.length === 0 ? <p className="desk-rail-empty">现在没有等你处理的商品。</p> : <ul className="desk-rail-list">
            {inbox.slice(0, 6).map(item => <li key={item.id}>
              <b>{item.title}</b><span>{item.need}</span>
              <button type="button" className="button secondary" onClick={() => onOpenCandidate(item.id)}>打开</button>
            </li>)}</ul>}
          {inbox.length > 6 ? <button type="button" className="button secondary" onClick={onOpenInbox}>查看全部 {inbox.length} 条</button> : null}
        </section>
        <section className="desk-rail-block">
          <h3>进行中</h3>
          {board.some(column => column.cards.length) ? <ul className="desk-rail-progress">
            {board.map(column => <li key={column.key}><span>{column.title}</span><b>{column.cards.length}</b></li>)}</ul>
            : <p className="desk-rail-empty">本店暂时没有在做的商品。</p>}
          <button type="button" className="button secondary" onClick={onOpenBoard}>打开进行中</button>
        </section>
        <section className="desk-rail-block">
          <h3>本轮方向</h3>
          <p className="desk-rail-direction">{feed.direction ?? "还没有本店的查询方向。"}</p>
          {points === null ? null : <p className="desk-rail-points">{points}</p>}
          <button type="button" className="button primary" onClick={onFindNewRound}>找一轮新品</button>
        </section>
      </aside>
    </div>
  </div>;
}
