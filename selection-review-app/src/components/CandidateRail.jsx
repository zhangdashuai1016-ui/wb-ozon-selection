import { SOURCE_LABELS, STORE_LABELS } from "../constants";
import { matchesQueue, orderCandidates } from "../candidateViews";
import StatusBadge from "./StatusBadge";

function executionLabel(candidate) {
  const dispatch = candidate.activeDispatch;
  if (dispatch) {
    if (["queued", "waiting_assignee", "delivering"].includes(dispatch.status)) return "已派发待负责人领取";
    if (["received", "permission_required"].includes(dispatch.status)) return "负责人已接收";
    if (dispatch.status === "running") return "运行中 · 有实际任务";
  }
  if (candidate.processingStatus?.key === "queued") return "已确认 · 尚未派发";
  return candidate.processingStatus?.label || "当前无人运行";
}

export default function CandidateRail({
  candidates,
  selectedId,
  onSelect,
  queue,
  sourceFilter,
  onSourceFilterChange
}) {
  const filtered = orderCandidates(candidates).filter((candidate) =>
    matchesQueue(candidate, queue, sourceFilter)
  );

  return (
    <aside className="candidate-rail" aria-label="当前队列商品">
      <header className="rail-header">
        <strong>商品</strong>
        {["eliminated", "listed"].includes(queue) ? (
          <span className="all-sources-label">全部来源</span>
        ) : (
          <select
            aria-label="来源筛选"
            value={sourceFilter}
            onChange={(event) => onSourceFilterChange(event.target.value)}
          >
            <option value="all">全部来源</option>
            <option value="user">你提交</option>
            <option value="codex">Codex选品</option>
          </select>
        )}
      </header>
      <div className="candidate-list">
        {filtered.length ? (
          filtered.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              className={`candidate-row ${selectedId === candidate.id ? "selected" : ""}`}
              onClick={() => onSelect(candidate.id)}
            >
              <span className="candidate-thumb">
                {candidate.imageUrl ? (
                  <img src={candidate.imageUrl} alt="" />
                ) : (
                  <span>{candidate.targetStore === "miska" ? "M" : "?"}</span>
                )}
              </span>
              <span className="candidate-copy">
                <strong>{candidate.productName}</strong>
                <small>{STORE_LABELS[candidate.targetStore]}</small>
                {candidate.workflowStatus === "codex_processing" ? (
                  <small className={`rail-processing rail-${candidate.processingStatus?.key || "idle"}`}>
                    {executionLabel(candidate)}
                  </small>
                ) : null}
                <em className={`source source-${candidate.source}`}>{SOURCE_LABELS[candidate.source]}</em>
              </span>
              <StatusBadge status={candidate.workflowStatus} />
            </button>
          ))
        ) : (
          <div className="empty-state">这个队列暂时没有商品</div>
        )}
      </div>
    </aside>
  );
}
