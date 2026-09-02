import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 27000 + (process.pid % 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function candidate(id) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `测试音乐盒 ${id}`,
    productUrl: "https://www.ozon.ru/product/test-4403916892/",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    purchasePriceRmb: 17.3,
    packedWeightKg: 0.4,
    dimensionsCm: { length: 12, width: 12, height: 7 },
    workflowStatus: "codex_processing",
    dataRevision: 1,
    processing: { state: "idle", manualHold: true },
    lifecycleV11: {
      schemaVersion: "product-lifecycle-v1.1",
      status: "opportunity_sales_snapshot_captured",
      opportunityPackage: { schemaVersion: "product-lifecycle-v1.1", entityType: "OpportunityPackage" },
      platformWrites: 0
    },
    comments: [],
    history: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
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

function post(pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function aSubmission(dataRevision) {
  return {
    dataRevision,
    decision: "confirm",
    salesReview: {},
    supplierConfirmation: {
      productUrl: "https://qr.1688.com/s/7OnLCakq",
      ownerSupplyConfirmed: false
    }
  };
}

function heartbeat(version = "1.2.7") {
  return post("/api/extension/heartbeat", {
    version,
    backgroundReady: true,
    observedAt: new Date().toISOString()
  }, { Origin: extensionOrigin });
}

function evidence() {
  return {
    offerId: "876240928352",
    title: "复古缝纫机手摇音乐盒",
    offerStatus: "online",
    observedAt: new Date().toISOString(),
    titleSource: "offerBaseInfo.subject",
    offerIdSource: "offerBaseInfo.offerId",
    pageFields: {
      unitProductPriceCny: null,
      unitProductPriceSource: null,
      unitDomesticFreightCny: null,
      unitDomesticFreightSource: null
    },
    priceRanges: [],
    supplierAttributes: {},
    skus: [
      {
        sourceSkuId: "sewing-black",
        attributes: { 款式: "黑色缝纫机" },
        priceCny: 11.8,
        priceSource: "skuModel.skuInfoMap.price",
        stock: 120,
        stockSource: "skuModel.skuInfoMap.canBookCount"
      },
      {
        sourceSkuId: "sewing-ivory",
        attributes: { 款式: "象牙白缝纫机" },
        priceCny: null,
        priceSource: null,
        stock: null,
        stockSource: null
      }
    ]
  };
}

test("A确认动作建立唯一作业，心跳只领一次并原子回传真实SKU", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-job-"));
  const dataFile = path.join(directory, "candidates.json");
  const other = candidate("OTHER-1");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-19T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [candidate("A-JOB-1"), candidate("A-FAIL"), candidate("A-TIMEOUT"), other],
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  }));
  const originalOther = JSON.stringify(other);
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off",
      SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS: "2000",
      SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS: "500"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await waitForHealth(child, stderr);

  const beforeNoJob = await readFile(dataFile, "utf8");
  const idleHeartbeat = await heartbeat();
  assert.equal(idleHeartbeat.status, 200);
  assert.equal((await idleHeartbeat.json()).captureJob, null);
  assert.equal(await readFile(dataFile, "utf8"), beforeNoJob, "无任务心跳不得写业务数据");

  const queuedResponse = await post("/api/candidates/A-JOB-1/lifecycle/a-confirm", aSubmission(1));
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  assert.equal(queued.status, "supplier_capture_job_queued");
  assert.equal(queued.captureJob.status, "queued");
  assert.equal(queued.captureJob.attempt, 0);
  assert.equal(queued.captureJob.requiredExtensionVersion, "1.2.7");
  assert.equal(queued.candidate.sourceCapture.status, "waiting_extension");
  assert.equal(queued.bStarted, false);
  assert.equal(queued.c1Created, false);
  assert.equal(queued.dispatch, null);

  const duplicate = await post("/api/candidates/A-JOB-1/lifecycle/a-confirm", aSubmission(queued.candidate.dataRevision));
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.captureJob.jobId, queued.captureJob.jobId);
  assert.equal(duplicateBody.captureJob.attempt, 0);

  const mismatch = await heartbeat("1.2.6");
  const mismatchBody = await mismatch.json();
  assert.equal(mismatchBody.captureJob, null);
  assert.equal(mismatchBody.jobNotice.code, "extension_version_mismatch");
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  let current = state.candidates.find((item) => item.id === "A-JOB-1");
  assert.equal(current.sourceCapture.status, "extension_version_mismatch");
  assert.equal(current.workflowStatus, "codex_processing");

  const claimResponse = await heartbeat("1.2.7");
  const claim = await claimResponse.json();
  assert.equal(claim.captureJob.candidateId, "A-JOB-1");
  assert.equal(claim.captureJob.attempt, 1);
  assert.equal(claim.captureJob.mode, "a_supplier_capture");
  assert.equal(claim.captureJob.sourceUrl, "https://qr.1688.com/s/7OnLCakq");
  assert.equal(claim.captureJob.allowShortLinkResolution, true);
  assert.equal(typeof claim.captureJob.token, "string");

  const secondClaim = await heartbeat("1.2.7");
  assert.equal((await secondClaim.json()).captureJob, null, "已有一个作业执行时不能领取第二个候选");
  const blockedParallelCandidate = await post("/api/candidates/A-TIMEOUT/lifecycle/a-confirm", aSubmission(1));
  assert.equal(blockedParallelCandidate.status, 409, "一个采集作业执行时不得创建第二个候选作业");

  const revisionConflict = await post("/api/candidates/A-JOB-1/source-capture/result", {
    captureId: claim.captureJob.captureId,
    token: claim.captureJob.token,
    dataRevision: claim.captureJob.dataRevision - 1,
    status: "captured",
    resolvedSourceUrl: "https://detail.1688.com/offer/876240928352.html",
    evidence: evidence()
  }, { Origin: extensionOrigin });
  assert.equal(revisionConflict.status, 409);
  assert.equal((await revisionConflict.json()).code, "revision_conflict");

  const resultResponse = await post("/api/candidates/A-JOB-1/source-capture/result", {
    captureId: claim.captureJob.captureId,
    token: claim.captureJob.token,
    dataRevision: claim.captureJob.dataRevision,
    status: "captured",
    resolvedSourceUrl: "https://detail.1688.com/offer/876240928352.html",
    evidence: evidence()
  }, { Origin: extensionOrigin });
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json();
  assert.equal(result.candidate.sourceCapture.status, "captured_waiting_owner_selection");
  assert.equal(result.candidate.sourceCapture.jobStatus, "completed");
  assert.equal(result.candidate.sourceCapture.attempt, 1);
  assert.equal(result.candidate.sourceCapture.offerId, "876240928352");
  assert.equal(result.candidate.sourceCapture.sourceUrl, "https://detail.1688.com/offer/876240928352.html");
  assert.equal(result.candidate.sourceCapture.skuChoices.length, 2);
  assert.equal(result.candidate.sourceCapture.skuChoices[0].priceCny, 11.8);
  assert.equal(result.candidate.sourceCapture.skuChoices[1].priceCny, null);
  assert.equal(result.candidate.sourceCapture.skuChoices[1].stock, null);
  assert.deepEqual(result.candidate.sourceCapture.selectedSkuIds, []);
  assert.equal(result.candidate.sourceCapture.ownerSupplyConfirmed, false);
  assert.equal(result.candidate.workflowStatus, "codex_processing");
  assert.equal(result.candidate.lifecycleV11.skuPackage, undefined);
  assert.equal(result.dispatch, null);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.candidates.length, 4);
  assert.equal(state.meta.automationStarted, false);
  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(JSON.stringify(persisted.candidates.find((item) => item.id === "OTHER-1")), originalOther);

  const failedQueued = await post("/api/candidates/A-FAIL/lifecycle/a-confirm", aSubmission(1));
  assert.equal(failedQueued.status, 202);
  const failedClaimResponse = await heartbeat("1.2.7");
  const failedClaim = await failedClaimResponse.json();
  assert.equal(failedClaim.captureJob.candidateId, "A-FAIL");

  const rejectedRawUrl = await post("/api/candidates/A-FAIL/source-capture/result", {
    captureId: failedClaim.captureJob.captureId,
    token: failedClaim.captureJob.token,
    dataRevision: failedClaim.captureJob.dataRevision,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "detail_1688",
      finalPathType: "offer_detail",
      redirectClassification: "different_offer",
      navigationStage: "page_complete",
      observedOfferId: "999999",
      finalUrl: "https://detail.1688.com/offer/999999.html?token=must-not-persist"
    }
  }, { Origin: extensionOrigin });
  assert.equal(rejectedRawUrl.status, 400);
  assert.equal((await rejectedRawUrl.json()).code, "capture_failure_diagnostics_invalid");

  const failedResultResponse = await post("/api/candidates/A-FAIL/source-capture/result", {
    captureId: failedClaim.captureJob.captureId,
    token: failedClaim.captureJob.token,
    dataRevision: failedClaim.captureJob.dataRevision,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "detail_1688",
      finalPathType: "offer_detail",
      redirectClassification: "different_offer",
      navigationStage: "page_complete",
      observedOfferId: "999999"
    }
  }, { Origin: extensionOrigin });
  assert.equal(failedResultResponse.status, 200);
  const failedResult = await failedResultResponse.json();
  assert.equal(failedResult.candidate.sourceCapture.status, "failed");
  assert.equal(failedResult.candidate.sourceCapture.failureCode, "wrong_offer");
  assert.equal(failedResult.candidate.sourceCapture.failureDestinationLabel, "不同商品");
  assert.equal(failedResult.candidate.sourceCapture.failureDiagnostics.redirectClassification, "different_offer");
  assert.equal(failedResult.candidate.workflowStatus, "codex_processing");
  assert.equal(failedResult.candidate.lifecycleV11.skuPackage, undefined);
  assert.equal(failedResult.dispatch, null);
  const afterFailure = await readFile(dataFile, "utf8");
  assert.doesNotMatch(afterFailure, /must-not-persist|finalUrl|[?&]token=/i);
  const afterFailureData = JSON.parse(afterFailure);
  assert.equal(afterFailureData.dispatches.length, 0);
  assert.equal(afterFailureData.meta.automationStarted, false);
  assert.equal(JSON.stringify(afterFailureData.candidates.find((item) => item.id === "OTHER-1")), originalOther);

  const timeoutQueued = await post("/api/candidates/A-TIMEOUT/lifecycle/a-confirm", aSubmission(1));
  assert.equal(timeoutQueued.status, 202);
  const timeoutClaim = await heartbeat("1.2.7");
  assert.equal((await timeoutClaim.json()).captureJob.candidateId, "A-TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 700));
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const timedOut = state.candidates.find((item) => item.id === "A-TIMEOUT");
  assert.equal(timedOut.sourceCapture.status, "failed");
  assert.equal(timedOut.sourceCapture.failureCode, "unknown_outcome");
  assert.equal(timedOut.workflowStatus, "codex_processing");
  assert.equal((await (await heartbeat("1.2.7")).json()).captureJob, null, "unknown_outcome不得自动重新领取");
});
