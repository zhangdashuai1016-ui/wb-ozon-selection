import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { prepareKeywordEvidence, validateKeywordEvidencePreparation } from "../lib/keyword-evidence-orchestrator.mjs";
import { createKeywordEvidenceSnapshot } from "../lib/keyword-evidence-snapshot.mjs";

const NOW = "2026-08-23T04:00:00.000Z";
const identity = {
  candidateId: "CX-K2-001",
  parentOpportunityId: "opportunity:CX-K2-001",
  skuPackageId: "sku-package:CX-K2-001:SKU-1",
  dataRevision: 4
};
const bindings = {
  salesSnapshot: { snapshotId: "sales:CX-K2-001:4", version: "sales-snapshot-v1.1", fingerprint: "sales-fp-4" },
  supplySkuFacts: { version: "supply-sku-facts-v1", fingerprint: "supply-fp-4" }
};

function sourceAttempt(channel = "api", overrides = {}) {
  return {
    schemaVersion: "keyword-source-attempt-v1",
    attemptId: `attempt:${channel}`,
    provider: channel === "browser" ? "seerfar-browser" : "seerfar-api",
    channel,
    queryId: `query:${channel}`,
    queryText: "mechanical music box",
    locale: "ru-RU",
    targetPlatform: "ozon",
    requestId: `request:${channel}`,
    receiptId: null,
    startedAt: NOW,
    completedAt: NOW,
    status: "completed",
    resultCount: 1,
    failureClass: null,
    traceRef: `trace:${channel}`,
    ...overrides
  };
}

function raw(term = "mechanical music box", matchType = "exact_match", attemptId = "attempt:api") {
  return {
    term,
    sourceRefs: [attemptId],
    factRefs: ["supply:fact:mechanism"],
    competitorRefs: [],
    sourceTrust: null,
    matchType
  };
}

function comparable(index, matchType = "exact_match") {
  return {
    competitorRef: `sales:sample:${index}`,
    comparabilityStatus: "proven",
    comparabilityEvidenceRefs: [`sales:sample:${index}#/comparability`],
    matchType,
    terms: [{
      term: `${matchType} competitor term ${index}`,
      sourceRefs: [`sales:sample:${index}`],
      factRefs: [],
      sourceTrust: "frozen_sales_snapshot"
    }]
  };
}

function baseInput(overrides = {}) {
  return {
    identity: structuredClone(identity),
    bindings: structuredClone(bindings),
    platform: "ozon",
    exactSku: "SKU-1",
    fulfillment: "rfbs",
    locale: "ru-RU",
    businessGate: { approved: true, approvedAt: NOW, note: "A阶段证据准备已批准", evidenceRef: "owner-confirmation:A:4" },
    now: NOW,
    policy: { browserAllowed: true, browserPreauthorized: true },
    healthPolicy: {
      connectorVersion: "seerfar-connector-v1",
      apiSchemaVersion: "seerfar-api-v1",
      controlledWindowId: "window:2026-08-23-am",
      ttlMs: 3_600_000,
      suspectedSystemicFailure: false,
      standardSkus: [{ id: "standard:1" }, { id: "standard:2" }, { id: "standard:3" }],
      lastProof: {
        connectorVersion: "seerfar-connector-v1",
        apiSchemaVersion: "seerfar-api-v1",
        controlledWindowId: "window:2026-08-23-am",
        provedAt: NOW
      }
    },
    frozenEvidence: {
      productFactTerms: [{
        term: "hand crank",
        sourceRefs: ["supply:facts:4"],
        factRefs: ["supply:facts:4#/mechanism"],
        sourceTrust: "owner_confirmed_supply_fact",
        matchType: "target_fact"
      }],
      comparables: Array.from({ length: 5 }, (_, index) => comparable(index + 1)),
      seedEvidence: []
    },
    reusableSnapshot: null,
    ...overrides
  };
}

function providers(overrides = {}) {
  return {
    seerfarApi: async () => ({
      attempt: sourceAttempt(),
      candidates: [raw()],
      pointsBefore: 100,
      pointsAfter: 98,
      pointsSpent: 2
    }),
    browser: async () => ({ attempt: sourceAttempt("browser"), candidates: [raw("browser term", "exact_match", "attempt:browser")] }),
    standardSkuHealth: async ({ standardSku }) => ({
      standardSkuId: standardSku.id, status: "passed", checkedAt: NOW, receiptId: `health:${standardSku.id}`, attemptId: null,
      pointsBefore: null, pointsAfter: null, pointsSpent: null
    }),
    ...overrides
  };
}

function reusableSnapshot(overrides = {}) {
  const groups = Object.fromEntries(["title_keywords", "attribute_and_tag_keywords", "description_long_tail"].map((group) => [group, [{
    keyword: `${group} term`, sourceRefs: ["attempt:api"], factRefs: ["supply:fact"], score: null,
    scoringVersion: null, confidence: null, decision: null, decisionReason: null
  }]]));
  return createKeywordEvidenceSnapshot({
    snapshotId: "keyword:snapshot:4",
    identity: structuredClone(identity),
    bindings: structuredClone(bindings),
    currentBinding: {
      ...identity,
      salesSnapshotVersion: bindings.salesSnapshot.version,
      salesSnapshotFingerprint: bindings.salesSnapshot.fingerprint,
      supplySkuFactsVersion: bindings.supplySkuFacts.version,
      supplySkuFactsFingerprint: bindings.supplySkuFacts.fingerprint
    },
    collectedAt: NOW,
    expiresAt: "2026-08-24T04:00:00.000Z",
    asOf: NOW,
    sourceAttempts: [sourceAttempt()],
    groups,
    ...overrides
  });
}

test("有效K1快照0次提供器调用直接复用", async () => {
  let calls = 0;
  const result = await prepareKeywordEvidence(baseInput({ reusableSnapshot: reusableSnapshot() }), {
    seerfarApi: async () => { calls += 1; throw new Error("不得调用"); },
    browser: async () => { calls += 1; throw new Error("不得调用"); },
    standardSkuHealth: async () => { calls += 1; throw new Error("不得调用"); }
  });
  assert.equal(result.result, "reused_snapshot");
  assert.equal(result.execution.seerfarApiCalls, 0);
  assert.equal(result.execution.browserCalls, 0);
  assert.equal(result.execution.localFusionRuns, 0);
  assert.equal(calls, 0);
});

test("只有ready和partial_ready可零调用，缓存true_empty保留语义后只跑本地融合", async () => {
  const emptyGroups = { title_keywords: [], attribute_and_tag_keywords: [], description_long_tail: [] };
  const partialGroups = {
    ...emptyGroups,
    title_keywords: [{ keyword: "partial", sourceRefs: ["attempt:api"], factRefs: ["supply:fact"], score: null, scoringVersion: null, confidence: null, decision: null, decisionReason: null }]
  };
  let calls = 0;
  const partial = await prepareKeywordEvidence(baseInput({ reusableSnapshot: reusableSnapshot({ groups: partialGroups }) }), {
    seerfarApi: async () => { calls += 1; throw new Error("不得调用"); }
  });
  assert.equal(partial.result, "reused_snapshot");
  assert.equal(calls, 0);

  const cachedEmpty = reusableSnapshot({
    groups: emptyGroups,
    sourceAttempts: [sourceAttempt("api", { resultCount: 0, failureClass: "true_empty" })]
  });
  const continued = await prepareKeywordEvidence(baseInput({ reusableSnapshot: cachedEmpty }), {
    seerfarApi: async () => { calls += 1; throw new Error("不得调用"); }
  });
  assert.equal(calls, 0);
  assert.equal(continued.result, "source_candidates_ready");
  assert.equal(continued.sourceAttempts[0].failureClass, "true_empty");
  assert.equal(continued.sourceAttempts.at(-1).channel, "local_fusion");
});

test("technical_unavailable、needs_review和stale缓存不得短路", async () => {
  const emptyGroups = { title_keywords: [], attribute_and_tag_keywords: [], description_long_tail: [] };
  const snapshots = [
    reusableSnapshot({ groups: emptyGroups, sourceAttempts: [sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" })] }),
    reusableSnapshot({ groups: emptyGroups, sourceAttempts: [sourceAttempt()] }),
    reusableSnapshot({ groups: emptyGroups, sourceAttempts: [sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "stale_result" })] })
  ];
  for (const snapshot of snapshots) {
    let apiCalls = 0;
    const result = await prepareKeywordEvidence(baseInput({ reusableSnapshot: snapshot }), providers({ seerfarApi: async () => {
      apiCalls += 1;
      return { attempt: sourceAttempt(), candidates: [raw()] };
    }}));
    assert.equal(apiCalls, 1);
    assert.equal(result.result, "source_candidates_ready");
  }
});

test("过期、跨SKU、revision及销售供应指纹漂移均不能复用", async () => {
  const mutations = [
    (input) => { input.now = "2026-08-25T04:00:00.000Z"; },
    (input) => { input.identity.candidateId = "CX-K2-OTHER"; },
    (input) => { input.identity.dataRevision = 5; },
    (input) => { input.bindings.salesSnapshot.fingerprint = "changed-sales"; },
    (input) => { input.bindings.supplySkuFacts.fingerprint = "changed-supply"; }
  ];
  for (const mutate of mutations) {
    const input = baseInput({ reusableSnapshot: reusableSnapshot() });
    mutate(input);
    let apiCalls = 0;
    const result = await prepareKeywordEvidence(input, providers({ seerfarApi: async () => {
      apiCalls += 1;
      return { attempt: sourceAttempt(), candidates: [raw()] };
    }}));
    assert.equal(result.result, "source_candidates_ready");
    assert.equal(apiCalls, 1);
  }
});

test("API成功只调用一次并保留点数，输出仍是未评分候选池", async () => {
  let calls = 0;
  const result = await prepareKeywordEvidence(baseInput(), providers({ seerfarApi: async () => {
    calls += 1;
    return { attempt: sourceAttempt(), candidates: [raw()], pointsBefore: 100, pointsAfter: 98, pointsSpent: 2 };
  }}));
  assert.equal(calls, 1);
  assert.equal(result.result, "source_candidates_ready");
  assert.deepEqual([result.pointsBefore, result.pointsAfter, result.pointsSpent], [100, 98, 2]);
  assert.equal("groups" in result, false);
  assert.equal(result.reusedSnapshot, null);
});

test("provider回执禁止失败夹带候选、结果数不一致和attempt引用漂移", async () => {
  const failed = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "provider_server_error" });
  const cases = [
    { attempt: failed, candidates: [raw()] },
    { attempt: sourceAttempt("api", { resultCount: 2 }), candidates: [raw()] },
    { attempt: sourceAttempt(), candidates: [raw("term", "exact_match", "attempt:other")] }
  ];
  for (const receipt of cases) {
    await assert.rejects(() => prepareKeywordEvidence(baseInput(), providers({ seerfarApi: async () => receipt })), /KEYWORD_PROVIDER_/);
  }
});

test("结构化provider失败继续本地融合，provider抛异常准确停止且不重试", async () => {
  let structuredCalls = 0;
  const failed = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" });
  const continued = await prepareKeywordEvidence(baseInput({ policy: { browserAllowed: false, browserPreauthorized: false } }), providers({
    seerfarApi: async () => { structuredCalls += 1; return { attempt: failed, candidates: [] }; }
  }));
  assert.equal(structuredCalls, 1);
  assert.equal(continued.result, "source_candidates_ready");

  let thrownCalls = 0;
  await assert.rejects(() => prepareKeywordEvidence(baseInput(), providers({ seerfarApi: async () => {
    thrownCalls += 1;
    throw new Error("provider contract crashed");
  }})), /provider contract crashed/);
  assert.equal(thrownCalls, 1);
});

test("API 500后浏览器一次并继续本地融合，attempt完整保留且零重试", async () => {
  let apiCalls = 0;
  let browserCalls = 0;
  const apiFailure = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "provider_server_error" });
  const browserFailure = sourceAttempt("browser", { completedAt: null, status: "failed", resultCount: null, failureClass: "login_required" });
  const result = await prepareKeywordEvidence(baseInput(), providers({
    seerfarApi: async () => { apiCalls += 1; return { attempt: apiFailure, candidates: [] }; },
    browser: async () => { browserCalls += 1; return { attempt: browserFailure, candidates: [] }; }
  }));
  assert.equal(apiCalls, 1);
  assert.equal(browserCalls, 1);
  assert.deepEqual(result.sourceAttempts.map((item) => item.failureClass), ["provider_server_error", "login_required", null]);
  assert.equal(result.sourceAttempts.at(-1).channel, "local_fusion");
  assert.equal(result.execution.automaticRetries, 0);
  assert.equal(result.result, "source_candidates_ready");
});

test("API true_empty不调用浏览器并进入本地融合", async () => {
  let browserCalls = 0;
  const empty = sourceAttempt("api", { resultCount: 0, failureClass: "true_empty" });
  const result = await prepareKeywordEvidence(baseInput(), providers({
    seerfarApi: async () => ({ attempt: empty, candidates: [] }),
    browser: async () => { browserCalls += 1; throw new Error("不得调用"); }
  }));
  assert.equal(browserCalls, 0);
  assert.equal(result.execution.localFusionRuns, 1);
  assert.equal(result.result, "source_candidates_ready");
});

test("浏览器未预授权时技术失败后绝不调用浏览器", async () => {
  let browserCalls = 0;
  const failed = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" });
  const result = await prepareKeywordEvidence(baseInput({ policy: { browserAllowed: true, browserPreauthorized: false } }), providers({
    seerfarApi: async () => ({ attempt: failed, candidates: [] }),
    browser: async () => { browserCalls += 1; throw new Error("不得调用"); }
  }));
  assert.equal(browserCalls, 0);
  assert.equal(result.result, "source_candidates_ready");
});

test("browser六类技术失败原样保留且不混淆", async () => {
  for (const failureClass of ["login_required", "quota_or_rate_limit", "network_timeout", "selector_changed", "input_not_committed", "provider_server_error"]) {
    const apiFailure = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "provider_server_error" });
    const browserFailure = sourceAttempt("browser", { completedAt: null, status: "failed", resultCount: null, failureClass });
    const result = await prepareKeywordEvidence(baseInput(), providers({
      seerfarApi: async () => ({ attempt: apiFailure, candidates: [] }),
      browser: async () => ({ attempt: browserFailure, candidates: [] })
    }));
    assert.equal(result.sourceAttempts[1].failureClass, failureClass);
  }
});

test("标准SKU仅在触发条件运行三次，TTL有效时零调用", async () => {
  let healthCalls = 0;
  const triggered = baseInput();
  triggered.healthPolicy.connectorVersion = "seerfar-connector-v2";
  const first = await prepareKeywordEvidence(triggered, providers({ standardSkuHealth: async ({ standardSku }) => {
    healthCalls += 1;
    return {
      standardSkuId: standardSku.id, status: "passed", checkedAt: NOW, receiptId: `health:${standardSku.id}`, attemptId: null,
      pointsBefore: null, pointsAfter: null, pointsSpent: null
    };
  }}));
  assert.equal(first.connector.healthTrigger, "connector_version_changed");
  assert.equal(first.connector.standardSkuCalls, 3);
  assert.equal(healthCalls, 3);

  healthCalls = 0;
  const second = await prepareKeywordEvidence(baseInput(), providers({ standardSkuHealth: async () => { healthCalls += 1; } }));
  assert.equal(second.connector.standardSkuCalls, 0);
  assert.equal(healthCalls, 0);
});

test("三个标准SKU点数逐次留痕并与正式API共同计入总消耗", async () => {
  const input = baseInput();
  input.healthPolicy.connectorVersion = "seerfar-connector-v2";
  let balance = 100;
  const result = await prepareKeywordEvidence(input, providers({
    standardSkuHealth: async ({ standardSku }) => {
      const pointsBefore = balance;
      balance -= 1;
      return {
        standardSkuId: standardSku.id, status: "passed", checkedAt: NOW, receiptId: `health:${standardSku.id}`, attemptId: null,
        pointsBefore, pointsAfter: balance, pointsSpent: 1
      };
    },
    seerfarApi: async () => ({ attempt: sourceAttempt(), candidates: [raw()], pointsBefore: 97, pointsAfter: 95, pointsSpent: 2 })
  }));
  assert.deepEqual(result.connector.healthReceipts.map((item) => item.pointsSpent), [1, 1, 1]);
  assert.deepEqual([result.pointsBefore, result.pointsAfter, result.pointsSpent], [100, 95, 5]);
});

test("标准SKU健康回执身份、状态、时间、凭证和点数不完整时拒绝", async () => {
  const input = baseInput();
  input.healthPolicy.connectorVersion = "seerfar-connector-v2";
  for (const invalid of [
    { standardSkuId: "wrong", status: "passed", checkedAt: NOW, receiptId: "r", attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null },
    { standardSkuId: "standard:1", status: "unknown", checkedAt: NOW, receiptId: "r", attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null },
    { standardSkuId: "standard:1", status: "passed", checkedAt: "bad", receiptId: "r", attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null },
    { standardSkuId: "standard:1", status: "passed", checkedAt: NOW, receiptId: null, attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null },
    { standardSkuId: "standard:1", status: "passed", checkedAt: NOW, receiptId: "r", attemptId: null, pointsBefore: 10, pointsAfter: 9, pointsSpent: null }
  ]) {
    await assert.rejects(() => prepareKeywordEvidence(structuredClone(input), providers({ standardSkuHealth: async () => invalid })), /KEYWORD_STANDARD_SKU_/);
  }
});

test("标准SKU失败暂停Seerfar但本地融合继续，不能标数据库为空", async () => {
  let apiCalls = 0;
  const input = baseInput();
  input.healthPolicy.suspectedSystemicFailure = true;
  const result = await prepareKeywordEvidence(input, providers({
    standardSkuHealth: async ({ standardSku }) => ({
      standardSkuId: standardSku.id, status: standardSku.id === "standard:2" ? "failed" : "passed", checkedAt: NOW,
      receiptId: `health:${standardSku.id}`, attemptId: null, pointsBefore: null, pointsAfter: null, pointsSpent: null
    }),
    seerfarApi: async () => { apiCalls += 1; throw new Error("不得调用"); }
  }));
  assert.equal(result.connector.seerfarConnectorSuspended, true);
  assert.equal(result.connector.standardSkuCalls, 2);
  assert.equal(apiCalls, 0);
  assert.equal(result.result, "source_candidates_ready");
  assert.equal(result.sourceAttempts.some((item) => item.failureClass === "true_empty"), false);
});

test("竞品少于5明确partial，超过10显式停止", async () => {
  const partialInput = baseInput();
  partialInput.frozenEvidence.comparables = [comparable(1), comparable(2), comparable(3), comparable(4)];
  const partial = await prepareKeywordEvidence(partialInput, providers());
  assert.equal(partial.coverage, "partial");

  const overflow = baseInput();
  overflow.frozenEvidence.comparables = Array.from({ length: 11 }, (_, index) => comparable(index + 1));
  await assert.rejects(() => prepareKeywordEvidence(overflow, providers()), /COMPARABLE_LIMIT_EXCEEDED/);
});

test("exact-match与substitute分别保留，不混成精确共识", async () => {
  const input = baseInput();
  input.frozenEvidence.comparables = [comparable(1, "exact_match"), comparable(2, "substitute")];
  const result = await prepareKeywordEvidence(input, providers());
  const exact = result.rawCandidatePool.find((item) => item.term.includes("exact_match competitor"));
  const substitute = result.rawCandidatePool.find((item) => item.term.includes("substitute competitor"));
  assert.equal(exact.matchType, "exact_match");
  assert.equal(substitute.matchType, "substitute");
  assert.equal(result.coverage, "partial");
  assert.equal(result.rawCandidatePool.find((item) => item.term === "hand crank").matchType, "target_fact");
});

test("同词同语义合并全部竞品与来源引用，目标事实词不计入精确竞品覆盖", async () => {
  const input = baseInput();
  input.frozenEvidence.productFactTerms[0].term = "shared term";
  input.frozenEvidence.comparables = Array.from({ length: 4 }, (_, index) => ({
    ...comparable(index + 1),
    terms: [{ term: "shared term", sourceRefs: [`sales:sample:${index + 1}`], factRefs: [], sourceTrust: "frozen_sales_snapshot" }]
  }));
  const result = await prepareKeywordEvidence(input, providers());
  const exact = result.rawCandidatePool.find((item) => item.term === "shared term" && item.matchType === "exact_match");
  const target = result.rawCandidatePool.find((item) => item.term === "shared term" && item.matchType === "target_fact");
  assert.equal(exact.competitorRefs.length, 4);
  assert.equal(exact.sourceRefs.length, 4);
  assert.ok(target);
  assert.equal(result.coverage, "partial");
});

test("本地融合无默认值、无网络、无模型且零业务副作用", async () => {
  const failed = sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" });
  const result = await prepareKeywordEvidence(baseInput({ policy: { browserAllowed: false, browserPreauthorized: false } }), providers({
    seerfarApi: async () => ({ attempt: failed, candidates: [] })
  }));
  assert.equal(result.execution.networkCallsByLocalFusion, 0);
  assert.equal(result.execution.modelCallsByLocalFusion, 0);
  assert.deepEqual(result.businessEffect, { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 });
  assert.equal(result.rawCandidatePool.every((item) => item.sourceTrust === null || typeof item.sourceTrust === "string"), true);
});

test("无冻结候选时准确区分true_empty、technical_unavailable和needs_review", async () => {
  const emptyEvidence = { productFactTerms: [], comparables: [], seedEvidence: [] };
  const trueEmpty = await prepareKeywordEvidence(baseInput({ frozenEvidence: emptyEvidence }), providers({
    seerfarApi: async () => ({ attempt: sourceAttempt("api", { resultCount: 0, failureClass: "true_empty" }), candidates: [] })
  }));
  assert.equal(trueEmpty.result, "true_empty");

  const technical = await prepareKeywordEvidence(baseInput({ frozenEvidence: emptyEvidence, policy: { browserAllowed: false, browserPreauthorized: false } }), providers({
    seerfarApi: async () => ({ attempt: sourceAttempt("api", { completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" }), candidates: [] })
  }));
  assert.equal(technical.result, "technical_unavailable");

  const reviewInput = baseInput({ frozenEvidence: emptyEvidence });
  reviewInput.healthPolicy.suspectedSystemicFailure = true;
  const needsReview = await prepareKeywordEvidence(reviewInput, providers({
    standardSkuHealth: async ({ standardSku }) => ({
      standardSkuId: standardSku.id, status: "failed", checkedAt: NOW, receiptId: `health:${standardSku.id}`, attemptId: null,
      pointsBefore: null, pointsAfter: null, pointsSpent: null
    })
  }));
  assert.equal(needsReview.result, "needs_review");
});

test("Preparation Schema锁定调用次数、零副作用和候选来源结构", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/keyword-evidence-preparation-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.execution.properties.seerfarApiCalls.maximum, 1);
  assert.equal(schema.properties.execution.properties.browserCalls.maximum, 1);
  assert.equal(schema.properties.execution.properties.automaticRetries.const, 0);
  assert.equal(schema.properties.businessEffect.properties.bOrC1Created.const, false);
  assert.deepEqual(schema.$defs.RawCandidate.properties.matchType.enum, ["target_fact", "exact_match", "substitute", "multi_seed"]);
});

test("Preparation领域校验拒绝指纹、SKU绑定和业务副作用漂移", async () => {
  const result = await prepareKeywordEvidence(baseInput(), providers());
  for (const mutate of [
    (copy) => { copy.preparationFingerprint = "changed"; },
    (copy) => { copy.identity.skuPackageId = "sku-package:OTHER"; },
    (copy) => { copy.businessEffect.bOrC1Created = true; }
  ]) {
    const copy = structuredClone(result);
    mutate(copy);
    const validation = validateKeywordEvidencePreparation(copy, {
      currentBinding: {
        ...identity,
        salesSnapshotVersion: bindings.salesSnapshot.version,
        salesSnapshotFingerprint: bindings.salesSnapshot.fingerprint,
        supplySkuFactsVersion: bindings.supplySkuFacts.version,
        supplySkuFactsFingerprint: bindings.supplySkuFacts.fingerprint
      }
    });
    assert.equal(validation.valid, false);
  }
});

test("未证明可比性的竞品证据明确停止，不进入候选池", async () => {
  const input = baseInput();
  delete input.frozenEvidence.comparables[0].comparabilityEvidenceRefs;
  await assert.rejects(() => prepareKeywordEvidence(input, providers()), /KEYWORD_COMPARABLE_INVALID/);
});

test("businessGate必须同时保存note和evidenceRef", async () => {
  for (const missing of ["note", "evidenceRef"]) {
    const input = baseInput();
    delete input.businessGate[missing];
    await assert.rejects(() => prepareKeywordEvidence(input, providers()), /BUSINESS_GATE_NOT_APPROVED/);
  }
});
