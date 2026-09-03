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

test("运行中只显示一次尝试边界", () => {
  const view = keywordSoftwareRuntimeDisplay({
    candidate: candidate({ status: "waiting_platform", jobId: "job-1" }),
    runtimeStatus: { configured: true, softwareJobQueueEnabled: true }
  });
  assert.equal(view.status, "waiting_platform");
  assert.match(view.detail, /一次Open API请求/);
  assert.equal(view.jobId, "job-1");
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
