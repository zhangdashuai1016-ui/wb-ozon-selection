import { useMemo, useState } from "react";
import {
  LIFECYCLE_STATUS_LABELS,
  mapLifecycleStatus,
  withTechnicalFailureDisplay
} from "../lifecycleStatusView";

const STATUS_ITEMS = [
  { key: "businessPhase", label: "业务阶段" },
  { key: "businessResult", label: "业务结果" },
  { key: "technicalStatus", label: "技术状态" },
  { key: "ownerAction", label: "主人操作" }
];

function displayedValue(key, value) {
  return LIFECYCLE_STATUS_LABELS[key]?.[value] || value;
}

export default function LifecycleStatusCard({ candidate }) {
  const [failurePreview, setFailurePreview] = useState(false);
  const baseStatus = useMemo(() => mapLifecycleStatus(candidate), [candidate]);
  if (!baseStatus.available) return null;

  const status = failurePreview ? withTechnicalFailureDisplay(baseStatus) : baseStatus;
  return (
    <section className={`lifecycle-status-card${failurePreview ? " technical-failure-preview" : ""}`} aria-label="新版生命周期状态">
      <header>
        <div>
          <small>product-lifecycle-v1.1 · {baseStatus.sourceEntityType === "SkuLifecyclePackage" ? "当前SKU真实状态" : "当前商品方向真实状态"}</small>
          <h3>四条状态线</h3>
        </div>
        <span>来源修订 {status.sourceDataRevision}</span>
      </header>
      <div className="lifecycle-status-grid">
        {STATUS_ITEMS.map((item) => (
          <div key={item.key} className={`lifecycle-status-item status-${item.key}`}>
            <span>{item.label}</span>
            <strong data-testid={`lifecycle-${item.key}`}>{displayedValue(item.key, status[item.key])}</strong>
          </div>
        ))}
      </div>
      <div className="lifecycle-status-explanation">
        <p>{status.explanation}</p>
        {failurePreview ? (
          <strong data-testid="lifecycle-failure-boundary">商品没有失败 · 失败层：{status.failureLayer}</strong>
        ) : null}
      </div>
      <button
        type="button"
        className="lifecycle-preview-button"
        onClick={() => setFailurePreview((current) => !current)}
      >
        {failurePreview ? "返回完成状态" : "验证技术失败的显示"}
      </button>
    </section>
  );
}
