import test from "node:test";
import assert from "node:assert/strict";

import { keywordSoftwareRuntimeDisplay } from "../src/keywordSoftwareRuntimeView.js";

function candidate(job = null) {
  return {
    ...(job ? { c1PaidKeywordSoftwareJob: job } : {}),
    lifecycleV11: {
      skuPackage: { businessPhase: "C1" }
    }
  };
}

test("C1无作业且执行关闭时明确显示未开启", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate(),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: false }
  });
  assert.equal(view.status, "disabled");
  assert.match(view.title, /尚未开启/);
  assert.match(view.providerLabel, /不表示本SKU已授权、已绑定或已扣点/);
});

test("本次执行已确认时只显示一次尝试边界", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "waiting_platform", jobId: "job-1", currentExecutionConfirmed: true }),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(view.status, "waiting_platform");
  assert.match(view.detail, /一次Open API请求/);
  assert.equal(view.jobId, "job-1");
});

test("持久领取和等待平台状态没有本次证明时只显示历史", () => {
  for (const status of ["claimed", "waiting_platform"]) {
    for (const currentExecutionConfirmed of [undefined, false, "true"]) {
      const value = candidate({ status, jobId: "job-old", currentExecutionConfirmed });
      const before = structuredClone(value);
      const view = keywordSoftwareRuntimeDisplay({ candidate: value, runtimeStatus: { consumerConnected: true, configured: true, softwareJobQueueEnabled: true } });
      assert.equal(view.status, "historical_unconfirmed");
      assert.equal(view.recordedStatus, status);
      assert.equal(view.jobId, "job-old");
      assert.match(view.title, /历史关键词作业/);
      assert.match(view.detail, /不会重新领取|禁止自动重试或再次付费/);
      assert.deepEqual(value, before);
    }
    const live = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status, jobId: "job-current", currentExecutionConfirmed: true }), runtimeStatus: {} });
    assert.equal(live.status, status);
  }
});

test("排队和已完成记录各自保留语义，不推断本次运行", () => {
  const queued = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status: "queued", jobId: "job-old" }), runtimeStatus: {} });
  assert.equal(queued.status, "queued");
  assert.match(queued.title, /记录已保存，尚未开始执行/);
  assert.match(queued.detail, /不证明本次服务已领取/);
  const completed = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status: "completed", jobId: "job-completed", currentExecutionConfirmed: false }), runtimeStatus: {} });
  assert.equal(completed.status, "completed");
  assert.match(completed.detail, /只读取保存的证据/);
});

test("技术失败显示精确失败层且不承诺重试", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "failed", jobId: "job-2", failureClass: "network_timeout" }),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(view.failureClass, "network_timeout");
  assert.match(view.detail, /不会自动重试/);
});

test("排队不冒充执行器已连接，成功后本地失败不冒充外部失败", () => {
  const queued = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status: "queued", jobId: "job-queued" }),
    runtimeStatus: { softwareJobQueueEnabled: true, softwareExecutionEnabled: false, consumerConnected: false } });
  assert.equal(queued.status, "queued");
  assert.match(queued.title, /执行器尚未接入/);
  assert.match(queued.detail, /不会因排队而调用Seerfar或扣点/);
  const failed = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status: "failed", externalRequestState: "succeeded", jobId: "job-local-failed", failureClass: "c1-paid-keyword-local-preparation-failed" }), runtimeStatus: {} });
  assert.match(failed.title, /请求已成功/);
  assert.match(failed.detail, /禁止再次付费或自动重试/);
});

test("unknown_outcome显示结果未知且不承诺自动恢复", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "unknown_outcome", jobId: "job-3", failureClass: "service_restart_after_external_request" }),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(view.status, "unknown_outcome");
  assert.match(view.title, /运行结果未知/);
  assert.match(view.detail, /不会自动重试/);
});

test("not_found显示作业引用缺失而不是页面自行补发", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "not_found", jobId: "job-missing", failureClass: "software_job_not_found" }),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(view.status, "not_found");
  assert.match(view.title, /引用缺失/);
  assert.match(view.detail, /不会自动重试/);
});

test("非C1且无作业不显示卡片", () => {
  assert.equal(keywordSoftwareRuntimeDisplay({ candidate: { lifecycleV11: { skuPackage: { businessPhase: "B" } } }, runtimeStatus: null }), null);
});

test("服务端计划未就绪时显示真实缺口而不是要求页面拼请求", () => {
  const value = candidate(null);
  value.c1KeywordSoftwarePlanningView = {
    status: "not_ready",
    gaps: [{ code: "keyword_planning_evidence_missing", message: "缺少服务端已保存的关键词准备证据" }]
  };
  const display = keywordSoftwareRuntimeDisplay({
    candidate: value,
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(display.status, "not_ready");
  assert.equal(display.title, "服务端计划尚未就绪");
  assert.match(display.detail, /缺少服务端已保存的关键词准备证据/);
});


test("执行条件拒绝和服务未知故障都明确停止，不能显示仍在排队等待执行", () => {
  const rejected = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "queued", jobId: "job-rejected", admissionFailure: { code: "SOFTWARE_JOB_REVISION_CONFLICT" } }),
    runtimeStatus: { consumerConnected: true, serviceStatus: "running" }
  });
  assert.equal(rejected.status, "blocked");
  assert.equal(rejected.recordedStatus, "queued");
  assert.equal(rejected.failureClass, "SOFTWARE_JOB_REVISION_CONFLICT");
  assert.match(rejected.detail, /已停止发送请求/);
  const failed = keywordSoftwareRuntimeDisplay({ candidate: candidate({ status: "queued", jobId: "job-pending" }), runtimeStatus: { serviceStatus: "failed" } });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.failureClass, "runtime_failed");
  assert.match(failed.title, /因异常停止/);
});

test("已成功关键词和其持久C1交接异常分别显示，重启不隐藏且不混用其他作业异常", () => {
  const value = candidate({ status: "completed", jobId: "job-saved" });
  value.executionRuntime = { exceptionCase: { status: "open", softwareJobId: "job-saved", failureLayer: "c1_keyword_handoff" } };
  const before = structuredClone(value);
  const view = keywordSoftwareRuntimeDisplay({ candidate: value, runtimeStatus: { serviceStatus: "running" } });
  assert.equal(view.status, "handoff_failed");
  assert.equal(view.recordedStatus, "completed");
  assert.match(view.title, /证据已保存/);
  assert.match(view.detail, /不会重复付费/);
  assert.deepEqual(value, before);
  for (const patch of [{ status: "resolved" }, { softwareJobId: "another-job" }, { failureLayer: "another-layer" }]) {
    const other = structuredClone(value);
    Object.assign(other.executionRuntime.exceptionCase, patch);
    assert.equal(keywordSoftwareRuntimeDisplay({ candidate: other, runtimeStatus: { serviceStatus: "failed" } }).status, "completed");
  }
});


test("已知交接配置缺口保持关键词成功，持久停止不能被服务重启隐藏", () => {
  const value = candidate({ status: "completed", jobId: "job-config" });
  value.executionRuntime = { technicalFailure: { status: "stopped", softwareJobId: "job-config", failureLayer: "c1_keyword_handoff", errorCode: "C1_DRAFT_RUNTIME_UNAVAILABLE" } };
  const view = keywordSoftwareRuntimeDisplay({ candidate: value, runtimeStatus: { serviceStatus: "running" } });
  assert.equal(view.status, "handoff_blocked");
  assert.equal(view.recordedStatus, "completed");
  assert.equal(view.failureClass, "C1_DRAFT_RUNTIME_UNAVAILABLE");
  assert.match(view.detail, /继续准备文案.*复用原关键词结果/);
  value.executionRuntime.technicalFailure.softwareJobId = "different-job";
  assert.equal(keywordSoftwareRuntimeDisplay({ candidate: value, runtimeStatus: {} }).status, "completed");
});
