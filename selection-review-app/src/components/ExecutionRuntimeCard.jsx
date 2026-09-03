import { executionRuntimeDisplay } from "../executionRuntimeView";

export default function ExecutionRuntimeCard({ runtime }) {
  const display = executionRuntimeDisplay(runtime);
  if (!display) return null;
  return (
    <section className={`execution-runtime-card executor-${display.tone}`} aria-label="当前实际执行者">
      <header>
        <div>
          <small>{runtime.legacyReadOnly ? "历史兼容" : runtime.schemaVersion}</small>
          <h3>当前实际执行者</h3>
        </div>
        <strong data-testid="execution-runtime-executor">{display.executorLabel}</strong>
      </header>
      <div className="execution-runtime-summary">
        <span data-testid="execution-runtime-status">{display.statusLabel}</span>
        <span>当前步骤：{runtime.stepId}</span>
      </div>
      <p>{display.detail}</p>
      {!runtime.legacyReadOnly && runtime.inferenceReceiptId ? <small>AI结果凭证：{runtime.inferenceReceiptId}</small> : null}
    </section>
  );
}
