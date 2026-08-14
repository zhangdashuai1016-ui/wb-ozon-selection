import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateActiveNode,
  collaborationSummary,
  dispatchDeliveryGroups,
  dispatchOwnerForNode,
  ensureCollaborationData,
  migrateLegacyCStageOwnership,
  validateNodeExecution,
  workflowMapView
} from "../lib/workflow-map.mjs";

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

test("twelve selection items stay split into running, authorized, and stopped truthfully", () => {
  const candidates = [
    processingCandidate(),
    ...Array.from({ length: 11 }, (_, index) => processingCandidate({
      id: `STOP-${index}`,
      processing: { state: "blocked", manualHold: true }
    }))
  ];
  const summary = collaborationSummary({ candidates, dispatches: [] }, {});
  assert.equal(summary.actualRunning, 0);
  assert.equal(summary.authorized, 1);
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.stopped, 11);
});

test("an explicit dispatch removes an item from authorized but does not wake stopped SKUs", () => {
  const candidates = [
    processingCandidate(),
    processingCandidate({ id: "STOP-1", processing: { state: "blocked", manualHold: true } })
  ];
  const summary = collaborationSummary({
    candidates,
    dispatches: [{ id: "D-1", candidateId: "SKU-1", status: "queued" }]
  }, {});
  assert.equal(summary.authorized, 0);
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.stopped, 1);
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
