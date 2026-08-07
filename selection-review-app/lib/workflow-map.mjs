import fs from "node:fs/promises";

export const ACTIVE_DISPATCH_STATES = new Set([
  "queued",
  "waiting_assignee",
  "delivering",
  "received",
  "running",
  "permission_required"
]);

export const TASK_ROUTE_DEFAULTS = {
  selection_task: {
    role: "selection_task",
    title: "选品",
    threadId: "019fd25d-aa11-76a2-a6b2-10c44b7bb86e",
    projectPath: "/Users/shuaizhang/Documents/wb & ozon 选品",
    verifiedAt: null,
    status: "unverified"
  },
  listing_task: {
    role: "listing_task",
    title: "上架",
    threadId: "019fd25d-ac2c-7480-8f7c-d507d573ac32",
    projectPath: "/Users/shuaizhang/Documents/wb & ozon 选品",
    verifiedAt: null,
    status: "unverified"
  },
  control_task: {
    role: "control_task",
    title: "三店总控",
    threadId: "019fd046-93e9-7681-b3e2-c06a0a250327",
    projectPath: "/Users/shuaizhang/Documents/wb & ozon 选品",
    verifiedAt: null,
    status: "unverified"
  }
};

export async function readWorkflowMap(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export function ensureCollaborationData(data) {
  data.workflowComments ||= [];
  data.dispatches ||= [];
  data.taskRoutes = {
    ...TASK_ROUTE_DEFAULTS,
    ...(data.taskRoutes || {})
  };
  for (const role of Object.keys(TASK_ROUTE_DEFAULTS)) {
    data.taskRoutes[role] = {
      ...TASK_ROUTE_DEFAULTS[role],
      ...(data.taskRoutes?.[role] || {})
    };
  }
  return data;
}

export function dispatchOwnerForNode(node, scope) {
  if (scope === "workflow") return "control_task";
  return node.executionOwner;
}

export function candidateActiveNode(candidate) {
  if (!candidate) return null;
  if (
    candidate.workflowStatus === "codex_processing" &&
    (candidate.processing?.manualHold === true || ["blocked", "deferred"].includes(candidate.processing?.state))
  ) return "M12";
  if (candidate.workflowStatus === "awaiting_user_direction") return "M03";
  if (candidate.workflowStatus === "needs_user_data") return "M04";
  if (candidate.workflowStatus === "eliminated") return "M06";
  if (candidate.workflowStatus === "listed") return "M11";
  if (candidate.workflowStatus === "ready_to_list") {
    return ["handed_off", "paused_user_stopped", "claimed", "running"].includes(candidate.listingHandoff?.state)
      ? "M09"
      : "M08";
  }
  if (candidate.workflowStatus !== "codex_processing") return "M01";

  const stage = candidate.selectionStage?.stage || "";
  if (stage === "profit_review") return "M05";
  if (["profit_passed_source_pending", "profit_passed_source_mismatch", "ready_to_list"].includes(stage)) return "M07";
  if (stage === "auto_eliminate_ready") return "M06";
  if (candidate.source === "codex" && !candidate.userEvaluation) return "M02";
  return "M04";
}

function completedNodeIds(candidate, activeNodeId) {
  if (!candidate || !activeNodeId) return [];
  const userPath = ["M01", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"];
  const codexPath = ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"];
  const path = candidate.source === "user" ? userPath : codexPath;
  if (activeNodeId === "M12") return [];
  const index = path.indexOf(activeNodeId);
  return index > 0 ? path.slice(0, index) : [];
}

export function activeDispatchForCandidate(data, candidateId) {
  return [...(data.dispatches || [])]
    .reverse()
    .find((item) => item.candidateId === candidateId && ACTIVE_DISPATCH_STATES.has(item.status)) || null;
}

export function collaborationSummary(data, baseSummary) {
  const processing = data.candidates.filter((item) => item.workflowStatus === "codex_processing");
  const activeByCandidate = new Map();
  for (const dispatch of data.dispatches || []) {
    if (dispatch.candidateId && ACTIVE_DISPATCH_STATES.has(dispatch.status)) {
      activeByCandidate.set(dispatch.candidateId, dispatch);
    }
  }
  const received = [...activeByCandidate.values()].filter((item) => ["received", "running", "permission_required"].includes(item.status)).length;
  const dispatched = [...activeByCandidate.values()].filter((item) => ["queued", "waiting_assignee", "delivering"].includes(item.status)).length;
  const authorized = processing.filter((candidate) =>
    candidate.processing?.state === "queued" &&
    candidate.processing?.manualHold !== true &&
    !activeByCandidate.has(candidate.id)
  ).length;
  return {
    ...(baseSummary || {}),
    actualRunning: processing.filter((candidate) => candidate.processing?.state === "running" && candidate.processing?.runId).length,
    received,
    dispatched,
    authorized,
    stopped: processing.filter((candidate) => candidate.processing?.manualHold === true || ["blocked", "deferred"].includes(candidate.processing?.state)).length,
    stateAnomaly: processing.filter((candidate) => candidate.processing?.state === "running" && !candidate.processing?.runId).length
  };
}

export function workflowMapView(map, data, publicCandidates, selectedCandidateId = "") {
  const selected = publicCandidates.find((item) => item.id === selectedCandidateId) || null;
  const activeNodeId = candidateActiveNode(selected);
  const completed = new Set(completedNodeIds(selected, activeNodeId));
  const counts = Object.fromEntries(map.nodes.map((node) => [node.id, { total: 0, blocked: 0, running: 0 }]));

  for (const candidate of publicCandidates) {
    const nodeId = candidateActiveNode(candidate);
    if (!nodeId || !counts[nodeId]) continue;
    counts[nodeId].total += 1;
    if (nodeId === "M12") counts[nodeId].blocked += 1;
    if (candidate.processingStatus?.actualRunning) counts[nodeId].running += 1;
  }

  const dispatches = (data.dispatches || []).filter((item) =>
    item.scope === "workflow" || (selected && item.candidateId === selected.id)
  );
  const comments = [
    ...(data.workflowComments || []).filter((item) => item.scope === "workflow"),
    ...((selected?.comments || []).filter((item) => item.nodeId))
  ];
  const legacyComments = selected ? (selected.comments || []).filter((item) => !item.nodeId) : [];

  return {
    ...map,
    selectedCandidate: selected ? {
      id: selected.id,
      productName: selected.productName,
      targetStore: selected.targetStore,
      workflowStatus: selected.workflowStatus,
      activeNodeId
    } : null,
    nodes: map.nodes.map((node) => ({
      ...node,
      counts: counts[node.id],
      candidateState: !selected
        ? "none"
        : node.id === activeNodeId
          ? activeNodeId === "M12" ? "blocked" : "active"
          : completed.has(node.id) ? "completed" : "pending"
    })),
    comments,
    legacyComments,
    dispatches,
    taskRoutes: data.taskRoutes
  };
}

export function validateNodeExecution(node, scope, candidate) {
  if (!node) throw Object.assign(new Error("小地图节点不存在"), { status: 404 });
  if (!["candidate", "workflow"].includes(scope)) throw Object.assign(new Error("评论范围无效"), { status: 400 });
  if (scope === "candidate" && !candidate) throw Object.assign(new Error("当前商品不存在"), { status: 404 });
  if (scope === "candidate" && ["M08", "M09", "M10", "M11"].includes(node.id) && !["ready_to_list", "listed"].includes(candidate.workflowStatus)) {
    throw Object.assign(new Error("该商品尚未进入待上架，不能派给上架任务"), { status: 409 });
  }
  if (scope === "candidate" && ["M01", "M02", "M03", "M04", "M05", "M06", "M07"].includes(node.id) && ["ready_to_list", "listed"].includes(candidate.workflowStatus)) {
    throw Object.assign(new Error("该商品已交由上架任务负责，不能重新派给选品任务"), { status: 409 });
  }
}
