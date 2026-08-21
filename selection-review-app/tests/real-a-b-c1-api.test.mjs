import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 37000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const TEST_CATEGORY = "ozon:17028743:971097529";

function evidencePacks() {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return [{
    id: "fees:ozon:dandanshu:music-box:api-test",
    kind: "commission",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", category: TEST_CATEGORY, salesScheme: "rfbs" },
    checkedAt,
    expiresAt,
    evidenceData: {
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
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    }
  }, {
    id: "logistics:guoo:music-box:api-test",
    kind: "logistics_tariff",
    status: "active",
    scope: { route: "GUOO Economy Small", ruleVersion: "guoo-2026-07-20" },
    checkedAt,
    expiresAt,
    evidenceData: {
      chargeableWeightRule: "max_actual_volume",
      perKgRmb: 20,
      perParcelRmb: 10,
      volumeDivisorCm3PerKg: 6000,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  }, {
    id: "fx:official:api-test:RUB-CNY",
    kind: "exchange_rate",
    status: "active",
    scope: { pair: "RUB/CNY" },
    checkedAt,
    expiresAt,
    evidenceData: {
      rubPerCny: 12
    }
  }, {
    id: "schema:ozon:dandanshu:music-box:api-test",
    kind: "schema",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", category: TEST_CATEGORY, ruleVersion: "ozon-current" },
    checkedAt,
    expiresAt,
    evidenceData: {
      schemaRevision: "api-test",
      requiredFields: [],
      descriptionCategoryId: 17028743,
      typeId: 971097529
    }
  }].map((pack) => ({
    ...pack,
    sourceType: "isolated_test",
    sourceRef: `fixture:${pack.id}`
  }));
}

function payload(candidate) {
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

function markSupplierCaptureReady(candidate) {
  candidate.sourceUrl = "https://detail.1688.com/offer/876240928352.html";
  candidate.sourceCapture = {
    captureId: "SCJ-api-test-ready",
    jobId: "SCJ-api-test-ready",
    status: "captured_waiting_owner_selection",
    jobStatus: "completed",
    mode: "a_supplier_capture",
    attempt: 1,
    originalSourceUrl: "https://qr.1688.com/s/7OnLCakq",
    sourceUrl: candidate.sourceUrl,
    offerId: "876240928352",
    skuChoices: [],
    selectedSkuIds: [],
    ownerSupplyConfirmed: false,
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  return candidate;
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test("真实A确认API在隔离数据中原子保存B结果和唯一C1交接", async (t) => {
  const source = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  const candidate = markSupplierCaptureReady(structuredClone(source.candidates.find((item) => item.id === "CX-20260802-014")));
  delete candidate.lifecycleV11;
  candidate.workflowStatus = "codex_processing";
  candidate.listingHandoff = null;
  candidate.lifecycleEvidenceContextV11 = {
    ...candidate.lifecycleEvidenceContextV11,
    category: TEST_CATEGORY
  };
  candidate.processing = { state: "idle", manualHold: false };
  const fixture = {
    ...source,
    meta: { ...source.meta, automationStarted: false },
    candidates: [candidate],
    evidencePacks: evidencePacks(),
    dispatches: [],
    workflowComments: []
  };
  const directory = await mkdtemp(path.join(tmpdir(), "real-a-b-c1-api-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify(fixture, null, 2));
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  const untraceableCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "缺来源的结构化证据不得进入正式证据库",
    sourceType: "isolated_test",
    checkedAt: "2026-08-18T02:20:00.000Z",
    expiresAt: "2026-08-19T02:20:00.000Z",
    evidenceData: evidencePacks()[0].evidenceData
  });
  assert.equal(untraceableCommission.response.status, 422);
  assert.match(untraceableCommission.body.message, /可追溯来源/);

  const noExpiryCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "缺有效期的结构化证据不得进入正式证据库",
    sourceType: "isolated_test",
    sourceRef: "fixture:no-expiry",
    checkedAt: "2026-08-18T02:25:00.000Z",
    evidenceData: evidencePacks()[0].evidenceData
  });
  assert.equal(noExpiryCommission.response.status, 422);
  assert.match(noExpiryCommission.body.message, /失效时间/);

  const refreshedCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "隔离测试中的当前店铺类目佣金",
    sourceType: "isolated_test",
    sourceRef: "fixture:refreshed-commission",
    checkedAt: new Date(Date.now() - 30_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    evidenceData: {
      commissionRate: 0.15,
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
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    }
  });
  assert.equal(refreshedCommission.response.status, 201);
  const refreshedCommissionId = refreshedCommission.body.evidencePack.id;

  const injected = payload(candidate);
  injected.systemEvidence = {
    platformFeeEvidence: { evidenceId: "browser-fake", commissionRate: 0 },
    logisticsEvidence: { evidenceId: "browser-fake", amountRmb: 0 },
    exchangeRateEvidence: { evidenceId: "browser-fake", rubPerCny: 999 }
  };
  const first = await post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`, injected);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.candidate.workflowStatus, "listing_preparation");
  assert.equal(first.body.candidate.lifecycleV11.skuPackage.businessPhase, "C1");
  assert.equal(first.body.candidate.lifecycleV11.skuPackage.businessResult, "pending");
  assert.equal(first.body.candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
  assert.equal(first.body.candidate.lifecycleV11.c1Handoffs.length, 1);
  assert.equal(first.body.candidate.lifecycleV11.c1Handoffs[0].uniqueOwner, "listing_task");
  assert.equal(first.body.candidate.lifecycleV11.c1Handoffs[0].realTaskDispatched, false);
  assert.equal(first.body.candidate.listingHandoff.owner, "listing_task");
  assert.equal(first.body.candidate.listingHandoff.userAction, "无需再次点击开始上架准备");
  assert.equal(first.body.candidate.lifecycleV11.bSystemEvidenceBundle.browserSupplied, false);
  assert.equal(first.body.candidate.lifecycleV11.bSystemEvidenceBundle.sourcePackIds[0], refreshedCommissionId);
  assert.deepEqual(first.body.candidate.lifecycleV11.bSystemEvidenceBundle.sourcePackIds.slice(1), evidencePacks().slice(1).map((item) => item.id));
  assert.equal(first.body.candidate.lifecycleV11.skuPackage.profitModels[0].commissionRate, 0.15);
  assert.equal(
    first.body.candidate.lifecycleV11.opportunityPackage.salesSnapshots[0].platformCategoryEvidence.categoryToken,
    "ozon:17028743:971097529"
  );
  assert.equal(first.body.candidate.lifecycleEvidenceContextV11.category, "ozon:17028743:971097529");
  assert.equal(first.body.candidate.lifecycleV11.skuPackage.profitModels[0].internationalFreight.amount, 18);

  const repeated = await post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`, payload(candidate));
  assert.equal(repeated.response.status, 409);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  const saved = persisted.candidates[0];
  assert.equal(saved.lifecycleV11.c1Handoffs.length, 1);
  assert.equal(saved.lifecycleV11.skuPackage.profitModels.length, 1);
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(persisted.meta.automationStarted, false);
});

test("真实A确认API缺系统证据时不修改隔离候选", async (t) => {
  const source = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  const candidate = markSupplierCaptureReady(structuredClone(source.candidates.find((item) => item.id === "CX-20260802-014")));
  delete candidate.lifecycleV11;
  candidate.workflowStatus = "codex_processing";
  candidate.listingHandoff = null;
  candidate.lifecycleEvidenceContextV11 = {
    ...candidate.lifecycleEvidenceContextV11,
    category: TEST_CATEGORY
  };
  candidate.processing = { state: "idle", manualHold: false };
  const fixture = {
    ...source,
    meta: { ...source.meta, automationStarted: false },
    candidates: [candidate],
    evidencePacks: evidencePacks().slice(0, 1),
    dispatches: [],
    workflowComments: []
  };
  const directory = await mkdtemp(path.join(tmpdir(), "real-a-b-c1-gap-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify(fixture, null, 2));
  const before = await readFile(dataFile, "utf8");
  const localPort = port + 1;
  const localBaseUrl = `http://127.0.0.1:${localPort}`;
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(localPort),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: "http://127.0.0.1:1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  t.after(() => child.kill("SIGTERM"));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${localBaseUrl}/api/health`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = await fetch(`${localBaseUrl}/api/candidates/${candidate.id}/lifecycle/a-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(candidate))
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /B系统证据准备已停止/);
  assert.equal(await readFile(dataFile, "utf8"), before);
});
