import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createC1SoftwareEvidenceStage } from "../lib/c1-software-evidence-stage.mjs";

const NOW = "2026-08-23T15:00:00.000Z";
const CANDIDATE_ID = "NON-TRAIN-MUSIC-BOX";
const CANDIDATE_REVISION = 12;
const SKU_REVISION = 4;
const SKU_PACKAGE_ID = "sku-lifecycle:NON-TRAIN-MUSIC-BOX:SEWING-MACHINE";
const SUPPLIER_SKU_ID = "SEWING-MACHINE";
const SNAPSHOT_ID = "keyword-evidence:NON-TRAIN-MUSIC-BOX:12:abc";
const SNAPSHOT_FP = "a".repeat(64);
const PREPARATION_FP = "b".repeat(64);
const METRIC_FP = "c".repeat(64);
const SCORING_FP = "d".repeat(64);

function seoRules() {
  return {
    rulesVersion: "seo-rules-ru-v1",
    locale: "ru-RU",
    titleMaxLength: 120,
    descriptionMaxLength: 1800,
    bulletPointLimit: 5,
    prohibitedClaims: ["unverified_brand", "unverified_material", "unverified_dimensions", "unverified_certification"],
    evidenceRef: "project-rule:seo-rules-ru-v1",
    frozenAt: NOW
  };
}

function skuPackage() {
  return {
    businessPhase: "C1",
    dataRevision: SKU_REVISION,
    c1ProductPlan: {
      c1PlanId: "c1:NON-TRAIN-MUSIC-BOX:1",
      status: "facts_checked",
      identity: {
        parentOpportunityId: "opportunity:NON-TRAIN-MUSIC-BOX",
        skuPackageId: SKU_PACKAGE_ID,
        supplierSkuId: SUPPLIER_SKU_ID,
        targetPlatform: "ozon",
        targetStore: "dandanshu"
      }
    }
  };
}

function binding() {
  return {
    candidateId: CANDIDATE_ID,
    dataRevision: SKU_REVISION,
    parentOpportunityId: "opportunity:NON-TRAIN-MUSIC-BOX",
    skuPackageId: SKU_PACKAGE_ID,
    supplierSkuId: SUPPLIER_SKU_ID,
    preparationFingerprint: PREPARATION_FP,
    metricEvidenceFingerprint: METRIC_FP,
    scoringPayloadFingerprint: SCORING_FP
  };
}

function snapshot() {
  return {
    schemaVersion: "keyword-evidence-snapshot-v1",
    snapshotId: SNAPSHOT_ID,
    snapshotFingerprint: SNAPSHOT_FP,
    status: "ready",
    validity: { collectedAt: NOW, expiresAt: "2026-08-24T15:00:00.000Z" }
  };
}

function preparedInputs() {
  const rules = seoRules();
  return {
    schemaVersion: "c1-software-input-preparation-v1",
    status: "ready",
    preparedAt: NOW,
    identity: {
      c1PlanId: "c1:NON-TRAIN-MUSIC-BOX:1",
      skuPackageId: SKU_PACKAGE_ID,
      supplierSkuId: SUPPLIER_SKU_ID,
      targetPlatform: "ozon",
      targetStore: "dandanshu"
    },
    sourceFingerprints: { c1Facts: "e".repeat(64), salesSnapshot: "f".repeat(64) },
    gaps: [],
    inputs: {
      competitorTextSnapshot: { snapshotId: "competitor-text:music-box" },
      seoRules: rules,
      taskClassification: { complexity: "standard" },
      keywordEvidence: {
        evidenceId: "c1-k3-keywords:music-box",
        sourceBindings: {
          sourceSnapshotId: SNAPSHOT_ID,
          sourceSnapshotFingerprint: SNAPSHOT_FP,
          sourcePreparationFingerprint: PREPARATION_FP,
          sourceMetricEvidenceFingerprint: METRIC_FP,
          sourceScoringPayloadFingerprint: SCORING_FP
        }
      }
    },
    executionEvidence: { externalAccesses: [], seerfarCalls: 0, gatewayCalls: 0, codexDispatches: 0, platformWrites: 0 },
    downstream: { c2Started: false, productionStarted: false, eReadbackStarted: false }
  };
}

function create(overrides = {}) {
  return createC1SoftwareEvidenceStage({
    candidateId: CANDIDATE_ID,
    candidateRevision: CANDIDATE_REVISION,
    skuPackage: skuPackage(),
    preparedInputs: preparedInputs(),
    k3KeywordEvidenceSnapshot: snapshot(),
    k3CurrentBinding: binding(),
    frozenSeoRules: seoRules(),
    stagedAt: NOW,
    ...overrides
  });
}

test("当前非火车SKU的K3和SEO证据可冻结为零副作用C1软件证据包", async () => {
  const result = create();
  assert.equal(result.status, "created");
  assert.equal(result.sharedWriteRequired, true);
  assert.equal(result.evidence.candidateId, CANDIDATE_ID);
  assert.equal(result.evidence.skuPackageId, SKU_PACKAGE_ID);
  assert.equal(result.evidence.executionPolicy.attemptLimit, 1);
  assert.equal(result.evidence.executionPolicy.automaticRetry, false);
  assert.equal(result.evidence.executionPolicy.codexDispatches, 0);
  assert.equal(result.evidence.executionPolicy.platformAccesses, 0);
  assert.equal(result.evidence.executionPolicy.platformWrites, 0);
  assert.equal(result.evidence.downstream.aiStarted, false);
  assert.match(result.evidence.evidenceFingerprint, /^[a-f0-9]{64}$/);

  const schema = JSON.parse(await readFile(new URL("../schema/c1-software-evidence-stage-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "c1-software-evidence-stage-v1");
  assert.equal(schema.properties.executionPolicy.properties.attemptLimit.const, 1);
});

test("完全相同的证据包幂等复用，不要求第二次共享写入", () => {
  const first = create();
  const replay = create({ existingEvidence: first.evidence });
  assert.equal(replay.status, "reused");
  assert.equal(replay.sharedWriteRequired, false);
  assert.equal(replay.evidence.evidenceFingerprint, first.evidence.evidenceFingerprint);
});

test("跨候选、跨SKU、revision漂移和旧K3快照全部停止", () => {
  assert.throws(() => create({ k3CurrentBinding: { ...binding(), candidateId: "OTHER" } }), /K3_BINDING_DRIFT/);
  assert.throws(() => create({ k3CurrentBinding: { ...binding(), supplierSkuId: "OTHER-SKU" } }), /K3_BINDING_DRIFT/);
  assert.throws(() => create({ skuPackage: { ...skuPackage(), dataRevision: SKU_REVISION + 1 } }), /GATE_REJECTED/);
  assert.throws(() => create({
    k3KeywordEvidenceSnapshot: { ...snapshot(), validity: { ...snapshot().validity, expiresAt: NOW } }
  }), /K3_NOT_READY/);
});

test("SEO规则、K3输出指纹或已存在证据发生变化时禁止静默覆盖", () => {
  assert.throws(() => create({ frozenSeoRules: { ...seoRules(), titleMaxLength: 90 } }), /SEO_RULES_DRIFT/);
  const broken = preparedInputs();
  broken.inputs.keywordEvidence.sourceBindings.sourceSnapshotFingerprint = "9".repeat(64);
  assert.throws(() => create({ preparedInputs: broken }), /K3_OUTPUT_DRIFT/);
  const first = create();
  assert.throws(() => create({ existingEvidence: { ...first.evidence, evidenceFingerprint: "0".repeat(64) } }), /DUPLICATE_DRIFT/);
});
