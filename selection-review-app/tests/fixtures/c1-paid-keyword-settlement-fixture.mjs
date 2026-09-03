import { fingerprintCanonicalRecord } from "../../lib/production-contract-primitives.mjs";
import { produceC1KeywordPlanningEvidence } from "../../lib/c1-keyword-planning-evidence-producer.mjs";
import { prepareC1KeywordSoftwareExecution } from "../../lib/c1-keyword-software-use-case.mjs";
import { prepareC1FactKeywordPipeline } from "../../lib/c1-fact-keyword-pipeline.mjs";
import { prepareC1FactKeywordRuntime } from "../../lib/c1-fact-keyword-runtime.mjs";
import { KEYWORD_SCORING_COMPONENTS } from "../../lib/keyword-evidence-scoring.mjs";
import { KEYWORD_NOW, KEYWORD_SUPPLY_REF, keywordFactBinding, keywordPlanningCandidate, keywordPlanningSourceEvidence } from "./c1-keyword-planning-fixture.mjs";

export async function c1PaidKeywordSettlementCandidate({ candidateId = "CX-MUSIC-BOX-014", supplierSkuId = "MUSIC-WHITE" } = {}) {
  const candidate = keywordPlanningCandidate();
  candidate.id = candidateId;
  candidate.lifecycleV11.skuPackage.candidateId = candidateId;
  const plan = candidate.lifecycleV11.skuPackage.c1ProductPlan;
  candidate.lifecycleV11.skuPackage.supplierSkuId = supplierSkuId;
  candidate.lifecycleV11.skuPackage.skuPackageId = `sku-lifecycle:music-box:${supplierSkuId}`;
  plan.identity.supplierSkuId = supplierSkuId;
  plan.identity.skuPackageId = candidate.lifecycleV11.skuPackage.skuPackageId;
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.ownerSupplyConfirmation.supplierSkuId = supplierSkuId;
  plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.supplierSkuId = supplierSkuId;
  Object.assign(plan, {
    c1PlanId: "c1:music-box:31", createdAt: KEYWORD_NOW,
    factVerificationVersion: "c1-fact-verification-v1.1", factsVerifiedAt: KEYWORD_NOW,
    externalAccesses: [], profitRecalculated: false, skuReplaced: false,
    finalSeo: null, finalAttributes: null, complianceDecision: null, generatedAssets: null, productionPayload: null,
    seoTitleDraft: null, descriptionDraft: null, bulletPointsDraft: null, searchKeywordsDraft: null, seoEvidenceLayer: null
  });
  plan.identity.supplierOptionId = "supplier-option:music-box";
  plan.inputSnapshots.salesSnapshot.attributes = { material: "wood" };
  plan.inputRefs.platformSchemaEvidenceId = "schema:music-box";
  plan.inputSnapshots.platformSchemaRules = {
    evidenceId: "schema:music-box", platform: "ozon", store: "dandanshu",
    schemaRevision: "ozon:music-box:1", requiredFields: [], collectedAt: KEYWORD_NOW
  };
  const evidence = keywordPlanningSourceEvidence();
  evidence.frozenSeoRules = {
    rulesVersion: "seo-rules-ru-v6", locale: "ru-RU", titleMaxLength: 120,
    descriptionMaxLength: 1800, bulletPointLimit: 5, prohibitedClaims: ["unverified_brand"],
    evidenceRef: "config:seo-rules-ru-v6", frozenAt: KEYWORD_NOW
  };
  evidence.productFactTerms = Array.from({ length: 19 }, (_, index) => {
    const field = `keywordFact${index + 1}`;
    const term = `music box keyword ${index + 1}`;
    plan.productAttributes[field] = { value: term, verificationStatus: "confirmed", sourceRefs: [KEYWORD_SUPPLY_REF] };
    return {
      ...structuredClone(evidence.productFactTerms[0]), term,
      factBindings: [keywordFactBinding(`productAttributes.${field}`, term)]
    };
  });
  let produced = produceC1KeywordPlanningEvidence({
    candidate, expectedRevision: candidate.dataRevision, serverEvidence: evidence, producedAt: KEYWORD_NOW
  });
  if (produced.status !== "ready") throw new Error(`SETTLEMENT_FIXTURE_PLANNING_NOT_READY:${JSON.stringify(produced.production.gaps)}`);
  const preview = structuredClone(candidate);
  preview.dataRevision = produced.evidence.binding.candidateRevision;
  preview.lifecycleV11.skuPackage = structuredClone(produced.skuPackage);
  preview.lifecycleV11.c1KeywordPlanningEvidenceV1 = structuredClone(produced.evidence);
  const execution = prepareC1KeywordSoftwareExecution({ candidate: preview, clientInput: { dataRevision: preview.dataRevision }, plannedAt: KEYWORD_NOW });
  evidence.keywordMetricEvidence = await collectFixtureMetrics({ candidateId, skuPackage: preview.lifecycleV11.skuPackage, input: execution.jobRuntimeInput });
  produced = produceC1KeywordPlanningEvidence({ candidate, expectedRevision: candidate.dataRevision, serverEvidence: evidence, producedAt: KEYWORD_NOW });
  if (produced.status !== "ready") throw new Error(`SETTLEMENT_FIXTURE_METRIC_PLANNING_NOT_READY:${JSON.stringify(produced.production.gaps)}`);
  preview.lifecycleV11.c1KeywordPlanningEvidenceV1 = structuredClone(produced.evidence);
  return preview;
}

function fixtureMetrics(preparation) {
  return {
    version: "keyword-metrics-v1",
    preparationFingerprint: preparation.preparationFingerprint,
    candidates: preparation.rawCandidatePool.map((candidate, index) => {
      const components = Object.fromEntries(Object.keys(KEYWORD_SCORING_COMPONENTS).map((name) => {
        const value = name === "semanticMatch" ? (index < 9 ? 90 : 75) : 82;
        return [name, {
          value, rawValue: value, raw: null, normalizationRule: "identity_0_100", conversionRule: null,
          evidenceRef: `metric:${name}:${index}`, observedAt: KEYWORD_NOW, period: "30d"
        }];
      }));
      components.competitorConsensus = null;
      components.competitorCount = null;
      components.returnCancelHealth = null;
      return {
        key: `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`,
        descriptionGate: { approved: true, evidenceRef: `description-gate:${index}`, reason: "冻结事实支持" },
        components
      };
    })
  };
}

export function c1PaidKeywordFixtureReceipt() {
  return {
    attempt: {
      schemaVersion: "keyword-source-attempt-v1", attemptId: "attempt:api:music-box",
      provider: "seerfar-open-api", channel: "api", queryId: "query:music-box", queryText: "MUSIC-WHITE",
      locale: "ru-RU", targetPlatform: "ozon", requestId: "request:music-box", receiptId: "receipt:music-box",
      startedAt: KEYWORD_NOW, completedAt: KEYWORD_NOW, status: "completed", resultCount: 0,
      failureClass: "true_empty", failureStage: null, traceRef: "trace:music-box"
    }, candidates: [], pointsBefore: 80, pointsAfter: 65, pointsSpent: 15, providerEvidence: null
  };
}

/** Uses the production pipeline; all metric/provider observations are explicit in-memory fixtures. */
async function collectFixtureMetrics({ candidateId, skuPackage, input }) {
  const value = structuredClone(input);
  if (value.providerEvidence.seerfarApiReceipt === null) value.providerEvidence.seerfarApiReceipt = c1PaidKeywordFixtureReceipt();
  let metrics;
  await prepareC1FactKeywordPipeline({
    candidateId, candidateRevision: value.dataRevision, skuPackage,
    keywordSourceEvidence: value.keywordSourceEvidence, frozenSeoRules: value.frozenSeoRules,
    frozenComplexityDecision: value.frozenComplexityDecision, reusableKeywordSnapshot: value.reusableKeywordSnapshot,
    preparedAt: KEYWORD_NOW, keywordExpiresAt: value.keywordExpiresAt
  }, {
    seerfarApi: async () => structuredClone(value.providerEvidence.seerfarApiReceipt),
    keywordMetrics: async ({ preparation }) => {
      metrics = fixtureMetrics(preparation);
      return metrics;
    }
  });
  if (!metrics) throw new Error("SETTLEMENT_FIXTURE_METRICS_NOT_CREATED");
  return metrics;
}

export async function prepareC1PaidKeywordSettlementFixture({ candidateId, skuPackage, input }) {
  const value = structuredClone(input);
  if (value.providerEvidence.seerfarApiReceipt === null) value.providerEvidence.seerfarApiReceipt = c1PaidKeywordFixtureReceipt();
  const prepared = await prepareC1FactKeywordRuntime({ candidateId, skuPackage, input: value, preparedAt: KEYWORD_NOW });
  if (prepared.result.status !== "ready_for_atomic_persist") throw new Error("SETTLEMENT_FIXTURE_RUNTIME_NOT_READY");
  const { receiptFingerprint, ...receipt } = prepared.receipt;
  if (receiptFingerprint !== fingerprintCanonicalRecord(receipt)) throw new Error("SETTLEMENT_FIXTURE_RECEIPT_INVALID");
  return prepared;
}
