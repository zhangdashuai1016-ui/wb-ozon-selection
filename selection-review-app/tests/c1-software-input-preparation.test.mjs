import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  C1_SOFTWARE_INPUT_PREPARATION_VERSION,
  fingerprintC1SalesSnapshot,
  fingerprintC1VerifiedFacts,
  prepareC1SoftwareInputs
} from "../lib/c1-software-input-preparation.mjs";
import { buildC1AiDraftRequest } from "../lib/c1-ai-draft-contract.mjs";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";

const NOW = "2026-08-22T05:00:00.000Z";

function skuPackage() {
  return structuredClone(createFormalC1DraftFixture({ at: NOW, candidateId: "FIXTURE-SHELF-001", supplierSkuId: "SHELF-WHITE",
    variantKey: "颜色:白色", productName: "Полка для ванной комнаты без сверления", material: "plastic",
    categoryName: "Полки для ванной", categoryPath: "Дом / Полки", salesSnapshotVersion: "sales-snapshot-v1.1",
    salesAttributes: { material: "пластик", color: "белый", mounting: { method: "самоклеящийся" } },
    productUrl: "https://www.ozon.ru/product/synthetic-shelf-100000002/", imageUrl: "https://example.com/synthetic-shelf.png"
  }).checked.skuPackage);
}

function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v3",
    locale: "ru-RU",
    titleMaxLength: 120,
    descriptionMaxLength: 1800,
    bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand", "unverified_material", "unverified_dimensions", "unverified_certification"],
    evidenceRef: "config:seo-rules-ru-v3",
    frozenAt: NOW
  };
}

function keywordEvidence(pkg) {
  const plan = pkg.c1ProductPlan;
  return {
    evidenceId: "keywords:fixture:bathroom-shelf:2026-08-22",
    status: "ready",
    targetPlatform: "ozon",
    targetSkuPackageId: pkg.skuPackageId,
    sourcePlatform: "seerfar",
    collectionMode: "reused_verified_evidence",
    observedAt: NOW,
    evidenceRef: "evidence:keywords:bathroom-shelf:2026-08-22",
    sourceBindings: {
      c1PlanId: plan.c1PlanId,
      salesSnapshotId: plan.inputRefs.salesSnapshotId,
      c1FactsFingerprint: fingerprintC1VerifiedFacts(plan),
      salesSnapshotFingerprint: fingerprintC1SalesSnapshot(plan.inputSnapshots.salesSnapshot)
    },
    keywords: [{
      query: "полка для ванной",
      group: "core_product_type",
      keywordEvidenceRef: "keyword:fixture:полка-для-ванной",
      sourceSku: "ozon-fixture-shelf-1001",
      sourcePlatform: "seerfar",
      relevanceStatus: "retained",
      factBindingPaths: ["platformCategory.categoryName"]
    }]
  };
}

function prepare(pkg, overrides = {}) {
  return prepareC1SoftwareInputs({
    skuPackage: pkg,
    frozenSeoRules: seoRules(),
    savedKeywordEvidence: keywordEvidence(pkg),
    legacySavedKeywordEvidenceReadOnly: true,
    preparedAt: NOW,
    ...overrides
  });
}

test("普通非火车SKU只用冻结销售标题/属性和上游关键词证据形成ready输入", () => {
  const pkg = skuPackage();
  const result = prepare(pkg);

  assert.equal(result.schemaVersion, C1_SOFTWARE_INPUT_PREPARATION_VERSION);
  assert.equal(result.status, "ready");
  assert.equal(result.inputs.taskClassification.complexity, "standard");
  assert.equal(result.inputs.taskClassification.preapprovedForSol, false);
  assert.equal(result.inputs.taskClassification.gatewayTaskType, undefined);
  assert.equal(result.inputs.competitorTextSnapshot.sourceSalesSnapshotId, "fixture-sales:FIXTURE-SHELF-001");
  assert.equal(result.inputs.competitorTextSnapshot.evidenceRef, "test:sales:FIXTURE-SHELF-001");
  assert.deepEqual(
    result.inputs.competitorTextSnapshot.texts.map((item) => item.text),
    [
      "Полка для ванной комнаты без сверления",
      "material: пластик",
      "color: белый",
      "mounting.method: самоклеящийся"
    ]
  );
  assert.ok(result.inputs.competitorTextSnapshot.texts.every((item) => item.sourceRef.startsWith("test:sales:FIXTURE-SHELF-001")));
  assert.equal(result.inputs.keywordEvidence.keywords[0].query, "полка для ванной");
  const downstreamRequest = buildC1AiDraftRequest({
    skuPackage: pkg,
    ...result.inputs,
    requestedAt: NOW
  });
  assert.equal(downstreamRequest.provider, "terra");
  assert.equal(downstreamRequest.executionPolicy.attemptLimit, 1);
  assert.deepEqual(downstreamRequest.sourceIdentity, pkg.g1Identity);
  assert.equal(downstreamRequest.sourceSkuRevision, pkg.dataRevision);
  assert.deepEqual(result.executionEvidence, {
    externalAccesses: [],
    seerfarCalls: 0,
    gatewayCalls: 0,
    codexDispatches: 0,
    platformWrites: 0
  });
  assert.deepEqual(result.downstream, { c2Started: false, productionStarted: false, eReadbackStarted: false });
  assert.equal(Object.isFrozen(result), true);
});

test("上游没有关键词证据时返回not_ready且不从竞品标题拆词兜底", () => {
  const pkg = skuPackage();
  const result = prepare(pkg, { savedKeywordEvidence: null });

  assert.equal(result.status, "not_ready");
  assert.equal(result.inputs.keywordEvidence, null);
  assert.deepEqual(result.gaps.map((item) => item.code), ["keyword_evidence_missing"]);
  assert.equal(JSON.stringify(result.inputs).includes('"query"'), false);
  assert.equal(result.executionEvidence.seerfarCalls, 0);
});

test("活动路径拒绝旧扁平savedKeywordEvidence，只有显式历史只读兼容可读", () => {
  const pkg = skuPackage();
  const result = prepare(pkg, { legacySavedKeywordEvidenceReadOnly: false });
  assert.equal(result.status, "not_ready");
  assert.equal(result.inputs.keywordEvidence, null);
  assert.deepEqual(result.gaps.map((item) => item.code), ["k3_keyword_snapshot_required"]);
});

test("关键词证据绑定的冻结销售快照漂移时直接拒绝", () => {
  const pkg = skuPackage();
  const evidence = keywordEvidence(pkg);
  pkg.c1ProductPlan.inputSnapshots.salesSnapshot.title = "已漂移的新标题";

  assert.throws(
    () => prepare(pkg, { savedKeywordEvidence: evidence }),
    /C1_INPUT_PREPARATION_EVIDENCE_DRIFT/
  );
});

test("复杂任务只能由冻结规则预标并锁定允许的Sol gatewayTaskType", () => {
  const pkg = skuPackage();
  const factsFingerprint = fingerprintC1VerifiedFacts(pkg.c1ProductPlan);
  const decision = {
    decisionId: "complexity:fixture:bathroom-shelf:1",
    ruleVersion: "c1-complexity-rules-v1",
    evaluatedAt: NOW,
    c1PlanId: pkg.c1ProductPlan.c1PlanId,
    sourceFactsFingerprint: factsFingerprint,
    complexity: "complex",
    reason: "冻结规则发现品牌/IP合规冲突，需要预定义复杂分析",
    evidenceRefs: [pkg.c1ProductPlan.inputRefs.platformSchemaEvidenceId],
    gatewayTaskType: "brand_ip_compliance_analysis"
  };

  const result = prepare(pkg, { frozenComplexityDecision: decision });
  assert.equal(result.inputs.taskClassification.complexity, "complex");
  assert.equal(result.inputs.taskClassification.preapprovedForSol, true);
  assert.equal(result.inputs.taskClassification.gatewayTaskType, "brand_ip_compliance_analysis");

  assert.throws(
    () => prepare(pkg, { frozenComplexityDecision: { ...decision, gatewayTaskType: "model_decides" } }),
    /C1_INPUT_PREPARATION_COMPLEX_TASK_INVALID/
  );
});

test("输入准备函数不会发起任何外部访问且相同冻结输入幂等", () => {
  const pkg = skuPackage();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("不应访问网络");
  };
  try {
    const first = prepare(pkg);
    const second = prepare(pkg);
    assert.deepEqual(second, first);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("输入准备Schema明确禁止外部调用和下游阶段启动", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schema/c1-software-input-preparation-v1.schema.json", import.meta.url),
    "utf8"
  ));
  assert.equal(schema.properties.executionEvidence.properties.externalAccesses.maxItems, 0);
  assert.equal(schema.properties.executionEvidence.properties.seerfarCalls.const, 0);
  assert.equal(schema.properties.executionEvidence.properties.gatewayCalls.const, 0);
  assert.equal(schema.properties.executionEvidence.properties.codexDispatches.const, 0);
  assert.equal(schema.properties.downstream.properties.c2Started.const, false);
  assert.equal(schema.properties.downstream.properties.productionStarted.const, false);
});
