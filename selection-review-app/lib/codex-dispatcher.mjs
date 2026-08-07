import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";

function plainStatus(status) {
  if (!status) return "unknown";
  return typeof status === "string" ? status : status.type || "unknown";
}

function safeMessage(value) {
  return String(value || "").trim().slice(0, 12000);
}

export class CodexDispatcher {
  constructor({ onEvent, enabled = true, codexBin = process.env.SELECTION_REVIEW_CODEX_BIN || DEFAULT_CODEX_BIN } = {}) {
    this.onEvent = onEvent || (() => undefined);
    this.enabled = enabled && process.env.SELECTION_REVIEW_CODEX_DISPATCH !== "off";
    this.codexBin = codexBin;
    this.process = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.threadDispatches = new Map();
    this.approvals = new Map();
    this.initialized = false;
    this.initializing = null;
  }

  async ensureStarted() {
    if (!this.enabled) throw new Error("Codex一次性派发已在当前运行环境关闭");
    if (!fs.existsSync(this.codexBin)) throw new Error(`找不到Codex本机程序：${this.codexBin}`);
    if (this.process && this.process.exitCode === null && this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      this.process = child;
      this.initialized = false;
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-5000);
      });
      child.stdout.on("data", (chunk) => this.consume(String(chunk)));
      child.on("error", reject);
      child.on("exit", (code) => {
        const error = new Error(`Codex App Server已停止（${code ?? "unknown"}）：${stderr.trim() || "无更多信息"}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.process = null;
        this.initialized = false;
        this.initializing = null;
      });

      this.request("initialize", {
        clientInfo: {
          name: "selection-review-app",
          title: "今日选品评审台",
          version: "1.0.0"
        },
        capabilities: { experimentalApi: false }
      }, child).then(() => {
        this.notify("initialized", {}, child);
        this.initialized = true;
        this.initializing = null;
        resolve();
      }).catch((error) => {
        this.initializing = null;
        reject(error);
      });
    });
    return this.initializing;
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.handle(JSON.parse(line));
        } catch {}
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  handle(message) {
    if (Object.hasOwn(message, "id") && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex App Server请求失败"));
      else pending.resolve(message.result);
      return;
    }

    const params = message.params || {};
    const turnId = params.turn?.id || params.turnId || params.item?.turnId;
    const dispatchId = turnId ? this.turns.get(turnId) : null;

    if (Object.hasOwn(message, "id") && message.method) {
      const approvalDispatchId = dispatchId || this.findDispatchByThread(params.threadId);
      if (!approvalDispatchId) {
        this.respond(message.id, { decision: "decline" });
        return;
      }
      const approval = {
        requestId: String(message.id),
        method: message.method,
        reason: safeMessage(params.reason || params.message || "Codex请求本次额外权限"),
        cwd: safeMessage(params.cwd),
        availableDecisions: params.availableDecisions || ["accept", "decline"],
        createdAt: new Date().toISOString()
      };
      this.approvals.set(`${approvalDispatchId}:${message.id}`, message.id);
      this.onEvent({ type: "approval", dispatchId: approvalDispatchId, approval });
      return;
    }

    if (!dispatchId) return;
    if (message.method === "item/agentMessage/delta") {
      this.onEvent({ type: "assistant_delta", dispatchId, text: safeMessage(params.delta) });
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      this.onEvent({ type: "assistant_message", dispatchId, text: safeMessage(params.item.text || params.item.content) });
    } else if (message.method === "turn/completed") {
      this.onEvent({
        type: "turn_completed",
        dispatchId,
        turnId,
        status: params.turn?.status || "completed",
        error: safeMessage(params.turn?.error?.message || params.turn?.error)
      });
      this.turns.delete(turnId);
    }
  }

  findDispatchByThread(threadId) {
    return this.threadDispatches.get(threadId) || null;
  }

  request(method, params, child = this.process) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!child?.stdin?.writable) return reject(new Error("Codex App Server连接不可写"));
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params, child = this.process) {
    if (!child?.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async inspectRoute(route) {
    await this.ensureStarted();
    const result = await this.request("thread/read", { threadId: route.threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread) throw new Error("Codex任务不存在");
    if (route.title && thread.name && thread.name !== route.title) {
      throw new Error(`任务标题不一致：期望“${route.title}”，实际“${thread.name}”`);
    }
    const cwd = thread.cwd || thread.session?.cwd || "";
    if (cwd && route.projectPath && cwd !== route.projectPath) {
      throw new Error(`任务项目目录不一致：${cwd}`);
    }
    return { thread, status: plainStatus(thread.status) };
  }

  buildPrompt(dispatch, node, candidate) {
    const scopeText = dispatch.scope === "workflow" ? "整个评审流程" : `当前SKU ${candidate?.id || dispatch.candidateId}`;
    const claimUrl = `http://127.0.0.1:4317/api/dispatches/${dispatch.id}/claim`;
    const progressUrl = `http://127.0.0.1:4317/api/dispatches/${dispatch.id}/progress`;
    const completeUrl = `http://127.0.0.1:4317/api/dispatches/${dispatch.id}/complete`;
    return [
      "【今日选品评审台一次性派发】",
      `派发编号：${dispatch.id}`,
      `节点：${node.id} ${node.title}`,
      `范围：${scopeText}`,
      candidate ? `商品：${candidate.productName}` : "商品：无（流程级意见）",
      candidate ? `当前数据修订号：${candidate.dataRevision}` : "当前数据修订号：不适用",
      `主人留言：${dispatch.message}`,
      "",
      "只处理这一条明确派发，不领取下一条，不开启连续自动化。先读取评审台当前状态和修订号，不凭聊天旧值工作。",
      `开始实质工作前，POST ${claimUrl}，JSON至少包含 {\"runId\":\"本轮唯一编号\",\"currentStep\":\"当前真实步骤\"}。`,
      `取得新证据或步骤变化后，POST ${progressUrl}，JSON包含 {\"runId\":\"同一编号\",\"currentStep\":\"新步骤\",\"evidence\":\"新增证据摘要\"}。`,
      `完成、真实阻塞或需要主人决定时，POST ${completeUrl}，JSON包含 {\"runId\":\"同一编号\",\"status\":\"completed|blocked|needs_decision\",\"reply\":\"给主人的简短人话\",\"evidence\":\"完成证据或失败层\"}。`,
      "普通节点留言不授权店铺生产写入。涉及平台、店铺、SKU、价格、库存、素材或发布，缺精确生产确认卡时必须停止并写 needs_decision。",
      "若技术失败，说明失败层、是否产生写入和最小恢复动作；同一路径不要重复尝试。"
    ].join("\n");
  }

  async deliver(dispatch, route, node, candidate) {
    const inspected = await this.inspectRoute(route);
    if (["active", "systemError"].includes(inspected.status)) {
      return { status: "waiting_assignee", detail: inspected.status === "active" ? "负责人正在处理其他工作" : "负责人任务当前异常" };
    }
    await this.request("thread/resume", { threadId: route.threadId });
    const result = await this.request("turn/start", {
      threadId: route.threadId,
      input: [{ type: "text", text: this.buildPrompt(dispatch, node, candidate) }],
      cwd: route.projectPath
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex任务没有返回本轮编号");
    this.turns.set(turnId, dispatch.id);
    this.threadDispatches.set(route.threadId, dispatch.id);
    return { status: "received", turnId, detail: "负责人任务已接收一次性派发" };
  }

  resolveApproval(dispatchId, requestId, decision) {
    const key = `${dispatchId}:${requestId}`;
    const rawId = this.approvals.get(key);
    if (rawId === undefined) throw new Error("权限请求已失效或不属于当前派发");
    this.approvals.delete(key);
    this.respond(rawId, { decision });
  }
}
