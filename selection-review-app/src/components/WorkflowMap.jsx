import { useEffect, useMemo, useRef, useState } from "react";

const STORE_LABELS = { dandanshu: "蛋蛋鼠", miska: "Miska", wb: "WB" };

function timeLabel(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dispatchStatus(value) {
  return {
    queued: "已创建派发",
    waiting_assignee: "等待负责人空闲",
    delivering: "正在通知负责人",
    received: "负责人已接收",
    running: "运行中",
    permission_required: "等待本次权限确认",
    completed: "已完成并回写",
    responded_unverified: "已回复 · 结果未验证",
    blocked: "已停止",
    needs_decision: "等待主人决定",
    failed: "派发失败"
  }[value] || value;
}

export default function WorkflowMap({ map, candidate, onSubmit, onApproval, onProductionAuthorization, onClose }) {
  const [selectedNode, setSelectedNode] = useState(null);
  const [scope, setScope] = useState(candidate ? "candidate" : "workflow");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [scale, setScale] = useState(0.82);
  const [offset, setOffset] = useState({ x: 10, y: 10 });
  const [production, setProduction] = useState({ sku: "", price: "", stock: "", assets: "", publishScope: "仅保存草稿", exclusions: "", confirmed: false });
  const [productionSaving, setProductionSaving] = useState(false);
  const drag = useRef(null);
  const nodeById = useMemo(() => new Map((map?.nodes || []).map((node) => [node.id, node])), [map]);

  useEffect(() => {
    setScope(candidate ? "candidate" : "workflow");
    setProduction({
      sku: candidate?.productionAuthorization?.sku || "",
      price: candidate?.productionAuthorization?.price || "",
      stock: candidate?.productionAuthorization?.stock || "",
      assets: (candidate?.productionAuthorization?.assets || []).join("\n"),
      publishScope: candidate?.productionAuthorization?.publishScope || "仅保存草稿",
      exclusions: candidate?.productionAuthorization?.exclusions || "",
      confirmed: false
    });
  }, [candidate?.id, candidate?.dataRevision]);

  if (!map) return <main className="map-loading">正在读取小地图…</main>;

  const nodeComments = selectedNode
    ? (map.comments || []).filter((item) => item.nodeId === selectedNode.id && item.scope === scope)
    : [];
  const nodeDispatches = selectedNode
    ? (map.dispatches || []).filter((item) => item.nodeId === selectedNode.id && item.scope === scope)
    : [];

  async function submit() {
    if (!selectedNode || !message.trim()) return;
    setSaving(true);
    setFeedback("");
    try {
      await onSubmit({
        nodeId: selectedNode.id,
        scope,
        candidateId: scope === "candidate" ? candidate?.id : null,
        dataRevision: scope === "candidate" ? candidate?.dataRevision : null,
        message: message.trim(),
        action: "record"
      });
      setMessage("");
      setFeedback("留言已保存，没有启动任务。派发请回商品评审主界面。");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveProductionAuthorization(event) {
    event.preventDefault();
    if (!candidate) return;
    setProductionSaving(true);
    setFeedback("");
    try {
      await onProductionAuthorization({
        platform: candidate.targetStore === "wb" ? "WB" : "Ozon",
        store: STORE_LABELS[candidate.targetStore] || candidate.targetStore,
        product: candidate.productName,
        sku: production.sku,
        price: production.price,
        stock: production.stock,
        assets: production.assets.split("\n").map((item) => item.trim()).filter(Boolean),
        publishScope: production.publishScope,
        exclusions: production.exclusions,
        confirmed: production.confirmed
      });
      setProduction((current) => ({ ...current, confirmed: false }));
      setFeedback("精确生产范围已记录；当前没有执行店铺写入。需要派发时请回商品评审主界面。");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setProductionSaving(false);
    }
  }

  function pointerDown(event) {
    if (event.target.closest("button")) return;
    drag.current = { x: event.clientX, y: event.clientY, offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event) {
    if (!drag.current) return;
    setOffset({
      x: drag.current.offset.x + event.clientX - drag.current.x,
      y: drag.current.offset.y + event.clientY - drag.current.y
    });
  }

  return (
    <main className="map-page">
      <div className="map-heading">
        <div>
          <p className="eyebrow">业务流程、真实状态和负责人</p>
          <h2>三店选品与上架小地图</h2>
          <p>拖动空白处移动，滚轮缩放；点击节点查看卡点、留言和派发。</p>
        </div>
        <div className="map-heading-actions">
          <div className="map-zoom">
            <button onClick={() => setScale((value) => Math.max(0.55, value - 0.1))}>−</button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale((value) => Math.min(1.35, value + 0.1))}>＋</button>
          </div>
          <button className="button secondary" onClick={onClose}>返回评审台</button>
        </div>
      </div>

      <section className="map-current">
        <strong>{candidate ? `${candidate.id} · ${candidate.productName}` : "全项目流程"}</strong>
        <span>{candidate ? `${STORE_LABELS[candidate.targetStore] || candidate.targetStore} · 当前节点 ${map.selectedCandidate?.activeNodeId || "未识别"}` : "选择商品后会高亮该SKU的真实路径"}</span>
        <em>连续自动化关闭 · 小地图只看流程和留言，当前商品统一回评审主界面派发</em>
      </section>

      <div className="map-legend">
        <span className="legend-completed">已走过</span>
        <span className="legend-active">当前步骤</span>
        <span className="legend-blocked">真实阻塞</span>
        <span className="legend-pending">尚未开始</span>
      </div>

      <section
        className="workflow-canvas"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={(event) => {
          event.preventDefault();
          setScale((value) => Math.min(1.35, Math.max(0.55, value + (event.deltaY > 0 ? -0.05 : 0.05))));
        }}
      >
        <div className="workflow-stage" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>
          <svg viewBox="0 0 1240 650" aria-hidden="true">
            <defs>
              <marker id="map-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" /></marker>
            </defs>
            {(map.edges || []).map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + 94;
              const y1 = from.y + 46;
              const x2 = to.x + 94;
              const y2 = to.y + 46;
              return (
                <g key={`${edge.from}-${edge.to}-${edge.label}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} className={edge.dashed ? "dashed" : ""} markerEnd="url(#map-arrow)" />
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7}>{edge.label}</text>
                </g>
              );
            })}
          </svg>
          {(map.nodes || []).map((node) => (
            <button
              key={node.id}
              className={`map-node state-${node.candidateState}`}
              style={{ left: node.x, top: node.y }}
              onClick={() => {
                setSelectedNode(node);
                setMessage("");
                setFeedback("");
              }}
            >
              <span>{node.id} · {node.lane}</span>
              <strong>{node.title}</strong>
              <small>负责人：{node.owner}</small>
              <em>{node.counts?.total || 0}件 · 阻塞{node.counts?.blocked || 0} · 运行{node.counts?.running || 0}</em>
            </button>
          ))}
        </div>
      </section>

      {map.legacyComments?.length ? (
        <details className="legacy-comments">
          <summary>历史留言／未归属节点 <small>{map.legacyComments.length}条</small></summary>
          {map.legacyComments.slice(-12).map((item) => <p key={item.id}>{item.message}<time>{timeLabel(item.at)}</time></p>)}
        </details>
      ) : null}

      {selectedNode ? (
        <div className="modal-backdrop" onMouseDown={() => setSelectedNode(null)}>
          <div className="modal map-node-modal" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div><p>{selectedNode.id} · {selectedNode.lane}</p><h2>{selectedNode.title}</h2></div>
              <button className="icon-button" onClick={() => setSelectedNode(null)}>×</button>
            </header>
            <div className="map-modal-body">
              <div className="node-owner-strip">
                <span>负责人：{selectedNode.owner}</span>
                <span>当前商品状态：{selectedNode.candidateState}</span>
                <span>节点商品：{selectedNode.counts?.total || 0}</span>
              </div>
              <div className="node-detail-grid">
                <section className="node-problem"><strong>现在卡在哪</strong><p>{selectedNode.issue}</p></section>
                <section><strong>输入</strong><p>{selectedNode.inputs.join("；") || "无"}</p></section>
                <section><strong>输出</strong><p>{selectedNode.outputs.join("；") || "无"}</p></section>
                <section><strong>规矩与验证</strong><p>{[...(selectedNode.ruleSource || []), ...(selectedNode.validation || [])].join("；")}</p></section>
                <section className="node-advice"><strong>建议下一步</strong><p>{selectedNode.recommendation}</p></section>
              </div>

              {selectedNode.id === "M10" ? (
                <>
                  <div className="production-warning">
                    <strong>普通留言不授权店铺写入</strong>
                    <p>必须另有平台、店铺、SKU、价格、库存、完整素材、发布范围和排除项确认。系统权限确认也不能替代这张业务确认卡。</p>
                  </div>
                  {candidate?.workflowStatus === "ready_to_list" ? (
                    <form className="production-confirmation" onSubmit={saveProductionAuthorization}>
                      <h3>生产写入精确确认卡</h3>
                      <div className="production-fixed">
                        <span>平台：{candidate.targetStore === "wb" ? "WB" : "Ozon"}</span>
                        <span>店铺：{STORE_LABELS[candidate.targetStore] || candidate.targetStore}</span>
                        <span>商品：{candidate.productName}</span>
                      </div>
                      <div className="production-grid">
                        <label>SKU / 货号<input value={production.sku} onChange={(event) => setProduction((current) => ({ ...current, sku: event.target.value }))} /></label>
                        <label>价格<input value={production.price} onChange={(event) => setProduction((current) => ({ ...current, price: event.target.value }))} /></label>
                        <label>库存<input value={production.stock} onChange={(event) => setProduction((current) => ({ ...current, stock: event.target.value }))} /></label>
                        <label>发布范围<select value={production.publishScope} onChange={(event) => setProduction((current) => ({ ...current, publishScope: event.target.value }))}><option>仅保存草稿</option><option>创建并送审</option><option>发布销售</option><option>仅更新现有商品</option></select></label>
                        <label className="span-2">完整素材清单（每行一个文件或附件）<textarea rows="4" value={production.assets} onChange={(event) => setProduction((current) => ({ ...current, assets: event.target.value }))} /></label>
                        <label className="span-2">明确排除项<textarea rows="2" value={production.exclusions} onChange={(event) => setProduction((current) => ({ ...current, exclusions: event.target.value }))} placeholder="例如：不上传视频、不发布、不改现有价格" /></label>
                      </div>
                      <label className="production-checkbox"><input type="checkbox" checked={production.confirmed} onChange={(event) => setProduction((current) => ({ ...current, confirmed: event.target.checked }))} />我确认以上对象和范围准确；本按钮只记录授权，不立即写店。</label>
                      <button className="button primary" disabled={productionSaving || !production.confirmed}>{productionSaving ? "记录中…" : "记录这一次精确生产范围"}</button>
                    </form>
                  ) : <p className="production-unavailable">当前商品尚未处于待上架，不能创建生产确认卡。</p>}
                </>
              ) : null}

              <div className="scope-switch">
                <button className={scope === "candidate" ? "active" : ""} disabled={!candidate} onClick={() => setScope("candidate")}>针对当前商品</button>
                <button className={scope === "workflow" ? "active" : ""} onClick={() => setScope("workflow")}>针对整个流程</button>
              </div>

              <section className="node-thread">
                <h3>节点记录与回复</h3>
                {nodeComments.length || nodeDispatches.length ? (
                  <div className="node-thread-list">
                    {nodeComments.map((item) => (
                      <article key={item.id} className={`node-message actor-${item.actor}`}>
                        <strong>{item.actor === "user" ? "我" : "Codex"}</strong>
                        <p>{item.message}</p>
                        <time>{timeLabel(item.at)} · {item.status}</time>
                      </article>
                    ))}
                    {nodeDispatches.map((item) => (
                      <article key={item.id} className={`dispatch-message status-${item.status}`}>
                        <strong>{item.id} · {dispatchStatus(item.status)}</strong>
                        <p>{item.currentStep || item.deliveryDetail || item.error || `负责人：${item.assigneeTitle || item.assigneeRole}`}</p>
                        <time>{timeLabel(item.lastEventAt || item.createdAt)}</time>
                        {item.pendingApproval ? (
                          <div className="permission-card">
                            <b>本次Codex权限确认</b>
                            <p>{item.pendingApproval.reason}</p>
                            <div>
                              <button className="button primary" onClick={() => onApproval(item, "accept")}>只允许这一次</button>
                              <button className="button secondary" onClick={() => onApproval(item, "decline")}>拒绝</button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : <p className="node-thread-empty">这个范围还没有留言或派发。</p>}
              </section>

              <label className="node-comment-field">
                <span>你想让我在这个步骤处理什么</span>
                <textarea rows="4" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="写下对这个步骤的问题或纠正；这里不会启动任务。" />
              </label>
              <div className="node-comment-actions">
                <span>派发请返回商品评审主界面。</span>
                <button className="button secondary" disabled={saving || !message.trim()} onClick={submit}>{saving ? "保存中…" : "保存留言"}</button>
              </div>
              {feedback ? <p className="node-feedback">{feedback}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
