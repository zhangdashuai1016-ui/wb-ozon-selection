import assert from "node:assert/strict";
import test from "node:test";

import { createSeerfarKeywordProviderAdapter } from "../lib/keyword-evidence-provider-adapter.mjs";
import { prepareKeywordEvidence } from "../lib/keyword-evidence-orchestrator.mjs";
import { buildSeerfarCategoryPayload, buildSeerfarProductPayload, buildSeerfarReversePayload, createSeerfarOpenApiTransport, SEERFAR_OPEN_API_BASE } from "../lib/seerfar-open-api-transport.mjs";

const NOW = "2026-08-24T06:00:00.000Z";
function response(step, records = null, extras = {}) {
  const data = step.startsWith("quota") ? { creditLimit: 100, creditUsed: step === "quota_before" ? 20 : 35 } : { records: records ?? [{ query: "mechanical music box" }] };
  return { status: 200, json: { code: 200, data }, requestId: `request:${step}`, completedAt: NOW, ...extras };
}
function plan(overrides = {}) { return { operation: "reverse_keywords", platform: "ozon", skuIds: ["123", "456"], factRefs: ["fact:mechanism"], competitorRefs: ["competitor:123", "competitor:456"], matchType: "exact_match", attemptId: "attempt:seerfar:1", queryId: "query:seerfar:1", startedAt: NOW, receiptId: "receipt:seerfar:1", ...overrides }; }
function request(overrides = {}) { return { queryText: "SKU-TARGET", locale: "ru-RU", targetPlatform: "ozon", exactSku: "SKU-TARGET", fulfillment: "rfbs", identity: { candidateId: "CX-NON-TRAIN-SEERFAR", dataRevision: 2 }, seerfarRequest: plan(), attemptLimit: 1, ...overrides }; }

test("只允许固定HTTPS域名和七个端点族，不接受任意URL、平台或操作", async () => {
  const urls = [];
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-test-key", httpTransport: async (req) => { urls.push(req.url); return response(req.step); }, clock: { now: () => 0 }, sleep: async () => {} });
  await transport(request());
  assert.deepEqual(urls, [`${SEERFAR_OPEN_API_BASE}/open-api/quota`, `${SEERFAR_OPEN_API_BASE}/open-api/keyword/backSearch/ozon`, `${SEERFAR_OPEN_API_BASE}/open-api/quota`]);
  const invalid = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", httpTransport: async () => { throw new Error("不得调用"); } });
  await assert.rejects(() => invalid(request({ targetPlatform: "evil", seerfarRequest: plan({ platform: "evil" }) })), /REQUEST_PLAN_INVALID|ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(() => createSeerfarOpenApiTransport({ secretProvider: async () => "fake", httpTransport: async () => response("quota_before") })(request({ seerfarRequest: plan({ operation: "arbitrary_url", url: "https://evil.test" }) })), /REQUEST_PLAN_INVALID/);
});

test("Skill已验证的product/category/reverse payload保持边界且Ozon普通类目ID拒绝", () => {
  assert.deepEqual(buildSeerfarProductPayload({ platform: "ozon", sku: "123", dateRange: "past_30_days" }), { sku: "123", dateRange: "past_30_days" });
  assert.deepEqual(buildSeerfarProductPayload({ platform: "wb", sku: "123", dateRange: "past_30_days" }), { sku: "123", dateRange: "past_30_days", includeFbs: true });
  assert.throws(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17028712", fulfillment: "rfbs" }), /NOT_COMPOSITE/);
  assert.doesNotThrow(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_17028712", fulfillment: "rfbs" }));
  const category = buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_17028712_93366", fulfillment: "rfbs" });
  assert.throws(() => buildSeerfarCategoryPayload({ platform: "ozon", categoryId: "17027494_bad", fulfillment: "rfbs" }), /NOT_COMPOSITE/);
  assert.deepEqual(category.page, { pageNumber: 1, pageSize: 20, orders: [{ field: "revenue", direction: "DESC" }] });
  const reverse = buildSeerfarReversePayload({ skuIds: ["123", "ABC"] });
  assert.deepEqual(reverse.skuIds, [123, "ABC"]);
  assert.equal(reverse.page.pageSize, "100");
});

test("配额前后、请求号、端点类别、点数、数据时间和脱敏引用进入回执", async () => {
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-test-key", httpTransport: async (req) => response(req.step), clock: { now: () => 0 }, sleep: async () => {} });
  const receipt = await transport(request());
  assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent], [80, 65, 15]);
  assert.deepEqual(receipt.evidence.requestIds, ["request:quota_before", "request:reverse_keywords", "request:quota_after"]);
  assert.equal(receipt.evidence.endpointCategory, "reverse_keywords");
  assert.equal(receipt.evidence.dataObservedAt, NOW);
  assert.match(receipt.evidence.evidenceRef, /^seerfar:reverse_keywords:[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(receipt).includes("fake-test-key"), false);
});

test("每个步骤一次且以注入clock/sleep执行3秒限频，无真实等待和自动重试", async () => {
  let now = 0; const waits = []; const steps = [];
  const transport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => now }, sleep: async (ms) => { waits.push(ms); now += ms; }, httpTransport: async (req) => { steps.push([req.step, req.attempt, req.redirect]); return response(req.step); } });
  await transport(request());
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(steps, [["quota_before", 1, "error"], ["reverse_keywords", 1, "error"], ["quota_after", 1, "error"]]);
  await assert.rejects(() => transport(request()), /ATTEMPT_LIMIT_EXCEEDED/);
});

test("HTTP、超时、配额、登录、stale和schema失败保持精确技术语义且不重试", async () => {
  const cases = [
    [401, null, "login_required"], [429, null, "quota_or_rate_limit"], [500, null, "provider_server_error"],
    [null, { code: "network_timeout" }, "network_timeout"], [null, { code: "network_error" }, "network_error"], [null, { code: "stale_result" }, "stale_result"], [null, { failureKind: "schema_error" }, "provider_server_error"]
  ];
  for (const [status, thrown, expected] of cases) {
    let targetCalls = 0;
    const openApiTransport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => {
      if (req.step === "quota_before") return response(req.step);
      targetCalls += 1;
      if (thrown) throw Object.assign(new Error("safe"), thrown);
      return response(req.step, null, { status });
    }});
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
    const receipt = await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 });
    assert.equal(receipt.attempt.failureClass, expected);
    assert.equal(targetCalls, 1);
  }
});

test("失败回执保留脱敏步骤，正式查询或额度后检失败可判定结果未知", async () => {
  for (const [failedStep, expectedStage] of [["reverse_keywords", "target_request"], ["quota_after", "quota_after"]]) {
    const transport = createSeerfarOpenApiTransport({
      secretProvider: async () => "fake",
      clock: { now: () => 0 },
      sleep: async () => {},
      httpTransport: async (req) => {
        if (req.step === failedStep) throw Object.assign(new Error("safe"), { code: "network_error" });
        return response(req.step);
      }
    });
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: transport });
    const receipt = await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 });
    assert.equal(receipt.attempt.failureClass, "network_error");
    assert.equal(receipt.attempt.failureStage, expectedStage);
    assert.equal(JSON.stringify(receipt).includes("fake"), false);
  }
});

test("true_empty仅来自明确完成且records严格为空，缺records属于schema失败", async () => {
  const empty = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => response(req.step, req.step === "reverse_keywords" ? [] : null) });
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport: empty });
  assert.equal((await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 })).attempt.failureClass, "true_empty");
  const missing = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => req.step === "reverse_keywords" ? { ...response(req.step), json: { code: 200, data: {} } } : response(req.step) });
  const missingAdapter = createSeerfarKeywordProviderAdapter({ openApiTransport: missing });
  assert.equal((await missingAdapter.providers.seerfarApi({ input: input(), attemptLimit: 1 })).attempt.failureClass, "provider_server_error");
});

test("假密钥仅进入注入HTTP头，供应商未知配额保留null且秘密响应拒绝", async () => {
  let seenHeader = null;
  const unknown = createSeerfarOpenApiTransport({ secretProvider: async () => "fake-only", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => { seenHeader = req.headers.Authorization; const r = response(req.step); if (req.step.startsWith("quota")) r.json.data = {}; return r; } });
  const receipt = await unknown(request());
  assert.equal(seenHeader, "Bearer fake-only");
  assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent], [null, null, null]);
  assert.equal(JSON.stringify(receipt).includes("fake-only"), false);
  const unsafe = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => req.step === "reverse_keywords" ? { ...response(req.step), json: { code: 200, data: { records: [], access_token: "leak" } } } : response(req.step) });
  const unsafeAdapter = createSeerfarKeywordProviderAdapter({ openApiTransport: unsafe });
  assert.equal((await unsafeAdapter.providers.seerfarApi({ input: input(), attemptLimit: 1 })).attempt.failureClass, "provider_server_error");
});

function input() {
  return { identity: { candidateId: "CX-NON-TRAIN-SEERFAR", parentOpportunityId: "op:1", skuPackageId: "sku:1", dataRevision: 2 }, bindings: { salesSnapshot: { snapshotId: "sales:2", version: "sales-v1", fingerprint: "sales-fp" }, supplySkuFacts: { version: "supply-v1", fingerprint: "supply-fp" } },
    platform: "ozon", exactSku: "SKU-TARGET", fulfillment: "rfbs", locale: "ru-RU", seerfarRequest: plan(), businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:2" }, now: NOW,
    policy: { browserAllowed: false, browserPreauthorized: false }, healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false, standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: { productFactTerms: [{ term: "hand crank", sourceRefs: ["supply:2"], factRefs: ["fact:mechanism"], sourceTrust: "owner" }], comparables: [], seedEvidence: [] }, reusableSnapshot: null };
}

test("普通非火车SKU可与provider adapter和K2联跑且保持零业务副作用", async () => {
  const openApiTransport = createSeerfarOpenApiTransport({ secretProvider: async () => "fake", clock: { now: () => 0 }, sleep: async () => {}, httpTransport: async (req) => response(req.step) });
  const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
  const orchestratorInput = input();
  orchestratorInput.policy = { browserAllowed: true, browserPreauthorized: true };
  const prepared = await prepareKeywordEvidence(orchestratorInput, adapter.providers);
  assert.equal(prepared.result, "source_candidates_ready");
  assert.deepEqual(prepared.businessEffect, { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 });
  assert.deepEqual([prepared.execution.seerfarApiCalls, prepared.execution.browserCalls, prepared.execution.automaticRetries], [1, 0, 0]);
});

test("密钥为空或secretProvider抛错均收口login_required且HTTP零调用不泄露", async () => {
  for (const secretProvider of [async () => "", async () => { throw new Error("FAKE-SUPER-SECRET-TEXT"); }]) {
    let httpCalls = 0;
    const openApiTransport = createSeerfarOpenApiTransport({ secretProvider, httpTransport: async () => { httpCalls += 1; throw new Error("不得调用"); } });
    const adapter = createSeerfarKeywordProviderAdapter({ openApiTransport });
    const receipt = await adapter.providers.seerfarApi({ input: input(), attemptLimit: 1 });
    assert.equal(receipt.attempt.failureClass, "login_required");
    assert.equal(receipt.candidates.length, 0);
    assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent, httpCalls], [null, null, null, 0]);
    assert.equal(JSON.stringify(receipt).includes("FAKE-SUPER-SECRET-TEXT"), false);
  }
});

test("密钥不可用与orchestrator联跑时按既有策略继续且不冒充true_empty", async () => {
  let browserCalls = 0;
  const openApiTransport = createSeerfarOpenApiTransport({ secretProvider: async () => "", httpTransport: async () => { throw new Error("不得调用"); } });
  const adapter = createSeerfarKeywordProviderAdapter({
    openApiTransport,
    browserTransport: async () => ({ observation: { attemptId: "attempt:browser", provider: "seerfar-browser", queryId: "query:browser", requestId: "request:browser", receiptId: null, startedAt: NOW, completedAt: null, completed: false, resultCount: null, selectorChanged: true, traceRef: "trace:browser" }, candidates: [], pointsBefore: null, pointsAfter: null, pointsSpent: null })
  });
  const originalBrowser = adapter.providers.browser;
  adapter.providers.browser = async (args) => { browserCalls += 1; return originalBrowser(args); };
  const orchestratorInput = input();
  orchestratorInput.policy = { browserAllowed: true, browserPreauthorized: true };
  const prepared = await prepareKeywordEvidence(orchestratorInput, adapter.providers);
  assert.equal(prepared.sourceAttempts[0].failureClass, "login_required");
  assert.equal(prepared.sourceAttempts[1].failureClass, "selector_changed");
  assert.equal(prepared.sourceAttempts.some((attempt) => attempt.failureClass === "true_empty"), false);
  assert.equal(prepared.result, "source_candidates_ready");
  assert.equal(browserCalls, 1);
});
