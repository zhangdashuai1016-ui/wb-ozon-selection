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
    const display = executionRuntimeDisplay({ available: true, executorType, status: "running", inputRevision: 1, outputRevision: null });
    assert.equal(display.executorLabel, expected);
  }
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
