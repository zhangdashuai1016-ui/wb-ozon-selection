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
import UserInspector from "./components/UserInspector";
import WorkflowMap from "./components/WorkflowMap";

const INITIAL_QUEUE = "codex_processing";

export default function App() {
  const [state, setState] = useState({
    candidates: [],
    meta: null,
    rules: null,
    summary: null
  });
  const [selectedId, setSelectedId] = useState("");
  const [queue, setQueue] = useState(INITIAL_QUEUE);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState("review");
  const [workflowMap, setWorkflowMap] = useState(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const next = await api.getState();
      setState(next);
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

  const loadWorkflowMap = useCallback(async (candidateId = selectedId) => {
    try {
      const next = await api.getWorkflowMap(candidateId || "");
      setWorkflowMap(next);
      return next;
    } catch (error) {
      setNotice({ type: "error", message: `读取小地图失败：${error.message}` });
      return null;
    }
  }, [selectedId]);

  useEffect(() => {
    if (view !== "map") return undefined;
    loadWorkflowMap();
    const timer = window.setInterval(() => loadWorkflowMap(), 3000);
    return () => window.clearInterval(timer);
  }, [view, loadWorkflowMap]);

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
        message: `${result.candidate.id} 已保存到执行状态；自动化关闭，等待总控安排`
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
      setNotice({ type: "success", message: "资料已保存；如此前技术阻塞，仍保持停止并等待总控确认" });
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

  async function resumeSelected(recoveryPath) {
    if (!selected) return;
    try {
      const result = await api.resumeCandidate({
        candidateId: selected.id,
        dataRevision: selected.dataRevision,
        recoveryPath
      });
      setQueue(result.candidate.workflowStatus);
      setSelectedId(result.candidate.id);
      setNotice({
        type: "success",
        message: "已确认并向总控派发当前SKU一次；连续自动化仍关闭"
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
            : "已保存到执行状态；当前不会自动领取"
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

  async function commentSelected(message, requestReview = true, category = "general") {
    if (!selected) return;
    try {
      const result = await api.addComment(selected.id, {
        actor: "user",
        message,
        requestReview,
        category
      });
      if (requestReview) {
        setQueue("codex_processing");
        setSourceFilter("all");
        setSelectedId(result.candidate.id);
      }
      setNotice({
        type: "success",
        message:
          category === "elimination_feedback"
            ? "淘汰原因已保存，后续自动选品会读取这条避坑条件"
            : requestReview
              ? "问题已保存到执行状态；自动化关闭，等待总控安排"
              : "留言已作为记录保存"
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

  async function submitNodeComment(payload) {
    const result = await api.addNodeComment(payload);
    setNotice({
      type: "success",
      message: "节点留言已保存，没有启动任务"
    });
    await Promise.all([load(true), loadWorkflowMap(payload.candidateId || "")]);
    return result;
  }

  async function dispatchSelected() {
    if (!selected) return;
    try {
      const result = await api.dispatchCandidate(selected.id, { dataRevision: selected.dataRevision });
      setNotice({
        type: "success",
        message: `已从评审台派发当前SKU一次给${result.dispatch.assigneeTitle || "负责人"}；连续自动化仍关闭`
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      if (error.status === 409) await load(true);
      return null;
    }
  }

  async function decideDispatchApproval(dispatch, decision) {
    try {
      await api.decideDispatchApproval(dispatch.id, {
        requestId: dispatch.pendingApproval?.requestId,
        decision
      });
      setNotice({ type: decision === "accept" ? "success" : "warning", message: decision === "accept" ? "只允许了这一次Codex权限" : "已拒绝本次Codex权限" });
      await loadWorkflowMap();
    } catch (error) {
      setNotice({ type: "error", message: error.message });
      await loadWorkflowMap();
    }
  }

  async function confirmProductionAuthorization(payload) {
    if (!selected) return;
    try {
      await api.confirmProductionAuthorization(selected.id, {
        ...payload,
        dataRevision: selected.dataRevision
      });
      setNotice({ type: "success", message: "已记录精确生产范围；尚未执行任何店铺写入" });
      await Promise.all([load(true), loadWorkflowMap(selected.id)]);
    } catch (error) {
      setNotice({ type: "error", message: error.message });
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
    return <div className="app-loading">正在打开今日选品评审台…</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>今日选品评审台</h1>
        <div className="header-actions">
          <button className={`button ${view === "map" ? "primary" : "secondary"}`} onClick={() => setView(view === "map" ? "review" : "map")}>
            {view === "map" ? "返回评审台" : "打开小地图"}
          </button>
          <button className="button add-button" onClick={() => setAddOpen(true)}>
            <PlusIcon /> 添加我找到的商品
          </button>
        </div>
      </header>

      {view === "map" ? (
        <>
          {notice ? <div className={`global-notice ${notice.type}`}>{notice.message}</div> : null}
          <WorkflowMap
            map={workflowMap}
            candidate={selected}
            onSubmit={submitNodeComment}
            onApproval={decideDispatchApproval}
            onProductionAuthorization={confirmProductionAuthorization}
            onClose={() => setView("review")}
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
            <CandidateDetail candidate={selected} />
            <UserInspector
              candidate={selected}
              rules={state.rules}
              onUpdate={updateSelected}
              onEvaluate={evaluateSelected}
              onComment={commentSelected}
              onMarkListed={markSelectedListed}
              onResume={resumeSelected}
              onDispatch={dispatchSelected}
            />
            <CandidateReview candidate={selected} />
          </div>
        ) : (
          <main className="candidate-detail empty-detail">这个队列暂时没有商品</main>
        )}
      </div>

      <OperatingRules />

      <footer className="boundary-footer">
        <div>A 方向初筛 → B 具体 SKU 利润核算 → C 采购/上架前来源与合规核验；SKU/链接不一致只拦当前 SKU，不淘汰方向。</div>
        <div>IP/品牌风险需总控确认；确认及 C 阶段权利/合规核验完成前，不得进入待上架或写入店铺。</div>
        <div>当前商品统一在评审主界面派发；小地图只看流程和留言。普通留言不会修改店铺商品、库存、价格或广告。</div>
      </footer>
      </>
      )}
      <AddCandidateModal open={addOpen} onClose={() => setAddOpen(false)} onSave={addCandidate} />
    </div>
  );
}
