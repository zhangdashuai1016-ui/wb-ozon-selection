import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexDispatcher,
  DISPATCH_OUTPUT_SCHEMA,
  dispatchCandidateSnapshot,
  dispatchCapabilityPlan,
  parseDispatchOutput,
  requiredSkillsForDispatch
} from "../lib/codex-dispatcher.mjs";

const candidate = {
  id: "SKU-ONE",
  dataRevision: 7,
  workflowStatus: "codex_processing",
  source: "user",
  targetStore: "dandanshu",
  productName: "当前SKU",
  productUrl: "https://www.ozon.ru/product/123/?token=do-not-copy#private",
  sourceUrl: "https://detail.1688.com/offer/456.html?spm=tracking",
  purchasePriceRmb: 12.5,
  packagingCostRmb: 1.5,
  packedWeightKg: 0.3,
  dimensionsCm: { length: 10, width: 9, height: 8 },
  powered: false,
  complianceStatus: "clear",
  authorizationStatus: "clear"
};

test("dispatch payload carries the exact SKU revision without callback or tokenized URLs", async () => {
  const requests = [];
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.inspectRoute = async () => ({ status: "idle" });
  dispatcher.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-real-123", status: "inProgress" } };
    return {};
  };
  const dispatch = {
    id: "D-ONE",
    scope: "candidate",
    candidateId: candidate.id,
    assigneeRole: "selection_task",
    dataRevision: candidate.dataRevision,
    candidateSnapshot: dispatchCandidateSnapshot(candidate),
    message: "只处理当前SKU一次"
  };
  const route = { threadId: "selection-thread", projectPath: "/project" };
  const node = { id: "M05", title: "市场、佣金与物流证据" };

  const result = await dispatcher.deliver(dispatch, route, node, candidate);
  assert.deepEqual(result, {
    status: "running",
    turnId: "turn-real-123",
    detail: "负责人任务已启动，已取得真实运行编号",
    attachedSkills: []
  });
  assert.deepEqual(requests.map((item) => item.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(requests[0].params, { threadId: "selection-thread", excludeTurns: true });
  const prompt = requests[1].params.input[0].text;
  assert.match(prompt, /"candidateId":"SKU-ONE"/);
  assert.match(prompt, /"dataRevision":7/);
  assert.match(prompt, /"purchasePriceRmb":12.5/);
  assert.doesNotMatch(prompt, /do-not-copy|spm=tracking/);
  assert.match(prompt, /本轮只完成A\/B选品与利润工作/);
  assert.match(prompt, /B阶段不得打开1688/);
  assert.match(prompt, /不得把这些项目重新要求主人补充/);
  assert.match(prompt, /选品任务到此停止/);
  assert.doesNotMatch(prompt, /自动为同一选品任务衔接C阶段/);
  assert.match(prompt, /估算费率不得冒充当前平台事实/);
  assert.match(prompt, /resultType必须为selection_review/);
  assert.match(prompt, /不要连接127\.0\.0\.1:4317/);
  assert.match(prompt, /outputSchema约束/);
  assert.deepEqual(requests[1].params.outputSchema, DISPATCH_OUTPUT_SCHEMA);
});

test("C-stage dispatch goes to listing with inherited inputs, capture evidence, and explicit skill items", async () => {
  const requests = [];
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.inspectRoute = async () => ({ status: "idle" });
  dispatcher.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-c-real", status: "inProgress" } };
    return {};
  };
  const cCandidate = {
    ...candidate,
    workflowStatus: "listing_preparation",
    sourceCapture: {
      captureId: "CAP-ONE",
      status: "verified",
      offerId: "456",
      sourceUrl: "https://detail.1688.com/offer/456.html",
      selectedSkus: [{ sourceSkuId: "sku-320", attributes: { 片数: "320片" }, priceCny: 12.5 }]
    }
  };
  const node = { id: "M07", title: "C阶段SKU、来源与合规" };
  const dispatch = {
    id: "D-C",
    scope: "candidate",
    candidateId: cCandidate.id,
    assigneeRole: "listing_task",
    dataRevision: cCandidate.dataRevision,
    candidateSnapshot: dispatchCandidateSnapshot(cCandidate),
    capabilityPlan: dispatchCapabilityPlan(node, cCandidate),
    requiredSkills: requiredSkillsForDispatch(node, cCandidate),
    message: "只做当前SKU的C阶段"
  };

  const result = await dispatcher.deliver(dispatch, { threadId: "listing-thread", projectPath: "/project" }, node, cCandidate);
  assert.deepEqual(result.attachedSkills, ["ozon-wb-pricing", "optimize-ecommerce-seo"]);
  const inputs = requests.find((item) => item.method === "turn/start").params.input;
  assert.deepEqual(inputs.map((item) => item.type), ["text", "skill", "skill"]);
  assert.match(inputs[0].text, /^\$ozon-wb-pricing \$optimize-ecommerce-seo/);
  assert.deepEqual(inputs.slice(1).map((item) => item.name), ["ozon-wb-pricing", "optimize-ecommerce-seo"]);
  assert.match(inputs[0].text, /采购到手总价、真实打包重量、尺寸、目标店铺和精确1688链接均为前期已填写的继承输入/);
  assert.match(inputs[0].text, /不得重新打开1688/);
  assert.match(inputs[0].text, /CAP-ONE/);
});

test("structured dispatch output is parsed without a reverse callback", () => {
  const parsed = parseDispatchOutput(JSON.stringify({
    status: "completed",
    reply: "利润审核完成",
    resultType: "selection_review",
    resultJson: JSON.stringify({ decision: "approved" }),
    evidenceSummary: "当前市场与利润证据"
  }));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.resultType, "selection_review");
  assert.deepEqual(JSON.parse(parsed.resultJson), { decision: "approved" });
});

test("listing dispatch does not receive selection B-to-C continuation instructions", () => {
  const dispatcher = new CodexDispatcher({ enabled: false });
  const prompt = dispatcher.buildPrompt(
    {
      id: "D-LIST",
      scope: "candidate",
      candidateId: candidate.id,
      assigneeRole: "listing_task",
      message: "准备上架"
    },
    { id: "M09", title: "上架准备与最终确认" },
    candidate
  );
  assert.doesNotMatch(prompt, /覆盖B阶段到C阶段的连续选品处理/);
});

test("busy assignee remains waiting and no turn is started", async () => {
  const events = [];
  const requests = [];
  const dispatcher = new CodexDispatcher({ enabled: false, onEvent: (event) => events.push(event) });
  dispatcher.inspectRoute = async () => ({ status: "active" });
  dispatcher.request = async (method) => {
    requests.push(method);
    return {};
  };
  const result = await dispatcher.deliver(
    { id: "D-BUSY", scope: "candidate", candidateId: candidate.id, message: "一次" },
    { threadId: "selection-thread", projectPath: "/project" },
    { id: "M05", title: "市场、佣金与物流证据" },
    candidate
  );
  assert.deepEqual(result, { status: "waiting_assignee", detail: "负责人任务存在未结束轮次" });
  assert.deepEqual(requests, ["thread/resume"]);
  dispatcher.handle({
    method: "thread/status/changed",
    params: { threadId: "selection-thread", status: { type: "idle" } }
  });
  await dispatcher.eventQueue;
  assert.deepEqual(events, [{ type: "assignee_available", dispatchId: "D-BUSY", threadId: "selection-thread" }]);
});

test("a writer lock from another client stops instead of polling forever", async () => {
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.inspectRoute = async () => ({ status: "active" });
  dispatcher.request = async () => {
    throw new Error("thread selection-thread already has an active writer");
  };
  const result = await dispatcher.deliver(
    { id: "D-LOCKED", scope: "candidate", candidateId: candidate.id, message: "一次" },
    { threadId: "selection-thread", projectPath: "/project" },
    { id: "M05", title: "市场、佣金与物流证据" },
    candidate
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.failureLayer, "codex_thread_writer_lock");
  assert.match(result.detail, /停止自动重试/);
});

test("an idle-looking desktop-owned assignee stops truthfully instead of staying queued", async () => {
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.inspectRoute = async () => ({ status: "notLoaded" });
  dispatcher.request = async () => {
    throw new Error("thread listing-thread already has an active writer");
  };
  const result = await dispatcher.deliver(
    { id: "D-DESKTOP-LOCK", scope: "candidate", candidateId: candidate.id, message: "一次" },
    { threadId: "listing-thread", projectPath: "/project" },
    { id: "M07", title: "C阶段SKU、来源与合规" },
    candidate
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.failureLayer, "codex_desktop_writer_lock");
  assert.match(result.detail, /停止而不是继续假排队/);
});

test("a desktop-started turn is adopted only when the stored turn contains the exact dispatch id", async () => {
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.ensureStarted = async () => undefined;
  dispatcher.request = async (method, params) => {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.threadId, "listing-thread");
    return {
      data: [{
        id: "turn-desktop-1",
        status: "inProgress",
        items: [{ type: "userMessage", content: [{ type: "text", text: "派发编号：D-DESKTOP-1" }] }]
      }]
    };
  };
  const result = await dispatcher.verifyDesktopTurn(
    { threadId: "listing-thread" },
    "turn-desktop-1",
    "D-DESKTOP-1"
  );
  assert.deepEqual(result, { turnId: "turn-desktop-1", status: "inProgress" });
  await assert.rejects(
    dispatcher.verifyDesktopTurn({ threadId: "listing-thread" }, "turn-desktop-1", "D-WRONG"),
    /派发编号不一致/
  );
});

test("an interrupted stored snapshot can be adopted only when the desktop still owns the writer", async () => {
  const dispatcher = new CodexDispatcher({ enabled: false });
  dispatcher.ensureStarted = async () => undefined;
  dispatcher.request = async (method) => {
    if (method === "thread/turns/list") {
      return {
        data: [{
          id: "turn-desktop-live",
          status: "interrupted",
          items: [{ type: "userMessage", content: [{ type: "text", text: "D-DESKTOP-LIVE" }] }]
        }]
      };
    }
    throw new Error("thread listing-thread already has an active writer");
  };
  const result = await dispatcher.verifyDesktopTurn(
    { threadId: "listing-thread" },
    "turn-desktop-live",
    "D-DESKTOP-LIVE"
  );
  assert.deepEqual(result, {
    turnId: "turn-desktop-live",
    status: "inProgress",
    liveWriterConfirmed: true
  });
});
