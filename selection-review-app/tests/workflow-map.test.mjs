import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateActiveNode,
  activeDispatchForCandidate,
  collaborationSummary,
  dispatchDeliveryGroups,
  dispatchOwnerForNode,
  ensureCollaborationData,
  migrateLegacyCStageOwnership,
  validateNodeExecution,
  workflowMapView
} from "../lib/workflow-map.mjs";
import { createSoftwareExecutionRuntime, openExceptionCase, authorizeExceptionMaintenance, recordExceptionMaintenanceStarted } from "../lib/software-execution-state.mjs";
import { currentProcessingStatusSummary } from "../lib/workflow.mjs";

const nodes = [
  { id: "M04", title: "B阶段资料准备", executionOwner: "selection_task" },
  { id: "M07", title: "C阶段SKU、来源与合规", executionOwner: "listing_task" },
  { id: "M08", title: "待上架交接", executionOwner: "listing_task" },
  { id: "M12", title: "异常停止与总控恢复", executionOwner: "control_task" }
];
const map = { nodes, edges: [] };

function processingCandidate(overrides = {}) {
  return {
    id: "SKU-1",
    source: "user",
    productName: "测试商品",
    targetStore: "dandanshu",
    workflowStatus: "codex_processing",
    dataRevision: 2,
    processing: { state: "queued", manualHold: false },
    processingStatus: { key: "queued", actualRunning: false },
    selectionStage: { stage: "pool_intake" },
    comments: [],
    ...overrides
  };
}

test("old queued records stay historical while stopped records remain stopped", () => {
  const candidates = [
    processingCandidate(),
    ...Array.from({ length: 11 }, (_, index) => processingCandidate({
      id: `STOP-${index}`,
      processing: { state: "blocked", manualHold: true }
    }))
  ];
  const summary = collaborationSummary({ candidates, dispatches: [] }, {});
  assert.equal(summary.actualRunning, 0);
  assert.equal(summary.authorized, 0);
  assert.equal(summary.historicalPending, 1);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.stopped, 11);
});

test("a persisted dispatch alone is not a current delivery or a new authorization", () => {
  const candidates = [
    processingCandidate(),
    processingCandidate({ id: "STOP-1", processing: { state: "blocked", manualHold: true } })
  ];
  const summary = collaborationSummary({
    candidates,
    dispatches: [{ id: "D-1", candidateId: "SKU-1", status: "queued" }]
  }, {});
  assert.equal(summary.authorized, 0);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.historicalPending, 1);
  assert.equal(summary.stopped, 1);
});

test("only this process's exact maintenance dispatch can represent current execution", () => {
  const at = "2026-09-07T00:00:00.000Z";
  const base = createSoftwareExecutionRuntime({ candidateId: "SKU-1", dataRevision: 2, at });
  const exception = openExceptionCase(base, { exceptionId: "exc-1", reasonCode: "system_failure", failureLayer: "local", evidenceRefs: ["test:local"], at });
  const authorized = authorizeExceptionMaintenance(exception, { exceptionId: "exc-1", maintenanceAuthorizationId: "maintenance-1", at });
  const candidate = processingCandidate({
    processing: { state: "running", runId: "turn-1", claimRevision: 2, currentStep: "maintenance started", startedAt: at, lastProgressAt: at },
    executionRuntime: recordExceptionMaintenanceStarted(authorized, { exceptionId: "exc-1", turnId: "turn-1", at })
  });
  const dispatch = { id: "D-1", candidateId: candidate.id, dataRevision: 2, workflowStatusAtDispatch: candidate.workflowStatus,
    status: "running", runId: "turn-1", turnId: "turn-1", lastEventAt: at };
  const data = { candidates: [candidate], dispatches: [dispatch] };
  const current = { activeDispatchIds: new Set([dispatch.id]), at: new Date(at) };
  assert.equal(activeDispatchForCandidate(data, candidate.id), null, "restart cannot adopt a persisted running record");
  assert.equal(activeDispatchForCandidate(data, candidate.id, current), dispatch);
  assert.equal(collaborationSummary(data, {}, current).actualRunning, 1);
  for (const change of [
    value => { value.candidates[0].dataRevision += 1; },
    value => { value.candidates[0].workflowStatus = "needs_user_data"; },
    value => { value.candidates[0].processing.manualHold = true; },
    value => { value.candidates[0].executionRuntime.exceptionCase.turnId = "other-turn"; },
    value => { value.candidates[0].executionRuntime.exceptionCase.maintenanceAuthorizationId = null; },
    value => { value.candidates[0].processing.lastProgressAt = "2026-09-06T00:00:00.000Z"; },
    value => { value.candidates[0].processing.claimRevision = 1; },
    value => { value.candidates[0].processing.runId = "other"; },
    value => { value.candidates = []; },
    value => { value.dispatches.push({ ...dispatch, id: "D-2", status: "completed" }); }
  ]) {
    const invalid = structuredClone(data);
    change(invalid);
    assert.equal(activeDispatchForCandidate(invalid, candidate.id, current), null);
    assert.equal(collaborationSummary(invalid, {}, current).actualRunning, 0);
  }
  const before = structuredClone(data);
  collaborationSummary(data, {}, current);
  assert.deepEqual(data, before);
  const staleMessage = structuredClone(data);
  staleMessage.dispatches[0].lastEventAt = at;
  staleMessage.candidates[0].processing.startedAt = "2026-09-06T00:00:00.000Z";
  staleMessage.candidates[0].processing.lastProgressAt = "2026-09-06T00:00:00.000Z";
  assert.equal(activeDispatchForCandidate(staleMessage, candidate.id, current), null, "ordinary messages cannot renew real progress");
  const realProgress = structuredClone(data);
  realProgress.dispatches[0].lastEventAt = "2026-09-06T00:00:00.000Z";
  assert.notEqual(activeDispatchForCandidate(realProgress, candidate.id, current), null, "validated progress does not require a message event");
  const listing = structuredClone(data);
  listing.candidates[0].workflowStatus = "listing_preparation";
  listing.candidates[0].listingHandoff = listing.candidates[0].processing;
  listing.candidates[0].processing = { state: "running", runId: "old-run", claimRevision: 1 };
  listing.dispatches[0].workflowStatusAtDispatch = "listing_preparation";
  const listingActive = activeDispatchForCandidate(listing, candidate.id, current);
  assert.equal(listingActive, listing.dispatches[0]);
  assert.equal(currentProcessingStatusSummary(listing.candidates[0], { activeDispatch: listingActive, at }).actualRunning, true);
  delete listing.candidates[0].listingHandoff.lastProgressAt;
  assert.equal(activeDispatchForCandidate(listing, candidate.id, current), null, "a fresh dispatch event cannot fill in absent listing progress");
  assert.equal(currentProcessingStatusSummary(listing.candidates[0], { activeDispatch: listingActive, at }).actualRunning, false);
});

test("a failed or unverified reply stays stopped instead of returning to authorized", () => {
  const candidates = [processingCandidate()];
  const summary = collaborationSummary({
    candidates,
    dispatches: [{ id: "D-OLD", candidateId: "SKU-1", status: "responded_unverified" }]
  }, {});
  assert.equal(summary.authorized, 0);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.stopped, 1);
});

test("map routes current SKU and workflow comments to different owners", () => {
  assert.equal(dispatchOwnerForNode(nodes[0], "candidate"), "selection_task");
  assert.equal(dispatchOwnerForNode(nodes[1], "candidate"), "listing_task");
  assert.equal(dispatchOwnerForNode(nodes[2], "candidate"), "listing_task");
  assert.equal(dispatchOwnerForNode(nodes[2], "workflow"), "control_task");
});

test("startup recovery keeps each assignee thread in its own delivery group", () => {
  const routes = ensureCollaborationData({ candidates: [], dispatches: [] }).taskRoutes;
  const groups = dispatchDeliveryGroups([
    { id: "D-S-1", assigneeRole: "selection_task" },
    { id: "D-S-2", assigneeRole: "selection_task" },
    { id: "D-L-1", assigneeRole: "listing_task" }
  ], routes);
  assert.deepEqual(groups.map((group) => group.map((dispatch) => dispatch.id)), [
    ["D-S-1", "D-S-2"],
    ["D-L-1"]
  ]);
});

test("legacy active C dispatch is reassigned in place to listing task", () => {
  const candidate = processingCandidate({
    workflowStatus: "listing_preparation",
    listingHandoff: { state: "queued", owner: "selection_task", currentStep: "等待选品任务" }
  });
  const data = ensureCollaborationData({
    candidates: [candidate],
    dispatches: [{
      id: "D-C-OLD",
      nodeId: "M07",
      candidateId: candidate.id,
      status: "waiting_assignee",
      assigneeRole: "selection_task",
      assigneeThreadId: "old-thread",
      assigneeTitle: "选品",
      message: "只由选品任务继续C阶段"
    }]
  });
  const outcome = migrateLegacyCStageOwnership(data, "2026-08-11T19:30:00.000Z");
  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.migratedCandidateIds, [candidate.id]);
  assert.equal(data.dispatches[0].id, "D-C-OLD");
  assert.equal(data.dispatches[0].assigneeRole, "listing_task");
  assert.equal(data.dispatches[0].status, "queued");
  assert.match(data.dispatches[0].message, /上架任务/);
  assert.equal(data.candidates[0].listingHandoff.owner, "listing_task");
});

test("ownership boundary prevents selection and listing tasks from taking each other's SKU", () => {
  assert.throws(
    () => validateNodeExecution(nodes[2], "candidate", processingCandidate()),
    /尚未进入待上架/
  );
  assert.throws(
    () => validateNodeExecution(nodes[0], "candidate", processingCandidate({ workflowStatus: "ready_to_list" })),
    /已交由上架任务/
  );
});

test("manual hold is highlighted on the recovery node and old comments remain unassigned", () => {
  const candidate = processingCandidate({
    processing: { state: "blocked", manualHold: true },
    comments: [{ id: "OLD-1", actor: "user", message: "旧留言", at: "2026-08-07T00:00:00Z" }]
  });
  assert.equal(candidateActiveNode(candidate), "M12");
  const data = ensureCollaborationData({ candidates: [candidate] });
  const view = workflowMapView(map, data, [candidate], candidate.id);
  assert.equal(view.selectedCandidate.activeNodeId, "M12");
  assert.equal(view.legacyComments.length, 1);
  assert.equal(view.nodes.find((node) => node.id === "M12").candidateState, "blocked");
});
