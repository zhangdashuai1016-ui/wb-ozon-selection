import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateActiveNode,
  collaborationSummary,
  dispatchOwnerForNode,
  ensureCollaborationData,
  validateNodeExecution,
  workflowMapView
} from "../lib/workflow-map.mjs";

const nodes = [
  { id: "M04", title: "B阶段资料准备", executionOwner: "selection_task" },
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

test("map routes current SKU and workflow comments to different owners", () => {
  assert.equal(dispatchOwnerForNode(nodes[0], "candidate"), "selection_task");
  assert.equal(dispatchOwnerForNode(nodes[1], "candidate"), "listing_task");
  assert.equal(dispatchOwnerForNode(nodes[1], "workflow"), "control_task");
});

test("ownership boundary prevents selection and listing tasks from taking each other's SKU", () => {
  assert.throws(
    () => validateNodeExecution(nodes[1], "candidate", processingCandidate()),
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
