import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  C1_KEYWORD_PLANNING_PRODUCTION_VERSION,
  produceC1KeywordPlanningEvidence
} from "../lib/c1-keyword-planning-evidence-producer.mjs";
import {
  KEYWORD_NOW,
  keywordFactBinding,
  keywordPlanningCandidate,
  keywordPlanningSourceEvidence
} from "./fixtures/c1-keyword-planning-fixture.mjs";

test("服务端正式来源证据生成绑定下一revision的关键词准备证据且零外部副作用", () => {
  const candidate = keywordPlanningCandidate();
  const source = keywordPlanningSourceEvidence();
  const candidateBefore = structuredClone(candidate);
  const sourceBefore = structuredClone(source);
  const result = produceC1KeywordPlanningEvidence({ candidate, expectedRevision: 31, serverEvidence: source, producedAt: KEYWORD_NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.evidence.binding.sourceCandidateRevision, 31);
  assert.equal(result.evidence.binding.candidateRevision, 32);
  assert.equal(result.evidence.binding.resultCandidateRevision, 32);
  assert.equal(result.evidence.binding.sourceSkuRevision, 9);
  assert.equal(result.evidence.binding.resultSkuRevision, 9);
  assert.equal(result.evidence.binding.skuPackageId, candidate.lifecycleV11.skuPackage.skuPackageId);
  assert.equal(result.evidence.binding.exactSupplierSkuId, "MUSIC-WHITE");
  assert.equal(result.production.schemaVersion, C1_KEYWORD_PLANNING_PRODUCTION_VERSION);
  assert.deepEqual(Object.values(result.production.execution).slice(1, 6), [0, 0, 0, 0, 0]);
  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(source, sourceBefore);
  assert.equal(result.evidence.productFactTerms.some(({ term }) => term.includes("282") || term.includes("Паровоз")), false);
  assert.notEqual(result.evidence.binding.skuPackageId, "sku-lifecycle:CX-20260803-010:4993364145574");
});

test("有效复用快照走reuse_ready验证分支，不被错误拒绝", () => {
  const candidate = keywordPlanningCandidate();
  const source = keywordPlanningSourceEvidence();
  source.reusableKeywordSnapshot = {
    schemaVersion: "keyword-evidence-snapshot-v1",
    snapshotId: "keyword-snapshot:music-box:31",
    snapshotFingerprint: "a".repeat(64),
    status: "ready",
    identity: {}, bindings: {}, validity: {}, sourceAttempts: [], groups: {}, scoringContext: {}, businessEffect: {}
  };
  source.reuseEvidenceNote = "当前SKU绑定快照仍有效";
  const result = produceC1KeywordPlanningEvidence(
    { candidate, expectedRevision: 31, serverEvidence: source, producedAt: KEYWORD_NOW },
    { buildPlan: () => ({ status: "reuse_ready", gaps: [] }) }
  );
  assert.equal(result.status, "ready");
  assert.equal(result.evidence.reuseEvidenceNote, "当前SKU绑定快照仍有效");
});

test("关键词和竞品证据必须绑定当前C1确认事实", () => {
  const source = keywordPlanningSourceEvidence();
  source.productFactTerms[0].factRefs = ["evidence:other-product"];
  const result = produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: source, producedAt: KEYWORD_NOW
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.production.gaps[0].code, "keyword_fact_binding_missing");

  for (const unrelatedRef of ["profit-v31", "sales:music-box:31", "evidence:sales:music-box:31"]) {
    const unproven = keywordPlanningSourceEvidence();
    unproven.productFactTerms[0].term = "несуществующий bluetooth";
    unproven.productFactTerms[0].factRefs = [unrelatedRef];
    unproven.comparables.forEach((item) => { item.factRefs = [unrelatedRef]; });
    const rejected = produceC1KeywordPlanningEvidence({
      candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: unproven, producedAt: KEYWORD_NOW
    });
    assert.equal(rejected.status, "not_ready");
    assert.equal(rejected.production.gaps[0].code, "keyword_fact_binding_missing");
  }

  const snapshotOnly = keywordPlanningSourceEvidence();
  snapshotOnly.productFactTerms[0].term = "несуществующий bluetooth";
  delete snapshotOnly.productFactTerms[0].factBindings;
  const snapshotOnlyRejected = produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: snapshotOnly, producedAt: KEYWORD_NOW
  });
  assert.equal(snapshotOnlyRejected.production.gaps[0].code, "product_fact_terms_missing");

  const falseSemanticBinding = keywordPlanningSourceEvidence();
  falseSemanticBinding.productFactTerms[0].term = "несуществующий bluetooth";
  const falseSemanticRejected = produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: falseSemanticBinding, producedAt: KEYWORD_NOW
  });
  assert.equal(falseSemanticRejected.status, "not_ready");
  assert.equal(falseSemanticRejected.production.gaps[0].code, "keyword_fact_binding_missing");

  const selfDeclaredTranslation = keywordPlanningSourceEvidence();
  selfDeclaredTranslation.productFactTerms[0] = {
    ...selfDeclaredTranslation.productFactTerms[0],
    term: "музыкальная шкатулка",
    factBindings: [keywordFactBinding("productAttributes.productType", "music box", undefined, {
      bindingRelation: "approved_translation",
      semanticProofRef: "self-declared-receipt"
    })]
  };
  const selfDeclaredTranslationRejected = produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: selfDeclaredTranslation, producedAt: KEYWORD_NOW
  });
  assert.equal(selfDeclaredTranslationRejected.status, "not_ready");
  assert.equal(selfDeclaredTranslationRejected.production.gaps[0].code, "keyword_fact_binding_missing");

  const exactField = keywordPlanningSourceEvidence();
  exactField.productFactTerms[0] = {
    ...exactField.productFactTerms[0],
    term: "wood",
    factBindings: [keywordFactBinding("productAttributes.material", "wood")]
  };
  assert.equal(produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: exactField, producedAt: KEYWORD_NOW
  }).status, "ready");

  const crossField = keywordPlanningSourceEvidence();
  crossField.productFactTerms[0].factBindings = [keywordFactBinding("batteryAssessment.assessment", "music box")];
  const crossFieldRejected = produceC1KeywordPlanningEvidence({
    candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: crossField, producedAt: KEYWORD_NOW
  });
  assert.equal(crossFieldRejected.production.gaps[0].code, "keyword_fact_binding_missing");
});

test("缺失来源证据只生成精确not_ready收据，不保存半套Evidence", () => {
  const cases = [
    [keywordPlanningSourceEvidence({ productFactTerms: [] }), "product_fact_terms_missing"],
    [keywordPlanningSourceEvidence({ comparables: [] }), "valid_competitor_count_invalid"],
    [keywordPlanningSourceEvidence({ healthPolicy: { standardSkus: [] } }), "standard_sku_health_missing"],
    [keywordPlanningSourceEvidence({ reusableKeywordSnapshot: null, quotaEvidence: null }), "paid_lookup_gate_missing"]
  ];
  for (const [serverEvidence, code] of cases) {
    const result = produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence, producedAt: KEYWORD_NOW });
    assert.equal(result.status, "not_ready");
    assert.equal(result.evidence, null);
    assert.equal(result.production.gaps[0].code, code);
  }
});

test("种子词和竞品词的空值或非字符串不能绕过原值语义门禁", () => {
  for (const invalidTerm of [null, 42, {}, "   "]) {
    const seedSource = keywordPlanningSourceEvidence();
    seedSource.seedEvidence = [{
      ...seedSource.productFactTerms[0],
      term: invalidTerm,
      matchType: "multi_seed"
    }];
    const seedResult = produceC1KeywordPlanningEvidence({
      candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: seedSource, producedAt: KEYWORD_NOW
    });
    assert.equal(seedResult.status, "not_ready");
    assert.equal(seedResult.production.gaps[0].code, "keyword_term_evidence_invalid");

    const comparableSource = keywordPlanningSourceEvidence();
    comparableSource.comparables[0].terms = [{
      ...comparableSource.productFactTerms[0],
      term: invalidTerm,
      matchType: "exact_match"
    }];
    const comparableResult = produceC1KeywordPlanningEvidence({
      candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: comparableSource, producedAt: KEYWORD_NOW
    });
    assert.equal(comparableResult.status, "not_ready");
    assert.equal(comparableResult.production.gaps[0].code, "keyword_term_evidence_invalid");
  }
});

test("标准SKU、竞品身份、revision和秘密字段均严格拒绝", () => {
  const duplicateHealth = keywordPlanningSourceEvidence();
  duplicateHealth.healthPolicy.standardSkus[2].id = duplicateHealth.healthPolicy.standardSkus[0].id;
  assert.equal(produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: duplicateHealth, producedAt: KEYWORD_NOW }).production.gaps[0].code, "standard_sku_health_invalid");

  const duplicateCompetitor = keywordPlanningSourceEvidence();
  duplicateCompetitor.comparables[3].seerfarSku = duplicateCompetitor.comparables[0].seerfarSku;
  assert.equal(produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: duplicateCompetitor, producedAt: KEYWORD_NOW }).production.gaps[0].code, "competitor_identity_invalid");

  const duplicateRef = keywordPlanningSourceEvidence();
  duplicateRef.comparables[3].competitorRef = duplicateRef.comparables[0].competitorRef;
  assert.equal(produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: duplicateRef, producedAt: KEYWORD_NOW }).production.gaps[0].code, "competitor_identity_invalid");

  assert.throws(() => produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 30, serverEvidence: keywordPlanningSourceEvidence(), producedAt: KEYWORD_NOW }), /REVISION_CONFLICT/);
  assert.throws(() => produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: keywordPlanningSourceEvidence({ apiKey: "forbidden" }), producedAt: KEYWORD_NOW }), /SECRET_FORBIDDEN/);
  const camelSecret = keywordPlanningSourceEvidence();
  camelSecret.healthPolicy.standardSkus[0].clientSecret = "forbidden";
  assert.throws(() => produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: camelSecret, producedAt: KEYWORD_NOW }), /SECRET_FORBIDDEN/);
  const secretUrl = keywordPlanningSourceEvidence();
  secretUrl.frozenSeoRules.evidenceRef = "https://example.test/evidence?token=forbidden";
  assert.throws(() => produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: secretUrl, producedAt: KEYWORD_NOW }), /SECRET_FORBIDDEN/);
  const unknownNested = keywordPlanningSourceEvidence();
  unknownNested.frozenSeoRules.unreviewedRule = true;
  assert.throws(() => produceC1KeywordPlanningEvidence({ candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: unknownNested, producedAt: KEYWORD_NOW }), /SOURCE_FIELD_FORBIDDEN/);
});

test("inputs_ready先完成确定性事实核验并准确区分来源与结果SKU revision", () => {
  const candidate = keywordPlanningCandidate();
  const verifiedSku = structuredClone(candidate.lifecycleV11.skuPackage);
  verifiedSku.dataRevision = 10;
  candidate.lifecycleV11.skuPackage.c1ProductPlan = { status: "inputs_ready" };
  const result = produceC1KeywordPlanningEvidence(
    { candidate, expectedRevision: 31, serverEvidence: keywordPlanningSourceEvidence(), producedAt: KEYWORD_NOW },
    {
      verifyFacts: () => ({ skuPackage: verifiedSku }),
      buildPlan: ({ candidate: staged }) => ({ status: "ready", gaps: [], candidateId: staged.id })
    }
  );
  assert.equal(result.status, "ready");
  assert.equal(result.production.factsVerifiedFromFrozenInputs, true);
  assert.equal(result.production.sourceSkuRevision, 9);
  assert.equal(result.production.resultSkuRevision, 10);
  assert.equal(result.evidence.binding.sourceSkuRevision, 9);
  assert.equal(result.evidence.binding.resultSkuRevision, 10);
});

test("同输入产生相同证据与生产指纹，Schema锁定白名单和零副作用", async () => {
  const input = { candidate: keywordPlanningCandidate(), expectedRevision: 31, serverEvidence: keywordPlanningSourceEvidence(), producedAt: KEYWORD_NOW };
  const first = produceC1KeywordPlanningEvidence(input);
  const second = produceC1KeywordPlanningEvidence(input);
  assert.equal(first.production.inputFingerprint, second.production.inputFingerprint);
  assert.equal(first.production.evidenceFingerprint, second.production.evidenceFingerprint);
  const evidenceSchema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-evidence-v1.schema.json", import.meta.url), "utf8"));
  const productionSchema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-production-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(evidenceSchema.additionalProperties, false);
  assert.equal(evidenceSchema.$defs.HealthPolicy.additionalProperties, false);
  assert.equal(evidenceSchema.$defs.Comparable.additionalProperties, false);
  assert.equal(evidenceSchema.$defs.FactBinding.additionalProperties, false);
  assert.equal(evidenceSchema.$defs.MetricCandidate.additionalProperties, false);
  assert.equal(productionSchema.additionalProperties, false);
  assert.equal(productionSchema.allOf.length, 2);
  assert.equal(productionSchema.properties.execution.properties.codexDispatchesPerformed.const, 0);
  assert.equal(productionSchema.properties.execution.properties.externalCallsPerformed.const, 0);
});
