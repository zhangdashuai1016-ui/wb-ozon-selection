import { executionRuntimeDisplay } from "../executionRuntimeView";

const STEP_LABELS = Object.freeze({ A_DETAIL_EVIDENCE_REQUIRED:"等待补齐商品详情", A_WAITING_OWNER_SUPPLY_CONFIRMATION:"等待确认供货方案", C2_OWNER_BUSINESS_CONFIRMATION: "最终方案与生产范围确认", D_TECHNICAL_ADMISSION: "生产执行条件检查" });

export default function ExecutionRuntimeCard({ runtime }) {
  const display = executionRuntimeDisplay(runtime);
  if (!display) return null;
  const current = runtime.currentExecutionConfirmed === true || runtime.currentPermissionRequired === true;
  const title = current ? "当前任务状态" : "执行记录与状态";
  return (
    <section className={`execution-runtime-card executor-${display.tone}`} aria-label={title}>
      <header>
        <div>
          <small>{runtime.legacyReadOnly ? "历史记录" : "本地任务状态"}</small>
          <h3>{title}</h3>
        </div>
        <strong data-testid="execution-runtime-executor">{display.executorLabel}</strong>
      </header>
      <div className="execution-runtime-summary">
        <span data-testid="execution-runtime-status">{display.statusLabel}</span>
        <span>{current ? "当前步骤" : "记录步骤"}：{STEP_LABELS[runtime.stepId] || runtime.stepId}</span>
      </div>
      <p>{display.detail}</p>
      {!runtime.legacyReadOnly && runtime.inferenceReceiptId ? <small>AI结果凭证：{runtime.inferenceReceiptId}</small> : null}
    </section>
  );
}
