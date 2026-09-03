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

const NOW = "2026-08-22T05:00:00.000Z";
const SALES_ID = "sales:fixture:bathroom-shelf";
const SALES_EVIDENCE = "evidence:fixture:bathroom-shelf";
const SUPPLY_EVIDENCE = "evidence:fixture:supplier:bathroom-shelf-white";
const SCHEMA_EVIDENCE = "evidence:fixture:ozon:bathroom-storage";

function fact(value, sourceRefs = [SUPPLY_EVIDENCE]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function skuPackage() {
  const schema = {
    evidenceId: SCHEMA_EVIDENCE,
    platform: "ozon",
    store: "dandanshu",
    schemaRevision: "ozon:bathroom-storage:2026-08-22",
    requiredFields: [{ fieldKey: "material", label: "材质", required: true, sourceAttributeKeys: ["material"] }],
    collectedAt: NOW
  };
  const plan = {
    schemaVersion: "c1-product-plan-v1.1",
    c1PlanId: "c1:sku-lifecycle:FIXTURE-SHELF-001:SHELF-WHITE:profit-v2",
    status: "facts_checked",
    createdAt: NOW,
    inputRefs: {
      salesSnapshotId: SALES_ID,
      selectedSupplySnapshotId: SUPPLY_EVIDENCE,
      profitModelVersion: "profit-v2",
      platformSchemaEvidenceId: SCHEMA_EVIDENCE
    },
    identity: {
      parentOpportunityId: "opportunity:bathroom-shelf",
      skuPackageId: "sku-lifecycle:FIXTURE-SHELF-001:SHELF-WHITE",
      supplierOptionId: "supplier-option:fixture:bathroom-shelf",
      supplierSkuId: "SHELF-WHITE",
      variantKey: "颜色:白色",
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    inputSnapshots: {
      salesSnapshot: {
        snapshotId: SALES_ID,
        title: "Полка для ванной комнаты без сверления",
        attributes: {
          material: "пластик",
          color: "белый",
          mounting: { method: "самоклеящийся" }
        },
        collectedAt: NOW,
        evidenceRef: SALES_EVIDENCE,
        currentPrice: 1290,
        currency: "RUB"
      },
      confirmedSupplierSkuSnapshot: { snapshotId: SUPPLY_EVIDENCE },
      profitModel: { profitModelVersion: "profit-v2", result: "passed" },
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
    factsVerifiedAt: NOW,
    exactSkuVerification: {
      status: fact("verified"),
      supplierSkuId: fact("SHELF-WHITE"),
      variantKey: fact("颜色:白色")
    },
    productAttributes: {
      status: fact("all_required_fields_known", [SUPPLY_EVIDENCE, SCHEMA_EVIDENCE]),
      material: fact("plastic"),
      color: fact("white"),
      mountingMethod: fact("self_adhesive")
    },
    platformCategory: {
      status: fact("identified", [SCHEMA_EVIDENCE]),
      categoryName: fact("Полки для ванной", [SCHEMA_EVIDENCE]),
      descriptionCategoryId: fact("17033001", [SCHEMA_EVIDENCE]),
      typeId: fact("94001", [SCHEMA_EVIDENCE])
    },
    schemaSnapshot: {
      status: fact("frozen", [SCHEMA_EVIDENCE]),
      schemaRevision: fact(schema.schemaRevision, [SCHEMA_EVIDENCE]),
      requiredFields: fact(schema.requiredFields, [SCHEMA_EVIDENCE])
    },
    batteryAssessment: {
      status: fact("fact_available"),
      assessment: fact("no_battery"),
      powered: fact(false),
      containsBattery: fact(false)
    },
    categoryRestrictions: {
      status: fact("known", [SCHEMA_EVIDENCE]),
      restrictions: fact([], [SCHEMA_EVIDENCE])
    },
    platformCompliance: {
      status: fact("known", [SCHEMA_EVIDENCE]),
      assessment: fact({ status: "clear" }, [SCHEMA_EVIDENCE]),
      requiredFieldGapCount: fact(0, [SCHEMA_EVIDENCE])
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
    supplierSkuId: plan.identity.supplierSkuId,
    variantKey: plan.identity.variantKey,
    targetPlatform: "ozon",
    targetStore: "dandanshu",
    businessPhase: "C1",
    businessResult: "pending",
    technicalStatus: "completed",
    ownerAction: "none",
    dataRevision: 8,
    c1ProductPlan: plan
  };
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
      salesSnapshotId: SALES_ID,
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
  assert.equal(result.inputs.competitorTextSnapshot.sourceSalesSnapshotId, SALES_ID);
  assert.equal(result.inputs.competitorTextSnapshot.evidenceRef, SALES_EVIDENCE);
  assert.deepEqual(
    result.inputs.competitorTextSnapshot.texts.map((item) => item.text),
    [
      "Полка для ванной комнаты без сверления",
      "material: пластик",
      "color: белый",
      "mounting.method: самоклеящийся"
    ]
  );
  assert.ok(result.inputs.competitorTextSnapshot.texts.every((item) => item.sourceRef.startsWith(SALES_EVIDENCE)));
  assert.equal(result.inputs.keywordEvidence.keywords[0].query, "полка для ванной");
  const downstreamRequest = buildC1AiDraftRequest({
    skuPackage: pkg,
    ...result.inputs,
    requestedAt: NOW
  });
  assert.equal(downstreamRequest.provider, "terra");
  assert.equal(downstreamRequest.executionPolicy.attemptLimit, 1);
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
    evidenceRefs: [SCHEMA_EVIDENCE],
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
