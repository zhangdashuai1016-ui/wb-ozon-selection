import { QUEUE_LABELS } from "../constants";

export default function QueueTabs({ active, counts, onChange }) {
  return (
    <nav className="queue-tabs" aria-label="选品处理队列">
      {Object.entries(QUEUE_LABELS).map(([status, label]) => (
        <button
          type="button"
          key={status}
          className={active === status ? "active" : ""}
          onClick={() => onChange(status)}
        >
          {label}<span>{counts?.[status] || 0}</span>
        </button>
      ))}
    </nav>
  );
}
