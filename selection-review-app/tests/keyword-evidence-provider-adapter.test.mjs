import assert from "node:assert/strict";
import test from "node:test";

import { createSeerfarKeywordProviderAdapter } from "../lib/keyword-evidence-provider-adapter.mjs";
import { prepareKeywordEvidence } from "../lib/keyword-evidence-orchestrator.mjs";

const NOW = "2026-08-24T04:00:00.000Z";
const identity = { candidateId: "CX-NON-TRAIN-PROVIDER", parentOpportunityId: "op:provider", skuPackageId: "sku:provider", dataRevision: 3 };
const bindings = { salesSnapshot: { snapshotId: "sales:3", version: "sales-v1", fingerprint: "sales-fp" }, supplySkuFacts: { version: "supply-v1", fingerprint: "supply-fp" } };

function input(overrides = {}) {
  return {
    identity, bindings, platform: "ozon", exactSku: "GENERIC-MUSIC-BOX", fulfillment: "rfbs", locale: "ru-RU",
    businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:3" }, now: NOW,
    policy: { browserAllowed: true, browserPreauthorized: true },
    healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false,
      standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: { productFactTerms: [{ term: "hand crank", sourceRefs: ["supply:3"], factRefs: ["supply:3#/mechanism"], sourceTrust: "owner" }], comparables: [], seedEvidence: [] }, reusableSnapshot: null,
    ...overrides
  };
}

function transportReceipt(channel, observation = {}, candidates = []) {
  return {
    observation: { attemptId: `attempt:${channel}`, provider: `seerfar-${channel}`, queryId: `query:${channel}`, requestId: `request:${channel}`, receiptId: null,
      startedAt: NOW, completedAt: NOW, traceRef: `trace:${channel}`, completed: true, resultCount: candidates.length, ...observation },
    candidates, pointsBefore: null, pointsAfter: null, pointsSpent: null
  };
}

function candidate(attemptId = "attempt:api") {
  return { term: "mechanical music box", sourceRefs: [attemptId], factRefs: ["fact:mechanism"], competitorRefs: ["competitor:1"], sourceTrust: null, matchType: "exact_match" };
}

test("普通非火车SKU优先Open API且成功时不调用浏览器", async () => {
  let api = 0, browser = 0;
  const adapter = createSeerfarKeywordProviderAdapter({
    openApiTransport: async () => { api += 1; return transportReceipt("api", {}, [candidate()]); },
    browserTransport: async () => { browser += 1; return transportReceipt("browser", {}, [candidate("attempt:browser")]); }
  });
  const result = await prepareKeywordEvidence(input(), adapter.providers);
  assert.equal(result.result, "source_candidates_ready");
  assert.deepEqual([api, browser, result.execution.seerfarApiCalls, result.execution.browserCalls], [1, 0, 1, 0]);
  assert.equal(result.businessEffect.dispatchesCreated, 0);
});

test("API技术失败仅在预授权后调用一次浏览器并保留分类", async () => {
  const classes = [
    ["login_required", { loginRequired: true }], ["quota_or_rate_limit", { httpStatus: 429 }], ["network_timeout", { timeout: true }],
    ["provider_server_error", { httpStatus: 500 }]
  ];
  for (const [expected, observation] of classes) {
    const adapter = createSeerfarKeywordProviderAdapter({
      openApiTransport: async () => transportReceipt("api", { ...observation, completed: false, completedAt: null, resultCount: null }, []),
      browserTransport: async () => transportReceipt("browser", {}, [candidate("attempt:browser")])
    });
    const result = await prepareKeywordEvidence(input(), adapter.providers);
    assert.equal(result.sourceAttempts[0].failureClass, expected);
    assert.deepEqual([adapter.calls.api, adapter.calls.browser], [1, 1]);
  }
  const staleAdapter = createSeerfarKeywordProviderAdapter({
    openApiTransport: async () => transportReceipt("api", { stale: true, completed: false, completedAt: null, resultCount: null }, []),
    browserTransport: async () => { throw new Error("stale不是技术失败，不得自动切浏览器"); }
  });
  const stale = await prepareKeywordEvidence(input(), staleAdapter.providers);
  assert.equal(stale.sourceAttempts[0].failureClass, "stale_result");
  assert.equal(staleAdapter.calls.browser, 0);
});

test("浏览器selector与input失败不混淆，未预授权时浏览器零调用", async () => {
  for (const [expected, observation] of [["selector_changed", { selectorChanged: true }], ["input_not_committed", { inputCommitted: false }]]) {
    const adapter = createSeerfarKeywordProviderAdapter({
      openApiTransport: async () => transportReceipt("api", { httpStatus: 500, completed: false, completedAt: null, resultCount: null }, []),
      browserTransport: async () => transportReceipt("browser", { ...observation, completed: false, completedAt: null, resultCount: null }, [])
    });
    const result = await prepareKeywordEvidence(input(), adapter.providers);
    assert.equal(result.sourceAttempts[1].failureClass, expected);
  }
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => transportReceipt("api", { timeout: true, completed: false, completedAt: null, resultCount: null }, []), browserTransport: async () => { throw new Error("不得调用"); } });
  await prepareKeywordEvidence(input({ policy: { browserAllowed: true, browserPreauthorized: false } }), adapter.providers);
  assert.equal(adapter.calls.browser, 0);
});

test("true_empty只接受完成查询且严格0结果", async () => {
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => transportReceipt("api", { resultCount: 0 }, []) });
  const result = await prepareKeywordEvidence(input(), adapter.providers);
  assert.equal(result.sourceAttempts[0].failureClass, "true_empty");
  assert.equal(adapter.calls.browser, 0);
  const invalid = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => transportReceipt("api", { completed: false, completedAt: null, resultCount: 0 }, []) });
  await assert.rejects(() => prepareKeywordEvidence(input(), invalid.providers), /OUTCOME_UNCLASSIFIED|ATTEMPT_INVALID/);
});

test("标准SKU故障暂停Seerfar付费调用但本地融合继续", async () => {
  const healthInput = input();
  healthInput.healthPolicy.connectorVersion = "v2";
  const adapter = createSeerfarKeywordProviderAdapter({
    openApiTransport: async () => { throw new Error("健康失败后不得调用"); },
    standardSkuHealthTransport: async ({ standardSku }) => ({ standardSkuId: standardSku.id, status: "failed", checkedAt: NOW, receiptId: `health:${standardSku.id}`, attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null })
  });
  const result = await prepareKeywordEvidence(healthInput, adapter.providers);
  assert.equal(result.connector.seerfarConnectorSuspended, true);
  assert.equal(result.result, "source_candidates_ready");
  assert.deepEqual([adapter.calls.standardSkuHealth, adapter.calls.api], [1, 0]);
});

test("适配层拒绝秘密字段且每条外部路径最多一次", async () => {
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => ({ ...transportReceipt("api", {}, [candidate()]), access_token: "forbidden" }) });
  await assert.rejects(() => prepareKeywordEvidence(input(), adapter.providers), /SECRET_FORBIDDEN/);
  const clean = createSeerfarKeywordProviderAdapter({ openApiTransport: async () => transportReceipt("api", {}, [candidate()]) });
  await clean.providers.seerfarApi({ input: input(), attemptLimit: 1 });
  await assert.rejects(() => clean.providers.seerfarApi({ input: input(), attemptLimit: 1 }), /ATTEMPT_LIMIT_EXCEEDED/);
});
