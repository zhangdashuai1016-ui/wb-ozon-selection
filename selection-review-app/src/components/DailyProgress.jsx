export default function DailyProgress({ summary }) {
  const progress = summary?.combined || {
    target: 10,
    profitPassed: 0,
    exactProfitPassed: 0,
    estimatedProfitPassed: 0,
    cCompleted: 0,
    readyToList: 0,
    legacyReadyPendingC: 0
  };
  return (
    <section className="daily-progress" aria-label="今日选品总量目标">
      <div className="store-progress combined-progress">
        <span>全店合计 · B利润通过</span>
        <strong>{progress.profitPassed}<i>/</i>{progress.target}</strong>
        <small>精确 {progress.exactProfitPassed} · 估算 {progress.estimatedProfitPassed}</small>
      </div>
      <div className="store-progress">
        <span>C阶段完成</span>
        <strong>{progress.cCompleted}</strong>
        <small>真正完成上架准备</small>
      </div>
      <div className="store-progress">
        <span>当前可上架</span>
        <strong>{progress.readyToList}</strong>
        <small>仍须精确生产确认 · 历史待补C {progress.legacyReadyPendingC || 0}</small>
      </div>
      <p>当前已登记店铺合计；B与C分开统计，不用变体凑数量。</p>
    </section>
  );
}
