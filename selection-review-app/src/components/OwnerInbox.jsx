import { inboxItems, storeLabel } from "../selectionDeskView.js";

/** Every product that is waiting on the owner, one row each. Opening a row only shows it; it starts no work. */
export default function OwnerInbox({ candidates, store, onOpenCandidate }) {
  const items = inboxItems(candidates, store);
  return <div className="page-panel inbox-page">
    <header className="inbox-header">
      <h2>需要你处理</h2>
      <p>{storeLabel(store)} · 共 {items.length} 条等你。处理完一条，它会自己从这里消失。</p>
    </header>
    {items.length === 0 ? <p role="status">现在没有等你处理的商品。</p> : <ul className="inbox-list">
      {items.map(item => <li key={item.id}>
        <div className="inbox-row-body">
          <b>{item.title}</b>
          <span className="inbox-row-need">等你：{item.need}{item.moreNeeds > 0 ? `（还有 ${item.moreNeeds} 项）` : ""}</span>
          <span className="inbox-row-status">{item.storeLabel} · {item.statusLine}</span>
        </div>
        <button type="button" className="button secondary" onClick={() => onOpenCandidate(item.id)}>打开</button>
      </li>)}
    </ul>}
  </div>;
}
