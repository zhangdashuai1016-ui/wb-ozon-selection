import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adaptLegacyCandidateToOpportunity } from "../lib/legacy-candidate-adapter.mjs";
import { sanitize1688Evidence } from "../lib/source-capture.mjs";
import { adapt1688CaptureToSupplierOption } from "../lib/supplier-option.mjs";
import {
  createOwnerSupplyConfirmation,
  createSkuLifecycleFromConfirmedSupply,
  recommendSupplierOption
} from "../lib/supplier-selection-flow.mjs";
import { runSkuProfitModel } from "../lib/profit-model.mjs";
import {
  C1_PRODUCT_PLAN_SCHEMA_VERSION,
  C1_FACT_VERIFICATION_VERSION,
  createC1ProductPlan,
  validateC1ProductPlan,
  validatePlatformSchemaEvidence,
  verifyC1ProductFacts
} from "../lib/c1-product-plan.mjs";
import { validateSkuLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import {
  C1_SEO_DRAFT_VERSION,
  createC1SeoDraft,
  validateC1SeoDraft
} from "../lib/c1-seo-draft.mjs";
import {
  C2_ASSET_LIFECYCLE_VERSION,
  addAiDraftAssets,
  confirmFinalUploads,
  createC2AssetLifecycle,
  selectConfirmedFinalUploadsForProduction,
  validateC2AssetLifecycle
} from "../lib/c2-asset-lifecycle.mjs";
import {
  FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION,
  createFinalProductPlanConfirmationCard,
  validateFinalProductPlanConfirmationCard
} from "../lib/final-product-plan-confirmation-card.mjs";
import {
  DEFAULT_NEW_PRODUCT_STOCK,
  PRODUCTION_AUTHORIZATION_VERSION,
  createProductionAuthorization,
  readAuthorizedProductionSnapshot,
  validateProductionAuthorization
} from "../lib/production-authorization.mjs";
import { attachPassedMarketAssessment } from "./helpers/market-assessment-fixture.mjs";
import { createTrainCandidate } from "./helpers/legacy-candidate-fixture.mjs";

const VARIANT = "规格:豪华小火车";

async function phase7PassedState({ sellerType = "cross_border_cn" } = {}) {
  const candidate = createTrainCandidate({ lifecycle: false });
  const opportunity = structuredClone(adaptLegacyCandidateToOpportunity(candidate));
  opportunity.salesSnapshots[0].platform = "ozon";
  opportunity.salesSnapshots[0].sellerType = sellerType;
  opportunity.salesSnapshots[0].sellerIdentityEvidence = {
    status: sellerType === "unknown" ? "unverified" : "verified",
    evidenceRef: sellerType === "unknown" ? "test:seller-identity:unknown" : "test:cross-border-cn"
  };
  attachPassedMarketAssessment(opportunity, { sellerType });
  const evidence = sanitize1688Evidence({
    offerId: "712421624571",
    observedAt: "2026-08-12T12:00:00.000Z",
    title: "机械发条木质火车",
    supplierSalesEvidence: { salesVolume: 500, stabilityScore: 80 },
    supplierBadges: ["牛头供应商"],
    skus: [{
      sourceSkuId: "4993364145574",
      propPath: VARIANT,
      attributes: { 规格: "豪华小火车" },
      priceCny: null,
      priceSource: null,
      stock: null,
      stockSource: null,
      imageUrl: null
    }]
  }, "712421624571");
  evidence.supplierSalesEvidence = { salesVolume: 500, stabilityScore: 80 };
  evidence.supplierBadges = ["牛头供应商"];
  evidence.skus[0].weight = { value: 0.3, unit: "kg" };
  evidence.skus[0].dimensions = { length: 23, width: 16, height: 3, unit: "cm" };
  evidence.skus[0].material = "DVP木纤维板";
  evidence.skus[0].powerProfile = { powered: false };
  const option = structuredClone(adapt1688CaptureToSupplierOption(evidence, {
    evidenceRef: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8"
  }));
  option.supplierSalesEvidence = evidence.supplierSalesEvidence;
  option.supplierBadges = evidence.supplierBadges;
  option.supplierSkus[0].actualPurchaseCost = 41;

  opportunity.businessPhase = "A";
  opportunity.businessResult = "passed";
  opportunity.technicalStatus = "completed";
  opportunity.ownerAction = "confirm_supplier_option";
  opportunity.supplierOptions = [option];
  opportunity.recommendedSupplierOptionId = null;
  opportunity.confirmedSupplierOptionId = null;

  const recommendation = recommendSupplierOption({
    opportunityPackage: opportunity,
    targetVariantKey: VARIANT,
    scoredAt: "2026-08-12T12:10:00.000Z"
  });
  const confirmation = createOwnerSupplyConfirmation({
    recommendedOpportunityPackage: recommendation.opportunityPackage,
    recommendation,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      supplierOptionId: option.supplierOptionId,
      supplierSkuId: option.supplierSkus[0].supplierSkuId,
      variantKey: VARIANT
    },
    confirmedAt: "2026-08-12T12:11:00.000Z"
  });
  const skuPackage = createSkuLifecycleFromConfirmedSupply({
    opportunityPackage: confirmation.opportunityPackage,
    ownerSupplyConfirmation: confirmation.confirmation,
    skuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    createdAt: "2026-08-12T12:12:00.000Z"
  });
  const result = runSkuProfitModel({
    opportunityPackage: confirmation.opportunityPackage,
    skuPackage,
    salesSelection: {
      salesSnapshotId: "legacy-sales:CX-20260803-010",
      pricePath: "marketEvidence.exactTarget.lowestOtherOfferRub",
      currency: "RUB"
    },
    platformFeeEvidence: {
      evidenceId: "platform-fees:ozon:dandanshu:17028665:rfbs:2026-08-12",
      commissionRate: 0.14,
      sourceType: "real_same_description_category_seller_api",
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0.05,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    },
    logisticsEvidence: {
      evidenceId: "logistics:guoo:economy-small:2026-07-20:0.3kg",
      route: "GUOO Economy Small PUDO/Courier",
      amountRmb: 26.4,
      billableWeightKg: 0.3,
      effectiveDate: "2026-07-20"
    },
    exchangeRateEvidence: {
      evidenceId: "fx:cbr:2026-08-07:RUB-CNY",
      rubPerCny: 12.0637,
      sourceType: "official"
    },
    calculatedAt: "2026-08-12T12:20:00.000Z"
  });
  return { opportunityPackage: confirmation.opportunityPackage, skuPackage: result.skuPackage };
}

function platformSchemaEvidence() {
  return {
    evidenceId: "schema:ozon:dandanshu:17028665:92935:2026-08-12",
    platform: "ozon",
    store: "dandanshu",
    descriptionCategoryId: "17028665",
    typeId: "92935",
    categoryName: "3D-пазл",
    schemaRevision: "ozon-schema:17028665:92935:2026-08-12",
    requiredFields: [
      { fieldKey: "brand", label: "品牌", required: true },
      { fieldKey: "model_name", label: "模型名", required: true },
      { fieldKey: "type", label: "类型", required: true }
    ],
    collectedAt: "2026-08-12T02:30:00.000Z"
  };
}

async function phase8InputsReadyState() {
  const state = await phase7PassedState();
  return createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });
}

async function phase9AFactsCheckedState() {
  const phase8 = await phase8InputsReadyState();
  return verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
}

function competitorTextSnapshot() {
  return {
    snapshotId: "competitor-text:CX-20260803-010:2026-08-07",
    sourceSalesSnapshotId: "legacy-sales:CX-20260803-010",
    observedAt: "2026-08-07T10:29:05.906Z",
    evidenceRef: "sales-snapshot:legacy-sales:CX-20260803-010#competitor_text",
    texts: [{
      textId: "ozon-competitor-title-3126033809",
      text: "Сложная трехмерная головоломка, деревянный паровозик 3D",
      sourceRef: "https://www.ozon.ru/product/3126033809/",
      role: "buyer_language_reference_only"
    }]
  };
}

function keywordEvidence() {
  return {
    evidenceId: "seo-evidence:CX-20260803-010:reused:2026-08-12",
    status: "ready",
    targetPlatform: "ozon",
    targetSkuPackageId: "sku-lifecycle:CX-20260803-010:4993364145574",
    sourcePlatform: "ozon",
    collectionMode: "reused_verified_evidence",
    pointsSpent: 0,
    observedAt: "2026-08-12T13:00:00.000Z",
    reuseEvidenceNote: "单SKU测试证据；目标平台、精确SKU事实、市场文本和证据时间已匹配。",
    keywords: [
      {
        query: "3D-пазл паровоз",
        group: "core_product_type",
        keywordEvidenceRef: "seerfar:query:3d-pazl-parovoz:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: [
          "platformCategory.categoryName",
          "exactSkuVerification.variantKey"
        ],
        reason: "与已确认平台产品类型和精确豪华小火车SKU一致"
      },
      {
        query: "деревянный 3D-пазл",
        group: "material",
        keywordEvidenceRef: "seerfar:query:derevyannyy-3d-pazl:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: [
          "platformCategory.categoryName",
          "productAttributes.material"
        ],
        reason: "与已确认3D拼图类目和DVP木纤维板材质一致"
      },
      {
        query: "механический паровоз 320 деталей",
        group: "differentiator",
        keywordEvidenceRef: "seerfar:query:mechanical-320:source-3126033809",
        sourcePlatform: "ozon",
        sourceSku: "3126033809",
        relevanceStatus: "retained",
        factBindingPaths: ["platformCompliance.assessment"],
        reason: "冻结事实未确认机械机制和320件，应拒绝"
      }
    ]
  };
}

async function phase9BSeoDraftState() {
  const phase9A = await phase9AFactsCheckedState();
  return createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    createdAt: "2026-08-12T13:05:00.000Z"
  });
}

async function phase10FinalAssetsConfirmedState() {
  const phase9B = await phase9BSeoDraftState();
  const initialized = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [{
      assetId: "collected:ozon:CX-20260803-010:main",
      mediaType: "image",
      assetRef: "https://ir.ozone.ru/reference-only.jpg",
      sourcePlatform: "ozon",
      sourceEvidenceRef: "legacy-sales:CX-20260803-010#imageUrl"
    }],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  return confirmFinalUploads({
    skuPackage: initialized.skuPackage,
    finalUploadAssets: [{
      assetId: "final:CX-20260803-010:main",
      mediaType: "image",
      assetRef: "/owner-confirmed/CX-20260803-010-main.jpg",
      sourceType: "owner_provided_final_upload"
    }],
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      approvedAssetIds: ["final:CX-20260803-010:main"],
      confirmationNote: "单SKU确认卡测试素材"
    },
    confirmedAt: "2026-08-12T13:12:00.000Z"
  });
}

async function phase11ConfirmationCardState() {
  const phase10 = await phase10FinalAssetsConfirmedState();
  return createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });
}

function ownerProductionApproval(cardId) {
  return {
    cardId,
    selectedOption: "approve_for_production_authorization",
    confirmedBy: "owner",
    note: "仅授权测试锁定范围"
  };
}

test("CX-20260803-010 enters C1 from exactly four frozen upstream inputs", async () => {
  const state = await phase7PassedState();
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.schemaVersion, C1_PRODUCT_PLAN_SCHEMA_VERSION);
  assert.equal(plan.status, "inputs_ready");
  assert.deepEqual(plan.inputRefs, {
    salesSnapshotId: "legacy-sales:CX-20260803-010",
    selectedSupplySnapshotId: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8:4993364145574",
    profitModelVersion: "profit-v1",
    platformSchemaEvidenceId: "schema:ozon:dandanshu:17028665:92935:2026-08-12"
  });
  assert.equal(plan.inputSnapshots.salesSnapshot.snapshotId, plan.inputRefs.salesSnapshotId);
  assert.equal(plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.supplierSkuId, "4993364145574");
  assert.equal(plan.inputSnapshots.profitModel.result, "passed");
  assert.equal(plan.inputSnapshots.platformSchemaRules.requiredFields.length, 3);
  assert.deepEqual(validateC1ProductPlan(plan), { valid: true, errors: [] });
  assert.deepEqual(validatePlatformSchemaEvidence(plan.inputSnapshots.platformSchemaRules), { valid: true, errors: [] });
});

test("unknown卖家样本经A正式放行且B利润达标后正常进入C1", async () => {
  const state = await phase7PassedState({ sellerType: "unknown" });
  assert.equal(state.skuPackage.businessResult, "passed");
  assert.ok(state.skuPackage.profitModels[0].unitProfitRmb >= 20);
  assert.ok(state.skuPackage.profitModels[0].profitMargin >= 0.25);
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:31:00.000Z"
  });
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.ownerAction, "none");
  assert.equal(result.c1ProductPlan.inputSnapshots.salesSnapshot.sellerType, "unknown");
});

test("C1 uses no external access and does not generate SEO, attributes, assets or production data", async () => {
  const state = await phase7PassedState();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("第8阶段禁止访问Ozon、WB或1688");
  };
  try {
    const result = createC1ProductPlan({
      ...state,
      platformSchemaEvidence: platformSchemaEvidence(),
      createdAt: "2026-08-12T12:30:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.c1ProductPlan.externalAccesses, []);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.finalAttributes, null);
    assert.equal(result.c1ProductPlan.complianceDecision, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
    assert.equal(result.skuPackage.c2FinalAssets, null);
    assert.equal(result.skuPackage.productionAuthorization, null);
    assert.equal(result.skuPackage.productionRecord, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C1 preserves the complete B result and exact supplier SKU identity", async () => {
  const state = await phase7PassedState();
  const modelsBefore = structuredClone(state.skuPackage.profitModels);
  const activeBefore = state.skuPackage.activeProfitModelVersion;
  const identityBefore = {
    supplierOptionId: state.skuPackage.supplierOptionId,
    supplierSkuId: state.skuPackage.supplierSkuId,
    variantKey: state.skuPackage.variantKey
  };
  const result = createC1ProductPlan({
    ...state,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  });

  assert.deepEqual(result.skuPackage.profitModels, modelsBefore);
  assert.equal(result.skuPackage.activeProfitModelVersion, activeBefore);
  assert.equal(result.skuPackage.profitModels[0].result, "passed");
  assert.deepEqual({
    supplierOptionId: result.skuPackage.supplierOptionId,
    supplierSkuId: result.skuPackage.supplierSkuId,
    variantKey: result.skuPackage.variantKey
  }, identityBefore);
  assert.equal(result.c1ProductPlan.profitRecalculated, false);
  assert.equal(result.c1ProductPlan.skuReplaced, false);
  assert.equal(result.skuPackage.businessPhase, "C1");
  assert.equal(result.skuPackage.businessResult, "pending");
  assert.equal(result.skuPackage.technicalStatus, "completed");
  assert.equal(validateSkuLifecyclePackage(result.skuPackage).valid, true);
});

test("C1 rejects a B result that is not passed without partial mutation", async () => {
  const state = await phase7PassedState();
  const inputBefore = JSON.stringify(state.skuPackage);
  const rejected = structuredClone(state.skuPackage);
  rejected.businessResult = "rejected";

  assert.throws(() => createC1ProductPlan({
    opportunityPackage: state.opportunityPackage,
    skuPackage: rejected,
    platformSchemaEvidence: platformSchemaEvidence(),
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_GATE_REJECTED|ProfitModel校验失败/);
  assert.equal(JSON.stringify(state.skuPackage), inputBefore);
  assert.equal(state.skuPackage.c1ProductPlan, null);
});

test("C1 stops when platform Schema evidence is missing or belongs to another store", async () => {
  const state = await phase7PassedState();
  assert.throws(() => createC1ProductPlan({
    ...state,
    platformSchemaEvidence: null,
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_INPUT_GAP: 平台Schema证据校验失败/);

  const wrongStore = platformSchemaEvidence();
  wrongStore.store = "Miska";
  assert.throws(() => createC1ProductPlan({
    ...state,
    platformSchemaEvidence: wrongStore,
    createdAt: "2026-08-12T12:30:00.000Z"
  }), /C1_INPUT_GAP: 平台Schema不适用于当前平台或店铺/);
});

test("published C1 schema freezes the four inputs and all phase-8 exclusions", async () => {
  const url = new URL("../schema/c1-product-plan-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.ok(schema.properties.status.enum.includes("inputs_ready"));
  for (const field of ["salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"]) {
    assert.ok(schema.properties.inputRefs.required.includes(field), field);
  }
  for (const field of ["finalSeo", "finalAttributes", "complianceDecision", "generatedAssets", "productionPayload"]) {
    assert.equal(schema.properties[field].type, "null");
  }
});

test("9A generates all seven sourced fact sections from the frozen C1 input package", async () => {
  const phase8 = await phase8InputsReadyState();
  const result = verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.status, "facts_checked");
  assert.equal(plan.factVerificationVersion, C1_FACT_VERIFICATION_VERSION);
  for (const field of [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ]) assert.equal(typeof plan[field], "object", field);
  assert.equal(plan.exactSkuVerification.supplierSkuId.value, "4993364145574");
  assert.match(plan.exactSkuVerification.supplierSkuId.sourceRefs[0], /supplierSku\/supplierSkuId/);
  assert.equal(plan.exactSkuVerification.status.value, "verified");
  assert.ok(plan.productAttributes.status.sourceRefs.length > 0);
  assert.equal(plan.platformCategory.descriptionCategoryId.value, "17028665");
  assert.equal(plan.schemaSnapshot.schemaRevision.value, "ozon-schema:17028665:92935:2026-08-12");
});

test("9A keeps unsupported brand, battery, restrictions and compliance explicitly unknown", async () => {
  const phase8 = await phase8InputsReadyState();
  const result = verifyC1ProductFacts({
    skuPackage: phase8.skuPackage,
    verifiedAt: "2026-08-12T12:40:00.000Z"
  });
  const plan = result.c1ProductPlan;
  const brand = plan.productAttributes.requiredPlatformFields.find((field) => field.fieldKey === "brand");

  assert.equal(brand.fact.value, "unknown");
  assert.equal(brand.fact.verificationStatus, "unknown");
  assert.equal(plan.batteryAssessment.assessment.value, "unknown");
  assert.equal(plan.batteryAssessment.containsBattery.value, "unknown");
  assert.equal(plan.categoryRestrictions.restrictions.value, "unknown");
  assert.equal(plan.platformCompliance.assessment.value, "unknown");
  assert.ok(brand.fact.sourceRefs.every((ref) => !ref.includes("image")));
});

test("9A makes zero platform calls and preserves B result, SKU, and all excluded outputs", async () => {
  const phase8 = await phase8InputsReadyState();
  const profitBefore = structuredClone(phase8.skuPackage.profitModels);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("9A禁止重新访问销售或供应平台");
  };
  try {
    const result = verifyC1ProductFacts({
      skuPackage: phase8.skuPackage,
      verifiedAt: "2026-08-12T12:40:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.skuPackage.profitModels, profitBefore);
    assert.equal(result.skuPackage.activeProfitModelVersion, "profit-v1");
    assert.equal(result.skuPackage.profitModels[0].result, "passed");
    assert.equal(result.skuPackage.supplierSkuId, phase8.skuPackage.supplierSkuId);
    assert.equal(result.skuPackage.variantKey, phase8.skuPackage.variantKey);
    assert.deepEqual(result.c1ProductPlan.externalAccesses, []);
    assert.equal(result.c1ProductPlan.profitRecalculated, false);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("9A accepts a fact only from a declared frozen field mapping, never from title or images", async () => {
  const phase8 = await phase8InputsReadyState();
  const skuPackage = structuredClone(phase8.skuPackage);
  const plan = skuPackage.c1ProductPlan;
  plan.inputSnapshots.salesSnapshot.title = "某品牌带电木质玩具";
  plan.inputSnapshots.salesSnapshot.imageRefs = ["https://example.test/looks-powered.jpg"];
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.material = "unknown";
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.powerProfile = "unknown";
  plan.inputSnapshots.platformSchemaRules.requiredFields[0].sourceAttributeKeys = ["品牌"];

  const result = verifyC1ProductFacts({ skuPackage, verifiedAt: "2026-08-12T12:40:00.000Z" });
  const brand = result.c1ProductPlan.productAttributes.requiredPlatformFields.find((field) => field.fieldKey === "brand");
  assert.equal(result.c1ProductPlan.productAttributes.material.value, "unknown");
  assert.equal(result.c1ProductPlan.batteryAssessment.assessment.value, "unknown");
  assert.equal(brand.fact.value, "unknown");
});

test("9B creates four Russian SEO draft outputs with evidence on every retained keyword", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const result = createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    createdAt: "2026-08-12T13:05:00.000Z"
  });
  const plan = result.c1ProductPlan;

  assert.equal(plan.status, "seo_draft_ready");
  assert.equal(plan.seoEvidenceLayer.draftVersion, C1_SEO_DRAFT_VERSION);
  assert.equal(plan.seoTitleDraft.status, "draft_only");
  assert.match(plan.seoTitleDraft.text, /3D-пазл паровоз/);
  assert.equal(plan.descriptionDraft.status, "draft_only");
  assert.ok(plan.bulletPointsDraft.length >= 2);
  assert.equal(plan.searchKeywordsDraft.keywords.length, 2);
  for (const keyword of plan.searchKeywordsDraft.keywords) {
    assert.ok(keyword.evidenceRefs.length > 0);
    assert.ok(keyword.factRefs.length > 0);
  }
  assert.deepEqual(validateC1SeoDraft(plan), { valid: true, errors: [] });
});

test("9B rejects an evidenced keyword when verified product facts do not support it", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const result = createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: keywordEvidence(),
    createdAt: "2026-08-12T13:05:00.000Z"
  });
  const rejected = result.c1ProductPlan.seoEvidenceLayer.keywordsRejected;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].query, "механический паровоз 320 деталей");
  assert.equal(rejected[0].reason, "unsupported_by_verified_product_facts");
  assert.ok(rejected[0].evidenceRefs.length > 0);
  assert.doesNotMatch(result.c1ProductPlan.seoTitleDraft.text, /320|механическ/i);
  assert.doesNotMatch(result.c1ProductPlan.descriptionDraft.text, /320|механическ/i);
});

test("9B preserves all 9A facts and B profit while making zero external or production writes", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const factsBefore = Object.fromEntries([
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ].map((field) => [field, structuredClone(phase9A.c1ProductPlan[field])]));
  const profitBefore = structuredClone(phase9A.skuPackage.profitModels);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("9B禁止访问平台");
  };
  try {
    const result = createC1SeoDraft({
      skuPackage: phase9A.skuPackage,
      competitorTextSnapshot: competitorTextSnapshot(),
      keywordEvidence: keywordEvidence(),
      createdAt: "2026-08-12T13:05:00.000Z"
    });
    assert.equal(fetchCalls, 0);
    for (const [field, value] of Object.entries(factsBefore)) assert.deepEqual(result.c1ProductPlan[field], value);
    assert.deepEqual(result.skuPackage.profitModels, profitBefore);
    assert.equal(result.skuPackage.businessPhase, "C1");
    assert.equal(result.skuPackage.c2FinalAssets, null);
    assert.equal(result.skuPackage.productionAuthorization, null);
    assert.equal(result.skuPackage.productionRecord, null);
    assert.equal(result.c1ProductPlan.finalSeo, null);
    assert.equal(result.c1ProductPlan.generatedAssets, null);
    assert.equal(result.c1ProductPlan.productionPayload, null);
    assert.equal(result.c1ProductPlan.seoEvidenceLayer.productionWrites, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("9B stops if keyword evidence has no fact binding or is not verified reusable evidence", async () => {
  const phase9A = await phase9AFactsCheckedState();
  const noBinding = keywordEvidence();
  noBinding.keywords[0].factBindingPaths = [];
  assert.throws(() => createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: noBinding,
    createdAt: "2026-08-12T13:05:00.000Z"
  }), /C1_SEO_INPUT_GAP: 关键词证据无效/);

  const paidOrFresh = keywordEvidence();
  paidOrFresh.collectionMode = "live_lookup";
  assert.throws(() => createC1SeoDraft({
    skuPackage: phase9A.skuPackage,
    competitorTextSnapshot: competitorTextSnapshot(),
    keywordEvidence: paidOrFresh,
    createdAt: "2026-08-12T13:05:00.000Z"
  }), /C1_SEO_INPUT_GAP: 关键词证据无效/);
});

test("10 creates three independent C2 asset regions without generation or production", async () => {
  const phase9B = await phase9BSeoDraftState();
  const result = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [
      {
        assetId: "collected:ozon:CX-20260803-010:main",
        mediaType: "image",
        assetRef: "https://ir.ozone.ru/reference-only.jpg",
        sourcePlatform: "ozon",
        sourceEvidenceRef: "legacy-sales:CX-20260803-010#imageUrl"
      },
      {
        assetId: "collected:1688:712421624571:main",
        mediaType: "image",
        assetRef: "https://cbu01.alicdn.com/reference-only.jpg",
        sourcePlatform: "1688",
        sourceEvidenceRef: "source-capture:SC-8f132e8e-425e-401a-8c72-13c32290d8b8"
      }
    ],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  const lifecycle = result.c2AssetLifecycle;

  assert.equal(lifecycle.schemaVersion, C2_ASSET_LIFECYCLE_VERSION);
  assert.equal(lifecycle.status, "awaiting_final_uploads");
  assert.equal(lifecycle.assets.collected.length, 2);
  assert.deepEqual(lifecycle.assets.aiDrafts, []);
  assert.deepEqual(lifecycle.assets.finalUploads, []);
  assert.equal(lifecycle.generationIntegrations.xiaohouzi, "not_connected");
  assert.equal(lifecycle.platformUploads, 0);
  assert.equal(lifecycle.productionStarted, false);
  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.ownerAction, "provide_final_assets");
  assert.deepEqual(validateC2AssetLifecycle(lifecycle), { valid: true, errors: [] });
});

test("10 never exposes collected assets to the future D asset selector", async () => {
  const phase9B = await phase9BSeoDraftState();
  const result = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [{
      assetId: "collected:ozon:CX-20260803-010:main",
      mediaType: "image",
      assetRef: "https://ir.ozone.ru/reference-only.jpg",
      sourcePlatform: "ozon",
      sourceEvidenceRef: "legacy-sales:CX-20260803-010#imageUrl"
    }],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  assert.equal(result.c2AssetLifecycle.assets.collected[0].productionEligible, false);
  assert.throws(
    () => selectConfirmedFinalUploadsForProduction(result.c2AssetLifecycle),
    /C2_OWNER_CONFIRMATION_REQUIRED/
  );
});

test("10 keeps AI drafts isolated and does not promote them into finalUploads", async () => {
  const phase9B = await phase9BSeoDraftState();
  const initialized = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  const withAi = addAiDraftAssets({
    skuPackage: initialized.skuPackage,
    aiDraftAssets: [{
      assetId: "ai-draft:CX-20260803-010:concept-1",
      mediaType: "image",
      assetRef: "local-draft://concept-1",
      generatorRef: "future-ai-placeholder"
    }],
    addedAt: "2026-08-12T13:11:00.000Z"
  });

  assert.equal(withAi.c2AssetLifecycle.assets.aiDrafts.length, 1);
  assert.equal(withAi.c2AssetLifecycle.assets.aiDrafts[0].productionEligible, false);
  assert.deepEqual(withAi.c2AssetLifecycle.assets.finalUploads, []);
  assert.throws(
    () => selectConfirmedFinalUploadsForProduction(withAi.c2AssetLifecycle),
    /C2_OWNER_CONFIRMATION_REQUIRED/
  );
});

test("10 requires owner confirmation and accepts only owner-provided final upload assets", async () => {
  const phase9B = await phase9BSeoDraftState();
  const initialized = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  const finalAssets = [{
    assetId: "final:CX-20260803-010:main",
    mediaType: "image",
    assetRef: "/owner-confirmed/CX-20260803-010-main.jpg",
    sourceType: "owner_provided_final_upload"
  }];

  assert.throws(() => confirmFinalUploads({
    skuPackage: initialized.skuPackage,
    finalUploadAssets: finalAssets,
    ownerDecision: null,
    confirmedAt: "2026-08-12T13:12:00.000Z"
  }), /C2_OWNER_CONFIRMATION_REQUIRED/);

  const aiAsFinal = structuredClone(finalAssets);
  aiAsFinal[0].sourceType = "ai_generated_draft";
  assert.throws(() => confirmFinalUploads({
    skuPackage: initialized.skuPackage,
    finalUploadAssets: aiAsFinal,
    ownerDecision: { status: "confirmed", confirmedBy: "owner", approvedAssetIds: [aiAsFinal[0].assetId] },
    confirmedAt: "2026-08-12T13:12:00.000Z"
  }), /不能自动成为finalUploads/);

  const confirmed = confirmFinalUploads({
    skuPackage: initialized.skuPackage,
    finalUploadAssets: finalAssets,
    ownerDecision: {
      status: "confirmed",
      confirmedBy: "owner",
      approvedAssetIds: ["final:CX-20260803-010:main"],
      confirmationNote: "单SKU基础设施测试确认"
    },
    confirmedAt: "2026-08-12T13:12:00.000Z"
  });
  assert.equal(confirmed.c2AssetLifecycle.status, "completed");
  assert.equal(confirmed.c2AssetLifecycle.assets.finalUploads[0].ownerConfirmed, true);

  const futureDInput = selectConfirmedFinalUploadsForProduction(confirmed.c2AssetLifecycle);
  assert.equal(futureDInput.sourceArea, "assets.finalUploads");
  assert.equal(futureDInput.assets.length, 1);
  assert.equal(futureDInput.collectedIncluded, false);
  assert.equal(futureDInput.aiDraftsIncluded, false);
  assert.equal(futureDInput.productionExecuted, false);
});

test("10 preserves product facts, C1 SEO drafts and B profit throughout C2 setup", async () => {
  const phase9B = await phase9BSeoDraftState();
  const c1Before = structuredClone(phase9B.skuPackage.c1ProductPlan);
  const profitBefore = structuredClone(phase9B.skuPackage.profitModels);
  const result = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  assert.deepEqual(result.skuPackage.c1ProductPlan, c1Before);
  assert.deepEqual(result.skuPackage.profitModels, profitBefore);
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.equal(result.c2AssetLifecycle.platformUploads, 0);
  assert.equal(result.c2AssetLifecycle.productionStarted, false);
});

test("published C2 schema freezes the three regions and D read policy", async () => {
  const url = new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.deepEqual(schema.properties.assets.required, ["collected", "aiDrafts", "finalUploads"]);
  assert.equal(schema.properties.dReadPolicy.properties.onlyAllowedArea.const, "assets.finalUploads");
  assert.equal(schema.properties.dReadPolicy.properties.collectedAllowed.const, false);
  assert.equal(schema.properties.dReadPolicy.properties.aiDraftsAllowed.const, false);
  assert.equal(schema.properties.dReadPolicy.properties.ownerConfirmationRequired.const, true);
  assert.equal(schema.properties.platformUploads.const, 0);
  assert.equal(schema.properties.productionStarted.const, false);
});

test("10 rejects a fake completed C2 shell at the lifecycle D gate", async () => {
  const phase9B = await phase9BSeoDraftState();
  const fake = structuredClone(phase9B.skuPackage);
  fake.businessPhase = "D";
  fake.c1ProductPlan.status = "completed";
  fake.c2FinalAssets = { status: "completed" };
  fake.productionAuthorization = { status: "confirmed", confirmedAt: "2026-08-12T13:15:00.000Z" };
  const validation = validateSkuLifecyclePackage(fake);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.path === "c2FinalAssets.schemaVersion"));
  assert.ok(validation.errors.some((error) => error.path === "c2FinalAssets.assets.finalUploads"));
});

test("11 creates one complete owner-facing final product plan confirmation card", async () => {
  const phase10 = await phase10FinalAssetsConfirmedState();
  const result = createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });
  const card = result.confirmationCard;

  assert.equal(card.schemaVersion, FINAL_PRODUCT_PLAN_CONFIRMATION_CARD_VERSION);
  assert.equal(card.status, "awaiting_owner_business_confirmation");
  assert.equal(card.ownerDecision, null);
  assert.ok(card.productInformation.productName.value);
  assert.equal(card.productInformation.sku.value.supplierSkuId, "4993364145574");
  assert.equal(card.productInformation.supplierOption.value.offerId, "712421624571");
  assert.equal(card.productInformation.targetPlatform.value.platform, "ozon");
  assert.equal(card.productInformation.targetPlatform.value.store, "dandanshu");
  assert.equal(card.profitResult.recommendedSalePrice.value.rub, 1831);
  assert.equal(card.profitResult.unitProfitRmb.value, 41.92);
  assert.equal(card.profitResult.profitMargin.value, 0.2762);
  assert.deepEqual(validateFinalProductPlanConfirmationCard(card), { valid: true, errors: [] });
});

test("11 card combines exact C1 facts and all four SEO drafts without changing them", async () => {
  const phase10 = await phase10FinalAssetsConfirmedState();
  const c1Before = structuredClone(phase10.skuPackage.c1ProductPlan);
  const result = createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });
  const card = result.confirmationCard;

  assert.equal(card.c1Facts.exactSku.supplierSkuId.value, "4993364145574");
  assert.equal(card.c1Facts.platformCategory.descriptionCategoryId.value, "17028665");
  assert.deepEqual(card.c1Facts.productAttributes, c1Before.productAttributes);
  assert.deepEqual(card.c1Facts.batteryStatus, c1Before.batteryAssessment);
  assert.deepEqual(card.c1Facts.platformCompliance, c1Before.platformCompliance);
  assert.deepEqual(card.seoDraft.title, c1Before.seoTitleDraft);
  assert.deepEqual(card.seoDraft.description, c1Before.descriptionDraft);
  assert.deepEqual(card.seoDraft.bulletPoints, c1Before.bulletPointsDraft);
  assert.deepEqual(card.seoDraft.searchKeywords, c1Before.searchKeywordsDraft);
  assert.deepEqual(result.skuPackage.c1ProductPlan, c1Before);
});

test("11 card reads only owner-confirmed assets.finalUploads and excludes collected and AI areas", async () => {
  const phase10 = await phase10FinalAssetsConfirmedState();
  const result = createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });
  const assets = result.confirmationCard.c2Assets;

  assert.equal(assets.sourceArea, "assets.finalUploads");
  assert.equal(assets.finalUploads.length, 1);
  assert.equal(assets.finalUploads[0].assetId, "final:CX-20260803-010:main");
  assert.equal(assets.finalUploads[0].ownerConfirmed, true);
  assert.equal("collected" in assets, false);
  assert.equal("aiDrafts" in assets, false);
  assert.doesNotMatch(JSON.stringify(assets), /reference-only/);
});

test("11 card surfaces risks and every unknown fact for one-card business review", async () => {
  const phase10 = await phase10FinalAssetsConfirmedState();
  const result = createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });
  const section = result.confirmationCard.riskAndUnknowns;

  assert.equal(section.status, "owner_review_required");
  assert.ok(section.materialRisks.includes("battery_status_unknown"));
  assert.ok(section.materialRisks.includes("category_restrictions_unknown"));
  assert.ok(section.materialRisks.includes("platform_compliance_unknown"));
  assert.ok(section.materialRisks.includes("required_platform_attributes_incomplete"));
  assert.ok(section.unknownCount > 0);
  assert.ok(section.unknownFields.every((item) => item.value === "unknown" && item.sourceRefs.length > 0));
  assert.ok(section.unknownFields.some((item) => item.fieldKey === "brand" && item.label === "品牌"));
});

test("11 remains C2 and cannot create D authorization, writes, uploads, or automatic owner approval", async () => {
  const phase10 = await phase10FinalAssetsConfirmedState();
  const c2Before = structuredClone(phase10.skuPackage.c2FinalAssets);
  const profitBefore = structuredClone(phase10.skuPackage.profitModels);
  const result = createFinalProductPlanConfirmationCard({
    skuPackage: phase10.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  });

  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.businessResult, "pending");
  assert.equal(result.skuPackage.ownerAction, "confirm_c1_plan");
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);
  assert.deepEqual(result.skuPackage.c2FinalAssets, c2Before);
  assert.deepEqual(result.skuPackage.profitModels, profitBefore);
  assert.equal(result.confirmationCard.productionBoundary.productionAuthorized, false);
  assert.equal(result.confirmationCard.productionBoundary.dStarted, false);
  assert.equal(result.confirmationCard.productionBoundary.platformWrites, 0);
  assert.equal(result.confirmationCard.productionBoundary.requiresSeparateExactAuthorization, true);
  assert.equal(result.confirmationCard.ownerDecision, null);
});

test("11 refuses to generate the card before finalUploads are owner-confirmed", async () => {
  const phase9B = await phase9BSeoDraftState();
  const awaiting = createC2AssetLifecycle({
    skuPackage: phase9B.skuPackage,
    collectedAssets: [],
    createdAt: "2026-08-12T13:10:00.000Z"
  });
  assert.throws(() => createFinalProductPlanConfirmationCard({
    skuPackage: awaiting.skuPackage,
    createdAt: "2026-08-12T13:20:00.000Z"
  }), /FINAL_PLAN_CARD_GATE_REJECTED/);
});

test("published final confirmation card schema freezes owner and production boundaries", async () => {
  const url = new URL("../schema/final-product-plan-confirmation-card-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  assert.ok(schema.properties.status.enum.includes("awaiting_owner_business_confirmation"));
  assert.ok(schema.properties.status.enum.includes("owner_business_approved"));
  assert.equal(schema.properties.c2Assets.properties.sourceArea.const, "assets.finalUploads");
  assert.equal(schema.properties.productionBoundary.properties.productionAuthorized.const, false);
  assert.equal(schema.properties.productionBoundary.properties.dStarted.const, false);
  assert.equal(schema.properties.productionBoundary.properties.platformWrites.const, 0);
  assert.equal(schema.properties.productionBoundary.properties.requiresSeparateExactAuthorization.const, true);
});

test("12 converts the exact owner-approved confirmation card into a locked ProductionAuthorization", async () => {
  const phase11 = await phase11ConfirmationCardState();
  const result = createProductionAuthorization({
    skuPackage: phase11.skuPackage,
    ownerDecision: ownerProductionApproval(phase11.confirmationCard.cardId),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: ["no_publish_or_activation", "no_moderation_submission", "no_promotion_change", "no_advertising_change"],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  });
  const authorization = result.productionAuthorization;

  assert.equal(authorization.schemaVersion, PRODUCTION_AUTHORIZATION_VERSION);
  assert.equal(authorization.status, "confirmed");
  assert.equal(authorization.confirmedBy, "owner");
  assert.equal(authorization.sourceConfirmationCardId, phase11.confirmationCard.cardId);
  assert.equal(authorization.authorizedDataRevision, phase11.skuPackage.dataRevision);
  assert.equal(authorization.lockedScope.platform, "ozon");
  assert.equal(authorization.lockedScope.store, "dandanshu");
  assert.equal(authorization.lockedScope.skuPackageId, "sku-lifecycle:CX-20260803-010:4993364145574");
  assert.equal(authorization.lockedScope.supplierSkuId, "4993364145574");
  assert.match(authorization.lockedScope.titleVersion, /^c1-seo-draft-v1\.1:/);
  assert.match(authorization.lockedScope.attributeVersion, /^c1-fact-verification-v1\.1:/);
  assert.deepEqual(authorization.lockedScope.platformCategory, result.skuPackage.c1ProductPlan.platformCategory);
  assert.deepEqual(authorization.lockedScope.recommendedPrice, { rub: 1831, cny: 151.78 });
  assert.deepEqual(authorization.lockedScope.buyerTargetPrice, { amount: 1831, currency: "RUB" });
  assert.deepEqual(authorization.lockedScope.platformWritePrice, { amount: 151.78, currency: "CNY" });
  assert.equal(authorization.lockedScope.stock, DEFAULT_NEW_PRODUCT_STOCK);
  assert.match(authorization.lockedScope.assetsFinalUploadsVersion, /^c2-assets:.*2026-08-12T13:12/);
  assert.equal(authorization.lockedScope.finalUploads.length, 1);
  assert.equal(authorization.lockedScope.publishScope, "create_draft_only");
  assert.deepEqual(authorization.lockedScope.exclusions, ["no_publish_or_activation", "no_moderation_submission", "no_promotion_change", "no_advertising_change"]);
  assert.deepEqual(validateProductionAuthorization(authorization), { valid: true, errors: [] });
});

test("12 requires the owner to approve the exact card and never auto-authorizes", async () => {
  const phase11 = await phase11ConfirmationCardState();
  const common = {
    skuPackage: phase11.skuPackage,
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: [],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  };
  assert.throws(() => createProductionAuthorization({ ...common, ownerDecision: null }), /OWNER_CONFIRMATION_REQUIRED/);
  assert.throws(() => createProductionAuthorization({
    ...common,
    ownerDecision: { ...ownerProductionApproval("wrong-card"), cardId: "wrong-card" }
  }), /OWNER_CONFIRMATION_REQUIRED/);
  assert.equal(phase11.skuPackage.productionAuthorization, null);
  assert.equal(phase11.confirmationCard.ownerDecision, null);
});

test("12 blocks production while the active B result still uses an estimated commission", async () => {
  const phase11 = await phase11ConfirmationCardState();
  const blocked = structuredClone(phase11.skuPackage);
  blocked.productionConfirmationCard.riskAndUnknowns.materialRisks.push("exact_commission_required_before_production");
  blocked.productionConfirmationCard.riskAndUnknowns.status = "owner_review_required";
  assert.throws(() => createProductionAuthorization({
    skuPackage: blocked,
    ownerDecision: ownerProductionApproval(blocked.productionConfirmationCard.cardId),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:test", checkedAt: "2026-08-12T13:30:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: [],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  }), /C阶段尚未补取当前精确佣金/);
});

test("12 locks SKU, title, attributes, price, stock, final assets and authorization scope against later source changes", async () => {
  const phase11 = await phase11ConfirmationCardState();
  const result = createProductionAuthorization({
    skuPackage: phase11.skuPackage,
    ownerDecision: ownerProductionApproval(phase11.confirmationCard.cardId),
    buyerTargetPrice: { amount: 1900, currency: "RUB" },
    platformWritePrice: { amount: 157.5, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0634920635, evidenceRef: "fx:test", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: ["do_not_publish"],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  });
  const expected = readAuthorizedProductionSnapshot(result.productionAuthorization);
  const mutatedLivePackage = structuredClone(result.skuPackage);
  mutatedLivePackage.supplierSkuId = "replacement-sku";
  mutatedLivePackage.c1ProductPlan.seoTitleDraft.text = "替换标题";
  mutatedLivePackage.c1ProductPlan.productAttributes = { replaced: true };
  mutatedLivePackage.c2FinalAssets.assets.finalUploads = [{ assetId: "replacement-asset" }];

  const actual = readAuthorizedProductionSnapshot(mutatedLivePackage.productionAuthorization);
  assert.deepEqual(actual, expected);
  assert.equal(actual.lockedScope.supplierSkuId, "4993364145574");
  assert.notEqual(actual.lockedScope.title, "替换标题");
  assert.equal(actual.lockedScope.finalUploads[0].assetId, "final:CX-20260803-010:main");
  assert.equal(actual.lockedScope.stock, 100);
  assert.equal(actual.lockedScope.publishScope, "create_draft_only");
  assert.deepEqual(actual.lockedScope.exclusions, ["do_not_publish"]);
});

test("12 rejects scope expansion and records all mutation or replacement controls as false", async () => {
  const phase11 = await phase11ConfirmationCardState();
  assert.throws(() => createProductionAuthorization({
    skuPackage: phase11.skuPackage,
    ownerDecision: ownerProductionApproval(phase11.confirmationCard.cardId),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: [],
    allowedWriteFields: ["title", "delete_product"],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  }), /SCOPE_REJECTED/);

  const result = createProductionAuthorization({
    skuPackage: phase11.skuPackage,
    ownerDecision: ownerProductionApproval(phase11.confirmationCard.cardId),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: [],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  });
  const authorization = result.productionAuthorization;
  assert.equal(authorization.scopeExpansionAllowed, false);
  assert.equal(authorization.fieldMutationAllowed, false);
  assert.equal(authorization.skuReplacementAllowed, false);
  assert.equal(authorization.assetReplacementAllowed, false);
  assert.equal(authorization.readPolicy, "authorization_snapshot_only");
});

test("12 stays in C2 and performs no D, E, upload, product creation, or platform write", async () => {
  const phase11 = await phase11ConfirmationCardState();
  const c1Before = structuredClone(phase11.skuPackage.c1ProductPlan);
  const c2Before = structuredClone(phase11.skuPackage.c2FinalAssets);
  const profitBefore = structuredClone(phase11.skuPackage.profitModels);
  const result = createProductionAuthorization({
    skuPackage: phase11.skuPackage,
    ownerDecision: ownerProductionApproval(phase11.confirmationCard.cardId),
    buyerTargetPrice: { amount: 1831, currency: "RUB" },
    platformWritePrice: { amount: 151.78, currency: "CNY" },
    priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:cbr:2026-08-07:RUB-CNY", checkedAt: "2026-08-07T00:00:00.000Z" },
    publishScope: "create_draft_only",
    exclusions: ["do_not_submit", "do_not_publish"],
    confirmedAt: "2026-08-12T13:30:00.000Z"
  });

  assert.equal(result.skuPackage.businessPhase, "C2");
  assert.equal(result.skuPackage.businessResult, "passed");
  assert.equal(result.skuPackage.ownerAction, "none");
  assert.equal(result.skuPackage.productionRecord, null);
  assert.deepEqual(result.skuPackage.c1ProductPlan, c1Before);
  assert.deepEqual(result.skuPackage.c2FinalAssets, c2Before);
  assert.deepEqual(result.skuPackage.profitModels, profitBefore);
  assert.equal(result.productionAuthorization.productionExecuted, false);
  assert.equal(result.productionAuthorization.platformWrites, 0);
  assert.equal(result.skuPackage.readbackHistory.length, 0);
});

test("published ProductionAuthorization schema freezes every required lock and no-write boundary", async () => {
  const url = new URL("../schema/production-authorization-v1.1.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(url, "utf8"));
  for (const field of [
    "platform", "store", "skuPackageId", "supplierSkuId", "titleVersion", "attributeVersion",
    "platformCategory", "recommendedPrice", "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock", "assetsFinalUploadsVersion", "finalUploads",
    "publishScope", "exclusions", "allowedWriteFields"
  ]) assert.ok(schema.properties.lockedScope.required.includes(field), field);
  assert.equal(schema.properties.lockedScope.properties.stock.const, 100);
  assert.equal(schema.properties.scopeExpansionAllowed.const, false);
  assert.equal(schema.properties.fieldMutationAllowed.const, false);
  assert.equal(schema.properties.skuReplacementAllowed.const, false);
  assert.equal(schema.properties.assetReplacementAllowed.const, false);
  assert.equal(schema.properties.readPolicy.const, "authorization_snapshot_only");
  assert.equal(schema.properties.productionExecuted.const, false);
  assert.equal(schema.properties.platformWrites.const, 0);
});
