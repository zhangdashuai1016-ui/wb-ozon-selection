import { dESoftwareRuntimeDisplay } from "../dESoftwareRuntimeView";

export default function DESoftwareRuntimeCard({ runtime }) {
  const display = dESoftwareRuntimeDisplay(runtime);
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
            : display.assetTransport.status === "in_flight"
              ? "单次传输中"
              : "尚未准备"}
      </p>
      {display.gaps.length > 0 ? (
        <ul>
          {display.gaps.map((item) => <li key={`${item.code}:${item.field}`}>{item.message}</li>)}
        </ul>
      ) : <p>当前没有未解决的准备度缺口。</p>}
      <small>不自动重试 · 不走浏览器兜底 · 不派发Codex · 当前平台写入 {runtime.platformWrites}</small>
    </section>
  );
}
