import { STORE_LABELS } from "../constants";

export default function DailyProgress({ summary }) {
  return (
    <section className="daily-progress" aria-label="今日选品总量目标">
      {["dandanshu", "miska"].map((store) => {
        const progress = summary?.stores?.[store] || { ready: 0, totalSelectedToday: 0, target: 10 };
        return (
          <div className="store-progress" key={store}>
            <span>{STORE_LABELS[store]}</span>
            <strong>{progress.totalSelectedToday || 0}<i>/</i>{progress.target}</strong>
            <small>今日选品 · 待上架 {progress.ready}</small>
            {progress.automaticAdditionEnabled === false ? (
              <small className="automation-paused">自动补品已暂停 · 等你提交</small>
            ) : null}
          </div>
        );
      })}
      <p>你提交与Codex选品合计；达标后停止自动补充</p>
    </section>
  );
}
