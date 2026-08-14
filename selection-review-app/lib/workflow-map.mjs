import fs from "node:fs/promises";

export const ACTIVE_DISPATCH_STATES = new Set([
  "queued",
  "waiting_assignee",
  "delivering",
  "received",
  "running",
  "permission_required"
]);

export const RECOVERABLE_TERMINAL_DISPATCH_STATES = new Set([
  "failed",
  "blocked",
  "needs_decision",
  "responded_unverified"
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
  data.evidencePacks ||= [];
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

export function dispatchDeliveryGroups(dispatches = [], taskRoutes = {}) {
  const groups = new Map();
  for (const dispatch of dispatches) {
    const route = taskRoutes?.[dispatch.assigneeRole] || {};
    const key = dispatch.assigneeThreadId || route.threadId || dispatch.assigneeRole;
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(dispatch);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function migrateLegacyCStageOwnership(data, timestamp = new Date().toISOString()) {
  ensureCollaborationData(data);
  const listingRoute = data.taskRoutes.listing_task;
  let changed = false;
  const migratedCandidateIds = new Set();

  for (const dispatch of data.dispatches) {
    if (
      dispatch.nodeId !== "M07" ||
      dispatch.assigneeRole !== "selection_task" ||
      !ACTIVE_DISPATCH_STATES.has(dispatch.status)
    ) continue;
    const candidate = data.candidates?.find((item) => item.id === dispatch.candidateId);
    if (!candidate || !["listing_preparation", "ready_to_list"].includes(candidate.workflowStatus)) continue;

    dispatch.assigneeRole = "listing_task";
    dispatch.assigneeThreadId = listingRoute.threadId;
    dispatch.assigneeTitle = listingRoute.title;
    dispatch.status = "queued";
    dispatch.runId = null;
    dispatch.turnId = null;
    dispatch.failureLayer = "";
    dispatch.error = "";
    dispatch.deliveryDetail = "";
    dispatch.deliveryAttemptedAt = null;
    dispatch.lastEventAt = timestamp;
    dispatch.message = String(dispatch.message || "")
      .replaceAll("选品任务", "上架任务")
      .replaceAll("选品负责人", "上架负责人");

    candidate.listingHandoff = {
      ...(candidate.listingHandoff || {}),
      state: "queued",
      owner: "listing_task",
      runId: null,
      currentStep: "等待上架任务领取C阶段",
      blockReason: null
    };
    candidate.updatedAt = timestamp;
    candidate.lastModifiedBy = "system";
    migratedCandidateIds.add(candidate.id);
    changed = true;
  }

  return { changed, migratedCandidateIds: [...migratedCandidateIds] };
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
  if (candidate.workflowStatus === "listing_preparation") {
    if (["blocked", "needs_decision"].includes(candidate.listingHandoff?.state)) return "M12";
    if (["queued", "claimed", "running", "permission_required"].includes(candidate.listingHandoff?.state)) return "M07";
    return "M08";
  }
  if (candidate.workflowStatus === "ready_to_list") {
    return candidate.listingPreparation?.status === "prepared" && candidate.cCompletedAt ? "M09" : "M08";
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
  const userPath = ["M01", "M04", "M05", "M06", "M08", "M07", "M09", "M10", "M11"];
  const codexPath = ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M07", "M09", "M10", "M11"];
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

export function latestDispatchForCandidate(data, candidateId) {
  return [...(data.dispatches || [])]
    .reverse()
    .find((item) => item.candidateId === candidateId) || null;
}

export function collaborationSummary(data, baseSummary) {
  const processing = data.candidates.filter((item) =>
    ["codex_processing", "listing_preparation", "ready_to_list"].includes(item.workflowStatus)
  );
  const activeByCandidate = new Map();
  const latestByCandidate = new Map();
  for (const dispatch of data.dispatches || []) {
    if (dispatch.candidateId) latestByCandidate.set(dispatch.candidateId, dispatch);
    if (dispatch.candidateId && ACTIVE_DISPATCH_STATES.has(dispatch.status)) {
      activeByCandidate.set(dispatch.candidateId, dispatch);
    }
  }
  const hasRecoverableTerminal = (candidate) => {
    const latest = latestByCandidate.get(candidate.id);
    if (!RECOVERABLE_TERMINAL_DISPATCH_STATES.has(latest?.status)) return false;
    const revisionMatches = latest.dataRevision === null || latest.dataRevision === undefined ||
      Number(latest.dataRevision) === Number(candidate.dataRevision);
    const stageMatches = !latest.workflowStatusAtDispatch || latest.workflowStatusAtDispatch === candidate.workflowStatus;
    return revisionMatches && stageMatches;
  };
  const received = [...activeByCandidate.values()].filter((item) => ["received", "permission_required"].includes(item.status)).length;
  const dispatched = [...activeByCandidate.values()].filter((item) => ["queued", "waiting_assignee", "delivering"].includes(item.status)).length;
  const authorized = processing.filter((candidate) =>
    candidate.processing?.state === "queued" &&
    candidate.processing?.manualHold !== true &&
    !activeByCandidate.has(candidate.id) &&
    !hasRecoverableTerminal(candidate)
  ).length;
  return {
    ...(baseSummary || {}),
    actualRunning: [...activeByCandidate.values()].filter((dispatch) => dispatch.status === "running" && dispatch.runId).length,
    received,
    dispatched,
    authorized,
    stopped: processing.filter((candidate) => {
      if (candidate.workflowStatus === "codex_processing") {
        return candidate.processing?.manualHold === true ||
          ["blocked", "deferred"].includes(candidate.processing?.state) ||
          hasRecoverableTerminal(candidate);
      }
      return ["blocked", "needs_decision", "paused_user_stopped"].includes(candidate.listingHandoff?.state) ||
        hasRecoverableTerminal(candidate);
    }).length,
    stateAnomaly: processing.filter((candidate) =>
      (candidate.workflowStatus === "codex_processing" && candidate.processing?.state === "running" && !candidate.processing?.runId) ||
      (candidate.workflowStatus !== "codex_processing" && candidate.listingHandoff?.state === "running" && !candidate.listingHandoff?.runId)
    ).length
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
    if (candidate.processingStatus?.actualRunning || candidate.activeDispatch?.status === "running") counts[nodeId].running += 1;
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
  if (scope === "candidate" && ["M07", "M08", "M09", "M10", "M11"].includes(node.id) && !["listing_preparation", "ready_to_list", "listed"].includes(candidate.workflowStatus)) {
    throw Object.assign(new Error("该商品尚未进入待上架，不能派给上架任务"), { status: 409 });
  }
  if (scope === "candidate" && ["M01", "M02", "M03", "M04", "M05", "M06"].includes(node.id) && ["listing_preparation", "ready_to_list", "listed"].includes(candidate.workflowStatus)) {
    throw Object.assign(new Error("该商品已交由上架任务负责，不能重新派给选品任务"), { status: 409 });
  }
}
