import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 43923;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function candidate(id, overrides = {}) {
  return {
    id,
    source: "codex",
    group: "codexPool",
    targetStore: "dandanshu",
    productName: `测试商品${id}`,
    productUrl: `https://www.ozon.ru/product/${id}/`,
    sourceUrl: "",
    purchasePriceRmb: 10,
    packagingCostRmb: 1.5,
    packedWeightKg: 0.3,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    workflowStatus: "codex_processing",
    processing: { state: "blocked", dispatchState: "blocked", manualHold: true },
    dataRevision: 1,
    comments: [],
    history: [],
    ...overrides
  };
}

test("stopped backlog is classified without asking for handwritten advice", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selection-recovery-"));
  const dataFile = path.join(directory, "candidates.json");
  await writeFile(dataFile, JSON.stringify({
    meta: { version: 2, title: "test", updatedAt: "2026-08-11T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates: [
      candidate("SYSTEM"),
      candidate("MISSING", { purchasePriceRmb: null }),
      candidate("DECISION"),
      candidate("EXTERNAL")
    ],
    dispatches: [
      {
        id: "D-SYSTEM", candidateId: "SYSTEM", nodeId: "M12", nodeTitle: "异常停止", scope: "candidate",
        dataRevision: 1, workflowStatusAtDispatch: "codex_processing", assigneeRole: "control_task",
        status: "failed", failureLayer: "codex_app_server", error: "active writer", createdAt: "2026-08-11T01:00:00.000Z"
      },
      {
        id: "D-DECISION", candidateId: "DECISION", nodeId: "M04", nodeTitle: "B阶段资料准备", scope: "candidate",
        dataRevision: 1, workflowStatusAtDispatch: "codex_processing", assigneeRole: "selection_task",
        status: "needs_decision", agentReply: "当前精确佣金未取得，需要主人允许估算佣金", createdAt: "2026-08-11T01:01:00.000Z"
      },
      {
        id: "D-EXTERNAL", candidateId: "EXTERNAL", nodeId: "M05", nodeTitle: "市场证据", scope: "candidate",
        dataRevision: 1, workflowStatusAtDispatch: "codex_processing", assigneeRole: "selection_task",
        status: "failed", failureLayer: "codex_app_server", error: "连接不可用", createdAt: "2026-08-11T01:02:00.000Z"
      }
    ]
  }));

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
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => child.kill("SIGTERM"));
  await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, `测试服务未启动：${stderr.join("")}`);

  const preview = await (await fetch(`${baseUrl}/api/control/reconcile-stopped`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: false })
  })).json();
  assert.deepEqual(preview.preview.map((item) => item.kind), ["system_recovery", "needs_data", "business_decision", "external_failure"]);

  const response = await fetch(`${baseUrl}/api/control/reconcile-stopped`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dispatchIds.length, 0);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const byId = Object.fromEntries(state.candidates.map((item) => [item.id, item]));
  assert.equal(byId.SYSTEM.processing.state, "blocked");
  assert.equal(byId.SYSTEM.processing.dispatchState, "legacy_read_only");
  assert.equal(byId.SYSTEM.activeDispatch, null);
  assert.equal(byId.MISSING.workflowStatus, "needs_user_data");
  assert.deepEqual(byId.MISSING.needsFromUser, ["采购到手总价（含国内运费）"]);
  assert.deepEqual(byId.MISSING.neededFieldKeys, ["purchasePriceRmb"]);
  assert.deepEqual(byId.DECISION.processing.recoveryDecision.actions.map((item) => item.id), ["allow_estimated_commission", "keep_stopped"]);
  assert.deepEqual(byId.EXTERNAL.processing.recoveryDecision.actions.map((item) => item.id), ["retry_current_stage_once", "keep_stopped"]);
  assert.equal(state.meta.automationStarted, false);
});
