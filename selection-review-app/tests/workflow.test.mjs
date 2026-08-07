import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RULES,
  NO_PROGRESS_TIMEOUT_MINUTES,
  WORKFLOW_STATUSES,
  promotionPricingGate,
  approvalGate,
  codexAutoEliminationGate,
  businessDate,
  dailySummary,
  dispatchQueueSummary,
  recoverStaleProcessing,
  recentAvoidanceFeedback,
  purchaseCeilingSummary,
  processingStatusSummary,
  queueUserDispatch,
  claimEligible,
  requiredInputFields,
  profitInputStatus,
  selectionStage,
  technicalFailureDisposition,
  validateListingRecord,
  validateListingReadback,
  electricalGate,
  filterUserNeededFields,
  wbAssessmentDecisionGate,
  wbAssessmentGate,
  normalizeDispatchStates,
  recordProcessingProgress,
  registerProcessingAttempt,
  stopNoProgressRuns
} from "../lib/workflow.mjs";

test("user activity clears stale blockers and requests immediate dispatch", () => {
  const processing = queueUserDispatch(
    {
      state: "deferred",
      attempts: 4,
      attemptsToday: 2,
      lastAttemptAt: "2026-08-04T06:00:00.000Z",
      lastError: "旧错误",
      blockReason: "旧阻塞",
      userAction: "旧用户动作",
      readAttempts: [{ path: "iab_public", status: "failed" }],
      deferredUntil: "2026-08-04T09:00:00.000Z"
    },
    "2026-08-04T08:30:00.000Z",
    "user_update"
  );

  assert.equal(processing.state, "queued");
  assert.equal(processing.attempts, 4);
  assert.equal(processing.lastError, null);
  assert.equal(processing.blockReason, null);
  assert.equal(processing.userAction, "");
  assert.deepEqual(processing.readAttempts, []);
  assert.equal(processing.deferredUntil, null);
  assert.equal(processing.dispatchState, "requested");
  assert.equal(processing.dispatchPriority, "user");
  assert.equal(processing.dispatchRequestedAt, "2026-08-04T08:30:00.000Z");
  assert.equal(claimEligible({ dataRevision: 4, processing }), true);
});

test("ordinary user edits cannot silently clear a technical manual hold", () => {
  const processing = queueUserDispatch(
    {
      state: "blocked",
      manualHold: true,
      dispatchState: "blocked",
      blockReason: "市场读取失败",
      userAction: "等待总控确认恢复路径"
    },
    "2026-08-04T08:30:00.000Z",
    "user_update"
  );
  assert.equal(processing.state, "blocked");
  assert.equal(processing.manualHold, true);
  assert.equal(processing.dispatchState, "blocked");
  assert.equal(claimEligible({ dataRevision: 4, processing }), false);
});

test("dispatch queue puts user-triggered work first and exposes truthful position", () => {
  const candidates = [
    {
      id: "RUNNING",
      workflowStatus: "codex_processing",
      processing: {
        state: "running",
        runId: "run-1",
        startedAt: "2026-08-04T08:25:00.000Z",
        currentStep: "读取Ozon市场证据",
        lastProgressAt: "2026-08-04T08:25:00.000Z"
      }
    },
    {
      id: "NORMAL",
      source: "codex",
      createdAt: "2026-08-04T07:00:00.000Z",
      dataRevision: 1,
      workflowStatus: "codex_processing",
      processing: { state: "queued", attempts: 0 }
    },
    {
      id: "USER-NEW",
      source: "codex",
      createdAt: "2026-08-04T08:00:00.000Z",
      dataRevision: 3,
      workflowStatus: "codex_processing",
      processing: {
        state: "queued",
        dispatchState: "requested",
        dispatchPriority: "user",
        dispatchRequestedAt: "2026-08-04T08:30:00.000Z",
        lastAttemptRevision: 3,
        lastAttemptBusinessDate: "2026-08-04"
      }
    },
    {
      id: "NORMAL-2",
      source: "codex",
      createdAt: "2026-08-04T07:10:00.000Z",
      dataRevision: 1,
      workflowStatus: "codex_processing",
      processing: { state: "queued", attempts: 0 }
    }
  ];

  const summary = dispatchQueueSummary(candidates, new Date("2026-08-04T08:30:30.000Z"));
  assert.deepEqual(summary.runningIds, ["RUNNING"]);
  assert.equal(summary.concurrencyLimit, 3);
  assert.deepEqual(summary.queuedIds, ["USER-NEW", "NORMAL", "NORMAL-2"]);
  assert.equal(summary.positions["USER-NEW"].queuePosition, 1);
  assert.equal(summary.positions["USER-NEW"].estimatedStart, "立即开始（等待领取）");
  assert.equal(summary.positions.NORMAL.queuePosition, 2);
  assert.equal(summary.positions.NORMAL.tasksAhead, 0);
  assert.equal(summary.positions["NORMAL-2"].tasksAhead, 1);
  assert.deepEqual(summary.processingCounts, { running: 1, queued: 3, deferred: 0, blocked: 0, stopped: 0, stateAnomaly: 0 });
});

test("listed is an exclusive terminal queue and keeps ready progress separate", () => {
  assert.ok(WORKFLOW_STATUSES.includes("listed"));
  const candidates = [
    passingCandidate({
      id: "READY",
      workflowStatus: "ready_to_list",
      readyAt: "2026-08-04T01:00:00.000Z",
      selectionDate: "2026-08-04"
    }),
    passingCandidate({
      id: "LISTED",
      workflowStatus: "listed",
      readyAt: "2026-08-04T01:30:00.000Z",
      listedAt: "2026-08-04T02:00:00.000Z",
      listingRecord: {
        platform: "ozon",
        productId: "5329930819",
        confirmedAt: "2026-08-04T02:00:00.000Z"
      },
      selectionDate: "2026-08-04"
    })
  ];
  const summary = dailySummary(candidates, DEFAULT_RULES, "2026-08-04");
  assert.equal(summary.queueCounts.ready_to_list, 1);
  assert.equal(summary.queueCounts.listed, 1);
  assert.equal(summary.stores.dandanshu.ready, 1);
});

test("listing record requires platform, product id or link, and confirmation time", () => {
  assert.deepEqual(
    validateListingRecord({ platform: "ozon", productId: "5329930819", confirmedAt: "2026-08-04T02:00:00.000Z" }),
    {
      platform: "ozon",
      store: "",
      productId: "5329930819",
      merchantSku: "",
      productUrl: "",
      confirmedAt: "2026-08-04T02:00:00.000Z",
      moderationStatus: "",
      saleStatus: "",
      method: "manual_fallback"
    }
  );
  assert.throws(() => validateListingRecord({ platform: "ozon" }), /商品ID或链接/);
  assert.throws(() => validateListingRecord({ platform: "other", productId: "1", confirmedAt: "2026-08-04T02:00:00.000Z" }), /平台/);
});

test("automatic listing readback requires current real platform evidence and complete identity", () => {
  const checkedAt = "2026-08-04T06:30:00.000Z";
  assert.deepEqual(
    validateListingReadback(
      {
        platform: "ozon",
        store: "dandanshu",
        productId: "5329930819",
        merchantSku: "USR-20260801-001",
        productUrl: "https://www.ozon.ru/product/5329930819/",
        confirmedAt: checkedAt,
        moderationStatus: "approved",
        saleStatus: "ready_for_sale_no_stock",
        readback: {
          sourceType: "real",
          source: "seller_api",
          checkedAt,
          evidenceRef: "Ozon Seller API product-info readback"
        }
      },
      new Date("2026-08-04T06:35:00.000Z")
    ),
    {
      platform: "ozon",
      store: "dandanshu",
      productId: "5329930819",
      merchantSku: "USR-20260801-001",
      productUrl: "https://www.ozon.ru/product/5329930819/",
      confirmedAt: checkedAt,
      moderationStatus: "approved",
      saleStatus: "ready_for_sale_no_stock",
      method: "automatic_readback",
      readback: {
        sourceType: "real",
        source: "seller_api",
        checkedAt,
        evidenceRef: "Ozon Seller API product-info readback"
      }
    }
  );
  assert.throws(
    () => validateListingReadback({ platform: "ozon", store: "dandanshu", productId: "1", merchantSku: "SKU", moderationStatus: "approved", saleStatus: "selling", readback: { sourceType: "summary", source: "chat", checkedAt } }, new Date("2026-08-04T06:35:00.000Z")),
    /真实回读/
  );
  assert.throws(
    () => validateListingReadback({ platform: "ozon", store: "dandanshu", productId: "1", merchantSku: "SKU", moderationStatus: "approved", saleStatus: "selling", readback: { sourceType: "real", source: "seller_api", checkedAt: "2026-08-02T06:30:00.000Z", evidenceRef: "old" } }, new Date("2026-08-04T06:35:00.000Z")),
    /24小时/
  );
  assert.throws(
    () => validateListingReadback({ platform: "ozon", store: "dandanshu", productId: "1", moderationStatus: "approved", saleStatus: "selling", readback: { sourceType: "real", source: "seller_api", checkedAt, evidenceRef: "missing sku" } }, new Date("2026-08-04T06:35:00.000Z")),
    /商家货号/
  );
});

test("processing status separates real running, queued, stopped, and idle truthfully", () => {
  const now = new Date("2026-08-04T06:00:00.000Z");
  const running = processingStatusSummary({ workflowStatus: "codex_processing", processing: {
    state: "running",
    runId: "run-1",
    startedAt: "2026-08-04T05:50:00.000Z",
    currentStep: "读取市场证据",
    lastProgressAt: "2026-08-04T05:58:00.000Z"
  } }, now);
  assert.equal(running.key, "running");
  assert.equal(running.actualRunning, true);
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "running", startedAt: "2026-08-04T05:50:00.000Z" } }, now).key, "state_anomaly");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "running", runId: "run-1", startedAt: "2026-08-04T05:50:00.000Z", lastProgressAt: "2026-08-04T05:58:00.000Z" } }, now).key, "state_anomaly");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "running", runId: "run-1", startedAt: "2026-08-04T05:50:00.000Z", currentStep: "读取市场证据" } }, now).key, "state_anomaly");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "queued" } }, now).key, "queued");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "queued", manualHold: true } }, now).key, "blocked");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "deferred", lastAttemptAt: "2026-08-04T05:00:00.000Z", lastError: "公开正文暂时不可读" } }, now).key, "blocked");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "blocked", userAction: "请让总控确认" } }, now).key, "blocked");
  assert.equal(processingStatusSummary({ workflowStatus: "codex_processing", processing: { state: "idle" } }, now).key, "idle");
});

test("manual hold is counted as stopped instead of queued", () => {
  const summary = dispatchQueueSummary([
    {
      id: "HELD-QUEUE",
      workflowStatus: "codex_processing",
      processing: { state: "queued", dispatchState: "normalized", manualHold: true }
    }
  ], new Date("2026-08-04T08:30:00.000Z"));
  assert.equal(summary.processingCounts.queued, 0);
  assert.equal(summary.processingCounts.blocked, 1);
  assert.equal(summary.processingCounts.stopped, 1);
  assert.deepEqual(summary.queuedIds, []);
});

test("dispatch normalization preserves candidates but stops orphan work", () => {
  const candidates = [
    {
      id: "DEFERRED",
      workflowStatus: "codex_processing",
      processing: { state: "deferred", dispatchState: "deferred", deferredUntil: "2026-08-04T05:00:00.000Z" }
    },
    {
      id: "CLAIMED-ORPHAN",
      workflowStatus: "codex_processing",
      processing: { state: "queued", dispatchState: "claimed", runId: null }
    },
    {
      id: "RUNNING",
      workflowStatus: "codex_processing",
      processing: { state: "running", dispatchState: "claimed", runId: "run-1", startedAt: "2026-08-04T05:50:00.000Z" }
    }
  ];
  const changed = normalizeDispatchStates(candidates, new Date("2026-08-04T06:00:00.000Z"));
  assert.deepEqual(changed.map((item) => item.candidateId), ["DEFERRED", "CLAIMED-ORPHAN"]);
  assert.equal(candidates[0].processing.state, "blocked");
  assert.equal(candidates[0].processing.manualHold, true);
  assert.equal(candidates[1].processing.state, "queued");
  assert.equal(candidates[1].processing.dispatchState, "normalized");
  assert.equal(candidates[1].processing.manualHold, true);
  assert.equal(candidates[2].processing.state, "running");
  assert.equal(candidates[2].processing.runId, "run-1");
});

test("one evidence-bearing technical failure stops without another browser retry", () => {
  const dualFailure = [
    { path: "iab_public", status: "failed", detail: "正文不可读" },
    { path: "chrome_logged_in", status: "failed", detail: "最小读取超时" }
  ];
  const oneFailure = [dualFailure[0]];
  assert.equal(technicalFailureDisposition({ attemptsToday: 1, readAttempts: oneFailure }).action, "block");
  assert.equal(technicalFailureDisposition({ attemptsToday: 1, readAttempts: dualFailure }).action, "block");
  assert.equal(technicalFailureDisposition({ attemptsToday: 3, readAttempts: dualFailure }).action, "block");
  assert.equal(technicalFailureDisposition({ attemptsToday: 1, readAttempts: dualFailure, explicitSafetyBlock: true }).action, "block");
  assert.throws(
    () => technicalFailureDisposition({ attemptsToday: 1, readAttempts: [] }),
    /真实失败证据/
  );
});

test("one run cannot repeat the same candidate evidence layer and target", () => {
  const processing = {
    state: "running",
    runId: "run-1",
    startedAt: "2026-08-04T05:50:00.000Z",
    currentStep: "读取Ozon市场证据",
    lastProgressAt: "2026-08-04T05:50:00.000Z",
    attemptLedger: []
  };
  const first = registerProcessingAttempt(processing, {
    candidateId: "C-1",
    runId: "run-1",
    evidenceLayer: "ozon_market",
    target: "https://www.ozon.ru/product/123/?ref=abc",
    path: "chrome_logged_in"
  }, "2026-08-04T05:51:00.000Z");
  assert.equal(first.attemptLedger.length, 1);
  assert.throws(() => registerProcessingAttempt(first, {
    candidateId: "C-1",
    runId: "run-1",
    evidenceLayer: "ozon_market",
    target: "https://www.ozon.ru/product/123/?ref=abc",
    path: "chrome_logged_in"
  }, "2026-08-04T05:52:00.000Z"), /本轮已尝试/);
});

test("only auditable new evidence or a real step change renews progress", () => {
  const processing = {
    state: "running",
    runId: "run-1",
    startedAt: "2026-08-04T05:50:00.000Z",
    currentStep: "读取Ozon市场证据",
    lastProgressAt: "2026-08-04T05:50:00.000Z",
    progressEvents: []
  };
  assert.throws(() => recordProcessingProgress(processing, {
    runId: "run-1",
    progressType: "new_evidence",
    currentStep: "读取Ozon市场证据",
    evidenceRef: ""
  }, "2026-08-04T05:55:00.000Z"), /证据/);
  const advanced = recordProcessingProgress(processing, {
    runId: "run-1",
    progressType: "step_change",
    currentStep: "核对当前佣金"
  }, "2026-08-04T05:55:00.000Z");
  assert.equal(advanced.currentStep, "核对当前佣金");
  assert.equal(advanced.lastProgressAt, "2026-08-04T05:55:00.000Z");
  assert.throws(() => recordProcessingProgress(advanced, {
    runId: "run-1",
    progressType: "step_change",
    currentStep: "核对当前佣金"
  }, "2026-08-04T05:56:00.000Z"), /没有实质变化/);
});

test("purchase ceiling uses the higher limit when profit or margin can pass", () => {
  const candidate = {
    targetStore: "dandanshu",
    purchaseCeiling: {
      status: "verified",
      scope: "purchase_plus_domestic_shipping",
      pricingPolicyVersion: DEFAULT_RULES.ozonDandanshu.pricingPolicyVersion,
      sellerRevenueRmb: 200,
      sellerRevenueSourceType: "real",
      sellerRevenueSourceUrl: "https://example.com/revenue",
      commissionRate: 0.14,
      commissionSourceType: "real",
      commissionSourceUrl: "https://example.com/commission",
      internationalLogisticsRmb: 40,
      logisticsSourceType: "real",
      logisticsSource: "GUOO 2026-08-03 route quote",
      packagingRmb: 1.5,
      labelRmb: 1.5,
      checkedAt: "2026-08-03T02:00:00.000Z"
    }
  };
  const result = purchaseCeilingSummary(candidate, DEFAULT_RULES);
  assert.equal(result.status, "verified");
  assert.equal(result.profitLimitedCeilingRmb, 89);
  assert.equal(result.marginLimitedCeilingRmb, 79);
  assert.equal(result.maximumAllInPurchaseRmb, 89);
});

test("current promotion policy keeps profit on discounted transaction price and only reverse-calculates list prices", () => {
  const candidate = {
    targetStore: "dandanshu",
    purchasePriceRmb: 30,
    purchaseCeiling: {
      status: "verified",
      scope: "purchase_plus_domestic_shipping",
      pricingPolicyVersion: DEFAULT_RULES.ozonDandanshu.pricingPolicyVersion,
      sellerRevenueRmb: 200,
      sellerRevenueSourceType: "real",
      sellerRevenueSourceUrl: "https://example.com/revenue",
      commissionRate: 0.14,
      commissionSourceType: "real",
      commissionSourceUrl: "https://example.com/commission",
      internationalLogisticsRmb: 40,
      logisticsSourceType: "real",
      logisticsSource: "GUOO 2026-08-04 route quote",
      packagingRmb: 1.5,
      labelRmb: 1.5,
      checkedAt: "2026-08-04T02:00:00.000Z"
    }
  };
  const result = purchaseCeilingSummary(candidate, DEFAULT_RULES);
  assert.equal(result.status, "verified");
  assert.equal(result.advertisingReserveRate, 0);
  assert.equal(result.unitProfitRmb, 79);
  assert.equal(result.marginRate, 0.395);
  assert.equal(result.maximumAllInPurchaseRmb, 89);
  assert.deepEqual(result.promotionPricing.map((item) => item.key), ["low", "base", "high"]);
  assert.deepEqual(result.promotionPricing.map((item) => item.suggestedListPriceRmb), [250, 266.67, 285.71]);
  assert.equal(result.policyUpdatePending, false);
});

test("promotion pricing gate requires list prices for 20, 25, and 30 percent discounts", () => {
  const rule = DEFAULT_RULES.ozonDandanshu;
  const complete = {
    pricingPolicyVersion: rule.pricingPolicyVersion,
    promotionPricing: [
      { key: "low", promotionDiscountRate: 0.2, targetTransactionPriceRmb: 200, suggestedListPriceRmb: 250 },
      { key: "base", promotionDiscountRate: 0.25, targetTransactionPriceRmb: 200, suggestedListPriceRmb: 266.67 },
      { key: "high", promotionDiscountRate: 0.3, targetTransactionPriceRmb: 200, suggestedListPriceRmb: 285.71 }
    ]
  };
  const gate = promotionPricingGate(complete, rule);
  assert.equal(gate.passed, true);
  const missingHigh = promotionPricingGate({
    ...complete,
    promotionPricing: complete.promotionPricing.slice(0, 2)
  }, rule);
  assert.equal(missingHigh.passed, false);
  assert.ok(missingHigh.blockers.some((item) => item.includes("30%")));
});

test("legacy promotion-as-advertising ceiling is invalidated without rewriting stored history", () => {
  const result = purchaseCeilingSummary({
    targetStore: "dandanshu",
    purchaseCeiling: {
      status: "verified",
      sellerRevenueRmb: 200,
      commissionRate: 0.14,
      internationalLogisticsRmb: 40,
      checkedAt: "2026-08-04T02:00:00.000Z"
    }
  }, DEFAULT_RULES);
  assert.equal(result.status, "unavailable");
  assert.equal(result.policyUpdatePending, true);
  assert.equal(result.maximumAllInPurchaseRmb, null);
  assert.match(result.missing[0], /二次扣除/);
});

test("purchase ceiling stays unverified instead of inventing a precise amount", () => {
  const result = purchaseCeilingSummary({ targetStore: "dandanshu" }, DEFAULT_RULES);
  assert.equal(result.status, "unavailable");
  assert.equal(result.maximumAllInPurchaseRmb, null);
  assert.ok(result.missing.some((item) => item.includes("佣金")));
  assert.ok(result.missing.some((item) => item.includes("国际运费")));
});

test("direction-stage estimate gives a sourcing interval without pretending final verification", () => {
  const result = purchaseCeilingSummary({
    targetStore: "miska",
    purchaseCeiling: {
      status: "estimated",
      scope: "purchase_plus_domestic_shipping",
      pricingPolicyVersion: DEFAULT_RULES.ozonMiska.pricingPolicyVersion,
      marketReferencePriceRmb: 571.06,
      sellerRevenueSourceType: "market_reference",
      sellerRevenueSourceUrl: "https://www.ozon.ru/product/example",
      commissionRate: 0.14,
      commissionSourceType: "category_reference",
      internationalLogisticsRmb: 93.14,
      logisticsSourceType: "product_page_estimate",
      logisticsSource: "GUOO 2026-07-20 Economy Big",
      checkedAt: "2026-08-03T06:00:00.000Z"
    }
  }, DEFAULT_RULES);
  assert.equal(result.status, "estimated");
  assert.equal(result.maximumAllInPurchaseRmb, 317.86);
  assert.equal(result.estimateOnly, true);
});

function passingCandidate(overrides = {}) {
  return {
    id: "PASS-1",
    source: "user",
    targetStore: "dandanshu",
    workflowStatus: "codex_processing",
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    acceptedTestRisk: false,
    packedWeightKg: 0.4,
    dimensionsCm: { length: 20, width: 10, height: 5 },
    selectionDate: "2026-08-01",
    codexReview: {
      decision: "approved",
      marketEvidence: { comparableCount: 5 },
      commission: { sourceType: "real" },
      logistics: { sourceType: "real" },
      profitCalculation: {
        status: "verified",
        inputsComplete: true,
        unitProfitRmb: 20,
        marginRate: 0.15
      }
    },
    ...overrides
  };
}

test("Asia/Shanghai business date crosses UTC day correctly", () => {
  assert.equal(businessDate("2026-07-31T16:30:00.000Z"), "2026-08-01");
});

test("strict Ozon gate passes when either 20 RMB profit or 15 percent margin is met", () => {
  assert.equal(approvalGate(passingCandidate(), DEFAULT_RULES).passed, true);
  const marginOnly = passingCandidate();
  marginOnly.codexReview.profitCalculation.unitProfitRmb = 19.99;
  assert.equal(approvalGate(marginOnly, DEFAULT_RULES).passed, true);
  const profitOnly = passingCandidate();
  profitOnly.codexReview.profitCalculation.marginRate = 0.149;
  assert.equal(approvalGate(profitOnly, DEFAULT_RULES).passed, true);
  const belowBoth = passingCandidate();
  belowBoth.codexReview.profitCalculation.unitProfitRmb = 19.99;
  belowBoth.codexReview.profitCalculation.marginRate = 0.149;
  assert.equal(approvalGate(belowBoth, DEFAULT_RULES).passed, false);
  const fakeCommission = passingCandidate();
  fakeCommission.codexReview.commission.sourceType = "reference";
  assert.ok(approvalGate(fakeCommission, DEFAULT_RULES).blockers.some((item) => item.includes("佣金")));
});

test("IP or brand risk requires control confirmation instead of automatic direction elimination", () => {
  const candidate = passingCandidate({ authorizationStatus: "needs_confirmation" });
  const gate = approvalGate(candidate, DEFAULT_RULES);
  assert.equal(gate.passed, false);
  assert.equal(gate.autoElimination.shouldEliminate, false);
  assert.ok(gate.blockers.some((item) => item.includes("授权状态")));
  assert.equal(DEFAULT_RULES.selectionFlow.stageBoundaries.A.ipOrBrandRiskDisposition, "needs_control_confirmation_not_auto_elimination");
  assert.equal(DEFAULT_RULES.selectionFlow.stageBoundaries.C.unresolvedRiskDisposition, "block_ready_to_list_until_control_confirmation_and_rights_review");
});

test("five comparables can only be replaced by explicit accepted test risk", () => {
  const candidate = passingCandidate();
  candidate.codexReview.marketEvidence.comparableCount = 4;
  assert.equal(approvalGate(candidate, DEFAULT_RULES).passed, false);
  candidate.acceptedTestRisk = true;
  assert.equal(approvalGate(candidate, DEFAULT_RULES).passed, true);
});

test("powered products require current platform and route evidence instead of automatic elimination", () => {
  const candidate = passingCandidate({ powered: true });
  assert.equal(approvalGate(candidate, DEFAULT_RULES).passed, false);
  candidate.codexReview.electricalAssessment = {
    status: "verified_allowed",
    sourceType: "real",
    platformAllowed: true,
    logisticsAllowed: true,
    platformSourceUrl: "https://docs.ozon.ru/example",
    logisticsSource: "GUOO current route table",
    checkedAt: "2026-08-01T13:00:00.000Z"
  };
  assert.equal(electricalGate(true, candidate.codexReview.electricalAssessment).passed, true);
  assert.equal(approvalGate(candidate, DEFAULT_RULES).passed, true);
  assert.equal(electricalGate("unknown", null).passed, false);
});

test("required inputs report exact user-fillable fields", () => {
  const fields = requiredInputFields({
    productUrl: "https://example.com/item",
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    dimensionsCm: {}
  }).map((item) => item.field);
  assert.deepEqual(fields, [
    "productName",
    "purchasePriceRmb",
    "packedWeightKg",
    "dimensionsCm"
  ]);
  assert.equal(DEFAULT_RULES.purchaseInput.scope, "all_in_including_domestic_shipping");
});

test("profit stage does not require a source page and stays separate from listing readiness", () => {
  const candidate = {
    productName: "木质机械火车 320片套装",
    purchasePriceRmb: 41,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 23, width: 16, height: 3 },
    powered: false,
    workflowStatus: "codex_processing",
    complianceStatus: "clear",
    authorizationStatus: "clear",
    codexReview: {
      marketEvidence: { comparableCount: 5 },
      commission: { sourceType: "real" },
      logistics: { sourceType: "real" },
      sourceConsistency: { status: "pending" },
      profitCalculation: {
        directionalStatus: "passed",
        status: "directional",
        inputsComplete: true,
        unitProfitRmb: 24,
        marginRate: 0.16
      }
    }
  };
  assert.equal(profitInputStatus(candidate).ready, true);
  assert.equal(selectionStage(candidate).stage, "profit_passed_source_pending");
  assert.equal(selectionStage(candidate).sourcePageBlocksProfit, false);
  assert.equal(approvalGate(candidate).passed, false);
  assert.ok(approvalGate(candidate).blockers.some((item) => item.includes("完整利润复算")));
  candidate.codexReview.sourceConsistency.status = "mismatch";
  const mismatchStage = selectionStage(candidate);
  assert.equal(mismatchStage.stage, "profit_passed_source_mismatch");
  assert.equal(mismatchStage.sourceConsistency, "mismatch_blocks_this_sku_only");
  assert.match(mismatchStage.nextAction, /方向初筛结论不因此淘汰/);
});

test("Codex candidates with verified non-positive purchase ceiling are marked for auto-elimination", () => {
  const candidate = {
    source: "codex",
    workflowStatus: "awaiting_user_direction",
    purchaseCeiling: {
      status: "verified",
      scope: "purchase_plus_domestic_shipping",
      pricingPolicyVersion: DEFAULT_RULES.ozonDandanshu.pricingPolicyVersion,
      sellerRevenueRmb: 100,
      sellerRevenueSourceType: "real",
      sellerRevenueSourceUrl: "https://www.ozon.ru/product/100/",
      commissionRate: 0.14,
      commissionSourceType: "real",
      commissionSourceUrl: "https://seller.ozon.ru/commission",
      internationalLogisticsRmb: 60,
      logisticsSourceType: "real",
      logisticsSource: "GUOO current route table",
      packagingRmb: 1.5,
      labelRmb: 1.5,
      checkedAt: "2026-08-04T08:00:00.000Z"
    }
  };
  const gate = codexAutoEliminationGate(candidate);
  assert.equal(gate.eligible, true);
  assert.equal(gate.shouldEliminate, true);
  assert.ok(gate.maximumAllInPurchaseRmb <= 0);
  assert.match(gate.formula, /最大采购到手价/);
  assert.ok(approvalGate(candidate).blockers.some((item) => item.includes("最大采购到手价")));
});

test("already supplied cost, weight, dimensions, SKU link and power state are never requested again", () => {
  const candidate = {
    sourceUrl: "https://detail.1688.com/offer/123456.html",
    purchasePriceRmb: 43,
    packedWeightKg: 1.5,
    dimensionsCm: { length: 15, width: 15, height: 5 },
    powered: false
  };
  assert.deepEqual(
    filterUserNeededFields(candidate, [
      "sourceUrl",
      "purchasePriceRmb",
      "packedWeightKg",
      "dimensionsCm",
      "powered",
      "notes"
    ]),
    ["notes"]
  );
  assert.deepEqual(
    filterUserNeededFields({ ...candidate, sourceUrl: "https://qr.1688.com/s/abc" }, ["sourceUrl"]),
    ["sourceUrl"]
  );
});

test("daily summary keeps queues exclusive and counts both user and Codex selections toward today's total", () => {
  const candidates = [
    passingCandidate({ workflowStatus: "awaiting_user_direction", selectionDate: "2026-08-01" }),
    passingCandidate({ id: "P2", workflowStatus: "codex_processing", source: "codex", selectionDate: "2026-08-01" }),
    passingCandidate({
      id: "R1",
      workflowStatus: "ready_to_list",
      selectionDate: "2026-08-01",
      readyAt: "2026-07-31T16:30:00.000Z"
    }),
    passingCandidate({ id: "OLD", selectionDate: "2026-07-31" })
  ];
  const summary = dailySummary(candidates, DEFAULT_RULES, "2026-08-01");
  assert.equal(summary.queueCounts.awaiting_user_direction, 1);
  assert.equal(summary.queueCounts.codex_processing, 2);
  assert.equal(summary.queueCounts.ready_to_list, 1);
  assert.equal(summary.stores.dandanshu.ready, 1);
  assert.equal(summary.stores.dandanshu.userSubmittedToday, 2);
  assert.equal(summary.stores.dandanshu.codexAddedToday, 1);
  assert.equal(summary.stores.dandanshu.totalSelectedToday, 3);
  assert.equal(summary.stores.dandanshu.suggestedNewCandidates, 7);
});

test("enough user submissions stop Codex additions even before review finishes", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    passingCandidate({
      id: `USR-${index + 1}`,
      source: "user",
      workflowStatus: "codex_processing",
      selectionDate: "2026-08-01"
    })
  );
  const summary = dailySummary(candidates, DEFAULT_RULES, "2026-08-01");
  assert.equal(summary.stores.dandanshu.userSubmittedToday, 10);
  assert.equal(summary.stores.dandanshu.totalSelectedToday, 10);
  assert.equal(summary.stores.dandanshu.suggestedNewCandidates, 0);
});

test("Miska paused direction keeps existing candidates but stops automatic additions", () => {
  const candidates = [
    passingCandidate({
      id: "MI-EXISTING",
      targetStore: "miska",
      source: "codex",
      workflowStatus: "awaiting_user_direction",
      selectionDate: "2026-07-31"
    })
  ];
  const summary = dailySummary(candidates, DEFAULT_RULES, "2026-08-01");
  assert.equal(summary.queueCounts.awaiting_user_direction, 1);
  assert.equal(summary.stores.miska.automaticAdditionEnabled, false);
  assert.equal(summary.stores.miska.suggestedNewCandidates, 0);
  assert.match(summary.stores.miska.automaticAdditionPauseReason, /只审核用户主动提交/);
  assert.equal(summary.stores.miska.userSampleReviewThreshold, 5);
  assert.equal(DEFAULT_RULES.selectionDirections.miska.sampleDeduplication, "same_product_color_or_size_variants_count_as_one_structural_sample");
  assert.equal(DEFAULT_RULES.selectionDirections.miska.expansionProposalLimit, 3);
});

test("automation receives only explicit user avoidance feedback and rejection reasons", () => {
  const candidate = passingCandidate({
    workflowStatus: "eliminated",
    userEvaluation: { decision: "reject", reason: "体积太大", at: "2026-08-01T01:00:00.000Z" },
    comments: [
      { actor: "user", category: "general", message: "普通记录", at: "2026-08-01T02:00:00.000Z" },
      { actor: "user", category: "elimination_feedback", message: "不要明显低客单价", at: "2026-08-01T03:00:00.000Z" }
    ]
  });
  assert.deepEqual(
    recentAvoidanceFeedback([candidate]).map((item) => item.message),
    ["不要明显低客单价", "体积太大"]
  );
});

test("a run with no substantive progress for 15 minutes is blocked once instead of requeued", () => {
  const candidates = [
    passingCandidate({
      workflowStatus: "codex_processing",
      processing: {
        state: "running",
        runId: "run-stale",
        startedAt: "2026-08-01T02:30:00.000Z",
        currentStep: "读取市场证据",
        lastProgressAt: "2026-08-01T02:40:00.000Z"
      }
    })
  ];
  assert.equal(NO_PROGRESS_TIMEOUT_MINUTES, 15);
  const alerts = stopNoProgressRuns(candidates, new Date("2026-08-01T03:00:00.000Z"));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].candidateId, "PASS-1");
  assert.equal(candidates[0].processing.state, "blocked");
  assert.equal(candidates[0].processing.manualHold, true);
  assert.equal(candidates[0].processing.runId, null);
  assert.deepEqual(stopNoProgressRuns(candidates, new Date("2026-08-01T03:01:00.000Z")), []);
  assert.deepEqual(recoverStaleProcessing(candidates, new Date("2026-08-01T04:00:00.000Z")), []);
});

test("WB suitable badge requires its own evidence and either profit threshold", () => {
  const candidate = passingCandidate();
  const assessment = {
    status: "suitable",
    marketEvidence: {
      sourceType: "real",
      exactMatchStatus: "found",
      exactMatchCount: 3,
      searchUrl: "https://www.wildberries.ru/catalog/0/search.aspx?search=test",
      checkedAt: "2026-08-03T08:00:00.000Z",
      competitors: [
        { url: "https://www.wildberries.ru/catalog/1/detail.aspx", priceRub: 2000 },
        { url: "https://www.wildberries.ru/catalog/2/detail.aspx", priceRub: 2200 },
        { url: "https://www.wildberries.ru/catalog/3/detail.aspx", priceRub: 2400 }
      ],
      medianPriceRub: 2200
    },
    commission: { sourceType: "real" },
    logistics: { sourceType: "real" },
    profitCalculation: {
      status: "verified",
      inputsComplete: true,
      priceBasis: "wb_exact_match_median",
      targetPriceRub: 2200,
      targetPriceRmb: 190,
      unitProfitRmb: 22,
      marginRate: 0.16
    }
  };
  assert.equal(wbAssessmentGate(assessment, candidate, DEFAULT_RULES).passed, true);
  assessment.profitCalculation.marginRate = 0.149;
  assert.equal(wbAssessmentGate(assessment, candidate, DEFAULT_RULES).passed, true);
  assessment.profitCalculation.unitProfitRmb = 19.99;
  assert.equal(wbAssessmentGate(assessment, candidate, DEFAULT_RULES).passed, false);
});

test("powered WB cross-listing needs an independent WB and CEL electrical assessment", () => {
  const candidate = passingCandidate({ powered: true });
  const assessment = {
    status: "suitable",
    marketEvidence: {
      sourceType: "real",
      exactMatchStatus: "not_found",
      exactMatchCount: 0,
      searchUrl: "https://www.wildberries.ru/catalog/0/search.aspx?search=unique",
      searchQuery: "unique product",
      checkedAt: "2026-08-03T08:00:00.000Z"
    },
    electricalAssessment: {
      status: "verified_allowed",
      sourceType: "real",
      platformAllowed: true,
      logisticsAllowed: true,
      platformSourceUrl: "https://seller.wildberries.ru/example",
      logisticsSource: "CEL current route table",
      checkedAt: "2026-08-01T13:00:00.000Z"
    },
    commission: { sourceType: "real" },
    logistics: { sourceType: "real" },
    profitCalculation: {
      status: "verified",
      inputsComplete: true,
      priceBasis: "wb_cost_based_suggested",
      recommendedPriceRub: 2600,
      targetPriceRub: 2600,
      targetPriceRmb: 220,
      unitProfitRmb: 22,
      marginRate: 0.16
    }
  };
  assert.equal(wbAssessmentGate(assessment, candidate, DEFAULT_RULES).passed, true);
  assessment.electricalAssessment.logisticsAllowed = false;
  assert.equal(wbAssessmentGate(assessment, candidate, DEFAULT_RULES).passed, false);
});

test("WB exact-match profit must use the verified competitor median instead of Ozon price", () => {
  const candidate = passingCandidate();
  const assessment = {
    status: "suitable",
    marketEvidence: {
      sourceType: "real",
      exactMatchStatus: "found",
      exactMatchCount: 2,
      searchUrl: "https://www.wildberries.ru/catalog/0/search.aspx?search=exact",
      checkedAt: "2026-08-03T08:00:00.000Z",
      competitors: [
        { url: "https://www.wildberries.ru/catalog/11/detail.aspx", priceRub: 1800 },
        { url: "https://www.wildberries.ru/catalog/12/detail.aspx", priceRub: 2200 }
      ],
      medianPriceRub: 2000
    },
    commission: { sourceType: "real" },
    logistics: { sourceType: "real" },
    profitCalculation: {
      status: "verified",
      inputsComplete: true,
      priceBasis: "wb_exact_match_median",
      targetPriceRub: 2500,
      targetPriceRmb: 210,
      unitProfitRmb: 22,
      marginRate: 0.16
    }
  };
  const gate = wbAssessmentGate(assessment, candidate, DEFAULT_RULES);
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((item) => item.includes("中位价")));
});

test("WB verified no-exact-match branch defaults to suitable with a cost-based suggested price", () => {
  const candidate = passingCandidate();
  const assessment = {
    status: "suitable",
    marketEvidence: {
      sourceType: "real",
      exactMatchStatus: "not_found",
      exactMatchCount: 0,
      searchUrl: "https://www.wildberries.ru/catalog/0/search.aspx?search=unique",
      searchQuery: "unique",
      checkedAt: "2026-08-03T08:00:00.000Z"
    },
    commission: { sourceType: "real" },
    logistics: { sourceType: "real" },
    profitCalculation: {
      status: "verified",
      inputsComplete: true,
      priceBasis: "wb_cost_based_suggested",
      recommendedPriceRub: 3100,
      targetPriceRub: 3100,
      targetPriceRmb: 260,
      unitProfitRmb: 20,
      marginRate: 0.1
    }
  };
  assert.equal(wbAssessmentDecisionGate(assessment, candidate, DEFAULT_RULES).passed, true);
  assessment.status = "notSuitable";
  assessment.reason = "无同款但想淘汰";
  assert.equal(wbAssessmentDecisionGate(assessment, candidate, DEFAULT_RULES).passed, false);
});

test("WB technical failure cannot be recorded as no exact match", () => {
  const candidate = passingCandidate();
  const assessment = {
    status: "suitable",
    marketEvidence: {
      sourceType: "technical_failure",
      exactMatchStatus: "not_found",
      exactMatchCount: 0,
      searchUrl: "https://www.wildberries.ru/catalog/0/search.aspx?search=test",
      searchQuery: "test",
      checkedAt: "2026-08-03T08:00:00.000Z"
    },
    commission: { sourceType: "real" },
    logistics: { sourceType: "real" },
    profitCalculation: {
      status: "verified",
      inputsComplete: true,
      priceBasis: "wb_cost_based_suggested",
      recommendedPriceRub: 3000,
      targetPriceRub: 3000,
      targetPriceRmb: 250,
      unitProfitRmb: 20,
      marginRate: 0.1
    }
  };
  assert.equal(wbAssessmentDecisionGate(assessment, candidate, DEFAULT_RULES).passed, false);
});
