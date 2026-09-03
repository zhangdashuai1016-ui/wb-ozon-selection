import { createHash } from "node:crypto";

export const KEYWORD_NOW = "2026-08-25T08:00:00.000Z";
export const KEYWORD_EXPIRES = "2026-08-26T08:00:00.000Z";
export const KEYWORD_SUPPLY_REF = "evidence:supply:music-box:white";

function confirmed(value, sourceRefs = [KEYWORD_SUPPLY_REF]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function valueFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function keywordFactBinding(factPath, value, sourceRef = KEYWORD_SUPPLY_REF, options = {}) {
  return {
    factPath,
    factValueFingerprint: valueFingerprint(value),
    sourceRef,
    bindingRelation: options.bindingRelation ?? "exact_value",
    semanticProofRef: options.semanticProofRef ?? null
  };
}

function productTypeBinding() {
  return keywordFactBinding("productAttributes.productType", "music box");
}

export function keywordPlanningCandidate(overrides = {}) {
  const sales = {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: "sales:music-box:31",
    platform: "ozon",
    title: "Деревянная музыкальная шкатулка",
    currentPrice: 1790,
    evidenceRef: "evidence:sales:music-box:31",
    collectedAt: KEYWORD_NOW
  };
  const supply = {
    schemaVersion: "confirmed-supplier-sku-snapshot-v1",
    snapshotId: KEYWORD_SUPPLY_REF,
    ownerSupplyConfirmation: { status: "confirmed", supplierSkuId: "MUSIC-WHITE" },
    supplierSku: { supplierSkuId: "MUSIC-WHITE", variantKey: "颜色:原木", attributes: { material: "wood" } }
  };
  const profit = {
    schemaVersion: "profit-model-v1.1",
    profitModelVersion: "profit-v31",
    result: "passed",
    unitProfitRmb: 24,
    profitMargin: 0.13
  };
  const c1ProductPlan = {
    schemaVersion: "c1-product-plan-v1.1",
    status: "facts_checked",
    inputRefs: {
      salesSnapshotId: sales.snapshotId,
      selectedSupplySnapshotId: supply.snapshotId,
      profitModelVersion: profit.profitModelVersion
    },
    identity: {
      parentOpportunityId: "opportunity:music-box",
      skuPackageId: "sku-lifecycle:music-box:MUSIC-WHITE",
      supplierSkuId: "MUSIC-WHITE",
      variantKey: "颜色:原木",
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    inputSnapshots: { salesSnapshot: sales, confirmedSupplierSkuSnapshot: supply, profitModel: profit },
    exactSkuVerification: { status: confirmed("verified") },
    productAttributes: { status: confirmed("known"), productType: confirmed("music box"), material: confirmed("wood") },
    platformCategory: { status: confirmed("identified", ["schema:music-box"]) },
    schemaSnapshot: { status: confirmed("frozen", ["schema:music-box"]) },
    batteryAssessment: { status: confirmed("known"), assessment: confirmed("no_battery") },
    categoryRestrictions: { status: confirmed("known", ["schema:music-box"]), restrictions: confirmed([], ["schema:music-box"]) },
    platformCompliance: { status: confirmed("clear", ["schema:music-box"]) }
  };
  return {
    id: "CX-MUSIC-BOX-014",
    dataRevision: 31,
    workflowStatus: "listing_preparation",
    lifecycleV11: {
      skuPackage: {
        candidateId: "CX-MUSIC-BOX-014",
        skuPackageId: c1ProductPlan.identity.skuPackageId,
        supplierSkuId: "MUSIC-WHITE",
        variantKey: "颜色:原木",
        targetPlatform: "ozon",
        targetStore: "dandanshu",
        businessPhase: "C1",
        dataRevision: 9,
        fulfillmentMode: "rfbs",
        c1ProductPlan
      }
    },
    ...structuredClone(overrides)
  };
}

export function keywordPlanningSourceEvidence(overrides = {}) {
  return {
    schemaVersion: "c1-keyword-planning-source-evidence-v1",
    locale: "ru-RU",
    expiresAt: KEYWORD_EXPIRES,
    frozenSeoRules: { rulesVersion: "seo-rules-ru-v6", evidenceRef: "config:seo-rules-ru-v6" },
    frozenComplexityDecision: null,
    healthPolicy: {
      connectorVersion: "seerfar-runtime-v1",
      apiSchemaVersion: "seerfar-open-api-v1",
      controlledWindowId: "window:2026-08-25-am",
      ttlMs: 3_600_000,
      suspectedSystemicFailure: false,
      standardSkus: [1, 2, 3].map((id) => ({ id: `standard:${id}`, status: "passed", evidenceRef: `health:${id}` })),
      lastProof: {
        connectorVersion: "seerfar-runtime-v1",
        apiSchemaVersion: "seerfar-open-api-v1",
        controlledWindowId: "window:2026-08-25-am",
        provedAt: "2026-08-25T07:30:00.000Z"
      }
    },
    productFactTerms: [{
      term: "music box",
      sourceRefs: [KEYWORD_SUPPLY_REF],
      factRefs: [KEYWORD_SUPPLY_REF],
      factBindings: [productTypeBinding()],
      sourceTrust: "confirmed_supply",
      matchType: "target_fact"
    }],
    comparables: Array.from({ length: 4 }, (_, index) => ({
      competitorRef: `competitor:music-box:${index + 1}`,
      seerfarSku: String(900000 + index),
      platform: "ozon",
      matchType: "exact_match",
      comparabilityStatus: "proven",
      comparabilityEvidenceRefs: [`comparison:${index + 1}`],
      factRefs: [KEYWORD_SUPPLY_REF],
      factBindings: [productTypeBinding()],
      useForReverseLookup: true,
      organicTraffic: { value: 400 - index * 50, period: "30d", evidenceRef: `organic:${index + 1}` },
      manualSelectionRank: index + 1,
      selectionEvidenceRef: `selection:${index + 1}`,
      terms: []
    })),
    seedEvidence: [],
    quotaEvidence: { availablePoints: 80, observedAt: KEYWORD_NOW, expiresAt: KEYWORD_EXPIRES, evidenceRef: "seerfar-quota:80" },
    pointBudget: { approved: true, maxPoints: 15, evidenceRef: "config:seerfar-budget-15" },
    keywordMetricEvidence: { version: "keyword-metrics-v1", evidenceRef: "metrics:music-box:31", candidates: [] },
    reusableKeywordSnapshot: null,
    reuseEvidenceNote: null,
    ...structuredClone(overrides)
  };
}

export function keywordPlanningSourceRecord(candidate, overrides = {}) {
  return {
    schemaVersion: "c1-keyword-planning-source-record-v1",
    candidateId: candidate.id,
    candidateRevision: candidate.dataRevision,
    skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
    recordedAt: KEYWORD_NOW,
    sourceEvidence: keywordPlanningSourceEvidence(),
    sourceRefs: ["keyword-source:music-box:31"],
    ...structuredClone(overrides)
  };
}
