import { STATUS_LABELS } from "../constants";

export default function StatusBadge({ status, readback }) {
  if (readback?.status === "source_conflict") return <span className="status-badge status-needs_user_data">历史上架记录 · 来源待核对</span>;
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}
