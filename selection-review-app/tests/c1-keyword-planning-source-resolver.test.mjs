import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveC1KeywordPlanningSourceEvidence } from "../lib/c1-keyword-planning-source-resolver.mjs";
import { KEYWORD_NOW, keywordPlanningCandidate, keywordPlanningSourceRecord } from "./fixtures/c1-keyword-planning-fixture.mjs";

function candidateWithSource(overrides = {}) {
  const candidate = keywordPlanningCandidate();
  candidate.lifecycleV11.c1KeywordPlanningSourceRecordV1 = keywordPlanningSourceRecord(candidate, overrides);
  return candidate;
}

test("只从当前候选已保存的正式来源记录解析，零外部副作用", () => {
  const candidate = candidateWithSource();
  const result = resolveC1KeywordPlanningSourceEvidence({ candidate, expectedRevision: 31, resolvedAt: KEYWORD_NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.sourceEvidence.schemaVersion, "c1-keyword-planning-source-evidence-v1");
  assert.match(result.sourceRecordFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.values(result.sideEffects), [0, 0, 0, 0, 0]);
});

test("缺失、过期和跨revision/SKU来源记录明确停止，不猜测或写入", () => {
  const missing = keywordPlanningCandidate();
  assert.equal(resolveC1KeywordPlanningSourceEvidence({ candidate: missing, expectedRevision: 31, resolvedAt: KEYWORD_NOW }).gaps[0].code, "planning_source_record_missing");

  const expired = candidateWithSource();
  expired.lifecycleV11.c1KeywordPlanningSourceRecordV1.sourceEvidence.expiresAt = "2026-08-24T00:00:00.000Z";
  assert.equal(resolveC1KeywordPlanningSourceEvidence({ candidate: expired, expectedRevision: 31, resolvedAt: KEYWORD_NOW }).gaps[0].code, "planning_source_evidence_expired");
  const boundary = candidateWithSource();
  boundary.lifecycleV11.c1KeywordPlanningSourceRecordV1.sourceEvidence.expiresAt = KEYWORD_NOW;
  assert.equal(resolveC1KeywordPlanningSourceEvidence({ candidate: boundary, expectedRevision: 31, resolvedAt: KEYWORD_NOW }).gaps[0].code, "planning_source_evidence_expired");

  for (const overrides of [{ candidateRevision: 30 }, { skuPackageId: "sku:other" }]) {
    const drift = candidateWithSource(overrides);
    assert.equal(resolveC1KeywordPlanningSourceEvidence({ candidate: drift, expectedRevision: 31, resolvedAt: KEYWORD_NOW }).gaps[0].code, "planning_source_binding_drift");
  }
});

test("来源记录秘密字段和未知字段均拒绝", () => {
  const secret = candidateWithSource({ accessToken: "secret" });
  assert.throws(() => resolveC1KeywordPlanningSourceEvidence({ candidate: secret, expectedRevision: 31, resolvedAt: KEYWORD_NOW }), /不得保存秘密字段/);
  const unknown = candidateWithSource({ unexpected: true });
  assert.equal(resolveC1KeywordPlanningSourceEvidence({ candidate: unknown, expectedRevision: 31, resolvedAt: KEYWORD_NOW }).gaps[0].code, "planning_source_binding_drift");
});

test("来源记录Schema严格且绑定当前候选与SKU", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-source-record-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, "c1-keyword-planning-source-record-v1");
  assert.ok(schema.required.includes("candidateRevision"));
  assert.equal(schema.properties.sourceEvidence.$ref, "c1-keyword-planning-source-evidence-v1.schema.json");
  const sourceSchema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-source-evidence-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(sourceSchema.additionalProperties, false);
  assert.equal(sourceSchema.$defs.SourceTerm.additionalProperties, false);
  assert.equal(sourceSchema.$defs.SourceComparable.additionalProperties, false);
  assert.equal(sourceSchema.$defs.FactBinding.additionalProperties, false);
  assert.deepEqual(sourceSchema.$defs.FactBinding.required, ["factPath", "factValueFingerprint", "sourceRef", "bindingRelation", "semanticProofRef"]);
  assert.equal(sourceSchema.properties.reusableKeywordSnapshot.oneOf[1].$ref, "keyword-evidence-snapshot-v1.schema.json");
});
