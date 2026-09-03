import { useEffect, useMemo, useState } from "react";

function ConnectionFlag({ label, value }) {
  return <span className={value ? "is-connected" : "is-not-connected"}>{label}：{value ? "已接" : "未接"}</span>;
}

function References({ title, refs, emptyLabel }) {
  return (
    <section className="three-store-map-detail-section">
      <strong>{title}</strong>
      {refs.length ? (
        <ul className="three-store-map-reference-list">
          {refs.map((item) => <li key={`${item.path}:${item.anchor}`}><code>{item.path}</code><span>{item.label}</span></li>)}
        </ul>
      ) : <p>{emptyLabel}</p>}
    </section>
  );
}

function TextList({ title, items, emptyLabel = "没有固定上下游。" }) {
  return (
    <section className="three-store-map-detail-section">
      <strong>{title}</strong>
      {items.length ? <div className="three-store-map-id-list">{items.map((item) => <span key={item.id}><b>{item.id}</b>{item.title}</span>)}</div> : <p>{emptyLabel}</p>}
    </section>
  );
}

function ModuleDetail({ module, moduleById }) {
  const upstream = module.upstream.map((id) => moduleById.get(id)).filter(Boolean);
  const downstream = module.downstream.map((id) => moduleById.get(id)).filter(Boolean);
  const status = module.currentStatus;
  return (
    <aside className="three-store-map-detail" aria-live="polite">
      <header>
        <p>{module.id} · 代码事实详情</p>
        <h2>{module.title}</h2>
        <span className={`three-store-map-status ${status.tone}`}>{status.label}</span>
      </header>

      <section className="three-store-map-detail-lead">
        <strong>这里在做什么</strong>
        <p>{module.plainDescription}</p>
      </section>

      <div className="three-store-map-detail-grid">
        <section className="three-store-map-detail-section">
          <strong>为什么是这个状态</strong>
          <p>{module.statusReason}</p>
          {module.runtimeNote ? <small>{module.runtimeNote}</small> : null}
        </section>
        <section className="three-store-map-detail-section">
          <strong>真实接线</strong>
          <p>{module.actualChain}</p>
          <div className="three-store-map-connection-flags">
            <ConnectionFlag label="真实代码" value={module.connection.codePresent} />
            <ConnectionFlag label="今日选品评审入口" value={module.connection.uiConnected} />
            <ConnectionFlag label="正常执行链" value={module.connection.executionConnected} />
          </div>
        </section>
        <section className="three-store-map-detail-section">
          <strong>输入</strong>
          <ul>{module.inputs.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="three-store-map-detail-section">
          <strong>产出</strong>
          <ul>{module.outputs.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <TextList title="上一站" items={upstream} emptyLabel="这是入口或独立运行边界。" />
        <TextList title="下一站" items={downstream} emptyLabel="没有固定下一站；恢复必须由状态机重新判断。" />
        <section className="three-store-map-detail-section human">
          <strong>主人何时介入</strong>
          <p>{module.ownerAction}</p>
        </section>
        <section className="three-store-map-detail-section codex">
          <strong>Codex 的边界</strong>
          <p>{module.codexRule}</p>
        </section>
        <section className="three-store-map-detail-section warning">
          <strong>失败或未知时</strong>
          <p>{module.failureAndUnknown}</p>
        </section>
        <section className="three-store-map-detail-section next">
          <strong>当前断点与下一步</strong>
          <p><b>断点：</b>{module.breakpoint}</p>
          <p><b>下一步：</b>{module.nextStep}</p>
        </section>
      </div>

      <References title="关联代码" refs={module.codeRefs} emptyLabel="当前没有正式代码实现。" />
      <References title="已接 UI" refs={module.uiRefs} emptyLabel="当前没有用户可用入口。" />
      <section className="three-store-map-detail-section">
        <strong>测试证据</strong>
        <p className="three-store-map-evidence-note">{module.testEvidence.note}</p>
        {module.testEvidence.refs.length ? (
          <ul className="three-store-map-reference-list">
            {module.testEvidence.refs.map((item) => <li key={`${item.path}:${item.anchor}`}><code>{item.path}</code><span>{item.label}</span></li>)}
          </ul>
        ) : <p>当前没有正式测试证据；这不是通过状态。</p>}
      </section>
    </aside>
  );
}

export default function ThreeStoreMap({ map, onClose, onRefresh }) {
  const [selectedId, setSelectedId] = useState("");
  const moduleById = useMemo(() => new Map((map?.modules || []).map((item) => [item.id, item])), [map]);
  const selectedModule = moduleById.get(selectedId) || map?.modules?.[0] || null;

  useEffect(() => {
    if (selectedId && moduleById.has(selectedId)) return;
    setSelectedId(map?.modules?.[0]?.id || "");
  }, [map, moduleById, selectedId]);

  if (!map) return <main className="three-store-map-loading">正在读取全店能力地图的当前代码事实…</main>;

  const mainFlow = map.mainFlow.map((id) => moduleById.get(id)).filter(Boolean);
  return (
    <main className="three-store-map-page">
      <header className="three-store-map-heading">
        <div>
          <p className="eyebrow">只读 · 代码事实 · 持续施工驾驶舱</p>
          <h1>{map.title}</h1>
          <p>{map.subtitle}</p>
        </div>
        <div className="three-store-map-heading-actions">
          <button className="button secondary" onClick={onRefresh}>重新读取当前事实</button>
          <button className="button secondary" onClick={onClose}>返回今日选品评审</button>
        </div>
      </header>

      <section className="three-store-map-boundary">
        <strong>这张图能证明什么</strong>
        <p>{map.evidenceScope}</p>
        <small>{map.maintenanceRule}</small>
      </section>

      <section className="three-store-map-runtime">
        <span>当前服务运行边界：<b>{map.runtimeFacts.deploymentMode === "local_development" ? "本地开发" : map.runtimeFacts.deploymentMode === "unknown" ? "未取得" : map.runtimeFacts.deploymentMode}</b></span>
        <span>多人中央运行：<b>{map.runtimeFacts.multiUserReady ? "已就绪" : "未就绪"}</b></span>
        <span>关键词运行开关：<b>{map.runtimeFacts.seerfarSoftwareExecutionEnabled ? "当前进程开启（仍未补齐队列）" : "当前进程关闭"}</b></span>
      </section>

      <section className="three-store-map-legend" aria-label="执行状态说明">
        {map.statusDefinitions.map((item) => <span key={item.id} className={`three-store-map-status ${item.tone}`} title={item.description}>{item.label}</span>)}
      </section>

      <section className="three-store-map-flow" aria-label="当前主流程">
        <header><strong>当前主流程</strong><span>箭头表示代码设计中的真实前后依赖；虚线支路代表异常停止，不会自动跳过。</span></header>
        <div className="three-store-map-flow-line">
          {mainFlow.map((item, index) => (
            <div className="three-store-map-flow-step" key={item.id}>
              {index ? <i aria-hidden="true">→</i> : null}
              <button className={selectedModule?.id === item.id ? "selected" : ""} onClick={() => setSelectedId(item.id)}><b>{item.id}</b>{item.title}</button>
            </div>
          ))}
        </div>
        <p className="three-store-map-exception-route"><b>异常支路：</b>{map.exceptionRoute.label}。{map.exceptionRoute.returnRule}</p>
      </section>

      <section className="three-store-map-layout">
        <div className="three-store-map-areas">
          {map.areas.map((area) => {
            const modules = map.modules.filter((item) => item.areaId === area.id);
            return (
              <section key={area.id} className="three-store-map-area">
                <header><p>{area.id}</p><div><h2>{area.title}</h2><span>{area.summary}</span></div></header>
                <div className="three-store-map-card-grid">
                  {modules.map((item) => {
                    const status = item.currentStatus;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={`three-store-map-card ${status.tone} ${selectedModule?.id === item.id ? "selected" : ""}`}
                        onClick={() => setSelectedId(item.id)}
                        aria-pressed={selectedModule?.id === item.id}
                      >
                        <div><span className="three-store-map-card-id">{item.id}</span><span className={`three-store-map-status ${status.tone}`}>{status.shortLabel}</span></div>
                        <strong>{item.title}</strong>
                        <p>{item.plainDescription}</p>
                        <div className="three-store-map-card-flags">
                          <ConnectionFlag label="代码" value={item.connection.codePresent} />
                          <ConnectionFlag label="UI" value={item.connection.uiConnected} />
                          <ConnectionFlag label="执行" value={item.connection.executionConnected} />
                        </div>
                        <small><b>断点：</b>{item.breakpoint}</small>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        {selectedModule ? <ModuleDetail module={selectedModule} moduleById={moduleById} /> : null}
      </section>
    </main>
  );
}
