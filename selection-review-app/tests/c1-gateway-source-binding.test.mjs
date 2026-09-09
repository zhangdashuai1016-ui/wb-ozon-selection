import assert from "node:assert/strict";
import test from "node:test";
import { buildC1GatewayJob, runC1SavedDraftRequestThroughGateway, C1_GATEWAY_SOURCE_BINDING_VERSION } from "../lib/c1-ai-gateway.mjs";
import { buildRequest, authorizedExecution, receipt } from "./fixtures/c1-ai-draft-fixture.mjs";

function fixture() {
  const request = buildRequest();
  const execution = authorizedExecution(request);
  const input = { request, authorizedExecution: execution,
    gatewayUrl: "http://127.0.0.1:4318", wait: async () => {}, statusIntervalMs: 0 };
  const wire = { ...buildC1GatewayJob({ candidateId: execution.identity.candidateId, dataRevision: execution.candidateRevision, request }),
    sourceBinding: { schemaVersion: C1_GATEWAY_SOURCE_BINDING_VERSION,
      softwareJobId: execution.jobId, requestFingerprint: request.requestFingerprint,
      sourceSkuRevision: request.sourceSkuRevision, c1PlanId: request.identity.c1PlanId,
      platform: request.sourceIdentity.platform, storeRef: structuredClone(request.sourceIdentity.storeRef),
      supplierSkuId: request.sourceIdentity.supplierSkuId, variantKey: request.identity.variantKey } };
  const completed = { ...wire, jobId: "gateway:payment:1", status: "completed", attempt: 1,
    startedAt: request.requestedAt, completedAt: request.requestedAt,
    receipt: { receiptVersion: "inference-receipt-v1", providerRequestId: "provider:payment:1", requestHash: "b".repeat(64),
      validation: { schemaValid: true }, usage: { prompt_tokens: 12, completion_tokens: 8 }, output: receipt(request).output } };
  return { input, wire, completed };
}

test("现有接口发送精确中央请求与店铺分支，接受编号落盘完成后才查询", async () => {
  const { input, wire, completed } = fixture();
  const events = [];
  let releaseAcceptance, acceptanceStarted;
  const started = new Promise(resolve => { acceptanceStarted = resolve; });
  const save = new Promise(resolve => { releaseAcceptance = resolve; });
  const pending = runC1SavedDraftRequestThroughGateway({ ...input,
    onGatewayJobAccepted: async value => { events.push(["accept", value]); acceptanceStarted(); await save; events.push(["saved"]); },
    fetchImpl: async (url, options) => {
      const method = options.method ?? "GET"; events.push([method]);
      assert.match(url, /\/v1\/inference-jobs(?:\/gateway%3Apayment%3A1)?$/);
      if (method === "POST") {
        assert.deepEqual(JSON.parse(options.body), wire);
        assert.equal(wire.sourceBinding.requestFingerprint, input.request.requestFingerprint);
        assert.deepEqual(wire.sourceBinding.storeRef, input.request.sourceIdentity.storeRef);
        assert.equal(Object.hasOwn(wire, "paymentAuthorization"), false);
        assert.equal(Object.hasOwn(wire, "authorizedExecution"), false);
        return Response.json({ ...wire, jobId: completed.jobId, status: "queued" });
      }
      assert.deepEqual(events.at(-2), ["saved"]);
      return Response.json(completed);
    } });
  await started;
  assert.deepEqual(events.map(event => event[0]), ["POST", "accept"]);
  releaseAcceptance();
  const result = await pending;
  assert.equal(result.status, "receipt_ready");
  assert.deepEqual(events.map(event => event[0]), ["POST", "accept", "saved", "GET"]);
});

test("未准入、携带不能满足的既有预算约束或缺接受编号保存器时零HTTP", async () => {
  const { input } = fixture();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("UNEXPECTED_EXTERNAL_REQUEST"); };
  for (const change of [
    value => { delete value.authorizedExecution; },
    value => { value.authorizedExecution.identity.storeRef.mappingVersion = "mapping:changed"; },
    value => { value.paymentAuthorization = { preservedRestrictedRecord: true }; },
    value => { delete value.onGatewayJobAccepted; }
  ]) {
    const value = { ...input, authorizedExecution: structuredClone(input.authorizedExecution), onGatewayJobAccepted: async () => {} };
    change(value);
    await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...value, fetchImpl }));
  }
  assert.equal(calls, 0);
});

test("接受编号保存失败、保存超时或网关来源回显漂移均不继续查询或再次POST", async () => {
  for (const scenario of ["save_failed", "save_timeout", "binding_drift"]) {
    const { input, wire } = fixture();
    let calls = 0, acceptedId = null;
    await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, totalTimeoutMs: 30,
      onGatewayJobAccepted: async ({ gatewayJobId }) => {
        acceptedId = gatewayJobId;
        if (scenario === "save_failed") throw new Error("PERSISTENCE_UNAVAILABLE");
        if (scenario === "save_timeout") await new Promise(() => {});
      },
      fetchImpl: async () => {
        calls += 1;
        const response = { ...structuredClone(wire), jobId: "gateway:accepted:1", status: "queued" };
        if (scenario === "binding_drift") response.sourceBinding.storeRef.mappingVersion = "mapping:other";
        return Response.json(response);
      } }), error => scenario === "save_failed" ? error.message === "PERSISTENCE_UNAVAILABLE"
        : error.externalRequestState === "unknown_outcome" && error.jobId === "gateway:accepted:1");
    assert.equal(calls, 1); assert.equal(acceptedId, "gateway:accepted:1");
  }
});

test("现有端点404只停止一次请求，不改路径或读取凭据探针", async () => {
  const { input } = fixture(), urls = [];
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, onGatewayJobAccepted: async () => assert.fail("未接受"),
    fetchImpl: async url => { urls.push(url); return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }); }
  }), error => error.code === "NOT_FOUND" && error.externalRequestState === "unknown_outcome");
  assert.deepEqual(urls, ["http://127.0.0.1:4318/v1/inference-jobs"]);
});

test("POST已返回编号时本地总时钟越界仍保存编号，随后零查询并保留unknown", async () => {
  const { input, wire } = fixture();
  let elapsed = 0, calls = 0, saved = null;
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, totalTimeoutMs: 10, clock: () => elapsed,
    onGatewayJobAccepted: async value => { saved = value.gatewayJobId; },
    fetchImpl: async () => {
      calls += 1; elapsed = 11;
      return Response.json({ ...wire, jobId: "gateway:deadline:accepted", status: "queued" });
    }
  }), error => error.code === "C1_AI_GATEWAY_DEADLINE_EXCEEDED" && error.jobId === "gateway:deadline:accepted" &&
    error.externalRequestState === "unknown_outcome");
  assert.equal(saved, "gateway:deadline:accepted"); assert.equal(calls, 1);
});

test("网关failed不冒充供应请求明确失败，保留真实耗用并明确费用未知", async () => {
  const { input, completed } = fixture();
  for (const requestState of [undefined, "succeeded", "failed", "unknown_outcome"]) {
    let calls = 0;
    await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, onGatewayJobAccepted: async () => {},
      fetchImpl: async () => { calls += 1; return Response.json({ ...completed, status: "failed", externalRequestState: requestState,
        requestTransmission: ["succeeded", "failed"].includes(requestState) ? "response_received" : requestState ? "attempted" : undefined,
        failure: { code: "MODEL_OUTPUT_REJECTED", layer: "output_schema" } }); }
    }), error => {
      assert.equal(error.externalRequestState, requestState ?? "unknown_outcome");
      assert.equal(error.accounting.providerRequestId, "provider:payment:1");
      assert.deepEqual(error.accounting.usage, { prompt_tokens: 12, completion_tokens: 8 });
      assert.equal(error.accounting.charge.status, "unknown");
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("供应商明确未发送与已调用网关分别记录，不能改成unknown或零网关调用", async () => {
  const { input, completed } = fixture();
  let posts = 0;
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, onGatewayJobAccepted: async () => {},
    fetchImpl: async () => { posts += 1; return Response.json({ ...completed, status: "failed",
      externalRequestState: "not_sent", requestTransmission: "not_attempted", receipt: null,
      failure: { code: "KEY_NOT_CONFIGURED", layer: "keychain" } }); }
  }), error => {
    assert.equal(error.externalRequestState, "failed");
    assert.deepEqual(error.providerOutcome, { schemaVersion: "c1-provider-outcome-v1", failureLayer: "keychain",
      externalRequestState: "not_sent", requestTransmission: "not_attempted" });
    assert.equal(error.accounting.usage, "unknown");
    return true;
  });
  assert.equal(posts, 1);
});

test("矛盾传输终态保存已知编号与耗用并结构化停止，不逃逸为无上下文错误", async () => {
  const { input, completed } = fixture();
  let posts = 0;
  await assert.rejects(runC1SavedDraftRequestThroughGateway({ ...input, onGatewayJobAccepted: async () => {},
    fetchImpl: async () => { posts += 1; return Response.json({ ...completed, status: "failed",
      externalRequestState: "failed", requestTransmission: "not_attempted", failure: { code: "CONTRADICTORY_RESULT", layer: "provider" } }); }
  }), error => {
    assert.equal(error.code, "C1_AI_GATEWAY_PROVIDER_OUTCOME_INVALID");
    assert.equal(error.jobId, completed.jobId); assert.equal(error.externalRequestState, "unknown_outcome");
    assert.deepEqual(error.accounting.usage, completed.receipt.usage);
    return true;
  });
  assert.equal(posts, 1);
});
