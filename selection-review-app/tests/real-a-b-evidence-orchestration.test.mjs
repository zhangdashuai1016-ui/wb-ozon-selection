import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRealAConfirmationWithSystemEvidence } from "../lib/real-a-b-evidence-orchestration.mjs";
import { GLOBAL_PRICING_POLICY_VERSION } from "../lib/global-pricing-policy.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const confirmedAt = "2026-08-18T09:00:00.000Z";

async function sourceCandidate() {
  const data = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  const candidate = structuredClone(data.candidates.find((item) => item.id === "CX-20260802-014"));
  delete candidate.lifecycleV11;
  candidate.workflowStatus = "codex_processing";
  candidate.listingHandoff = null;
  return candidate;
}

function confirmation(candidate) {
  return {
    dataRevision: candidate.dataRevision,
    decision: "confirm",
    salesReview: {
      snapshotId: candidate.salesSnapshotsV11[0].snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

function evidenceData(kind) {
  if (kind === "commission") return {
    commissionRate: 0.14,
    descriptionCategoryId: 17028743,
    typeId: 971097529,
    otherCosts: {
      packagingRmb: 1.5,
      labelRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingRate: 0,
      returnReserveRate: 0,
      damageReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: GLOBAL_PRICING_POLICY_VERSION
    }
  };
  if (kind === "logistics_tariff") return {
    chargeableWeightRule: "actual_weight",
    perKgRmb: 20,
    perParcelRmb: 10,
    minimumChargeableWeightKg: 0,
    weightRoundingRule: "none",
    weightRoundingKg: null
  };
  if (kind === "exchange_rate") return { rubPerCny: 12 };
  return {
    schemaRevision: "orchestration-test",
    requiredFields: [],
    descriptionCategoryId: 17028743,
    typeId: 971097529
  };
}

test("一次A确认会准备四类系统证据并直接完成B到唯一C1，不修改输入", async () => {
  const candidate = await sourceCandidate();
  const before = JSON.stringify(candidate);
  const calls = [];
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => {
      calls.push(kind);
      return {
        id: `orchestration:${kind}`,
        kind,
        status: "active",
        scope: request.scope,
        checkedAt: confirmedAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        sourceType: "isolated_test",
        sourceRef: `fixture:orchestration:${kind}`,
        evidenceData: evidenceData(kind)
      };
    }
  ]));
  const run = await runRealAConfirmationWithSystemEvidence({
    candidate,
    submission: confirmation(candidate),
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  assert.equal(run.status, "completed");
  assert.deepEqual(calls, ["commission", "logistics_tariff", "exchange_rate", "schema"]);
  assert.equal(run.evidencePacksToCommit.length, 4);
  assert.equal(run.result.profitModel.result, "passed");
  assert.equal(run.result.c1Handoff.uniqueOwner, "listing_task");
  const frozenSnapshot = run.result.opportunityPackage.salesSnapshots[0];
  assert.deepEqual(frozenSnapshot.platformCategoryEvidence, {
    status: "verified",
    descriptionCategoryId: 17028743,
    typeId: 971097529,
    categoryToken: "ozon:17028743:971097529",
    sourceProductId: "4403916892",
    sourceSnapshotId: candidate.salesSnapshotsV11[0].snapshotId,
    sourceEvidenceRefs: ["orchestration:commission", "orchestration:schema"],
    verifiedAt: confirmedAt
  });
  assert.equal(frozenSnapshot.attributes.description_category_id, 17028743);
  assert.equal(frozenSnapshot.attributes.type_id, 971097529);
  assert.equal(run.evidenceContext.category, "ozon:17028743:971097529");
  assert.equal(run.result.taskDispatches, 0);
  assert.equal(run.platformWrites, 0);
  assert.equal(JSON.stringify(candidate), before);
});

test("系统证据晚于主人确认时间取得时，按证据冻结时间进入B而不误报四类证据缺失", async () => {
  const candidate = await sourceCandidate();
  const evidenceCheckedAt = new Date(Date.parse(confirmedAt) + 1_000).toISOString();
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => ({
      id: `orchestration:delayed:${kind}`,
      kind,
      status: "active",
      scope: request.scope,
      checkedAt: evidenceCheckedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceType: "isolated_test",
      sourceRef: `fixture:orchestration:delayed:${kind}`,
      evidenceData: evidenceData(kind)
    })
  ]));
  const run = await runRealAConfirmationWithSystemEvidence({
    candidate,
    submission: confirmation(candidate),
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });

  assert.equal(run.status, "completed");
  assert.equal(run.result.systemEvidenceBundle.createdAt, run.evidencePreparation.finalReadiness.checkedAt);
  assert.ok(Date.parse(run.result.profitModel.calculatedAt) >= Date.parse(evidenceCheckedAt));
  assert.equal(run.result.profitModel.result, "passed");
  assert.equal(run.result.c1Handoff.uniqueOwner, "listing_task");
});

test("主人选择淘汰或提交无效时不会调用任何系统证据提供器", async () => {
  const candidate = await sourceCandidate();
  const providers = new Proxy({}, {
    get() {
      throw new Error("不应读取提供器");
    }
  });
  const rejected = await runRealAConfirmationWithSystemEvidence({
    candidate,
    submission: { dataRevision: candidate.dataRevision, decision: "reject" },
    evidencePacks: [],
    providers,
    confirmedAt
  });
  assert.equal(rejected.result.decision, "reject");
  assert.deepEqual(rejected.externalAccesses, []);
  await assert.rejects(
    runRealAConfirmationWithSystemEvidence({
      candidate,
      submission: { dataRevision: candidate.dataRevision, decision: "confirm" },
      evidencePacks: [],
      providers,
      confirmedAt
    }),
    /REAL_A_CONFIRMATION_INVALID/
  );
});

test("已落盘的同一A/B结果重放时不再调用证据提供器或创建第二个C1", async () => {
  const candidate = await sourceCandidate();
  const input = confirmation(candidate);
  const providers = Object.fromEntries(["commission", "logistics_tariff", "exchange_rate", "schema"].map((kind) => [
    kind,
    async (request) => ({
      id: `orchestration:replay:${kind}`,
      kind,
      status: "active",
      scope: request.scope,
      checkedAt: confirmedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceType: "isolated_test",
      sourceRef: `fixture:orchestration:replay:${kind}`,
      evidenceData: evidenceData(kind)
    })
  ]));
  const first = await runRealAConfirmationWithSystemEvidence({
    candidate,
    submission: input,
    evidencePacks: [],
    providers,
    confirmedAt,
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  const persisted = structuredClone(candidate);
  persisted.dataRevision += 1;
  persisted.lifecycleEvidenceContextV11 = structuredClone(first.evidenceContext);
  persisted.lifecycleV11 = {
    aConfirmationReceipt: {
      receiptId: first.result.confirmationReceiptId,
      sourceCandidateRevision: first.result.sourceCandidateRevision
    },
    opportunityPackage: structuredClone(first.result.opportunityPackage),
    ownerSupplyConfirmation: structuredClone(first.result.ownerSupplyConfirmation),
    bSystemEvidenceBundle: structuredClone(first.result.systemEvidenceBundle),
    skuPackage: structuredClone(first.result.skuPackage),
    c1Handoffs: [structuredClone(first.result.c1Handoff)]
  };
  let replayCalls = 0;
  const replayProviders = new Proxy({}, { get() { replayCalls += 1; throw new Error("重放不应读取提供器"); } });
  const replay = await runRealAConfirmationWithSystemEvidence({
    candidate: persisted,
    submission: input,
    evidencePacks: [],
    providers: replayProviders,
    confirmedAt,
    guooFilePath: "/tmp/unused.xlsx"
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.result.idempotentReplay, true);
  assert.equal(replayCalls, 0);
  assert.equal(replay.evidencePacksToCommit.length, 0);
  assert.equal(replay.result.skuPackage.dataRevision, first.result.skuPackage.dataRevision);
  assert.deepEqual(replay.result.c1Handoff, first.result.c1Handoff);
});
