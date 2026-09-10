import test from "node:test";
import assert from "node:assert/strict";
import { buildAStageTerraRequest, runAStageTerraAssist } from "../lib/a-stage-terra-gateway.mjs";
import { collectMockOzonSalesSnapshot } from "../lib/sales-snapshot.mjs";

function snapshot() {
  return collectMockOzonSalesSnapshot({
    sourceMode: "mock_ozon_fixture",
    snapshotId: "sales:terra:test",
    marketScope: "ozon_cn_cross_border",
    sellerType: "unknown",
    sellerIdentityEvidence: { status: "unverified", signals: [], evidenceRef: "seller:test" },
    productUrl: "https://www.ozon.ru/product/123456789/",
    title: "公开测试商品",
    imageRefs: ["https://cdn.example.com/public.jpg"],
    currentPrice: 1000,
    currency: "RUB",
    categoryPath: "测试类目",
    attributes: { color: "green" },
    collectedAt: "2026-08-22T05:00:00.000Z",
    evidenceRef: "public:test:evidence"
  });
}

const candidate = { id: "TEST-A-TERRA", dataRevision: 7 };
const gatewayUrl = "http://127.0.0.1:4318";

function completedJob(request, output = { summary: "整理完成", comparabilitySignals: ["价格清晰"], attributeHints: [] }) {
  return {
    jobId: "inf-terra-1",
    candidateId: request.candidateId,
    dataRevision: request.dataRevision,
    taskType: request.taskType,
    model: request.model,
    status: "completed",
    attempt: 1,
    receipt: {
      requestHash: "a".repeat(64),
      completedAt: "2026-08-22T05:01:00.000Z",
      validation: { strictJson: true, schemaValid: true },
      output
    }
  };
}

test("A阶段Terra请求只含公开文字，不发送图片、链接凭证或生产授权", () => {
  const request = buildAStageTerraRequest({ candidate, snapshot: snapshot() });
  assert.equal(request.taskType, "sales_comparability_assist");
  assert.equal(request.model, "gpt-5.6-terra");
  assert.deepEqual(request.input.images, []);
  assert.doesNotMatch(request.input.text, /Bearer|api.?key|cookie|生产授权/i);
  assert.equal(request.evidenceRefs[0].authorizedForAi, true);
});

test("Terra成功只追加辅助草稿并保存可追溯回执，不覆盖销售事实", async () => {
  const source = snapshot();
  const before = structuredClone(source);
  const request = buildAStageTerraRequest({ candidate, snapshot: source });
  const job = completedJob(request);
  let supplierPosts = 0;
  const result = await runAStageTerraAssist({
    candidate,
    snapshot: source,
    gatewayUrl,
    wait: async () => {},
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "POST") supplierPosts += 1;
      return new Response(JSON.stringify(job), { status: options.method === "POST" ? 202 : 200 });
    }
  });
  assert.equal(supplierPosts, 1);
  assert.equal(result.supplierAttempts, 1);
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.snapshot.title, before.title);
  assert.equal(result.snapshot.currentPrice, before.currentPrice);
  assert.equal(result.snapshot.auxiliaryDrafts[0].authoritative, false);
  assert.equal(result.snapshot.auxiliaryDrafts[0].mayOverrideObservedFields, false);
});

test("Terra失败立即停止，不换Sol、不重复创建供应商请求", async () => {
  let supplierPosts = 0;
  const failure = {
    jobId: "inf-failed",
    candidateId: candidate.id,
    dataRevision: String(candidate.dataRevision),
    taskType: "sales_comparability_assist",
    model: "gpt-5.6-terra",
    status: "failed",
    attempt: 1,
    failure: { layer: "provider", code: "PROVIDER_HTTP_ERROR", message: "供应商失败" }
  };
  await assert.rejects(() => runAStageTerraAssist({
    candidate,
    snapshot: snapshot(),
    gatewayUrl,
    wait: async () => {},
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "POST") supplierPosts += 1;
      return new Response(JSON.stringify(failure), { status: 202 });
    }
  }), (error) => error.code === "PROVIDER_HTTP_ERROR" && error.layer === "provider");
  assert.equal(supplierPosts, 1);
});

test("Terra回执候选或修订不一致时拒绝附加草稿", async () => {
  const request = buildAStageTerraRequest({ candidate, snapshot: snapshot() });
  const wrong = { ...completedJob(request), candidateId: "OTHER" };
  await assert.rejects(() => runAStageTerraAssist({
    candidate,
    snapshot: snapshot(),
    gatewayUrl,
    wait: async () => {},
    fetchImpl: async () => new Response(JSON.stringify(wrong), { status: 202 })
  }), /回执候选或修订号不一致/);
});
