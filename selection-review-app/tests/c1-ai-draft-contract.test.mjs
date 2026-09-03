import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  C1_AI_DRAFT_RECEIPT_VERSION,
  C1_AI_DRAFT_REQUEST_VERSION,
  buildC1AiDraftRequest,
  mergeC1AiDraftReceipt,
  validateC1AiDraftReceipt
} from "../lib/c1-ai-draft-contract.mjs";
import {
  C1AiGatewayError,
  buildC1GatewayJob,
  runC1AiDraftThroughGateway
} from "../lib/c1-ai-gateway.mjs";
import { runC1SoftwareOrchestration } from "../lib/c1-software-orchestrator.mjs";

const CREATED_AT = "2026-08-22T02:00:00.000Z";
const FACT_SOURCE = "source-capture:fixture:sink-organizer-blue";
const SCHEMA_SOURCE = "schema:ozon:fixture:kitchen-organizer";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fact(value, sourceRefs = [FACT_SOURCE]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function unknown(reason) {
  return { value: "unknown", verificationStatus: "unknown", sourceRefs: [FACT_SOURCE], reason };
}

function nonTrainSkuPackage() {
  const schema = {
    evidenceId: SCHEMA_SOURCE,
    platform: "ozon",
    store: "dandanshu",
    descriptionCategoryId: "17029001",
    typeId: "93001",
    categoryName: "Органайзер для раковины",
    schemaRevision: "ozon-schema:kitchen-organizer:2026-08-22",
    requiredFields: [
      { fieldKey: "product_type", label: "商品类型", required: true, sourceAttributeKeys: ["product_type"] },
      { fieldKey: "material", label: "材质", required: true, sourceAttributeKeys: ["material"] }
    ],
    categoryRestrictions: [],
    platformCompliance: { status: "clear" },
    collectedAt: CREATED_AT
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    c1PlanId: "c1:sku-lifecycle:GENERIC-SINK-001:SINK-BLUE:profit-v1",
    status: "facts_checked",
    createdAt: CREATED_AT,
    inputRefs: {
      salesSnapshotId: "sales:fixture:sink-organizer",
      selectedSupplySnapshotId: FACT_SOURCE,
      profitModelVersion: "profit-v1",
      platformSchemaEvidenceId: SCHEMA_SOURCE
    },
    identity: {
      parentOpportunityId: "opportunity:sink-organizer",
      skuPackageId: "sku-lifecycle:GENERIC-SINK-001:SINK-BLUE",
      supplierOptionId: "supplier-option:fixture:sink-organizer",
      supplierSkuId: "SINK-BLUE",
      variantKey: "颜色:蓝色",
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    inputSnapshots: {
      salesSnapshot: { snapshotId: "sales:fixture:sink-organizer" },
      confirmedSupplierSkuSnapshot: { snapshotId: FACT_SOURCE },
      profitModel: { profitModelVersion: "profit-v1", result: "passed" },
      platformSchemaRules: schema
    },
    externalAccesses: [],
    profitRecalculated: false,
    skuReplaced: false,
    finalSeo: null,
    finalAttributes: null,
    complianceDecision: null,
    generatedAssets: null,
    productionPayload: null,
    factVerificationVersion: "c1-fact-verification-v1.1",
    factsVerifiedAt: CREATED_AT,
    exactSkuVerification: {
      status: fact("verified"),
      supplierSkuId: fact("SINK-BLUE"),
      variantKey: fact("颜色:蓝色")
    },
    productAttributes: {
      status: fact("all_required_fields_known", [FACT_SOURCE, SCHEMA_SOURCE]),
      material: fact("silicone"),
      color: fact("blue"),
      brand: unknown("brand_not_present_in_frozen_inputs"),
      dimensions: fact({ length: 22, width: 11, height: 4, unit: "cm" }),
      requiredPlatformFields: [
        { fieldKey: "product_type", fact: fact("sink organizer") },
        { fieldKey: "material", fact: fact("silicone") }
      ]
    },
    platformCategory: {
      status: fact("identified", [SCHEMA_SOURCE]),
      categoryName: fact("Органайзер для раковины", [SCHEMA_SOURCE]),
      descriptionCategoryId: fact("17029001", [SCHEMA_SOURCE]),
      typeId: fact("93001", [SCHEMA_SOURCE])
    },
    schemaSnapshot: {
      status: fact("frozen", [SCHEMA_SOURCE]),
      schemaRevision: fact(schema.schemaRevision, [SCHEMA_SOURCE]),
      requiredFields: fact(schema.requiredFields, [SCHEMA_SOURCE])
    },
    batteryAssessment: {
      status: fact("fact_available"),
      assessment: fact("no_battery"),
      powered: fact(false),
      containsBattery: fact(false),
      batteryType: fact("not_applicable"),
      batteryCount: fact(0),
      batteryCapacity: fact("not_applicable")
    },
    categoryRestrictions: {
      status: fact("known", [SCHEMA_SOURCE]),
      restrictions: fact([], [SCHEMA_SOURCE])
    },
    platformCompliance: {
      status: fact("known", [SCHEMA_SOURCE]),
      assessment: fact({ status: "clear" }, [SCHEMA_SOURCE]),
      requiredFieldGapCount: fact(0, [SCHEMA_SOURCE])
    },
    seoTitleDraft: null,
    descriptionDraft: null,
    bulletPointsDraft: null,
    searchKeywordsDraft: null,
    seoEvidenceLayer: null
  };
  return {
    schemaVersion: "sku-lifecycle-v1.1",
    skuPackageId: plan.identity.skuPackageId,
    supplierSkuId: "SINK-BLUE",
    variantKey: "颜色:蓝色",
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none",
    dataRevision: 4,
    activeProfitModelVersion: "profit-v1",
    profitModels: [{ profitModelVersion: "profit-v1", result: "passed", unitProfitRmb: 36, profitMargin: 0.36 }],
    c1ProductPlan: plan,
    c2FinalAssets: null,
    productionAuthorization: null,
    productionRecord: null,
    externalListingRecord: null,
    eVerificationRecord: null,
    audit: { updatedAt: CREATED_AT, history: [] }
  };
}

function competitorTextSnapshot() {
  return {
    snapshotId: "competitor-text:fixture:sink-organizer",
    sourceSalesSnapshotId: "sales:fixture:sink-organizer",
    observedAt: CREATED_AT,
    evidenceRef: "sales:fixture:sink-organizer#competitor-text",
    texts: [{
      textId: "competitor-title-1",
      text: "Силиконовый органайзер для кухонной раковины",
      sourceRef: "ozon-product:fixture:1001",
      role: "buyer_language_reference_only"
    }]
  };
}

function keywordEvidence() {
  return {
    evidenceId: "seo:fixture:sink-organizer",
    status: "ready",
    targetPlatform: "ozon",
    targetSkuPackageId: "sku-lifecycle:GENERIC-SINK-001:SINK-BLUE",
    sourcePlatform: "ozon",
    collectionMode: "reused_verified_evidence",
    observedAt: CREATED_AT,
    keywords: [
      {
        query: "органайзер для раковины",
        group: "core_product_type",
        keywordEvidenceRef: "keyword:fixture:sink-organizer",
        sourceSku: "ozon-fixture-1001",
        sourcePlatform: "ozon",
        relevanceStatus: "retained",
        factBindingPaths: ["platformCategory.categoryName"]
      },
      {
        query: "деревянный органайзер",
        group: "material",
        keywordEvidenceRef: "keyword:fixture:wood",
        sourceSku: "ozon-fixture-1002",
        sourcePlatform: "ozon",
        relevanceStatus: "retained",
        factBindingPaths: ["productAttributes.brand"]
      }
    ]
  };
}

function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v1",
    locale: "ru-RU",
    titleMaxLength: 120,
    descriptionMaxLength: 1200,
    bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand", "unverified_material", "unverified_dimensions", "unverified_certification"]
  };
}

function standardClassification() {
  return {
    complexity: "standard",
    preapprovedForSol: false,
    reason: "单SKU常规俄语Listing草稿",
    markedBy: "software",
    markedAt: CREATED_AT
  };
}

function buildRequest(overrides = {}) {
  return buildC1AiDraftRequest({
    skuPackage: nonTrainSkuPackage(),
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    ...overrides
  });
}

function receipt(request, overrides = {}) {
  const factPath = "platformCategory.categoryName";
  const factValue = "Органайзер для раковины";
  const cited = (text) => ({
    text,
    factRefs: [factPath],
    keywordRefs: ["keyword:fixture:sink-organizer"],
    assertions: [{ factPath, value: factValue }]
  });
  const output = {
    status: "draft_only",
    locale: "ru-RU",
    claimCoverage: "complete",
    unsupportedClaims: [],
    title: cited("Органайзер для раковины"),
    description: cited("Органайзер для кухонной раковины."),
    bulletPoints: [cited("Для организации пространства у раковины.")],
    searchKeywords: [cited("органайзер для раковины")]
  };
  const inputEvidenceRefs = [...new Set([
    request.competitorTextEvidence.evidenceRef,
    request.keywordEvidence.evidenceId,
    ...request.verifiedFacts.flatMap((factItem) => factItem.evidenceRefs)
  ])].sort();
  return {
    schemaVersion: C1_AI_DRAFT_RECEIPT_VERSION,
    receiptId: `receipt:${request.requestId}`,
    providerRequestId: "provider-call:test:1",
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    provider: request.provider,
    modelVersion: request.provider === "terra" ? "terra-test-1" : "sol-test-1",
    serviceVersion: "third-party-gateway-test-v1",
    status: "completed",
    attempt: 1,
    startedAt: "2026-08-22T02:01:00.000Z",
    completedAt: "2026-08-22T02:01:01.000Z",
    inputEvidenceRefs,
    outputFingerprint: createHash("sha256").update(JSON.stringify(canonicalize(output))).digest("hex"),
    externalPlatformAccesses: 0,
    codexDispatches: 0,
    productionWrites: 0,
    output,
    ...overrides
  };
}

test("普通非火车SKU构造Terra单次请求，只携带四类冻结输入与已确认事实", () => {
  const request = buildRequest();
  assert.equal(request.schemaVersion, C1_AI_DRAFT_REQUEST_VERSION);
  assert.equal(request.provider, "terra");
  assert.equal(request.identity.supplierSkuId, "SINK-BLUE");
  assert.equal(request.executionPolicy.attemptLimit, 1);
  assert.equal(request.executionPolicy.automaticRetry, false);
  assert.equal(request.executionPolicy.fallbackProvider, null);
  assert.equal(request.executionPolicy.codexDispatch, false);
  assert.equal(request.executionPolicy.platformAccessAllowed, false);
  assert.equal(request.verifiedFacts.some((item) => item.factPath === "productAttributes.material"), true);
  assert.equal(request.verifiedFacts.some((item) => item.factPath === "productAttributes.brand"), false);
  assert.deepEqual(request.keywordEvidence.keywords.map((item) => item.query), ["органайзер для раковины"]);
});

test("Sol只接受调用前已标记并批准的复杂任务，Terra失败策略不自动切换", () => {
  const terraRequest = buildRequest();
  const failedTerraReceipt = receipt(terraRequest, { status: "failed" });
  assert.equal(validateC1AiDraftReceipt({ request: terraRequest, receipt: failedTerraReceipt }).valid, false);
  assert.equal(terraRequest.provider, "terra");
  assert.equal(terraRequest.executionPolicy.fallbackProvider, null);
  const complex = standardClassification();
  complex.complexity = "complex";
  assert.throws(() => buildRequest({ taskClassification: complex }), /SOL_PREAPPROVAL_REQUIRED/);
  complex.preapprovedForSol = true;
  complex.reason = "预先识别的复杂多属性俄语表达任务";
  const request = buildRequest({ taskClassification: complex });
  assert.equal(request.provider, "sol");
  assert.equal(request.executionPolicy.solFallbackAfterTerraFailure, false);
  const ordinary = standardClassification();
  ordinary.preapprovedForSol = true;
  assert.throws(() => buildRequest({ taskClassification: ordinary }), /ROUTE_SCOPE_REJECTED/);
});

test("严格回执校验后合并draft_only，保留B和SKU且不进入C2/D/E", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const aiReceipt = receipt(request);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: aiReceipt }), { valid: true, errors: [] });
  const result = mergeC1AiDraftReceipt({ skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:02:00.000Z" });
  assert.equal(result.c1ProductPlan.status, "seo_draft_ready");
  assert.equal(result.c1ProductPlan.seoTitleDraft.status, "draft_only");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.provider, "terra");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.modelVersion, "terra-test-1");
  assert.equal(result.c1ProductPlan.seoEvidenceLayer.executionPolicy.codexDispatch, false);
  assert.deepEqual(result.skuPackage.profitModels, skuPackage.profitModels);
  assert.equal(result.skuPackage.supplierSkuId, "SINK-BLUE");
  assert.equal(result.skuPackage.c2FinalAssets, null);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
});

test("模型新增材质、品牌、尺寸或认证事实时拒绝且不改变B结果", () => {
  const skuPackage = nonTrainSkuPackage();
  const before = JSON.stringify(skuPackage);
  const request = buildRequest({ skuPackage });
  for (const [factPath, value] of [
    ["productAttributes.material", "wood"],
    ["productAttributes.brand", "ImaginaryBrand"],
    ["productAttributes.dimensions", { length: 99, width: 99, height: 99, unit: "cm" }],
    ["platformCompliance.certification", "EAC"]
  ]) {
    const hallucination = receipt(request);
    hallucination.output.description.assertions = [{ factPath, value }];
    const validation = validateC1AiDraftReceipt({ request, receipt: hallucination });
    assert.equal(validation.valid, false, factPath);
    assert.match(validation.errors.join(" "), /新增或篡改/);
  }
  assert.equal(JSON.stringify(skuPackage), before);
  assert.equal(skuPackage.profitModels[0].result, "passed");
});

test("缺事实引用、关键词引用或完整宣称覆盖的回执全部拒绝", () => {
  const request = buildRequest();
  const missingFact = receipt(request);
  missingFact.output.title.factRefs = [];
  assert.equal(validateC1AiDraftReceipt({ request, receipt: missingFact }).valid, false);
  const missingKeyword = receipt(request);
  missingKeyword.output.title.keywordRefs = [];
  assert.equal(validateC1AiDraftReceipt({ request, receipt: missingKeyword }).valid, false);
  const incomplete = receipt(request);
  incomplete.output.claimCoverage = "partial";
  assert.equal(validateC1AiDraftReceipt({ request, receipt: incomplete }).valid, false);
});

test("事实漂移阻止合并，同一成功回执重复合并保持幂等", () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const aiReceipt = receipt(request);
  const changed = structuredClone(skuPackage);
  changed.c1ProductPlan.productAttributes.material.value = "rubber";
  assert.throws(() => mergeC1AiDraftReceipt({
    skuPackage: changed,
    request,
    receipt: aiReceipt,
    mergedAt: "2026-08-22T02:02:00.000Z"
  }), /FACT_DRIFT_DETECTED/);

  const first = mergeC1AiDraftReceipt({ skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:02:00.000Z" });
  const second = mergeC1AiDraftReceipt({ skuPackage: first.skuPackage, request, receipt: aiReceipt, mergedAt: "2026-08-22T02:03:00.000Z" });
  assert.equal(second.idempotent, true);
  assert.equal(second.skuPackage.dataRevision, first.skuPackage.dataRevision);
  assert.deepEqual(second.skuPackage.audit.history, first.skuPackage.audit.history);
});

test("领域函数不访问4318或平台、不派发Codex，并且活动契约无火车商品默认值", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("C1领域契约禁止联网");
  };
  try {
    const skuPackage = nonTrainSkuPackage();
    const request = buildRequest({ skuPackage });
    mergeC1AiDraftReceipt({ skuPackage, request, receipt: receipt(request), mergedAt: "2026-08-22T02:02:00.000Z" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const source = await readFile(new URL("../lib/c1-ai-draft-contract.mjs", import.meta.url), "utf8");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("发布的请求和回执Schema冻结单次路由、零派发与draft_only边界", async () => {
  const requestSchema = JSON.parse(await readFile(new URL("../schema/c1-ai-draft-request-v1.schema.json", import.meta.url), "utf8"));
  const receiptSchema = JSON.parse(await readFile(new URL("../schema/c1-ai-draft-receipt-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(requestSchema.properties.executionPolicy.properties.attemptLimit.const, 1);
  assert.equal(requestSchema.properties.executionPolicy.properties.automaticRetry.const, false);
  assert.equal(requestSchema.properties.executionPolicy.properties.codexDispatch.const, false);
  assert.equal(receiptSchema.properties.output.properties.status.const, "draft_only");
  assert.equal(receiptSchema.properties.codexDispatches.const, 0);
  assert.equal(receiptSchema.properties.productionWrites.const, 0);
});

test("总控把普通C1请求锁定为4318 Terra SEO任务，不发送店铺凭证或生产授权", () => {
  const request = buildRequest();
  const job = buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request });
  assert.equal(job.businessPhase, "C1");
  assert.equal(job.taskType, "seo_draft");
  assert.equal(job.model, "gpt-5.6-terra");
  assert.equal(job.dataRevision, "12");
  assert.equal(job.input.images.length, 0);
  assert.equal(job.evidenceRefs.length, 3);
  assert.doesNotMatch(job.input.text, /cookie|password|api[_-]?key|productionAuthorization/i);
  assert.doesNotMatch(job.input.text, /dandanshu/i);
});

test("C1网关只创建一次供应商任务，成功后严格合并draft_only且零Codex派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const gatewayOutput = receipt(request).output;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (options.method === "POST") {
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, "gpt-5.6-terra");
      return new Response(JSON.stringify({ jobId: "job-c1-1", status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      jobId: "job-c1-1",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "completed",
      attempt: 1,
      startedAt: "2026-08-22T02:01:00.000Z",
      completedAt: "2026-08-22T02:01:01.000Z",
      receipt: {
        receiptVersion: "inference-receipt-v1",
        providerRequestId: "linlongs-c1-1",
        requestHash: "a".repeat(64),
        requestedAt: "2026-08-22T02:01:00.000Z",
        completedAt: "2026-08-22T02:01:01.000Z",
        validation: { schemaValid: true, strictJson: true },
        output: gatewayOutput
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runC1AiDraftThroughGateway({
    candidateId: "GENERIC-SINK-001",
    dataRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    mergedAt: "2026-08-22T02:02:00.000Z",
    gatewayUrl: "http://127.0.0.1:4318",
    fetchImpl,
    wait: async () => {},
    maxStatusReads: 2
  });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(result.supplierAttempts, 1);
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.c1ProductPlan.status, "seo_draft_ready");
  assert.deepEqual(result.skuPackage.profitModels, skuPackage.profitModels);
  assert.equal(result.skuPackage.c2FinalAssets, null);
});

test("C1网关失败立即停止，不重复POST、不切Sol、不改变输入SKU", async () => {
  const skuPackage = nonTrainSkuPackage();
  const before = JSON.stringify(skuPackage);
  let posts = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") posts += 1;
    return new Response(JSON.stringify({
      jobId: "job-c1-failed",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "failed",
      attempt: 1,
      failure: { code: "MODEL_OUTPUT_SCHEMA_MISMATCH", layer: "output_schema", message: "输出不符合Schema" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => runC1AiDraftThroughGateway({
    candidateId: "GENERIC-SINK-001",
    dataRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    requestedAt: CREATED_AT,
    gatewayUrl: "http://127.0.0.1:4318",
    fetchImpl,
    wait: async () => {}
  }), (error) => error instanceof C1AiGatewayError && error.layer === "output_schema");
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(skuPackage), before);
});

test("Sol复杂任务必须在调用前锁定允许的复杂任务类型", () => {
  const complex = { ...standardClassification(), complexity: "complex", preapprovedForSol: true, reason: "类目存在实质争议" };
  const request = buildRequest({ taskClassification: complex });
  assert.throws(() => buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request }), /COMPLEX_TASK_TYPE_REQUIRED/);
  complex.gatewayTaskType = "category_dispute_analysis";
  const accepted = buildC1GatewayJob({ candidateId: "GENERIC-SINK-001", dataRevision: 12, request: buildRequest({ taskClassification: complex }) });
  assert.equal(accepted.model, "gpt-5.6-sol");
  assert.equal(accepted.taskType, "category_dispute_analysis");
});

test("C1软件编排成功保持B结论和SKU，正常路径不生成ExceptionCase或Codex派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const request = buildRequest({ skuPackage });
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") {
      return new Response(JSON.stringify({ jobId: "job-c1-orchestrator", status: "running" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      jobId: "job-c1-orchestrator",
      candidateId: "GENERIC-SINK-001",
      skuPackageId: skuPackage.skuPackageId,
      dataRevision: "12",
      businessPhase: "C1",
      taskType: "seo_draft",
      model: "gpt-5.6-terra",
      status: "completed",
      attempt: 1,
      startedAt: "2026-08-22T02:01:00.000Z",
      completedAt: "2026-08-22T02:01:01.000Z",
      receipt: {
        receiptVersion: "inference-receipt-v1",
        providerRequestId: "linlongs-c1-orchestrator",
        requestHash: "b".repeat(64),
        requestedAt: "2026-08-22T02:01:00.000Z",
        completedAt: "2026-08-22T02:01:01.000Z",
        validation: { schemaValid: true, strictJson: true },
        output: receipt(request).output
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runC1SoftwareOrchestration({
    candidateId: "GENERIC-SINK-001",
    candidateRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    startedAt: CREATED_AT,
    gatewayOptions: { gatewayUrl: "http://127.0.0.1:4318", fetchImpl, wait: async () => {}, maxStatusReads: 2 }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.exceptionCase, null);
  assert.equal(result.codexDispatches, 0);
  assert.equal(result.skuPackage.supplierSkuId, skuPackage.supplierSkuId);
  assert.deepEqual(result.skuPackage.profitModels, skuPackage.profitModels);
  assert.equal(result.c1ProductPlan.status, "seo_draft_ready");
});

test("C1网关Key未配置属于已知技术失败，不生成ExceptionCase或Codex派发", async () => {
  const skuPackage = nonTrainSkuPackage();
  const result = await runC1SoftwareOrchestration({
    candidateId: "GENERIC-SINK-001",
    candidateRevision: 12,
    skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    seoRules: seoRules(),
    taskClassification: standardClassification(),
    startedAt: CREATED_AT,
    gatewayOptions: {
      gatewayUrl: "http://127.0.0.1:4318",
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "KEY_NOT_CONFIGURED", message: "网关Key未配置" } }), { status: 503, headers: { "content-type": "application/json" } })
    }
  });
  assert.equal(result.status, "technical_failure");
  assert.equal(result.exceptionCase, null);
  assert.equal(result.technicalFailure.status, "stopped");
  assert.equal(result.technicalFailure.kind, "external_dependency");
  assert.equal(result.technicalFailure.automaticRetryAllowed, false);
  assert.equal(result.technicalFailure.businessStateChanged, false);
  assert.equal(result.codexDispatches, 0);
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.profitModels[0].result, "passed");
  assert.deepEqual(result.skuPackage, skuPackage);
});
