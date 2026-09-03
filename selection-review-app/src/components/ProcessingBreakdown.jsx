export default function ProcessingBreakdown({ summary, automationStarted }) {
  const counts = summary?.dispatch?.processingCounts || {};
  return (
    <section className="processing-breakdown" aria-label="审核队列真实执行状态">
      <strong>真实执行状态</strong>
      <span className="processing-running">实际运行 {counts.actualRunning ?? counts.running ?? 0}</span>
      <span>负责人已接收 {counts.received || 0}</span>
      <span>已派发待领取 {counts.dispatched || 0}</span>
      <span>已确认待派发 {counts.authorized || 0}</span>
      <span className="processing-stopped">已停止待决定 {counts.stopped || 0}</span>
      {counts.stateAnomaly ? <span className="processing-anomaly">状态异常 {counts.stateAnomaly}</span> : null}
      <small>{automationStarted === true ? "连续自动化已由总控开启" : "连续自动化关闭 · 新候选进入软件状态机，不唤醒Codex；失败不自动重试"}</small>
    </section>
  );
}
