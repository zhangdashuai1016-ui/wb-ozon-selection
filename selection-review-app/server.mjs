import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PACKAGING_COST_RMB,
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  NO_PROGRESS_TIMEOUT_MINUTES,
  DEFAULT_RULES,
  WORKFLOW_STATUSES,
  promotionPricingGate,
  approvalGate,
  codexAutoEliminationGate,
  businessDate,
  claimEligible,
  dailySummary,
  dispatchQueueSummary,
  filterUserNeededFields,
  processingStatusSummary,
  isActualProcessingRun,
  recordProcessingProgress,
  registerProcessingAttempt,
  recentAvoidanceFeedback,
  requiredInputFields,
  selectionStage,
  purchaseCeilingSummary,
  queueUserDispatch,
  sortDispatchQueue,
  stopNoProgressRuns,
  technicalFailureDisposition,
  validateListingRecord,
  validateListingReadback,
  wbAssessmentDecisionGate
} from "./lib/workflow.mjs";
import {
  ACTIVE_DISPATCH_STATES,
  activeDispatchForCandidate,
  candidateActiveNode,
  collaborationSummary,
  dispatchOwnerForNode,
  ensureCollaborationData,
  readWorkflowMap,
  validateNodeExecution,
  workflowMapView
} from "./lib/workflow-map.mjs";
import { CodexDispatcher } from "./lib/codex-dispatcher.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.SELECTION_REVIEW_DATA_FILE || path.join(appDir, "data", "candidates.json");
const workflowMapFile = process.env.SELECTION_REVIEW_WORKFLOW_MAP_FILE || path.join(appDir, "data", "workflow-map.json");
const imagesDir = path.join(appDir, "product-images");
const distDir = path.join(appDir, "dist");
const apiOnly = process.argv.includes("--api-only");
const port = apiOnly ? Number(process.env.SELECTION_REVIEW_API_PORT || 4318) : Number(process.env.SELECTION_REVIEW_PORT || 4317);
const host = "127.0.0.1";
const automationConcurrencyLimit = Math.min(
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  Math.max(1, Number(process.env.SELECTION_REVIEW_CONCURRENCY_LIMIT || DEFAULT_AUTOMATION_CONCURRENCY_LIMIT))
);
const explicitDispatchDeliveryEnabled = process.env.SELECTION_REVIEW_AUTO_DELIVER !== "off";

const USER_FIELDS = [
  "targetStore",
  "productUrl",
  "productName",
  "sourceUrl",
  "competitorUrl",
  "purchasePriceRmb",
  "packagingCostRmb",
  "moq",
  "netWeightKg",
  "packedWeightKg",
  "dimensionsCm",
  "materialsAndAge",
  "powered",
  "complianceStatus",
  "authorizationStatus",
  "expectedPriceRub",
  "sellerRevenueCny",
  "imageUrl",
  "notes",
  "acceptedTestRisk"
];

const DEFAULTED_USER_FIELDS = new Set([
  "domesticShippingRmb",
  "packagingCostRmb",
  "complianceStatus",
  "authorizationStatus"
]);

let mutationQueue = Promise.resolve();

function currentProfitRule(persisted, current) {
  return {
    ...current,
    ...(persisted || {}),
    pricingPolicyVersion: current.pricingPolicyVersion,
    advertisingReserveRate: 0,
    advertisingReserveScenarios: undefined,
    decisionAdvertisingScenario: undefined,
    stressAdvertisingScenario: undefined,
    promotionDiscountScenarios: current.promotionDiscountScenarios,
    decisionPromotionScenario: current.decisionPromotionScenario,
    thresholdPolicy: "either",
    note: current.note
  };
}

function candidateProfitRule(candidate, rules) {
  if (candidate.targetStore === "miska") return rules.ozonMiska;
  if (candidate.targetStore === "wb") return rules.wbCrossListing;
  return rules.ozonDandanshu;
}

function now() {
  return new Date().toISOString();
}

function json(res, status, responseBody) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(responseBody));
}

async function requestBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw httpError(413, "请求内容过大");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求不是有效JSON");
  }
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

async function readData() {
  const data = JSON.parse(await fs.readFile(dataFile, "utf8"));
  if (Number(data.meta?.version || 1) !== 2) {
    throw new Error("候选数据尚未迁移到v2");
  }
  data.rules = {
    ...DEFAULT_RULES,
    ...(data.rules || {}),
    selectionFlow: {
      ...DEFAULT_RULES.selectionFlow,
      ...(data.rules?.selectionFlow || {}),
      stageBoundaries: {
        ...DEFAULT_RULES.selectionFlow.stageBoundaries,
        ...(data.rules?.selectionFlow?.stageBoundaries || {}),
        A: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.A,
          ...(data.rules?.selectionFlow?.stageBoundaries?.A || {})
        },
        B: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.B,
          ...(data.rules?.selectionFlow?.stageBoundaries?.B || {})
        },
        C: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.C,
          ...(data.rules?.selectionFlow?.stageBoundaries?.C || {})
        }
      },
      antiIdleRun: {
        ...DEFAULT_RULES.selectionFlow.antiIdleRun,
        ...(data.rules?.selectionFlow?.antiIdleRun || {})
      },
      technicalFailurePolicy: DEFAULT_RULES.selectionFlow.technicalFailurePolicy,
      retryPolicy: DEFAULT_RULES.selectionFlow.retryPolicy,
      note: DEFAULT_RULES.selectionFlow.note
    },
    dailyTargets: {
      ...DEFAULT_RULES.dailyTargets,
      ...(data.rules?.dailyTargets || {}),
      cadence: DEFAULT_RULES.dailyTargets.cadence,
      automaticAuditEnabled: false
    },
    purchaseInput: {
      ...DEFAULT_RULES.purchaseInput,
      ...(data.rules?.purchaseInput || {}),
      scope: DEFAULT_RULES.purchaseInput.scope,
      domesticShippingRmb: 0,
      note: DEFAULT_RULES.purchaseInput.note
    },
    ozonDandanshu: currentProfitRule(data.rules?.ozonDandanshu, DEFAULT_RULES.ozonDandanshu),
    ozonMiska: currentProfitRule(data.rules?.ozonMiska, DEFAULT_RULES.ozonMiska),
    wbCrossListing: currentProfitRule(data.rules?.wbCrossListing, DEFAULT_RULES.wbCrossListing),
    selectionDirections: {
      ...DEFAULT_RULES.selectionDirections,
      ...(data.rules?.selectionDirections || {}),
      dandanshu: {
        ...DEFAULT_RULES.selectionDirections.dandanshu,
        ...(data.rules?.selectionDirections?.dandanshu || {}),
        minimumCrossBorderShare: 0.4,
        requirePositivePurchaseSpaceBeforeSourceSearch: true,
        automaticRetryEnabled: false
      },
      miska: {
        ...DEFAULT_RULES.selectionDirections.miska,
        ...(data.rules?.selectionDirections?.miska || {}),
        automaticAdditionEnabled: false,
        pauseReason: DEFAULT_RULES.selectionDirections.miska.pauseReason,
        userSampleReviewThreshold: DEFAULT_RULES.selectionDirections.miska.userSampleReviewThreshold
      },
      note: DEFAULT_RULES.selectionDirections.note
    }
  };
  return ensureCollaborationData(data);
}

async function persistData(data) {
  const tempFile = `${dataFile}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, dataFile);
}

function mutateData(mutator) {
  const operation = mutationQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    await persistData(data);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function mutateDataWhenChanged(mutator) {
  const operation = mutationQueue.then(async () => {
    const data = await readData();
    const outcome = await mutator(data);
    if (!outcome?.changed) return outcome?.result;
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    await persistData(data);
    return outcome.result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function dispatchPublic(dispatch) {
  if (!dispatch) return null;
  return {
    ...dispatch,
    message: dispatch.message,
    pendingApproval: dispatch.pendingApproval || null
  };
}

function appendNodeReply(data, dispatch, message, status = "responded") {
  const text = String(message || "").trim();
  if (!text || dispatch.replyCommentId) return;
  const comment = {
    id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor: "codex",
    message: text,
    nodeId: dispatch.nodeId,
    scope: dispatch.scope,
    dispatchId: dispatch.id,
    replyTo: dispatch.commentId || null,
    requiresResponse: status === "needs_decision",
    status,
    at: now()
  };
  if (dispatch.scope === "workflow") {
    data.workflowComments.push(comment);
  } else {
    const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
    if (candidate) {
      candidate.comments ||= [];
      candidate.comments.push(comment);
    }
  }
  dispatch.replyCommentId = comment.id;
}

async function handleDispatcherEvent(event) {
  if (event.type === "assistant_delta") return;
  await mutateDataWhenChanged((data) => {
    const dispatch = (data.dispatches || []).find((item) => item.id === event.dispatchId);
    if (!dispatch) return { changed: false };
    const timestamp = now();
    if (event.type === "approval") {
      dispatch.status = "permission_required";
      dispatch.pendingApproval = event.approval;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "assistant_message") {
      dispatch.agentReply = event.text;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "turn_completed") {
      dispatch.turnCompletedAt = timestamp;
      dispatch.turnStatus = event.status;
      dispatch.error = event.error || dispatch.error || "";
      if (!["completed", "blocked", "needs_decision"].includes(dispatch.status)) {
        dispatch.status = event.error ? "failed" : "responded_unverified";
        dispatch.failureLayer = event.error ? "codex_turn" : "missing_business_readback";
      }
      appendNodeReply(
        data,
        dispatch,
        dispatch.agentReply || (event.error ? `任务失败：${event.error}` : "任务已回复，但没有取得可验证的数据回写。"),
        dispatch.status === "needs_decision" ? "needs_decision" : "responded"
      );
    } else {
      return { changed: false };
    }
    return { changed: true, result: dispatchPublic(dispatch) };
  });
}

const codexDispatcher = new CodexDispatcher({ onEvent: (event) => {
  handleDispatcherEvent(event).catch((error) => console.error("派发事件保存失败", error));
} });

async function deliverDispatch(dispatchId) {
  let delivery;
  await mutateData((data) => {
    const dispatch = data.dispatches.find((item) => item.id === dispatchId);
    if (!dispatch || !["queued", "waiting_assignee"].includes(dispatch.status)) return null;
    dispatch.status = "delivering";
    dispatch.deliveryAttemptedAt = now();
    dispatch.lastEventAt = dispatch.deliveryAttemptedAt;
    delivery = {
      dispatch: { ...dispatch },
      route: { ...data.taskRoutes[dispatch.assigneeRole] },
      candidate: dispatch.candidateId ? data.candidates.find((item) => item.id === dispatch.candidateId) : null
    };
    return dispatch;
  });
  if (!delivery) return null;

  const map = await readWorkflowMap(workflowMapFile);
  const node = map.nodes.find((item) => item.id === delivery.dispatch.nodeId);
  try {
    const outcome = await codexDispatcher.deliver(delivery.dispatch, delivery.route, node, delivery.candidate);
    return await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch) return null;
      dispatch.status = outcome.status;
      dispatch.turnId = outcome.turnId || null;
      dispatch.deliveryDetail = outcome.detail || "";
      dispatch.deliveredAt = outcome.status === "received" ? now() : null;
      dispatch.lastEventAt = now();
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = "verified";
      route.verifiedAt = now();
      route.lastError = "";
      return dispatchPublic(dispatch);
    });
  } catch (error) {
    return mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch) return null;
      dispatch.status = "failed";
      dispatch.failureLayer = "codex_app_server";
      dispatch.error = error.message;
      dispatch.lastEventAt = now();
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = "failed";
      route.lastError = error.message;
      return dispatchPublic(dispatch);
    });
  }
}

async function deliverWaitingDispatches() {
  const data = await readData();
  const waiting = (data.dispatches || []).filter((item) => ["queued", "waiting_assignee"].includes(item.status));
  for (const dispatch of waiting) {
    await deliverDispatch(dispatch.id);
  }
}

function createDispatchRecord(data, { node, scope, candidate = null, message, commentId = null, trigger = "node_comment" }) {
  const assigneeRole = dispatchOwnerForNode(node, scope);
  const duplicate = (data.dispatches || []).find((item) =>
    item.scope === scope &&
    item.nodeId === node.id &&
    item.candidateId === (candidate?.id || null) &&
    ACTIVE_DISPATCH_STATES.has(item.status)
  );
  if (duplicate) throw httpError(409, "该节点已有一次工作正在等待或执行，不能重复派发", { dispatchId: duplicate.id });
  const timestamp = now();
  const dispatch = {
    id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scope,
    nodeId: node.id,
    nodeTitle: node.title,
    candidateId: candidate?.id || null,
    dataRevision: candidate ? Number(candidate.dataRevision) : null,
    workflowStatusAtDispatch: candidate?.workflowStatus || null,
    assigneeRole,
    assigneeThreadId: data.taskRoutes?.[assigneeRole]?.threadId || null,
    assigneeTitle: data.taskRoutes?.[assigneeRole]?.title || node.owner,
    message: String(message || "").trim(),
    commentId,
    trigger,
    status: "queued",
    runId: null,
    turnId: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    pendingApproval: null,
    agentReply: "",
    completionEvidence: "",
    productionAuthorized: false
  };
  data.dispatches.push(dispatch);
  return dispatch;
}

function appendControlAlert(data, alert) {
  data.controlAlerts ||= [];
  if (data.controlAlerts.some((item) => item.dedupeKey === alert.dedupeKey)) return false;
  data.controlAlerts.push(alert);
  return true;
}

async function stopRunsWithoutProgress() {
  return mutateDataWhenChanged((data) => {
    const alerts = stopNoProgressRuns(data.candidates, new Date(), NO_PROGRESS_TIMEOUT_MINUTES);
    if (!alerts.length) return { changed: false, result: [] };
    for (const alert of alerts) {
      const candidate = data.candidates.find((item) => item.id === alert.candidateId);
      if (candidate) {
        addHistory(candidate, "system", "stoppedNoProgress", alert.message, alert.createdAt);
        candidate.updatedAt = alert.createdAt;
        candidate.lastModifiedBy = "system";
      }
      appendControlAlert(data, alert);
    }
    return { changed: true, result: alerts };
  });
}

function cleanUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    const kept = new URLSearchParams();
    for (const key of ["offerId", "hotSaleSkuId", "sku", "skuId", "product_id"]) {
      if (parsed.searchParams.has(key)) kept.set(key, parsed.searchParams.get(key));
    }
    parsed.search = kept.toString();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function candidateLinks(candidate) {
  return [candidate.productUrl, candidate.sourceUrl, candidate.competitorUrl]
    .map(cleanUrl)
    .filter(Boolean);
}

function duplicateCandidate(candidates, links, exceptId = "") {
  const requested = new Set(links.map(cleanUrl).filter(Boolean));
  if (!requested.size) return null;
  return candidates.find(
    (candidate) =>
      candidate.id !== exceptId &&
      candidateLinks(candidate).some((link) => requested.has(link))
  );
}

function nextCandidateId(candidates, prefix) {
  const date = businessDate().replaceAll("-", "");
  const base = `${prefix}-${date}-`;
  const highest = candidates.reduce((maximum, candidate) => {
    if (!candidate.id.startsWith(base)) return maximum;
    return Math.max(maximum, Number(candidate.id.slice(base.length)) || 0);
  }, 0);
  return `${base}${String(highest + 1).padStart(3, "0")}`;
}

function addHistory(candidate, actor, action, detail, at = now()) {
  candidate.history ||= [];
  candidate.history.push({
    id: `H-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    action,
    detail,
    at
  });
}

function queuedProcessing(previous = {}) {
  return {
    state: "queued",
    runId: null,
    startedAt: null,
    claimRevision: null,
    attempts: Number(previous.attempts || 0),
    attemptsToday: Number(previous.attemptsToday || 0),
    lastAttemptAt: previous.lastAttemptAt || null,
    lastError: previous.lastError || null,
    blockReason: previous.blockReason || null,
    userAction: previous.userAction || "",
    readAttempts: Array.isArray(previous.readAttempts) ? previous.readAttempts : [],
    deferredUntil: previous.deferredUntil || null,
    deferredRunId: previous.deferredRunId || null,
    lastAttemptRevision: previous.lastAttemptRevision ?? null,
    lastAttemptBusinessDate: previous.lastAttemptBusinessDate || null,
    dispatchState: previous.dispatchState || null,
    dispatchPriority: previous.dispatchPriority || null,
    dispatchRequestedAt: previous.dispatchRequestedAt || null,
    dispatchTrigger: previous.dispatchTrigger || null,
    manualHold: previous.manualHold === true,
    normalizedAt: previous.normalizedAt || null,
    normalizedFrom: previous.normalizedFrom || null,
    recoveryOptions: Array.isArray(previous.recoveryOptions) ? previous.recoveryOptions : [],
    currentStep: previous.currentStep || "",
    lastProgressAt: previous.lastProgressAt || null,
    progressEvents: Array.isArray(previous.progressEvents) ? previous.progressEvents : [],
    attemptLedger: Array.isArray(previous.attemptLedger) ? previous.attemptLedger : [],
    lastRunId: previous.lastRunId || null,
    stoppedAt: previous.stoppedAt || null,
    stopReason: previous.stopReason || "",
    controlAlertKey: previous.controlAlertKey || ""
  };
}

function completeListing(current, listingRecord, actor, timestamp) {
  current.workflowStatus = "listed";
  current.listingRecord = listingRecord;
  current.listedAt = listingRecord.confirmedAt;
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "completed",
    owner: "listing_task",
    completedAt: listingRecord.confirmedAt,
    completionMethod: listingRecord.method
  };
  current.processing = { ...queuedProcessing(current.processing), state: "idle" };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = actor;
}

function effectiveNeeds(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const reviewNeeds = candidate.codexReview?.needsFromUser;
  const needs = Array.isArray(reviewNeeds) && reviewNeeds.length
    ? reviewNeeds
    : requiredInputFields(candidate).map((item) => item.label);
  return needs.filter(
    (need) => !/包材成本|包装成本|国内运费|合规|认证|授权|权属/.test(String(need))
  );
}

function effectiveNeededFields(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const requested = candidate.codexReview?.needsFromUserFields;
  const valid = Array.isArray(requested)
    ? requested.filter(
        (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
      )
    : [];
  if (valid.length) return filterUserNeededFields(candidate, valid);

  const inferred = [];
  for (const rawNeed of effectiveNeeds(candidate)) {
    const need = String(rawNeed);
    if (/SKU|款式|型号/.test(need)) inferred.push("productName");
    if (/链接|1688|货源/.test(need)) inferred.push(candidate.sourceUrl ? "productUrl" : "sourceUrl");
    if (/采购价|货价|到手总价/.test(need)) inferred.push("purchasePriceRmb");
    if (/重量|实重/.test(need)) inferred.push("packedWeightKg");
    if (/尺寸|长宽高/.test(need)) inferred.push("dimensionsCm");
    if (/非电|带电|电池/.test(need)) inferred.push("powered");
    if (/厚度|防碎|包装说明|补充说明/.test(need)) inferred.push("notes");
  }
  return filterUserNeededFields(candidate, [...new Set(inferred)].filter(
    (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
  ));
}

function publicCandidate(candidate, rules, queueInfo = {}) {
  const userDecision = candidate.userEvaluation?.decision || null;
  const codexDecision = candidate.codexReview?.decision || null;
  const opinionsDiffer =
    Boolean(userDecision && codexDecision) &&
    !(
      (userDecision === "viable" && codexDecision === "approved") ||
      (userDecision === "unsure" && ["approved", "sourcePending", "needsInfo"].includes(codexDecision)) ||
      (userDecision === "reject" && codexDecision === "eliminated")
    );
  return {
    ...candidate,
    processingStatus: processingStatusSummary(candidate, new Date(), queueInfo),
    owner:
      candidate.workflowStatus === "ready_to_list" || candidate.workflowStatus === "listed"
        ? "listing_task"
        : "selection_task",
    purchaseCeiling: purchaseCeilingSummary(candidate, rules),
    displayStatus: candidate.workflowStatus,
    needsFromUser: effectiveNeeds(candidate),
    neededFieldKeys: effectiveNeededFields(candidate),
    approvalGate: approvalGate(candidate, rules),
    selectionStage: selectionStage(candidate, rules),
    wbAssessmentGate: candidate.wbAssessment
      ? wbAssessmentDecisionGate(candidate.wbAssessment, candidate, rules)
      : null,
    unansweredCommentCount: (candidate.comments || []).filter(
      (comment) =>
        comment.actor === "user" &&
        comment.requiresResponse === true &&
        comment.status !== "responded"
    ).length,
    opinionsDiffer
  };
}

function responseState(data) {
  const rules = data.rules || DEFAULT_RULES;
  const dispatch = dispatchQueueSummary(data.candidates, new Date(), automationConcurrencyLimit);
  const candidates = data.candidates.map((candidate) => {
    const publicValue = publicCandidate(candidate, rules, dispatch.positions[candidate.id] || {});
    const activeDispatch = activeDispatchForCandidate(data, candidate.id);
    return {
      ...publicValue,
      activeDispatch: dispatchPublic(activeDispatch)
    };
  });
  return {
    meta: data.meta,
    rules,
    summary: {
      ...dailySummary(data.candidates, rules),
      dispatch: {
        ...dispatch,
        processingCounts: collaborationSummary(data, dispatch.processingCounts)
      },
      controlAlertsPending: (data.controlAlerts || []).filter((item) => !item.acknowledgedAt).length
    },
    candidates
  };
}

function validateStore(store) {
  if (!["dandanshu", "miska", "wb"].includes(store)) {
    throw httpError(400, "请选择目标店铺");
  }
}

function initialCandidate(input, source, id, timestamp) {
  return {
    id,
    source,
    group: source === "user" ? "userAdded" : input.group || "evergreen",
    targetStore: input.targetStore,
    productName: input.productName?.trim() || (source === "user" ? "用户添加的待识别商品" : "Codex新增候选"),
    productUrl: input.productUrl?.trim() || "",
    sourceUrl: input.sourceUrl?.trim() || "",
    competitorUrl: input.competitorUrl?.trim() || "",
    purchasePriceRmb: input.purchasePriceRmb ?? null,
    domesticShippingRmb: 0,
    packagingCostRmb: input.packagingCostRmb ?? DEFAULT_PACKAGING_COST_RMB,
    moq: input.moq ?? null,
    netWeightKg: input.netWeightKg ?? null,
    packedWeightKg: input.packedWeightKg ?? null,
    dimensionsCm: input.dimensionsCm || { length: null, width: null, height: null },
    materialsAndAge: input.materialsAndAge?.trim() || "",
    powered: input.powered ?? "unknown",
    complianceStatus: input.complianceStatus || "clear",
    authorizationStatus: input.authorizationStatus || "clear",
    expectedPriceRub: input.expectedPriceRub ?? null,
    sellerRevenueCny: input.sellerRevenueCny ?? null,
    purchaseCeiling: input.purchaseCeiling || {
      status: "unavailable",
      scope: "purchase_plus_domestic_shipping",
      missing: ["Codex尚未完成方向采购价反算"]
    },
    acceptedTestRisk: input.acceptedTestRisk === true,
    imageUrl: input.imageUrl?.trim() || "",
    notes: input.notes?.trim() || "",
    createdAt: timestamp,
    updatedAt: timestamp,
    reviewedAt: null,
    lastModifiedBy: source,
    userEvaluation: null,
    codexReview: null,
    comments: [],
    history: [],
    workflowStatus: source === "user" ? "codex_processing" : "awaiting_user_direction",
    processing:
      source === "user"
        ? queueUserDispatch({}, timestamp, "user_created")
        : { ...queuedProcessing(), state: "idle" },
    dataRevision: 1,
    selectionDate: businessDate(timestamp),
    readyAt: null,
    eliminatedAt: null,
    eliminationReason: "",
    wbAssessment: null,
    sourceSearchAttempts: Number(input.sourceSearchAttempts || 0),
    sourceSearchAttemptLimit: 3
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    await fs.access(dataFile);
    const data = await readData();
    return json(res, 200, {
      ok: true,
      service: "selection-review-app",
      version: 2,
      dataVersion: data.meta.version,
      checkedAt: now()
    });
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return json(res, 200, responseState(await readData()));
  }

  if (req.method === "GET" && pathname === "/api/workflow-map") {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    const selectedCandidateId = requestUrl.searchParams.get("candidateId") || "";
    const data = await readData();
    const state = responseState(data);
    const map = await readWorkflowMap(workflowMapFile);
    return json(res, 200, workflowMapView(map, data, state.candidates, selectedCandidateId));
  }

  if (req.method === "POST" && pathname === "/api/node-comments") {
    const input = await requestBody(req);
    if (!input.nodeId?.trim() || !input.message?.trim()) {
      throw httpError(400, "节点留言必须包含节点和内容");
    }
    if (input.action !== "record") {
      throw httpError(409, "小地图只保存节点留言；请回到商品评审主界面派发当前SKU");
    }
    const map = await readWorkflowMap(workflowMapFile);
    const node = map.nodes.find((item) => item.id === input.nodeId.trim());
    const result = await mutateData((data) => {
      const scope = input.scope === "workflow" ? "workflow" : "candidate";
      const candidate = scope === "candidate"
        ? data.candidates.find((item) => item.id === input.candidateId)
        : null;
      validateNodeExecution(node, scope, candidate);
      if (candidate && Number(candidate.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "商品资料已变化，请刷新小地图后重新提交");
      }
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: input.message.trim(),
        nodeId: node.id,
        scope,
        dispatchId: null,
        requiresResponse: false,
        status: "recorded",
        replyTo: null,
        at: timestamp
      };
      if (scope === "workflow") data.workflowComments.push(comment);
      else {
        candidate.comments ||= [];
        candidate.comments.push(comment);
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = "user";
        addHistory(candidate, "user", "nodeCommented", `在${node.id} ${node.title}提交记录留言`, timestamp);
      }
      return { comment, dispatch: null };
    });
    json(res, 201, result);
    return;
  }

  const candidateDispatchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && candidateDispatchRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "派发必须提供当前数据修订号");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const candidate = data.candidates.find((item) => item.id === candidateDispatchRoute[1]);
      if (!candidate) throw httpError(404, "候选不存在");
      if (Number(candidate.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新派发");
      }
      if (candidate.workflowStatus === "codex_processing") {
        if (candidate.processing?.state !== "queued" || candidate.processing?.manualHold === true) {
          throw httpError(409, "当前商品尚未获得派发许可；已停止商品必须先在主界面选择恢复方式");
        }
      } else if (candidate.workflowStatus === "ready_to_list") {
        if (["paused_user_stopped", "blocked"].includes(candidate.listingHandoff?.state)) {
          throw httpError(409, "当前上架任务已被主人停止，必须先明确恢复范围");
        }
      } else {
        throw httpError(409, "当前业务阶段不能直接派发");
      }
      const nodeId = candidateActiveNode(candidate);
      const node = map.nodes.find((item) => item.id === nodeId);
      validateNodeExecution(node, "candidate", candidate);
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: "主人从商品评审主界面明确派发当前SKU一次",
        nodeId: node.id,
        scope: "candidate",
        dispatchId: null,
        requiresResponse: true,
        status: "pending",
        replyTo: null,
        at: timestamp
      };
      candidate.comments ||= [];
      candidate.comments.push(comment);
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = "user";
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate,
        message: comment.message,
        commentId: comment.id,
        trigger: "review_ui_dispatch"
      });
      comment.dispatchId = dispatch.id;
      dispatchId = dispatch.id;
      addHistory(candidate, "user", "reviewUiDispatched", `从商品评审主界面向${dispatch.assigneeTitle || dispatch.assigneeRole}派发当前SKU一次`, timestamp);
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 201, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("主界面一次性派发失败", error)), 0);
    return;
  }

  const productionAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/production-authorization$/);
  if (req.method === "POST" && productionAuthorizationRoute) {
    const input = await requestBody(req);
    const requiredText = ["platform", "store", "product", "sku", "price", "stock", "publishScope"];
    const missing = requiredText.filter((field) => !String(input[field] ?? "").trim());
    if (missing.length || !Array.isArray(input.assets) || !input.assets.filter((item) => String(item).trim()).length || input.confirmed !== true) {
      throw httpError(400, "生产确认必须完整填写平台、店铺、商品、SKU、价格、库存、素材、发布范围并明确勾选确认");
    }
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "生产确认必须提供当前数据修订号");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === productionAuthorizationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "ready_to_list") throw httpError(409, "只有待上架商品可以记录生产确认");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认生产范围");
      const expectedPlatform = current.targetStore === "wb" ? "WB" : "Ozon";
      if (input.platform !== expectedPlatform) throw httpError(409, `当前商品目标平台是${expectedPlatform}，不能跨平台复用确认`);
      const timestamp = now();
      current.productionAuthorization = {
        status: "confirmed",
        platform: input.platform,
        store: String(input.store).trim(),
        product: String(input.product).trim(),
        sku: String(input.sku).trim(),
        price: String(input.price).trim(),
        stock: String(input.stock).trim(),
        assets: input.assets.map((item) => String(item).trim()).filter(Boolean),
        publishScope: String(input.publishScope).trim(),
        exclusions: String(input.exclusions || "").trim(),
        confirmedAt: timestamp,
        confirmedBy: "user",
        consumedAt: null
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "productionScopeConfirmed", `已确认${input.platform}/${String(input.store).trim()}的SKU ${String(input.sku).trim()}生产范围；尚未执行店铺写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const dispatchClaimRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/claim$/);
  if (req.method === "POST" && dispatchClaimRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "领取一次性派发必须提供runId和当前真实步骤");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchClaimRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (!["received", "permission_required"].includes(dispatch.status)) {
        throw httpError(409, "该派发尚未被目标任务接收或已经结束");
      }
      const timestamp = now();
      dispatch.status = "running";
      dispatch.runId = input.runId.trim();
      dispatch.currentStep = input.currentStep.trim();
      dispatch.startedAt = timestamp;
      dispatch.lastProgressAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (!candidate) throw httpError(404, "派发对应商品不存在");
        if (Number(candidate.dataRevision) !== Number(dispatch.dataRevision)) {
          throw httpError(409, "商品资料已变化，本次派发失效");
        }
        if (candidate.processing?.state === "running" && candidate.processing?.runId !== dispatch.runId) {
          throw httpError(409, "同一SKU已有另一个负责人正在运行");
        }
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "running",
          runId: dispatch.runId,
          startedAt: timestamp,
          currentStep: dispatch.currentStep,
          lastProgressAt: timestamp,
          claimRevision: candidate.dataRevision,
          dispatchState: "claimed",
          manualHold: false,
          attempts: Number(candidate.processing?.attempts || 0) + 1,
          progressEvents: []
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
        addHistory(candidate, "codex", "oneShotClaimed", `一次性派发${dispatch.id}已开始：${dispatch.currentStep}`, timestamp);
      }
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const dispatchProgressRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/progress$/);
  if (req.method === "POST" && dispatchProgressRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "记录派发进展必须提供runId和当前步骤");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchProgressRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (dispatch.status !== "running" || dispatch.runId !== input.runId.trim()) {
        throw httpError(409, "只能更新当前实际运行的一次性派发");
      }
      const timestamp = now();
      dispatch.currentStep = input.currentStep.trim();
      dispatch.lastProgressAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.progressEvents ||= [];
      dispatch.progressEvents.push({ at: timestamp, step: dispatch.currentStep, evidence: String(input.evidence || "").trim() });
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (candidate?.processing?.runId !== dispatch.runId) throw httpError(409, "SKU运行编号已变化");
        candidate.processing.currentStep = dispatch.currentStep;
        candidate.processing.lastProgressAt = timestamp;
        candidate.processing.progressEvents ||= [];
        candidate.processing.progressEvents.push({ at: timestamp, type: "dispatch_progress", step: dispatch.currentStep, evidenceRef: String(input.evidence || "").trim() });
        candidate.updatedAt = timestamp;
        addHistory(candidate, "codex", "oneShotProgress", `${dispatch.currentStep}${input.evidence ? `；证据：${String(input.evidence).trim()}` : ""}`, timestamp);
      }
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const dispatchCompleteRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/complete$/);
  if (req.method === "POST" && dispatchCompleteRoute) {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !["completed", "blocked", "needs_decision"].includes(input.status) || !input.reply?.trim()) {
      throw httpError(400, "收口派发必须提供runId、真实状态和给主人回复");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchCompleteRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (dispatch.runId !== input.runId.trim() || !["running", "permission_required"].includes(dispatch.status)) {
        throw httpError(409, "只能收口当前运行的一次性派发");
      }
      const timestamp = now();
      let finalStatus = input.status;
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (!candidate) throw httpError(404, "派发对应商品不存在");
        if (
          input.status === "completed" &&
          Number(candidate.dataRevision) === Number(dispatch.dataRevision) &&
          candidate.workflowStatus === dispatch.workflowStatusAtDispatch &&
          !String(input.evidence || "").trim()
        ) finalStatus = "responded_unverified";
        if (candidate.processing?.runId === dispatch.runId) {
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: input.status === "completed" ? "idle" : "blocked",
            runId: null,
            startedAt: null,
            currentStep: input.status === "completed" ? "本次派发已结束" : "已停止：等待主人决定",
            lastRunId: dispatch.runId,
            lastProgressAt: timestamp,
            dispatchState: input.status === "completed" ? "completed" : "blocked",
            manualHold: input.status !== "completed",
            blockReason: input.status === "completed" ? null : input.reply.trim(),
            userAction: input.status === "needs_decision" ? input.reply.trim() : ""
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = dispatch.assigneeRole;
          addHistory(candidate, "codex", "oneShotCompleted", `一次性派发${finalStatus}：${input.reply.trim()}`, timestamp);
        }
      }
      dispatch.status = finalStatus;
      dispatch.agentReply = input.reply.trim();
      dispatch.completionEvidence = String(input.evidence || "").trim();
      dispatch.completedAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      appendNodeReply(data, dispatch, input.reply.trim(), input.status === "needs_decision" ? "needs_decision" : "responded");
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const dispatchApprovalRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/approval$/);
  if (req.method === "POST" && dispatchApprovalRoute) {
    const input = await requestBody(req);
    if (!input.requestId || !["accept", "decline", "cancel"].includes(input.decision)) {
      throw httpError(400, "权限决定必须是允许、拒绝或取消本次");
    }
    const data = await readData();
    const dispatch = data.dispatches.find((item) => item.id === dispatchApprovalRoute[1]);
    if (!dispatch?.pendingApproval || String(dispatch.pendingApproval.requestId) !== String(input.requestId)) {
      throw httpError(409, "权限请求已失效，请刷新");
    }
    try {
      codexDispatcher.resolveApproval(dispatch.id, String(input.requestId), input.decision);
    } catch (error) {
      throw httpError(409, error.message);
    }
    const updated = await mutateData((currentData) => {
      const current = currentData.dispatches.find((item) => item.id === dispatch.id);
      current.pendingApproval = null;
      current.status = input.decision === "accept" ? "running" : "blocked";
      current.permissionDecision = { decision: input.decision, at: now() };
      current.lastEventAt = now();
      return dispatchPublic(current);
    });
    return json(res, 200, { dispatch: updated });
  }

  if (req.method === "GET" && pathname === "/api/control/alerts") {
    const data = await readData();
    const alerts = (data.controlAlerts || []).filter((item) => !item.acknowledgedAt);
    return json(res, 200, { alerts });
  }

  const controlAlertAckRoute = pathname.match(/^\/api\/control\/alerts\/([^/]+)\/ack$/);
  if (req.method === "POST" && controlAlertAckRoute) {
    const alertId = controlAlertAckRoute[1];
    const alert = await mutateData((data) => {
      const current = (data.controlAlerts || []).find((item) => item.id === alertId);
      if (!current) throw httpError(404, "总控提醒不存在");
      if (!current.acknowledgedAt) current.acknowledgedAt = now();
      return current;
    });
    return json(res, 200, { alert });
  }

  if (req.method === "POST" && pathname === "/api/control/resume") {
    const input = await requestBody(req);
    if (!input.candidateId || !input.recoveryPath?.trim()) {
      throw httpError(400, "总控恢复必须指定candidateId和唯一恢复路径");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "总控恢复必须提供当前数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    const node = map.nodes.find((item) => item.id === "M12");
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选数据已变化，请刷新后重新确认恢复方式");
      }
      if (
        current.workflowStatus !== "codex_processing" ||
        current.processing?.manualHold !== true ||
        !["blocked", "queued", "deferred"].includes(current.processing?.state)
      ) {
        throw httpError(409, "只有已停止待总控确认的候选可以恢复");
      }
      const timestamp = now();
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "queued",
        runId: null,
        startedAt: null,
        currentStep: "",
        lastProgressAt: null,
        progressEvents: [],
        attemptLedger: [],
        manualHold: false,
        dispatchState: "requested",
        dispatchPriority: "control",
        dispatchRequestedAt: timestamp,
        dispatchTrigger: "control_resume",
        recoveryPath: input.recoveryPath.trim(),
        blockReason: null,
        userAction: "",
        stoppedAt: null,
        stopReason: "",
        controlAlertKey: ""
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "control";
      addHistory(current, "control", "resumeAuthorized", `总控允许按指定路径恢复：${input.recoveryPath.trim()}`, timestamp);
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate: current,
        message: `按这一次指定恢复路径继续：${input.recoveryPath.trim()}`,
        trigger: "control_resume"
      });
      dispatchId = dispatch.id;
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("恢复派发失败", error)), 0);
    return;
  }

  if (req.method === "GET" && pathname === "/api/automation/work") {
    const data = await readData();
    const state = responseState(data);
    const publicById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
    const automationEnabled = data.meta?.automationStarted === true;
    const dispatchQueue = automationEnabled ? sortDispatchQueue(data.candidates) : [];
    return json(res, 200, {
      automationEnabled,
      disabledReason: automationEnabled ? "" : "自动化已关闭；等待总控明确开启",
      notificationPolicy: "健康检查、队列不变和重复证据保持静默",
      summary: state.summary,
      queued: dispatchQueue.map((candidate) => publicById.get(candidate.id)),
      urgent: dispatchQueue
        .filter((candidate) => candidate.processing?.dispatchState === "requested")
        .map((candidate) => publicById.get(candidate.id)),
      wbReassessment: state.candidates.filter(
        () => false
      ),
      handoffPending: state.candidates.filter(
        (candidate) =>
          candidate.workflowStatus === "ready_to_list" &&
          candidate.listingHandoff?.state === "queued"
      ),
      avoidanceFeedback: recentAvoidanceFeedback(data.candidates),
      rules: state.rules
    });
  }

  if (req.method === "POST" && pathname === "/api/automation/claim") {
    const input = await requestBody(req);
    if (!input.runId?.trim()) throw httpError(400, "自动审核必须提供runId");
    if (!input.initialStep?.trim()) throw httpError(400, "自动审核必须提供当前执行步骤");
    const result = await mutateData((data) => {
      if (data.meta?.automationStarted !== true) {
        throw httpError(409, "自动化已关闭，只有总控明确开启后才能领取任务");
      }
      const running = data.candidates.filter(
        (candidate) => candidate.workflowStatus === "codex_processing" && isActualProcessingRun(candidate.processing)
      ).sort((a, b) => {
        const timeDifference = new Date(a.processing.startedAt).getTime() - new Date(b.processing.startedAt).getTime();
        return timeDifference || a.id.localeCompare(b.id);
      });
      const alreadyRunning = input.candidateId
        ? running.find((candidate) => candidate.id === input.candidateId)
        : null;
      if (alreadyRunning) {
        return {
          candidate: null,
          alreadyRunning: {
            candidateId: alreadyRunning.id,
            runId: alreadyRunning.processing.runId,
            startedAt: alreadyRunning.processing.startedAt
          }
        };
      }
      const duplicateRunId = running.find(
        (candidate) => candidate.processing?.runId === input.runId.trim()
      );
      if (duplicateRunId) {
        throw httpError(409, "runId已被另一条运行中候选使用", {
          candidateId: duplicateRunId.id
        });
      }
      if (running.length >= automationConcurrencyLimit) {
        return {
          candidate: null,
          busy: {
            candidateId: running[0].id,
            candidateIds: running.map((candidate) => candidate.id),
            startedAt: running[0].processing.startedAt,
            concurrencyLimit: automationConcurrencyLimit,
            availableSlots: 0
          }
        };
      }
      const queue = sortDispatchQueue(data.candidates).filter(
        (candidate) =>
          candidate.processing?.deferredRunId !== input.runId.trim() &&
          (!input.candidateId || candidate.id === input.candidateId)
      );
      const candidate = queue[0];
      if (!candidate) return { candidate: null };
      const claimTime = now();
      const sameBusinessDate = candidate.processing?.lastAttemptBusinessDate === businessDate(claimTime);
      candidate.processing = {
        ...candidate.processing,
        state: "running",
        runId: input.runId.trim(),
        startedAt: claimTime,
        currentStep: input.initialStep.trim(),
        lastProgressAt: claimTime,
        progressEvents: [],
        attemptLedger: [],
        lastAttemptAt: claimTime,
        claimRevision: candidate.dataRevision,
        attempts: Number(candidate.processing?.attempts || 0) + 1,
        attemptsToday: sameBusinessDate ? Number(candidate.processing?.attemptsToday || 0) + 1 : 1,
        lastAttemptBusinessDate: businessDate(claimTime),
        lastError: null,
        blockReason: null,
        userAction: "",
        readAttempts: [],
        deferredUntil: null,
        deferredRunId: null,
        dispatchState: "claimed",
        manualHold: false,
        stoppedAt: null,
        stopReason: "",
        controlAlertKey: ""
      };
      candidate.updatedAt = candidate.processing.startedAt;
      candidate.lastModifiedBy = "automation";
      addHistory(candidate, "codex", "claimed", `自动审核开始：${input.runId.trim()}`);
      return {
        candidate: publicCandidate(candidate, data.rules),
        claimRevision: candidate.dataRevision
      };
    });
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/automation/attempt") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.evidenceLayer?.trim() || !input.target?.trim()) {
      throw httpError(400, "登记读取尝试必须提供runId、candidateId、证据层和目标");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，本轮读取尝试已失效");
      }
      try {
        current.processing = registerProcessingAttempt(current.processing, input, now());
      } catch (error) {
        throw httpError(/本轮已尝试/.test(error.message) ? 409 : 400, error.message);
      }
      current.updatedAt = now();
      current.lastModifiedBy = "automation";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/progress") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.progressType?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "记录实质进展必须提供runId、candidateId、进展类型和当前步骤");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，本轮进展已失效");
      }
      try {
        current.processing = recordProcessingProgress(current.processing, input, now());
      } catch (error) {
        throw httpError(/已记录|没有实质变化/.test(error.message) ? 409 : 400, error.message);
      }
      current.updatedAt = current.processing.lastProgressAt;
      current.lastModifiedBy = "automation";
      addHistory(
        current,
        "codex",
        "progress",
        input.progressType === "new_evidence"
          ? `取得新证据：${input.evidenceRef.trim()}；下一步：${input.currentStep.trim()}`
          : `执行步骤更新：${input.currentStep.trim()}`,
        current.processing.lastProgressAt
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/release") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.error?.trim()) {
      throw httpError(400, "释放自动审核任务必须提供runId、candidateId和具体错误");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (
        current.processing?.state !== "running" ||
        current.processing.runId !== input.runId.trim()
      ) {
        throw httpError(409, "只能释放当前runId实际领取的审核任务");
      }
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，当前任务无需再释放");
      }
      const timestamp = now();
      const failureScope = String(input.failureScope || "supplier_link").trim();
      let disposition;
      try {
        disposition = technicalFailureDisposition({
          attemptsToday: Number(current.processing?.attemptsToday || 0),
          readAttempts: input.readAttempts,
          explicitSafetyBlock: input.explicitSafetyBlock === true
        });
      } catch (error) {
        throw httpError(400, error.message);
      }
      const userAction =
        input.userAction?.trim() ||
        "请让总控明确是否按一个恢复路径重新开始；恢复前不再自动重试";
      const stoppedRunId = input.runId.trim();
      const dedupeKey = `technical-block|${current.id}|${stoppedRunId}|${failureScope}`;
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "blocked",
        runId: null,
        startedAt: null,
        currentStep: "已停止：等待总控确认",
        lastRunId: stoppedRunId,
        lastError: input.error.trim(),
        blockReason: input.error.trim(),
        userAction,
        readAttempts: disposition.readAttempts,
        deferredRunId: null,
        deferredUntil: null,
        lastAttemptRevision: Number(input.dataRevision),
        lastAttemptBusinessDate: businessDate(timestamp),
        dispatchState: "blocked",
        manualHold: true,
        failureScope,
        stoppedAt: timestamp,
        stopReason: "evidence_bearing_technical_failure",
        controlAlertKey: dedupeKey,
        recoveryOptions: disposition.recoveryOptions || []
      };
      current.codexReview = {
        ...(current.codexReview || {}),
        technicalBlock: {
          reason: input.error.trim(),
          failureScope,
          stoppedAt: timestamp,
          runId: stoppedRunId,
          readAttempts: disposition.readAttempts
        }
      };
      const alert = {
        id: dedupeKey,
        dedupeKey,
        candidateId: current.id,
        runId: stoppedRunId,
        type: "evidence_bearing_technical_failure",
        message: input.error.trim(),
        createdAt: timestamp,
        acknowledgedAt: null,
        recoveryOptions: disposition.recoveryOptions || []
      };
      appendControlAlert(data, alert);
      addHistory(
        current,
        "codex",
        "blockedAfterTechnicalFailure",
        `一次证据化技术失败后已停止：${input.error.trim()}；下一步：${userAction}`,
        timestamp
      );
      current.updatedAt = timestamp;
      current.lastModifiedBy = "automation";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const sourceAttemptRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-search-attempt$/);
  if (req.method === "POST" && sourceAttemptRoute) {
    const input = await requestBody(req);
    if (!["found", "not_found"].includes(input.result)) {
      throw httpError(400, "找货结果必须是found或not_found；技术失败请释放任务重试");
    }
    if (!input.checkedAt || !input.searchQuery?.trim()) {
      throw httpError(400, "找货记录必须包含查询词和查询时间");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "找货记录必须提供领取时的数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceAttemptRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.source !== "codex" || current.workflowStatus !== "codex_processing") {
        throw httpError(409, "只有已认可且正在处理的Codex方向候选可记录自动找货");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧找货结果不得覆盖新数据");
      }
      if (input.runId && current.processing?.runId !== input.runId) {
        throw httpError(409, "找货runId与当前领取任务不一致");
      }
      current.sourceSearchHistory ||= [];
      current.sourceSearchHistory.push({
        result: input.result,
        searchQuery: input.searchQuery.trim(),
        evidenceUrl: input.evidenceUrl?.trim() || "",
        checkedAt: input.checkedAt
      });
      const timestamp = now();
      if (input.result === "found") {
        if (!input.sourceUrl?.trim()) throw httpError(400, "找到货源时必须保存精确货源链接");
        const duplicate = duplicateCandidate(data.candidates, [input.sourceUrl], current.id);
        if (duplicate) {
          throw httpError(409, `该货源链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
        }
        current.sourceUrl = input.sourceUrl.trim();
        current.workflowStatus = "codex_processing";
        current.processing = queuedProcessing(current.processing);
        addHistory(current, "codex", "sourceFound", "已找到精确货源，自动进入利润审核", timestamp);
      } else {
        current.sourceSearchAttempts = Number(current.sourceSearchAttempts || 0) + 1;
        current.sourceSearchAttemptLimit = Number(current.sourceSearchAttemptLimit || 3);
        if (current.sourceSearchAttempts >= current.sourceSearchAttemptLimit) {
          current.workflowStatus = "eliminated";
          current.processing = { ...queuedProcessing(current.processing), state: "idle" };
          current.eliminatedAt = timestamp;
          current.eliminationReason = `Codex已完成${current.sourceSearchAttempts}轮精确找货，仍未找到可审核货源`;
          addHistory(current, "codex", "sourceSearchExhausted", current.eliminationReason, timestamp);
        } else {
          current.processing = queuedProcessing(current.processing);
          addHistory(
            current,
            "codex",
            "sourceNotFound",
            `第${current.sourceSearchAttempts}/${current.sourceSearchAttemptLimit}轮精确找货未找到，保留后续重试`,
            timestamp
          );
        }
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "codex";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/candidates") {
    const input = await requestBody(req);
    validateStore(input.targetStore);
    if (!input.productUrl?.trim()) throw httpError(400, "请填写商品链接");
    const candidate = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const timestamp = now();
      const created = initialCandidate(input, "user", nextCandidateId(data.candidates, "USR"), timestamp);
      addHistory(created, "user", "created", "用户添加候选，已自动进入Codex审核队列", timestamp);
      data.candidates.unshift(created);
      return publicCandidate(created, data.rules);
    });
    return json(res, 201, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/codex/candidates") {
    const input = await requestBody(req);
    validateStore(input.targetStore);
    if (!input.productUrl?.trim()) throw httpError(400, "Codex候选必须提供真实商品链接");
    if (![true, false].includes(input.powered)) throw httpError(400, "Codex候选必须确认是否带电");
    if (!["clear", "needs_confirmation"].includes(input.complianceStatus)) {
      throw httpError(400, "Codex候选合规状态只能是clear或needs_confirmation");
    }
    if (!["clear", "needs_confirmation"].includes(input.authorizationStatus)) {
      throw httpError(400, "Codex候选权利/IP状态只能是clear或needs_confirmation");
    }
    if (!input.purchaseCeiling || !["verified", "estimated", "unavailable"].includes(input.purchaseCeiling.status)) {
      throw httpError(400, "Codex候选必须提供含国内邮费采购区间，或明确标记尚无法反算");
    }
    const ceiling = purchaseCeilingSummary(input, DEFAULT_RULES);
    if (
      ["verified", "estimated"].includes(input.purchaseCeiling.status) &&
      input.purchaseCeiling.pricingPolicyVersion !== candidateProfitRule(input, DEFAULT_RULES).pricingPolicyVersion
    ) {
      throw httpError(400, "新采购上限必须按折后成交价计算利润，并保存20%、25%、30%促销对应建议标价");
    }
    if (input.purchaseCeiling.status === "verified" && ceiling.status !== "verified") {
      throw httpError(400, "采购上限证据不完整，不能标记为已验证", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "estimated" && ceiling.status !== "estimated"
    ) {
      throw httpError(400, "方向采购区间证据不足，不能标记为已估算", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "unavailable" &&
      (!Array.isArray(input.purchaseCeiling.missing) || !input.purchaseCeiling.missing.length)
    ) {
      throw httpError(400, "尚无法反算时必须写明Codex的技术缺口");
    }
    const candidate = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const summary = dailySummary(data.candidates, data.rules);
      const storeSummary = summary.stores[input.targetStore];
      if (storeSummary && storeSummary.automaticAdditionEnabled === false) {
        throw httpError(429, storeSummary.automaticAdditionPauseReason);
      }
      if (storeSummary && storeSummary.totalSelectedToday >= storeSummary.target) {
        throw httpError(429, `${input.targetStore} 今日选品总量已达标，无需继续自动补充`);
      }
      if (storeSummary && storeSummary.remainingCodexAdditionCapacity <= 0) {
        throw httpError(429, `${input.targetStore} 今日Codex新增候选已达到30条上限`);
      }
      const timestamp = now();
      const created = initialCandidate(input, "codex", nextCandidateId(data.candidates, "CX"), timestamp);
      addHistory(created, "codex", "created", "Codex自动补充候选，等待用户判断方向", timestamp);
      data.candidates.unshift(created);
      return publicCandidate(created, data.rules);
    });
    return json(res, 201, { candidate });
  }

  const candidateRoute = pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (req.method === "PATCH" && candidateRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "保存候选资料必须提供当前数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再保存", {
          currentRevision: current.dataRevision
        });
      }
      if (["ready_to_list", "listed", "eliminated"].includes(current.workflowStatus)) {
        throw httpError(409, "终态候选不可直接修改；请保留历史结论并创建新候选");
      }
      const duplicate = duplicateCandidate(
        data.candidates,
        [input.productUrl, input.sourceUrl, input.competitorUrl],
        current.id
      );
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      for (const field of USER_FIELDS) {
        if (Object.hasOwn(input, field)) current[field] = input[field];
      }
      if (Object.hasOwn(input, "purchasePriceRmb")) current.domesticShippingRmb = 0;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = now();
      current.lastModifiedBy = "user";
      if (
        current.workflowStatus === "needs_user_data" ||
        current.workflowStatus === "codex_processing" ||
        current.processing?.state === "running"
      ) {
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, current.updatedAt, "user_update");
      }
      addHistory(current, "user", "updated", "用户补充资料；技术阻塞不会自动解除，是否恢复由总控决定");
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const evaluationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/user-evaluation$/);
  if (req.method === "POST" && evaluationRoute) {
    const input = await requestBody(req);
    if (!["viable", "reject", "unsure"].includes(input.decision)) {
      throw httpError(400, "请选择你的判断");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === evaluationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (!Number.isInteger(input.dataRevision)) {
        throw httpError(400, "提交判断必须提供当前数据修订号");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再判断", {
          currentRevision: current.dataRevision
        });
      }
      const timestamp = now();
      const profitInputs = input.candidateData || {};
      if (input.decision === "unsure" && Object.keys(profitInputs).length) {
        if (profitInputs.sourceUrl?.trim()) {
          const duplicate = duplicateCandidate(data.candidates, [profitInputs.sourceUrl], current.id);
          if (duplicate) {
            throw httpError(409, `该采购链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
          }
        }
        for (const field of ["productName", "sourceUrl", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"]) {
          if (Object.hasOwn(profitInputs, field)) current[field] = profitInputs[field];
        }
        if (Object.hasOwn(profitInputs, "purchasePriceRmb")) current.domesticShippingRmb = 0;
      }
      current.userEvaluation = {
        decision: input.decision,
        reason: input.reason?.trim() || "",
        at: timestamp
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      if (input.decision === "reject") {
        current.workflowStatus = "eliminated";
        current.processing = { ...queuedProcessing(current.processing), state: "idle" };
        current.eliminatedAt = timestamp;
        current.eliminationReason = `用户判断不行${current.userEvaluation.reason ? `：${current.userEvaluation.reason}` : ""}`;
      } else {
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, timestamp, "user_evaluation");
        current.eliminatedAt = null;
        current.eliminationReason = "";
      }
      const labels = { viable: "可做，交给Codex核算", reject: "不行，立即淘汰", unsure: "待确认，交给Codex核算" };
      const inputNote =
        input.decision === "unsure" && Object.keys(profitInputs).length
          ? "；已同时补充采购链接、含国内邮费的采购总价和包装规格"
          : "";
      addHistory(current, "user", "evaluated", `用户判断：${labels[input.decision]}${inputNote}`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const commentRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/comments$/);
  if (req.method === "POST" && commentRoute) {
    const input = await requestBody(req);
    if (!input.message?.trim()) throw httpError(400, "留言不能为空");
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === commentRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const comment = {
        id: `C-${Date.now()}`,
        actor: input.actor === "codex" ? "codex" : "user",
        message: input.message.trim(),
        category: input.category === "elimination_feedback" ? "elimination_feedback" : "general",
        requiresResponse: input.actor !== "codex" && input.requestReview === true,
        status: input.actor !== "codex" && input.requestReview === true ? "pending" : "recorded",
        replyTo: input.replyTo || null,
        at: now()
      };
      current.comments ||= [];
      current.comments.push(comment);
      if (comment.actor === "codex" && comment.replyTo) {
        const original = current.comments.find((item) => item.id === comment.replyTo);
        if (original?.actor === "user") {
          original.status = "responded";
          original.respondedAt = comment.at;
          original.responseCommentId = comment.id;
        }
      }
      if (input.requestReview === true) {
        if (["ready_to_list", "listed"].includes(current.workflowStatus)) {
          throw httpError(409, "该商品已交由上架任务负责；选品任务不再重排此SKU");
        }
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, comment.at, "user_comment");
        current.readyAt = null;
        current.eliminatedAt = null;
        current.eliminationReason = "";
        current.wbAssessment = null;
        addHistory(
          current,
          comment.actor,
          "requeued",
          "留言要求Codex处理，候选已进入执行状态；自动化关闭时不会自动领取",
          comment.at
        );
      }
      current.updatedAt = comment.at;
      current.lastModifiedBy = comment.actor;
      addHistory(
        current,
        comment.actor,
        "commented",
        comment.category === "elimination_feedback"
          ? "新增后续选品避坑原因"
          : input.requestReview === true
            ? "新增待Codex处理留言"
            : "新增双方记录留言",
        comment.at
      );
      return { comment, candidate: publicCandidate(current, data.rules) };
    });
    return json(res, 201, result);
  }

  const reviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/codex-review$/);
  if (req.method === "POST" && reviewRoute) {
    const input = await requestBody(req);
    if (!["approved", "needsInfo", "eliminated"].includes(input.decision)) {
      throw httpError(400, "Codex判断无效");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "Codex审核必须提供领取时的数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === reviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧审核结果不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (
        current.processing?.state === "running" &&
        input.runId &&
        current.processing.runId !== input.runId
      ) {
        throw httpError(409, "自动审核runId与当前领取任务不一致");
      }
      const reviewInput = { ...input };
      const wbAssessment = reviewInput.wbAssessment;
      delete reviewInput.wbAssessment;
      const autoElimination = codexAutoEliminationGate(
        { ...current, codexReview: reviewInput },
        data.rules
      );
      if (autoElimination.shouldEliminate && reviewInput.decision !== "eliminated") {
        reviewInput.decision = "eliminated";
        reviewInput.reason = autoElimination.reason;
        reviewInput.autoElimination = autoElimination;
      }
      if (
        reviewInput.decision === "approved" &&
        !["suitable", "notSuitable"].includes(wbAssessment?.status)
      ) {
        throw httpError(400, "进入待上架前必须同时给出WB适合或不适合的明确结论");
      }
      if (
        reviewInput.decision === "approved" &&
        wbAssessment?.status === "notSuitable" &&
        !wbAssessment.reason?.trim()
      ) {
        throw httpError(400, "WB不适合必须写明当前判断依据");
      }
      if (reviewInput.decision === "approved") {
        const scenarioGate = promotionPricingGate(
          reviewInput.profitCalculation,
          candidateProfitRule(current, data.rules)
        );
        if (!scenarioGate.passed) {
          throw httpError(422, "Ozon利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: scenarioGate.blockers
          });
        }
        const wbScenarioGate = promotionPricingGate(
          wbAssessment?.profitCalculation,
          data.rules.wbCrossListing
        );
        if (!wbScenarioGate.passed) {
          throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: wbScenarioGate.blockers
          });
        }
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeeds({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须明确列出用户需要补什么");
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeededFields({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须指向明确且可填写的字段，不能退回整套表单");
      }
      const reviewedAt = now();
      current.codexReview = { ...reviewInput, reviewedAt };
      if (reviewInput.decision === "approved") {
        const gate = approvalGate(current, data.rules);
        if (!gate.passed) {
          throw httpError(422, "不满足待上架门槛，只能标为待补资料或淘汰", {
            blockers: gate.blockers
          });
        }
        current.workflowStatus = "ready_to_list";
        const assessedWb = { ...wbAssessment, assessedAt: reviewedAt };
        const wbGate = wbAssessmentDecisionGate(assessedWb, current, data.rules);
        if (!wbGate.passed) {
          throw httpError(422, "WB市场与利润判断不满足新规则", {
            blockers: wbGate.blockers
          });
        }
        current.wbAssessment = assessedWb;
        current.readyAt = reviewedAt;
        current.listingHandoff = {
          state: "queued",
          owner: "listing_task",
          queuedAt: reviewedAt
        };
        current.eliminatedAt = null;
        current.eliminationReason = "";
      } else if (reviewInput.decision === "eliminated") {
        current.workflowStatus = "eliminated";
        current.readyAt = null;
        current.eliminatedAt = reviewedAt;
        current.eliminationReason = reviewInput.reason?.trim() || "Codex判断不可做";
      } else {
        current.workflowStatus = "needs_user_data";
        current.readyAt = null;
      }
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "idle",
        lastError: null,
        blockReason: null,
        userAction: "",
        dispatchState: "completed"
      };
      current.reviewedAt = reviewedAt;
      current.updatedAt = reviewedAt;
      current.lastModifiedBy = "codex";
      const labels = { approved: "通过并进入待上架", needsInfo: "需要用户补资料", eliminated: "淘汰" };
      addHistory(current, "codex", "reviewed", `Codex判断：${labels[reviewInput.decision]}`, reviewedAt);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const wbRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/wb-assessment$/);
  const listingReadbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/listing-readback$/);
  if (req.method === "POST" && listingReadbackRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "自动上架回写必须提供当前数据修订号");
    }
    let listingRecord;
    try {
      listingRecord = validateListingReadback(input);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listingReadbackRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus === "listed") {
        const existing = current.listingRecord || {};
        if (
          existing.platform === listingRecord.platform &&
          existing.productId === listingRecord.productId &&
          existing.merchantSku === listingRecord.merchantSku
        ) {
          return publicCandidate(current, data.rules);
        }
        throw httpError(409, "该候选已记录为另一个平台商品，不能自动覆盖");
      }
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品可以接收上架回读");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧上架回读不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (current.listingHandoff?.owner && current.listingHandoff.owner !== "listing_task") {
        throw httpError(409, "该SKU尚未交给上架任务，不能自动标记已上架");
      }
      if (listingRecord.store !== current.targetStore) {
        throw httpError(409, "回读店铺与候选目标店铺不一致");
      }
      const expectedPlatform = current.targetStore === "wb" ? "wb" : "ozon";
      if (listingRecord.platform !== expectedPlatform) {
        throw httpError(409, "回读平台与候选目标平台不一致");
      }
      const timestamp = now();
      completeListing(current, listingRecord, "listing_task", timestamp);
      addHistory(
        current,
        "system",
        "listingReadbackCompleted",
        `上架任务真实回读完成：${listingRecord.platform.toUpperCase()} ${listingRecord.productId} · ${listingRecord.moderationStatus} · ${listingRecord.saleStatus}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const listedRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/mark-listed$/);
  if (req.method === "POST" && listedRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "标记已上架必须提供当前数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listedRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品可以标记为已上架");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已更新，请刷新后再确认已上架");
      }
      let listingRecord;
      try {
        listingRecord = validateListingRecord({
          ...input,
          store: input.store || current.targetStore
        });
      } catch (error) {
        throw httpError(400, error.message);
      }
      const timestamp = now();
      completeListing(current, listingRecord, "user", timestamp);
      addHistory(
        current,
        "user",
        "markedListed",
        `自动回读不可用，手动确认上架：${listingRecord.platform.toUpperCase()} ${listingRecord.productId || listingRecord.productUrl}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && wbRoute) {
    const input = await requestBody(req);
    if (!["suitable", "notSuitable"].includes(input.status)) {
      throw httpError(400, "WB判断状态无效");
    }
    if (input.status === "notSuitable" && !input.reason?.trim()) {
      throw httpError(400, "WB不适合必须写明当前判断依据");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === wbRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品才进行WB独立复算");
      }
      const assessment = { ...input, assessedAt: now() };
      const scenarioGate = promotionPricingGate(
        assessment.profitCalculation,
        data.rules.wbCrossListing
      );
      if (!scenarioGate.passed) {
        throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
          blockers: scenarioGate.blockers
        });
      }
      const gate = wbAssessmentDecisionGate(assessment, current, data.rules);
      if (!gate.passed) {
        throw httpError(422, "WB市场与利润判断不满足新规则", { blockers: gate.blockers });
      }
      current.wbAssessment = assessment;
      current.updatedAt = assessment.assessedAt;
      current.lastModifiedBy = "codex";
      addHistory(current, "codex", "wbAssessed", `WB独立判断：${input.status}`, assessment.assessedAt);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  return json(res, 404, { message: "接口不存在" });
}

async function serveFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    // This dashboard is an operational surface: serving a stale JavaScript bundle
    // can make a valid form submit without its current dataRevision. Always ask
    // the browser to revalidate app assets instead of retaining an old UI.
    "Cache-Control": extension === ".html" ? "no-cache" : "no-cache"
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    if (pathname.startsWith("/product-images/")) {
      const filename = path.basename(pathname);
      return await serveFile(res, path.join(imagesDir, filename));
    }
    if (apiOnly) return json(res, 404, { message: "API服务仅处理/api和/product-images" });
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(distDir, requested);
    if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
      return json(res, 403, { message: "禁止访问" });
    }
    try {
      return await serveFile(res, filePath);
    } catch {
      return await serveFile(res, path.join(distDir, "index.html"));
    }
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, {
      message: error.message || "服务器错误",
      ...(error.extra || {})
    });
  }
});

server.listen(port, host, () => {
  console.log(`今日选品评审台${apiOnly ? " API" : ""}：http://${host}:${port}`);
});

// This guard never claims work or calls a marketplace. It only stops a run
// whose auditable progress lease expired, then creates one deduplicated notice
// for total control to consume.
const noProgressGuard = setInterval(() => {
  stopRunsWithoutProgress().catch((error) => console.error("防空跑门禁失败", error));
}, 60_000);
noProgressGuard.unref();

// This loop only delivers explicit one-shot requests already created by a user
// action. It never creates business work, reactivates stopped SKUs, or enables
// the continuous automation queue.
if (explicitDispatchDeliveryEnabled) {
  const explicitDispatchGuard = setInterval(() => {
    deliverWaitingDispatches().catch((error) => console.error("一次性派发检查失败", error));
  }, 5_000);
  explicitDispatchGuard.unref();
}

export { server };
