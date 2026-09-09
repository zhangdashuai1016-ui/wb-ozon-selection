import test from "node:test";
import assert from "node:assert/strict";
import { executionRuntimeDisplay } from "../src/executionRuntimeView.js";

test("UI用大白话区分四类执行者", () => {
  for (const [executorType, expected] of [
    ["software", "软件执行"],
    ["third_party_ai", "第三方AI执行"],
    ["codex_exception", "Codex技术维护中"],
    ["owner", "主人决策"]
  ]) {
    const display = executionRuntimeDisplay({ available: true, currentExecutionConfirmed: true, executorType, status: "running", inputRevision: 1, outputRevision: null });
    assert.equal(display.executorLabel, expected);
  }
});

test("saved production authorization waits for software conditions without asking for a second owner decision", () => {
  const display = executionRuntimeDisplay({ available: true, source: "production_authorization_handoff",
    stepId: "D_TECHNICAL_ADMISSION", status: "not_started", executorType: "software" });
  assert.equal(display.statusLabel, "生产授权已保存");
  assert.equal(display.executorLabel, "软件检查");
  assert.match(display.detail, /未开始平台写入/);
  const invalid = executionRuntimeDisplay({ available: true, source: "production_authorization_handoff",
    stepId: "D_TECHNICAL_ADMISSION", status: "not_started", recordIssue: "production_authorization_handoff_invalid_or_stale" });
  assert.equal(invalid.statusLabel, "当前执行未确认");
});

test("historical running and invalid records do not claim a current executor", () => {
  for (const view of [
    { available: true, executorType: "software", status: "running" },
    { available: true, status: "blocked", exceptionCase: { status: "open", dispatchState: "running", turnId: "old" } }
  ]) {
    const display = executionRuntimeDisplay(view);
    assert.equal(display.executorLabel, "历史执行记录（只读）");
    assert.equal(display.statusLabel, "当前运行未确认");
  }
  const invalid = executionRuntimeDisplay({ available: true, recordIssue: "execution_record_invalid_or_wrong_candidate" });
  assert.equal(invalid.executorLabel, "执行记录异常");
  assert.equal(invalid.statusLabel, "当前执行未确认");
});

test("a currently admitted permission wait is neither running nor historical", () => {
  const display = executionRuntimeDisplay({ available: true, status: "blocked", currentExecutionConfirmed: false,
    currentPermissionRequired: true, historicalExecution: false,
    exceptionCase: { status: "open", dispatchState: "running", turnId: "current-turn" } });
  assert.equal(display.executorLabel, "当前维护任务");
  assert.equal(display.statusLabel, "等待权限决定");
});

test("旧Codex状态明确显示为历史只读，不能冒充当前执行", () => {
  const display = executionRuntimeDisplay({ available: true, legacyReadOnly: true });
  assert.equal(display.executorLabel, "历史Codex记录（只读）");
  assert.match(display.detail, /不能推动新版商品/);
});

test("未领取的ExceptionCase显示需要技术维护，不冒充Codex已介入", () => {
  const display = executionRuntimeDisplay({
    available: true,
    executorType: "software",
    status: "blocked",
    inputRevision: 1,
    exceptionCase: { status: "open", dispatchState: "not_dispatched", failureLayer: "schema", reasonCode: "output_schema_mismatch" }
  });
  assert.equal(display.executorLabel, "需要技术维护 / ExceptionCase");
  assert.match(display.detail, /schema/);
  assert.match(display.detail, /业务结论未改变/);
  assert.match(display.detail, /不表示Codex已介入/);
});

test("等待主人、外部服务失败和结果未知使用不同大白话", () => {
  const owner = executionRuntimeDisplay({ available: true, executorType: "owner", status: "waiting_owner", inputRevision: 1, outputRevision: null });
  assert.equal(owner.statusLabel, "等待主人确认");

  const external = executionRuntimeDisplay({
    available: true,
    executorType: "software",
    status: "blocked",
    inputRevision: 1,
    technicalFailure: {
      status: "stopped",
      kind: "external_dependency",
      message: "外部服务当前不可用，软件已安全停止且不会自动重试。",
      failureLayer: "gateway",
      errorCode: "GATEWAY_UNREACHABLE"
    }
  });
  assert.equal(external.executorLabel, "外部服务有问题");

  const unknown = executionRuntimeDisplay({
    available: true,
    executorType: "software",
    status: "blocked",
    inputRevision: 1,
    technicalFailure: {
      status: "stopped",
      kind: "unknown_outcome",
      message: "结果未知。",
      failureLayer: "provider",
      errorCode: "UNKNOWN_OUTCOME"
    }
  });
  assert.equal(unknown.statusLabel, "结果未知，禁止自动重试");
});
