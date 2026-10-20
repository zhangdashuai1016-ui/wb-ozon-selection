import { boardColumns, inboxItems, inboxRows, storeLabel } from "../selectionDeskView.js";
import EliminateControl from "./EliminateControl.jsx";
import "./SelectionHome.css";

function Thumbnail({ imageUrl }) {
  return imageUrl
    ? <img className="selection-home-thumb" src={imageUrl} alt="" width="44" height="44" loading="lazy" referrerPolicy="no-referrer" />
    : <span className="selection-home-thumb empty" aria-hidden="true">图</span>;
}

function EliminateTarget({ target, onEliminateCandidate }) {
  if (typeof onEliminateCandidate !== "function") return null;
  const revisionKnown = Number.isSafeInteger(target.dataRevision) && target.dataRevision >= 0;
  return <span className="selection-home-eliminate" data-candidate-id={target.id}
    title={revisionKnown ? undefined : "未读取到当前版本，请刷新后再淘汰"}>
    <EliminateControl id={target.id} dataRevision={target.dataRevision} disabled={!revisionKnown}
      label={target.label ? `淘汰「${target.label}」` : "淘汰"} onEliminate={onEliminateCandidate} />
  </span>;
}

function ProductRow({ card, columnTitle, onOpenCandidate, onEliminateCandidate }) {
  const grouped = card.members.length > 1;
  return <li className="selection-home-row" data-testid="selection-home-product" data-candidate-id={card.id}>
    <Thumbnail imageUrl={card.imageUrl} />
    <div className="selection-home-row-body">
      <button type="button" className="selection-home-title" onClick={() => onOpenCandidate(card.id)}>{card.title}</button>
      <p className="selection-home-meta"><span className="selection-home-chip">{columnTitle}</span>
        {card.colour && !grouped ? `${card.colour} · ` : ""}{card.statusLine}{card.positionLine ? ` · ${card.positionLine}` : ""}</p>
      {card.stuckLine ? <p className="selection-home-warning">{card.stuckLine}</p> : null}
      {card.waitingLine ? <p className="selection-home-meta">等你：{card.waitingLine}</p> : null}
      {card.roughProfit ? <p className="selection-home-meta">{card.roughProfit.label}</p> : null}
      {grouped ? <ul className="selection-home-members" aria-label={`${card.title} 的颜色`}>
        {card.members.map(member => <li key={member.id}>
          <button type="button" className="intake-link" onClick={() => onOpenCandidate(member.id)}>{member.label}</button>
          <span>{member.statusLine}</span>
        </li>)}
      </ul> : null}
      {card.elsewhereLine ? <p className="selection-home-meta">{card.elsewhereLine}</p> : null}
    </div>
    <div className="selection-home-actions">
      <button type="button" className="button primary" onClick={() => onOpenCandidate(card.id)}>查看商品</button>
      {grouped ? <details className="selection-home-more"><summary>逐个颜色操作</summary>
        {card.members.map(member => <EliminateTarget key={member.id} target={member} onEliminateCandidate={onEliminateCandidate} />)}
      </details> : <EliminateTarget target={card} onEliminateCandidate={onEliminateCandidate} />}
    </div>
  </li>;
}

function AttentionRow({ row, onOpenCandidate, onEliminateCandidate }) {
  return <li className="selection-home-row attention" data-testid="selection-home-attention">
    <Thumbnail imageUrl={row.imageUrl} />
    <div className="selection-home-row-body">
      <strong>{row.title}</strong>
      {row.members.map(item => <div key={item.id} className="selection-home-attention-member" data-candidate-id={item.id}>
        {row.grouped ? <b className="selection-home-colour">{item.colour ?? "颜色没读到"}</b> : null}
        <ul className="selection-home-reasons">{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        <p className="selection-home-meta">{item.statusLine}</p>
        <div className="selection-home-actions">
          <button type="button" className="button primary" onClick={() => onOpenCandidate(item.id)}>{item.action.label}</button>
          <EliminateTarget target={{ id: item.id, dataRevision: item.dataRevision, label: row.grouped ? item.colour : null }}
            onEliminateCandidate={onEliminateCandidate} />
        </div>
      </div>)}
    </div>
  </li>;
}

/** The approved home layout reads existing projections; every primary action only navigates to its existing page. */
export default function SelectionHome({ candidates, store, storeLine, discoveryView = null, discoveryError = null,
  intakeQueue = null, intakeError = null, ownerReady = false, onOpenCandidate, onEliminateCandidate,
  onOpenIntake, onOpenSeerfar, onOpenInbox, onOpenBoard }) {
  if (!ownerReady) return <section className="selection-home-locked"><p role="status">请先登录后查看选品台。</p></section>;
  const columns = boardColumns(candidates, store, { discoveryView, intakeQueue });
  const products = columns.flatMap(column => column.cards.map(card => ({ card, columnTitle: column.title })));
  const attention = inboxItems(candidates, store, { discoveryView, intakeQueue });
  const attentionRows = inboxRows(attention);
  const reasons = new Map();
  for (const item of attention) reasons.set(item.need, (reasons.get(item.need) ?? 0) + 1);
  return <div className="selection-home" aria-label={`${storeLabel(store)} 选品总览`}>
    <main className="selection-home-main">
      <section className="selection-home-block" aria-labelledby="selection-home-products">
        <header className="selection-home-section-heading">
          <div><h2 id="selection-home-products">我选的商品（{products.length}）</h2><p>{storeLine ?? storeLabel(store)}</p></div>
          <button type="button" className="button secondary" onClick={onOpenIntake}>＋ 添加商品</button>
        </header>
        {intakeError ? <p role="alert" className="selection-home-warning">找货队列读取失败：{intakeError}。下面保留已保存的商品状态。</p> : null}
        {discoveryError ? <p role="alert" className="selection-home-warning">查询记录读取失败：{discoveryError}。已保存的商品仍可查看。</p> : null}
        {products.length === 0 ? <p className="selection-home-empty">本店还没有选定的商品。可以添加商品，或到 Seerfar 查看选品结果。</p>
          : <ul className="selection-home-list">{products.map(({ card, columnTitle }) => <ProductRow key={`${card.column}:${card.id}`}
            card={card} columnTitle={columnTitle} onOpenCandidate={onOpenCandidate} onEliminateCandidate={onEliminateCandidate} />)}</ul>}
      </section>
      <section className="selection-home-block" aria-labelledby="selection-home-attention">
        <header className="selection-home-section-heading"><h2 id="selection-home-attention">待你处理（{attentionRows.length}）</h2>
          <button type="button" className="intake-link" onClick={onOpenInbox}>查看全部</button></header>
        {attentionRows.length === 0 ? <p className="selection-home-empty">现在没有等你处理的商品。</p>
          : <ul className="selection-home-list">{attentionRows.map(row => <AttentionRow key={row.key} row={row}
            onOpenCandidate={onOpenCandidate} onEliminateCandidate={onEliminateCandidate} />)}</ul>}
      </section>
    </main>
    <aside className="selection-home-rail" aria-label="本店汇总与下一轮">
      <section className="selection-home-box"><h3>需要你处理（{attention.length}）</h3>
        {reasons.size === 0 ? <p>现在没有待处理事项。</p> : <ul className="selection-home-summary">
          {[...reasons].map(([reason, count]) => <li key={reason}><span>{reason}</span><b>{count}</b></li>)}
        </ul>}
        <button type="button" className="intake-link" onClick={onOpenInbox}>打开需要你处理</button>
      </section>
      <section className="selection-home-box"><h3>进行中</h3>
        <ul className="selection-home-summary">{columns.map(column => <li key={column.key}><span>{column.title}</span><b>{column.count}</b></li>)}</ul>
        <button type="button" className="intake-link" onClick={onOpenBoard}>打开进行中</button>
      </section>
      <section className="selection-home-box"><h3>下一轮方向</h3>
        <p>按当前店铺档案，在 Seerfar 查看方向和选品结果。</p>
        <button type="button" className="button primary" onClick={onOpenSeerfar}>找一轮新品</button>
      </section>
    </aside>
  </div>;
}
