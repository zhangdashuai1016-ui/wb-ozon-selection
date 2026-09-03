import { keywordSoftwareRuntimeDisplay } from "../keywordSoftwareRuntimeView";

export default function KeywordSoftwareRuntimeCard({ candidate, runtimeStatus }) {
  const display = keywordSoftwareRuntimeDisplay({ candidate, runtimeStatus });
  if (!display) return null;
  return (
    <section className={`execution-runtime-card keyword-software-${display.status}`} aria-label="C1关键词软件状态">
      <header>
        <div>
          <small>C1关键词证据</small>
          <h3>Seerfar软件执行</h3>
        </div>
        <strong data-testid="keyword-software-status">{display.title}</strong>
      </header>
      <div className="execution-runtime-summary">
        <span>{display.providerLabel}</span>
        <span>自动重试：0</span>
      </div>
      <p>{display.detail}</p>
      {display.jobId ? <small>作业编号：{display.jobId}</small> : null}
    </section>
  );
}
