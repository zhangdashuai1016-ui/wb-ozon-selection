import { dESoftwareRuntimeDisplay, eReadbackRuntimeDisplay, dESavedJobRuntimeDisplay } from "../dESoftwareRuntimeView";
import { useSubmit } from "./FormRevisionNotice.jsx";

export default function DESoftwareRuntimeCard({ runtime, readback, savedJobRuntime = null, onContinueSaved = null }) {
  const { saving, error, run } = useSubmit();
  const saved = dESavedJobRuntimeDisplay(savedJobRuntime);
  if (saved) return (
    <section className={`de-software-runtime-card status-${saved.tone}`} aria-label="D和E软件闭环状态">
      <header><div><small>生产与平台核验</small><h3>{saved.statusLabel}</h3></div></header>
      {saved.stages.map(stage => <div key={stage.stage} aria-label={stage.title}>
        <h4>{stage.title}：{stage.statusLabel}</h4>
        <p>{stage.receiptLabel}。</p>
        {stage.reconciliationMessage ? <p>{stage.reconciliationMessage}</p> : null}
        {stage.blockers.length ? <ul>{stage.blockers.map(message => <li key={message}>{message}</li>)}</ul> : null}
      </div>)}
      {saved.canContinueSaved ? <button type="button" disabled={saving || typeof onContinueSaved !== "function"}
        onClick={() => run(async () => { await onContinueSaved(saved.continuation); })}>
        {saving ? "正在继续已保存任务…" : "继续已保存任务"}</button> : null}
      {error ? <p role="alert">{error}</p> : null}
      <p>{savedJobRuntime.currentVerified ? "当前商品的独立验证结果已保存。" : "尚未形成当前商品的独立验证通过结果。"}</p>
      <small>配置存在不代表平台在线。继续时会重新检查当前条件；已经发出的请求不会自动重发。</small>
    </section>
  );
  const display = dESoftwareRuntimeDisplay(runtime);
  const readbackDisplay = eReadbackRuntimeDisplay(readback);
  if (!display) return null;
  return (
    <section className={`de-software-runtime-card status-${display.tone}`} aria-label="D和E软件闭环状态">
      <header>
        <div>
          <small>D / E 软件闭环</small>
          <h3>{display.statusLabel}</h3>
        </div>
        <strong>{runtime.canExecutePlatformWrite ? "可执行" : "未开放写入"}</strong>
      </header>
      <p>
        OSS最终素材：{display.assetTransport.status === "verified"
          ? `已验证（${display.assetTransport.resolvedCount}个）`
          : display.assetTransport.status === "unknown_outcome"
            ? "结果未知，已停止"
            : display.assetTransport.status === "failed"
              ? "执行条件检查未通过，未发起上传"
            : display.assetTransport.status === "in_flight"
              ? "已保存传输意图，结果待核对"
              : "尚未准备"}
      </p>
      {display.execution ? (
        <p>
          执行开始：{display.execution.startedAt || "未记录"}；最近进展：{display.execution.lastProgressAt || "未记录"}。
          {display.execution.taskId ? ` 平台任务号：${display.execution.taskId}。` : ""}
          {display.execution.productId ? ` 商品编号：${display.execution.productId}。` : ""}
        </p>
      ) : null}
      {display.gaps.length > 0 ? (
        <ul>
          {display.gaps.map((item) => <li key={`${item.code}:${item.field}`}>{item.message}</li>)}
        </ul>
      ) : <p>当前没有未解决的准备度缺口。</p>}
      {readbackDisplay ? <div aria-label="平台独立回读结果">
        <h4>{readbackDisplay.statusLabel}</h4>
        {readbackDisplay.startedAt ? <p>开始读取：{readbackDisplay.startedAt}；
          {readbackDisplay.completedAt ? `记录完成：${readbackDisplay.completedAt}` : "尚未保存完成结果"}。</p> : null}
        {readbackDisplay.gaps.length ? <ul>{readbackDisplay.gaps.map(message => <li key={message}>{message}</li>)}</ul> : null}
        <p>{readbackDisplay.verified ? "商品、图片顺序、价格、指定仓库库存和销售状态均已对应本次写入。"
          : "尚未形成当前商品的独立验证；读取失败后不会自动重复查询。"}</p>
      </div> : null}
      <small>每次执行一次，结果未知时停止并等待核对。平台写入：{runtime.platformWrites === "unknown" ? "结果待核对" : runtime.platformWrites}</small>
    </section>
  );
}
