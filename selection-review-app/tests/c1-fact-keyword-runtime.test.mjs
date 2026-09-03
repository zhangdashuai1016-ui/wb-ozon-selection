import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  C1_FACT_KEYWORD_RUNTIME_INPUT_VERSION,
  prepareC1FactKeywordRuntime
} from "../lib/c1-fact-keyword-runtime.mjs";

const NOW = "2026-08-24T00:00:00.000Z";

function input(overrides = {}) {
  return {
    schemaVersion: C1_FACT_KEYWORD_RUNTIME_INPUT_VERSION,
    dataRevision: 21,
    keywordSourceEvidence: { fulfillment: "rfbs", locale: "ru-RU", frozenEvidence: {}, policy: {}, healthPolicy: {} },
    frozenSeoRules: { rulesVersion: "seo-v1" },
    frozenComplexityDecision: null,
    reusableKeywordSnapshot: null,
    keywordExpiresAt: "2026-08-25T00:00:00.000Z",
    providerEvidence: {
      seerfarApiReceipt: { receiptId: "seerfar:1" },
      browserReceipt: null,
      standardSkuHealthReceipts: [
        { standardSkuId: "s1", receiptId: "health:1" },
        { standardSkuId: "s2", receiptId: "health:2" },
        { standardSkuId: "s3", receiptId: "health:3" }
      ],
      keywordMetricEvidence: { evidenceId: "metrics:1" }
    },
    ...overrides
  };
}

function skuPackage() {
  return { candidateId: "CX-RUNTIME-001", skuPackageId: "sku:runtime:001", businessPhase: "C1", dataRevision: 7, c1ProductPlan: { status: "facts_checked" } };
}

test("服务端接缝只读取冻结提供器回执一次，不执行外部访问", async () => {
  let pipelineCalls = 0;
  const prepared = await prepareC1FactKeywordRuntime({
    candidateId: "CX-RUNTIME-001",
    skuPackage: skuPackage(),
    input: input(),
    preparedAt: NOW
  }, {
    preparePipeline: async (args, providers) => {
      pipelineCalls += 1;
      assert.equal(args.candidateRevision, 21);
      assert.deepEqual(await providers.seerfarApi({}), { receiptId: "seerfar:1" });
      assert.deepEqual(await providers.standardSkuHealth({ standardSku: { id: "s1" } }), { standardSkuId: "s1", receiptId: "health:1" });
      assert.deepEqual(await providers.keywordMetrics({}), { evidenceId: "metrics:1" });
      return { status: "ready_for_atomic_persist", execution: { metricProviderCalls: 1 } };
    }
  });
  assert.equal(pipelineCalls, 1);
  assert.equal(prepared.result.status, "ready_for_atomic_persist");
  assert.equal(prepared.receipt.skuPackageId, "sku:runtime:001");
  assert.deepEqual(prepared.receipt.providerReceiptReads, {
    seerfarApi: 1,
    browser: 0,
    standardSkuHealth: 1,
    keywordMetrics: 1
  });
  assert.equal(prepared.receipt.externalCallsByRuntime, 0);
  assert.equal(prepared.receipt.codexDispatches, 0);
  assert.equal(prepared.receipt.platformWrites, 0);
  assert.equal(prepared.receipt.automaticRetries, 0);
});

test("缺冻结回执或同一回执被重复读取时停止，不走兜底", async () => {
  const missing = input();
  missing.providerEvidence.seerfarApiReceipt = null;
  await assert.rejects(() => prepareC1FactKeywordRuntime({
    candidateId: "CX-RUNTIME-001", skuPackage: skuPackage(), input: missing, preparedAt: NOW
  }, { preparePipeline: async (_args, providers) => providers.seerfarApi({}) }), /FROZEN_SEERFAR_RECEIPT_MISSING/);

  await assert.rejects(() => prepareC1FactKeywordRuntime({
    candidateId: "CX-RUNTIME-001", skuPackage: skuPackage(), input: input(), preparedAt: NOW
  }, { preparePipeline: async (_args, providers) => {
    await providers.keywordMetrics({});
    return providers.keywordMetrics({});
  } }), /PROVIDER_REUSED:keywordMetrics/);
});

test("候选或输入结构漂移在流水线调用前拒绝", async () => {
  let calls = 0;
  await assert.rejects(() => prepareC1FactKeywordRuntime({
    candidateId: "OTHER", skuPackage: skuPackage(), input: input(), preparedAt: NOW
  }, { preparePipeline: async () => { calls += 1; } }), /CANDIDATE_DRIFT/);
  await assert.rejects(() => prepareC1FactKeywordRuntime({
    candidateId: "CX-RUNTIME-001", skuPackage: skuPackage(), input: { ...input(), dataRevision: null }, preparedAt: NOW
  }, { preparePipeline: async () => { calls += 1; } }), /INPUT_INVALID/);
  assert.equal(calls, 0);
});

test("冻结回执含Token、Cookie、密码或密钥字段时在持久化前拒绝", async () => {
  for (const [field, value] of [["access_token", "secret"], ["Cookie", "session=1"], ["apiKey", "secret"], ["password", "secret"]]) {
    const unsafe = input();
    unsafe.providerEvidence.keywordMetricEvidence[field] = value;
    await assert.rejects(() => prepareC1FactKeywordRuntime({
      candidateId: "CX-RUNTIME-001", skuPackage: skuPackage(), input: unsafe, preparedAt: NOW
    }, { preparePipeline: async () => ({ status: "ready_for_atomic_persist" }) }), /SECRET_FORBIDDEN/);
  }
});

test("发布Schema锁定冻结回执输入，不允许任意额外字段", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-fact-keyword-runtime-input-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, C1_FACT_KEYWORD_RUNTIME_INPUT_VERSION);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.providerEvidence.additionalProperties, false);
  assert.equal(schema.properties.providerEvidence.properties.standardSkuHealthReceipts.maxItems, 3);
});
