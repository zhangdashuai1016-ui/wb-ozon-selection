import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { firstInQueue, matchesQueue } from "./candidateViews";
import AddCandidateModal from "./components/AddCandidateModal";
import CandidateDetail, { CandidateReview } from "./components/CandidateDetail";
import CandidateRail from "./components/CandidateRail";
import DailyProgress from "./components/DailyProgress";
import { PlusIcon } from "./components/Icons";
import QueueTabs from "./components/QueueTabs";
import OperatingRules from "./components/OperatingRules";
import ProcessingBreakdown from "./components/ProcessingBreakdown";
import RuntimeArchitectureStatus from "./components/RuntimeArchitectureStatus";
import Phase2ASimulation from "./components/Phase2ASimulation";
import UserInspector from "./components/UserInspector";
import ThreeStoreMap from "./components/ThreeStoreMap";
import {
  EXTENSION_CAPTURE_ACK_TIMEOUT_MS,
  EXTENSION_STATUS_PING,
  EXTENSION_STATUS_RESPONSE,
  EXTENSION_STATUS_RESPONSE_TIMEOUT_MS,
  extensionConnectionStatus,
  readCachedExtensionVersion
} from "./extensionStatus";

const INITIAL_QUEUE = "codex_processing";
const SOURCE_CAPTURE_REQUEST = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
const SOURCE_CAPTURE_ACK = "SELECTION_REVIEW_1688_CAPTURE_ACK";
const OZON_CAPTURE_REQUEST = "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
const OZON_CAPTURE_ACK = "SELECTION_REVIEW_OZON_CAPTURE_ACK";

function request1688ExtensionCapture(payload, timeoutMs = EXTENSION_CAPTURE_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ accepted: false, code: "extension_bridge_unavailable", error: "今日选品评审页面没有收到扩展桥接回应" });
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== SOURCE_CAPTURE_ACK || event.data?.captureId !== payload.captureId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ accepted: event.data.accepted === true, code: event.data.code || "", error: event.data.error || "" });
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ type: SOURCE_CAPTURE_REQUEST, payload }, window.location.origin);
  });
}

function requestOzonExtensionCapture(payload, timeoutMs = EXTENSION_CAPTURE_ACK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ accepted: false, code: "extension_bridge_unavailable", error: "今日选品评审页面没有收到扩展桥接回应" });
    }, timeoutMs);
    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== OZON_CAPTURE_ACK || event.data?.captureId !== payload.captureId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ accepted: event.data.accepted === true, code: event.data.code || "", error: event.data.error || "" });
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ type: OZON_CAPTURE_REQUEST, payload }, window.location.origin);
  });
}

export default function App() {
  const [state, setState] = useState({
    candidates: [],
    meta: null,
    rules: null,
    summary: null,
    seerfarRuntime: null,
    extensionHeartbeat: null,
    runtimeArchitecture: null,
    captureControl: { status: "idle", label: "商品采集控制空闲" }
  });
  const [selectedId, setSelectedId] = useState("");
  const [queue, setQueue] = useState(INITIAL_QUEUE);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState("review");
  const [threeStoreMap, setThreeStoreMap] = useState(null);
  const [extensionStatus, setExtensionStatus] = useState(() => extensionConnectionStatus({
    cachedVersion: readCachedExtensionVersion()
  }));
  const effectiveExtensionStatus = useMemo(() => {
    if (["connected", "background_unavailable", "reload_required"].includes(extensionStatus.code)) {
      return extensionStatus;
    }
    return extensionConnectionStatus({
      cachedVersion: readCachedExtensionVersion(),
      serverHeartbeat: state.extensionHeartbeat
    });
  }, [extensionStatus, state.extensionHeartbeat]);

  useEffect(() => {
    let active = true;
    api.getSeerfarRuntimeStatus()
      .then((seerfarRuntime) => {
        if (active) setState((current) => ({ ...current, seerfarRuntime }));
      })
      .catch((error) => {
        if (active) setState((current) => ({
          ...current,
          seerfarRuntime: {
            configured: false,
            softwareExecutionEnabled: false,
            statusError: error.message
          }
        }));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let responseTimer;
    let liveVersion = "";
    let pendingNonce = "";
    function ping() {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingNonce = nonce;
      window.postMessage({ type: EXTENSION_STATUS_PING, nonce }, window.location.origin);
      window.clearTimeout(responseTimer);
      responseTimer = window.setTimeout(() => {
        liveVersion = "";
        setExtensionStatus(extensionConnectionStatus({ cachedVersion: readCachedExtensionVersion() }));
      }, EXTENSION_STATUS_RESPONSE_TIMEOUT_MS);
    }
    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== EXTENSION_STATUS_RESPONSE) return;
      if (event.data?.nonce !== pendingNonce) return;
      liveVersion = String(event.data.version || "").trim();
      window.clearTimeout(responseTimer);
      setExtensionStatus(extensionConnectionStatus({
        liveVersion,
        backgroundReady: event.data.backgroundReady === true
      }));
    }
    window.addEventListener("message", onMessage);
    ping();
    const interval = window.setInterval(ping, 10000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(responseTimer);
    };
  }, []);

  const load = useCallback(async (quiet = false) => {
    try {
      const next = await api.getState();
      setState((current) => ({ ...next, seerfarRuntime: current.seerfarRuntime }));
      setSelectedId((currentId) => {
        const current = next.candidates.find((candidate) => candidate.id === currentId);
        if (current && matchesQueue(current, queue, sourceFilter)) return currentId;
        return firstInQueue(next.candidates, queue, sourceFilter)?.id || "";
      });
      if (!quiet) setLoading(false);
      return next;
    } catch (error) {
      setNotice({ type: "error", message: `读取共享数据失败：${error.message}` });
      if (!quiet) setLoading(false);
      return null;
    }
  }, [queue, sourceFilter]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(
    () => state.candidates.find((candidate) => candidate.id === selectedId) || null,
    [state.candidates, selectedId]
  );

  const loadThreeStoreMap = useCallback(async () => {
    try {
      const next = await api.getThreeStoreMap();
      setThreeStoreMap(next);
      return next;
    } catch (error) {
      setNotice({ type: "error", message: `读取全店能力地图失败：${error.message}` });
      return null;
    }
  }, []);

  useEffect(() => {
    if (view === "map") loadThreeStoreMap();
  }, [view, loadThreeStoreMap]);

  function openQueue(nextQueue, preferredId = "", nextSourceFilter = sourceFilter) {
    if (["eliminated", "listed"].includes(nextQueue)) nextSourceFilter = "all";
    setQueue(nextQueue);
    setSourceFilter(nextSourceFilter);
    const preferred = state.candidates.find(
      (candidate) =>
        candidate.id === preferredId && matchesQueue(candidate, nextQueue, nextSourceFilter)
    );
    setSelectedId(
      preferred?.id || firstInQueue(state.candidates, nextQueue, nextSourceFilter)?.id || ""
    );
  }

  async function addCandidate(payload) {
    try {
      const result = await api.addCandidate(payload);
      setAddOpen(false);
      setSourceFilter("all");
      setQueue(result.candidate.workflowStatus);
      setSelectedId(result.candidate.id);
      setNotice({
        type: "success",
        message: `${result.candidate.id} 已保存到软件状态机，当前等待A阶段方向判断；未唤醒Codex任务`
      });
      await load(true);
    } catch (error) {
      if (error.body?.duplicateId) {
        const nextState = await load(true);
        const duplicate = nextState?.candidates.find((candidate) => candidate.id === error.body.duplicateId);
        setQueue(duplicate?.workflowStatus || "codex_processing");
        setSourceFilter("all");
        setSelectedId(error.body.duplicateId);
        setAddOpen(false);
        setNotice({ type: "warning", message: `${error.message}，已跳转已有候选` });
        return;
      }
      throw error;
    }
  }

  async function updateSelected(payload) {
    if (!selected) return;
    try {
      const result = await api.updateCandidate(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      setQueue(result.candidate.workflowStatus);
      setSelectedId(result.candidate.id);
      setNotice({ type: "success", message: result.dispatch ? "资料已保存，并已进入受控异常处理" : "资料已保存；软件状态机未唤醒Codex，停止状态也没有被自动重启" });
      await load(true);
    } catch (error) {
      if (error.body?.duplicateId) {
        const nextState = await load(true);
        const duplicate = nextState?.candidates.find((candidate) => candidate.id === error.body.duplicateId);
        setSourceFilter("all");
        if (duplicate?.workflowStatus) setQueue(duplicate.workflowStatus);
        setSelectedId(error.body.duplicateId);
        setNotice({ type: "warning", message: `${error.message}，已跳转已有候选` });
      } else {
        setNotice({ type: "error", message: error.message });
      }
    }
  }

  async function confirmRealAStage(payload) {
    if (!selected) return;
    try {
      const result = await api.confirmRealAStage(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      setQueue(result.candidate.workflowStatus);
      setSelectedId(result.candidate.id);
      setNotice({
        type: "success",
        message: payload.decision === "reject"
          ? "A阶段已淘汰当前商品；未启动B或任何平台操作"
          : result.status === "supplier_capture_job_queued"
            ? "A阶段供应链接已保存；单候选采集作业等待插件后台自动领取，无需额外点击采集"
          : result.candidate.lifecycleV11?.skuPackage?.businessPhase === "C1"
            ? "A确认已原子保存，B已自动通过并创建C1；无需再次点击开始上架准备"
            : "A确认已原子保存，B已自动计算；当前商品未进入C1"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
    }
  }

  async function chooseRecoveryAction(action) {
    if (!selected) return;
    try {
      const result = await api.chooseRecoveryAction(selected.id, {
        dataRevision: selected.dataRevision,
        action
      });
      setQueue(result.candidate.workflowStatus);
      setSelectedId(result.candidate.id);
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已按固定处理方式交给${result.dispatch.assigneeTitle || "当前负责人"}；再次真实失败仍会停止`
          : "已记录为保持停止，系统不会自动重试"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
    }
  }

  async function evaluateSelected(payload) {
    if (!selected) return;
    try {
      const previousId = selected.id;
      const result = await api.saveUserEvaluation(previousId, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      const targetQueue = result.candidate.workflowStatus;
      setNotice({
        type: "success",
        message:
          payload.decision === "reject"
            ? "已淘汰；不会自动补充新候选"
            : "该旧判断入口已停止执行；新版商品请使用A阶段完整确认卡"
      });
      const nextState = await load(true);
      const next = firstInQueue(nextState?.candidates || [], "awaiting_user_direction", sourceFilter, previousId);
      if (queue === "awaiting_user_direction" && next) {
        setSelectedId(next.id);
      } else {
        setQueue(targetQueue);
        setSourceFilter("all");
        setSelectedId(result.candidate.id);
      }
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    }
  }

  async function commentSelected(message, requestReview = false, category = "general") {
    if (!selected) return;
    try {
      const result = await api.addComment(selected.id, {
        actor: "user",
        message,
        requestReview,
        category
      });
      setNotice({
        type: "success",
        message:
          category === "elimination_feedback"
            ? "淘汰原因已保存，后续自动选品会读取这条避坑条件"
            : "留言已保存；普通留言不会启动或重试任务"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    }
  }

  async function markSelectedListed(payload) {
    if (!selected) return;
    try {
      const result = await api.markListed(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      setQueue("listed");
      setSourceFilter("all");
      setSelectedId(result.candidate.id);
      setNotice({ type: "success", message: "已移入“已上架”，复盘记录和上架信息均已保留" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    }
  }

  async function startSourceCapture(recoverySuggestion = "", mode = "") {
    if (!selected) return null;
    try {
      const result = await api.startSourceCapture(selected.id, {
        dataRevision: selected.dataRevision,
        recoverySuggestion,
        ...(mode ? { mode } : {})
      });
      setSelectedId(result.candidate.id);
      const ack = await request1688ExtensionCapture(result.extensionRequest);
      if (!ack.accepted) {
        const failureCode = ack.code === "background_unavailable"
          ? "extension_background_unavailable"
          : "extension_not_installed";
        await api.completeSourceCapture(selected.id, {
          captureId: result.captureId,
          token: result.extensionRequest.token,
          dataRevision: result.dataRevision,
          status: "failed",
          failureCode,
          message: ack.error || "Chrome没有收到采集请求",
          observedAt: new Date().toISOString()
        });
        setNotice({
          type: "error",
          message: failureCode === "extension_background_unavailable"
            ? "1688采集已停止：插件已安装，但后台没有响应。系统会继续自动检查，不需要反复重新加载。"
            : "1688采集已停止：今日选品评审页面没有检测到扩展桥接。没有派发任务。"
        });
      } else {
        setNotice({
          type: "success",
          message: mode === "listed_evidence_recovery"
            ? "已让本机Chrome补采当前已上架商品；原上架记录保持不变，不会自动派发任务"
            : "已让本机Chrome打开并采集当前1688商品；只执行这一次，失败不会自动重试"
        });
      }
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      return null;
    }
  }

  async function startOzonSalesCapture() {
    if (!selected) return null;
    try {
      const result = await api.startOzonSalesCapture(selected.id, { dataRevision: selected.dataRevision });
      setSelectedId(result.candidate.id);
      const ack = await requestOzonExtensionCapture(result.extensionRequest);
      if (!ack.accepted) {
        const failureCode = ack.code === "background_unavailable"
          ? "extension_background_unavailable"
          : "extension_not_installed";
        await api.completeOzonSalesCapture(selected.id, {
          captureId: result.captureId,
          token: result.extensionRequest.token,
          dataRevision: result.dataRevision,
          status: "failed",
          failureCode,
          message: ack.error || "Chrome没有收到Ozon采集请求",
          observedAt: new Date().toISOString()
        });
        setNotice({
          type: "error",
          message: failureCode === "extension_background_unavailable"
            ? "Ozon采集已停止：插件已安装，但后台没有响应。系统会继续自动检查，不需要反复重新加载。"
            : "Ozon采集已停止：今日选品评审页面没有检测到扩展桥接。商品业务状态没有改变。"
        });
      } else {
        setNotice({ type: "success", message: "已让本机Chrome只读采集当前Ozon商品一次；不会推进B/C/D/E。" });
      }
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      return null;
    }
  }

  async function selectSourceCaptureSku(sourceSkuIds) {
    if (!selected) return null;
    try {
      const result = await api.selectSourceCaptureSku(selected.id, {
        dataRevision: selected.dataRevision,
        sourceSkuIds
      });
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已确认${sourceSkuIds.length}个1688 SKU，并且只向选品任务派发当前商品B阶段一次`
          : `已确认${sourceSkuIds.length}个1688 SKU；证据已保存，原上架记录保持不变且没有自动派发任务`
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      return null;
    }
  }

  async function confirmProductionAuthorization(payload) {
    if (!selected) return;
    try {
      await api.confirmProductionAuthorization(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      setNotice({ type: "success", message: "已确认精确生产卡并启动当前SKU上架任务" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      throw error;
    }
  }

  async function confirmLifecycleProductionAuthorization(payload) {
    if (!selected) return;
    try {
      await api.confirmLifecycleProductionAuthorization(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision,
        confirmed: true
      });
      setNotice({ type: "success", message: "最终商品方案已通过，生产授权已锁定；尚未启动D阶段，也没有店铺写入" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      throw error;
    }
  }

  async function uploadLifecycleFinalAsset(file) {
    if (!selected) throw new Error("当前没有选中的商品");
    try {
      return await api.uploadLifecycleFinalAsset(selected.id, {
        dataRevision: selected.dataRevision,
        file
      });
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function confirmLifecycleFinalAssets(payload) {
    if (!selected) return;
    try {
      await api.confirmLifecycleFinalAssets(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision,
        confirmed: true
      });
      setNotice({ type: "success", message: "最终素材及顺序已锁定，最终商品方案卡已生成；尚未生产授权，也没有店铺写入" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  function changeQueue(nextQueue) {
    openQueue(nextQueue);
  }

  function changeSourceFilter(nextFilter) {
    setSourceFilter(nextFilter);
    setSelectedId(firstInQueue(state.candidates, queue, nextFilter)?.id || "");
  }

  if (loading) {
    return <div className="app-loading">正在打开全店经营工作台…</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <h1>全店经营工作台</h1>
          <p>{view === "map" ? "全店能力地图" : view === "phase2a" ? "第2A模拟验收" : "今日选品评审"}</p>
        </div>
        <div className="header-actions">
          <RuntimeArchitectureStatus status={state.runtimeArchitecture} />
          <span className={`extension-status ${effectiveExtensionStatus.code}`} data-testid="extension-status">
            <i aria-hidden="true" />{effectiveExtensionStatus.label}
          </span>
          <span className={`capture-control-status ${state.captureControl?.status || "idle"}`} data-testid="capture-control-status">
            <i aria-hidden="true" />{state.captureControl?.label || "商品采集控制状态未取得"}
          </span>
          <button className={`button ${view === "phase2a" ? "primary" : "secondary"}`} onClick={() => setView(view === "phase2a" ? "review" : "phase2a")}>
            {view === "phase2a" ? "返回今日选品评审" : "第2A模拟验收"}
          </button>
          <button className={`button ${view === "map" ? "primary" : "secondary"}`} onClick={() => setView(view === "map" ? "review" : "map")}>
            {view === "map" ? "返回今日选品评审" : "全店能力地图"}
          </button>
          <button className="button add-button" onClick={() => setAddOpen(true)}>
            <PlusIcon /> 添加我找到的商品
          </button>
        </div>
      </header>

      {view === "phase2a" ? (
        <Phase2ASimulation onClose={() => setView("review")} />
      ) : view === "map" ? (
        <>
          {notice ? <div className={`global-notice ${notice.type}`}>{notice.message}</div> : null}
          <ThreeStoreMap
            map={threeStoreMap}
            onClose={() => setView("review")}
            onRefresh={loadThreeStoreMap}
          />
        </>
      ) : (
      <>

      <DailyProgress summary={state.summary} />
      <QueueTabs
        active={queue}
        counts={state.summary?.queueCounts}
        onChange={changeQueue}
      />
      <ProcessingBreakdown
        summary={state.summary}
        automationStarted={state.meta?.automationStarted}
      />

      {notice ? <div className={`global-notice ${notice.type}`}>{notice.message}</div> : null}

      <div className="workspace">
        <CandidateRail
          candidates={state.candidates}
          selectedId={selectedId}
          onSelect={setSelectedId}
          queue={queue}
          sourceFilter={sourceFilter}
          onSourceFilterChange={changeSourceFilter}
        />
        {selected ? (
          <div className="review-pane">
            <CandidateDetail
              candidate={selected}
              seerfarRuntime={state.seerfarRuntime}
              onRealAConfirm={confirmRealAStage}
            />
            <UserInspector
              candidate={selected}
              rules={state.rules}
              captureControl={state.captureControl}
              extensionStatus={effectiveExtensionStatus}
              onUpdate={updateSelected}
              onEvaluate={evaluateSelected}
              onComment={commentSelected}
              onMarkListed={markSelectedListed}
              onRecoveryAction={chooseRecoveryAction}
              onStartSourceCapture={startSourceCapture}
              onStartOzonSalesCapture={startOzonSalesCapture}
              onSelectSourceCaptureSku={selectSourceCaptureSku}
              onProductionAuthorization={confirmProductionAuthorization}
              onUploadLifecycleFinalAsset={uploadLifecycleFinalAsset}
              onConfirmLifecycleFinalAssets={confirmLifecycleFinalAssets}
              onLifecycleProductionAuthorization={confirmLifecycleProductionAuthorization}
            />
            <CandidateReview candidate={selected} />
          </div>
        ) : (
          <main className="candidate-detail empty-detail">这个队列暂时没有商品</main>
        )}
      </div>

      <OperatingRules />

      <footer className="boundary-footer">
        <div>A销售与供应方案确认 → B具体SKU利润 → 自动进入C1 → C2最终素材 → 生产确认；SKU独立生命周期。</div>
        <div>精确1688链接、供应SKU、货价、国内运费、采购成本、重量和尺寸在A阶段完成；B通过后由软件自动进入C1，不再要求主人点开始。上架任务只负责领域开发、验收与异常维护。</div>
        <div>失败立即停止且不自动重试。普通留言不会启动任务；生产写入必须另行确认价格、库存100、素材和发布范围。</div>
      </footer>
      </>
      )}
      <AddCandidateModal open={addOpen} onClose={() => setAddOpen(false)} onSave={addCandidate} />
    </div>
  );
}
