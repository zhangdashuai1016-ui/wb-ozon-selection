import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43918;
const baseUrl = `http://127.0.0.1:${port}`;

function candidate(id, workflowStatus, processing) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `${id}商品`,
    productUrl: "",
    sourceUrl: "",
    competitorUrl: "",
    purchasePriceRmb: 10,
    domesticShippingRmb: 0,
    packagingCostRmb: 1.5,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    acceptedTestRisk: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    workflowStatus,
    processing,
    dataRevision: 1,
    comments: [],
    history: []
  };
}

function profitPassedCandidate(id) {
  const item = candidate(id, "listing_preparation", { state: "idle", manualHold: false });
  item.acceptedTestRisk = true;
  item.codexReview = {
    decision: "sourcePending",
    marketEvidence: { comparableCount: 1 },
    profitCalculation: {
      status: "estimated",
      directionalStatus: "passed",
      inputsComplete: true,
      unitProfitRmb: 25,
      marginRate: 0.2
    }
  };
  item.bPassedAt = "2026-08-07T01:00:00.000Z";
  item.defaultStock = 100;
  item.listingPreparation = { status: "awaiting_user_start", defaultStock: 100 };
  item.listingHandoff = { state: "awaiting_user_start", owner: "listing_task", defaultStock: 100 };
  return item;
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function post(url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("node comments, one-shot dispatch, exact claim, and production confirmation stay isolated", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-collaboration-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-07T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [
      candidate("QUEUE-1", "codex_processing", { state: "queued", dispatchState: "requested", manualHold: false }),
      candidate("STOP-1", "codex_processing", { state: "blocked", dispatchState: "blocked", manualHold: true }),
      profitPassedCandidate("C-PENDING-1"),
      profitPassedCandidate("C-DECISION-1"),
      Object.assign(candidate("READY-1", "ready_to_list", { state: "idle", manualHold: false }), {
        cCompletedAt: "2026-08-11T08:00:00.000Z",
        defaultStock: 100,
        listingPreparation: { status: "prepared", exactSourceSku: "READY-1-SKU", assets: ["main.png"] },
        listingHandoff: { state: "prepared", owner: "listing_task", defaultStock: 100 }
      }),
      candidate("LEGACY-READY", "ready_to_list", { state: "idle", manualHold: false })
      ,candidate("MANUAL-PREP", "listing_preparation", { state: "idle", manualHold: false })
      ,candidate("MANUAL-PREP-DENIED", "listing_preparation", { state: "idle", manualHold: false })
      ,candidate("MANUAL-OTHER", "codex_processing", { state: "idle", manualHold: false })
    ]
  }));

  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, stderr);

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.meta.automationStarted, false);
  assert.equal(state.summary.dispatch.processingCounts.actualRunning, 0);
  assert.equal(state.summary.dispatch.processingCounts.authorized, 1);
  assert.equal(state.summary.dispatch.processingCounts.stopped, 1);

  const map = await (await fetch(`${baseUrl}/api/workflow-map?candidateId=QUEUE-1`)).json();
  assert.equal(map.selectedCandidate.activeNodeId, "M05");

  const recorded = await post("/api/node-comments", {
    nodeId: "M04",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "只记录这条说明",
    action: "record"
  });
  assert.equal(recorded.status, 201);
  assert.equal((await recorded.json()).dispatch, null);

  const executed = await post("/api/node-comments", {
    nodeId: "M04",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "只处理当前SKU一次",
    action: "execute"
  });
  assert.equal(executed.status, 409);

  const mainUiDispatch = await post("/api/candidates/QUEUE-1/dispatch", {
    dataRevision: 1
  });
  assert.equal(mainUiDispatch.status, 201);
  const dispatch = (await mainUiDispatch.json()).dispatch;
  assert.equal(dispatch.status, "queued");
  assert.equal(dispatch.assigneeRole, "selection_task");
  assert.equal(dispatch.trigger, "review_ui_dispatch");

  const automaticContinuation = await post("/api/candidates/C-PENDING-1/dispatch", {
    dataRevision: 1,
    trigger: "automatic_stage_continuation"
  });
  assert.equal(automaticContinuation.status, 409);

  const startPreparation = await post("/api/candidates/C-PENDING-1/start-listing-preparation", {
    dataRevision: 1
  });
  assert.equal(startPreparation.status, 200);
  const preparationDispatch = (await startPreparation.json()).dispatch;
  assert.equal(preparationDispatch.assigneeRole, "listing_task");
  assert.equal(preparationDispatch.nodeId, "M07");
  assert.equal(preparationDispatch.trigger, "listing_preparation_user_start");
  assert.deepEqual(preparationDispatch.requiredSkills.map((skill) => skill.name), ["ozon-wb-pricing", "optimize-ecommerce-seo"]);

  const preparationData = JSON.parse(await readFile(dataFile, "utf8"));
  preparationData.dispatches.find((item) => item.id === preparationDispatch.id).status = "received";
  await writeFile(dataFile, JSON.stringify(preparationData));
  const preparationClaim = await post(`/api/dispatches/${preparationDispatch.id}/claim`, {
    runId: "prep-run-1",
    currentStep: "核对精确1688 SKU与上架字段"
  });
  assert.equal(preparationClaim.status, 200);
  const preparationCandidate = (await preparationClaim.json()).candidate;
  const preparationReview = await post("/api/candidates/C-PENDING-1/listing-preparation-review", {
    dataRevision: preparationCandidate.dataRevision,
    runId: "prep-run-1",
    status: "prepared",
    candidateData: {
      powered: false,
      complianceStatus: "clear",
      authorizationStatus: "clear"
    },
    codexReview: {
      marketEvidence: { comparableCount: 1, checkedAt: "2026-08-11T09:00:00.000Z" },
      commission: { sourceType: "real", rate: 0.15, checkedAt: "2026-08-11T09:00:00.000Z" },
      logistics: { sourceType: "real", route: "GUOO", freightRmb: 18, checkedAt: "2026-08-11T09:00:00.000Z" },
      sourceConsistency: { status: "verified" },
      profitCalculation: { status: "verified", inputsComplete: true, unitProfitRmb: 25, marginRate: 0.3 }
    },
    preparation: {
      exactSourceSku: "1688-123456-red",
      category: "Ozon test category",
      schemaEvidence: "schema-current-2026-08-11",
      finalPrice: "3000 RUB",
      assets: ["main.png", "detail.png"]
    },
    evidencePackIds: []
  });
  assert.equal(preparationReview.status, 200);
  const readyAfterPreparation = (await preparationReview.json()).candidate;
  assert.equal(readyAfterPreparation.workflowStatus, "ready_to_list");
  assert.equal(readyAfterPreparation.defaultStock, 100);
  assert.equal(readyAfterPreparation.listingPreparation.status, "prepared");
  const preparationComplete = await post(`/api/dispatches/${preparationDispatch.id}/complete`, {
    runId: "prep-run-1",
    status: "completed",
    reply: "C阶段结构化回写已完成",
    evidence: "listing-preparation-review accepted"
  });
  assert.equal(preparationComplete.status, 200);

  const decisionStart = await post("/api/candidates/C-DECISION-1/start-listing-preparation", {
    dataRevision: 1
  });
  assert.equal(decisionStart.status, 200);
  const decisionDispatch = (await decisionStart.json()).dispatch;
  const decisionData = JSON.parse(await readFile(dataFile, "utf8"));
  decisionData.dispatches.find((item) => item.id === decisionDispatch.id).status = "received";
  await writeFile(dataFile, JSON.stringify(decisionData));
  const decisionClaim = await post(`/api/dispatches/${decisionDispatch.id}/claim`, {
    runId: "decision-run-1",
    currentStep: "核对品牌与素材"
  });
  assert.equal(decisionClaim.status, 200);
  const decisionCandidate = (await decisionClaim.json()).candidate;
  const needsDecision = await post("/api/candidates/C-DECISION-1/listing-preparation-review", {
    dataRevision: decisionCandidate.dataRevision,
    runId: "decision-run-1",
    status: "needs_decision",
    reason: "品牌和素材需要主人确认",
    userAction: "请确认品牌与素材清单",
    decisionItems: ["无品牌或准确品牌", "授权素材清单与顺序"],
    evidencePackIds: []
  });
  assert.equal(needsDecision.status, 200);
  const decisionResult = (await needsDecision.json()).candidate;
  assert.equal(decisionResult.listingHandoff.currentStep, "C阶段只读核验完成，等待主人确认必要事实");
  assert.equal(decisionResult.listingHandoff.userAction, "请确认品牌与素材清单");
  assert.deepEqual(decisionResult.listingHandoff.decisionItems, ["无品牌或准确品牌", "授权素材清单与顺序"]);
  assert.equal(decisionResult.listingPreparation.status, "needs_decision");

  const packOne = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", category: "toys", salesScheme: "rfbs" },
    summary: "蛋蛋鼠玩具RFBS当前佣金",
    sourceType: "real",
    checkedAt: "2026-08-11T09:00:00.000Z",
    sourceRef: "seller-api-readonly"
  });
  assert.equal(packOne.status, 201);
  const firstPackId = (await packOne.json()).evidencePack.id;
  const packTwo = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", category: "toys", salesScheme: "rfbs" },
    summary: "同一范围更新后的佣金证据",
    sourceType: "real",
    checkedAt: "2026-08-11T10:00:00.000Z",
    sourceRef: "seller-api-readonly-2"
  });
  assert.equal(packTwo.status, 201);
  const packState = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(packState.evidencePacks.filter((item) => item.status === "active").length, 1);
  assert.equal(packState.evidencePacks.find((item) => item.id === firstPackId).status, "superseded");

  const duplicate = await post("/api/candidates/QUEUE-1/dispatch", {
    dataRevision: 1,
  });
  assert.equal(duplicate.status, 409);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.summary.dispatch.processingCounts.authorized, 0);
  assert.equal(state.summary.dispatch.processingCounts.dispatched, 1);
  assert.equal(state.summary.dispatch.processingCounts.stopped, 2);

  const persisted = JSON.parse(await readFile(dataFile, "utf8"));
  persisted.dispatches.find((item) => item.id === dispatch.id).status = "received";
  await writeFile(dataFile, JSON.stringify(persisted));

  const claimed = await post(`/api/dispatches/${dispatch.id}/claim`, {
    runId: "one-shot-run-1",
    currentStep: "读取当前资料"
  });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).candidate.processing.state, "running");

  const progressed = await post(`/api/dispatches/${dispatch.id}/progress`, {
    runId: "one-shot-run-1",
    currentStep: "核对当前市场",
    evidence: "新增一条可追溯证据"
  });
  assert.equal(progressed.status, 200);

  const completed = await post(`/api/dispatches/${dispatch.id}/complete`, {
    runId: "one-shot-run-1",
    status: "completed",
    reply: "任务已回复",
    evidence: ""
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).dispatch.status, "responded_unverified");

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const queueAfterReply = state.candidates.find((item) => item.id === "QUEUE-1");
  assert.equal(queueAfterReply.activeDispatch, null);
  assert.equal(queueAfterReply.latestDispatch.status, "responded_unverified");

  const wrongOwner = await post("/api/node-comments", {
    nodeId: "M08",
    scope: "candidate",
    candidateId: "QUEUE-1",
    dataRevision: 1,
    message: "不能越级上架",
    action: "execute"
  });
  assert.equal(wrongOwner.status, 409);

  const listingDispatch = await post("/api/candidates/READY-1/dispatch", {
    dataRevision: 1
  });
  assert.equal(listingDispatch.status, 409);

  const production = await post("/api/candidates/READY-1/production-authorization", {
    dataRevision: 1,
    platform: "Ozon",
    store: "蛋蛋鼠",
    product: "READY-1商品",
    sku: "READY-1-SKU",
    price: "3000 RUB",
    stock: "100",
    assets: ["主图.png", "详情图.png"],
    publishScope: "仅保存草稿",
    exclusions: "不送审、不发布",
    confirmed: true
  });
  assert.equal(production.status, 200);
  const authorized = (await production.json()).candidate;
  assert.equal(authorized.workflowStatus, "ready_to_list");
  assert.equal(authorized.productionAuthorization.status, "confirmed");
  assert.equal(authorized.dataRevision, 2);

  const blockedLegacyProduction = await post("/api/candidates/LEGACY-READY/production-authorization", {
    dataRevision: 1,
    platform: "Ozon",
    store: "蛋蛋鼠",
    product: "LEGACY-READY商品",
    sku: "LEGACY-READY-SKU",
    price: "3000 RUB",
    stock: "100",
    assets: ["main.png"],
    publishScope: "仅保存草稿",
    confirmed: true
  });
  assert.equal(blockedLegacyProduction.status, 409);
  const legacyPreparation = await post("/api/candidates/LEGACY-READY/start-listing-preparation", {
    dataRevision: 1
  });
  assert.equal(legacyPreparation.status, 200);
  const legacyBody = await legacyPreparation.json();
  assert.equal(legacyBody.candidate.workflowStatus, "listing_preparation");
  assert.equal(legacyBody.dispatch.assigneeRole, "listing_task");

  const deniedPreparationListing = await post("/api/candidates/MANUAL-PREP-DENIED/mark-listed", {
    dataRevision: 1,
    platform: "ozon",
    confirmedAt: "2026-08-11T09:00:00.000Z"
  });
  assert.equal(deniedPreparationListing.status, 409);

  const deniedOtherListing = await post("/api/candidates/MANUAL-OTHER/mark-listed", {
    dataRevision: 1,
    platform: "ozon",
    confirmedAt: "2026-08-11T09:00:00.000Z",
    confirmedAlreadyListed: true
  });
  assert.equal(deniedOtherListing.status, 409);

  const confirmedPreparationListing = await post("/api/candidates/MANUAL-PREP/mark-listed", {
    dataRevision: 1,
    platform: "ozon",
    confirmedAt: "2026-08-11T09:00:00.000Z",
    confirmedAlreadyListed: true
  });
  assert.equal(confirmedPreparationListing.status, 200);
  const confirmedPreparation = (await confirmedPreparationListing.json()).candidate;
  assert.equal(confirmedPreparation.workflowStatus, "listed");
  assert.equal(confirmedPreparation.dataRevision, 2);
  assert.equal(confirmedPreparation.listingRecord.productId, "");
  assert.equal(confirmedPreparation.listingRecord.productUrl, "");
  assert.equal(confirmedPreparation.listingRecord.confirmationSource, "user_explicit_confirmation");
  assert.equal(confirmedPreparation.listingRecord.stateOnly, true);

  const finalData = JSON.parse(await readFile(dataFile, "utf8"));
  assert.equal(finalData.meta.automationStarted, false);
  assert.equal(finalData.candidates.find((item) => item.id === "STOP-1").processing.manualHold, true);
});
