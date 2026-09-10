import { boardColumns, storeLabel } from "../selectionDeskView.js";

/** Five plain columns for one store. Clicking a card opens that product in the review board; nothing is started here. */
export default function PipelineBoard({ candidates, store, onOpenCandidate }) {
  const columns = boardColumns(candidates, store);
  const total = columns.reduce((count, column) => count + column.cards.length, 0);
  return <div className="page-panel board-page">
    <header className="board-header">
      <h2>进行中</h2>
      <p>{storeLabel(store)} · 共 {total} 件在做的商品。点一张卡片打开它的详情。</p>
    </header>
    {total === 0 ? <p role="status">本店暂时没有在做的商品。</p> : null}
    <div className="board-columns">
      {columns.map(column => <section key={column.key} className="board-column" aria-label={column.title}>
        <h3>{column.title}<span>{column.cards.length}</span></h3>
        {column.cards.length === 0 ? <p className="board-empty">这一步暂时没有商品。</p> : null}
        {column.cards.map(card => <button key={card.id} type="button" className="board-card" onClick={() => onOpenCandidate(card.id)}>
          {card.imageUrl
            ? <img src={card.imageUrl} alt="" width="40" height="40" loading="lazy" referrerPolicy="no-referrer" />
            : <span className="board-card-thumb-empty">主图</span>}
          <span className="board-card-body">
            <b>{card.title}</b>
            <span className="board-card-status">{card.statusLine}</span>
            {card.waitingLine === null ? null : <span className="board-card-waiting">等你：{card.waitingLine}</span>}
          </span>
        </button>)}
      </section>)}
    </div>
  </div>;
}
