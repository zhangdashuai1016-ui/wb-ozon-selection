/**
 * 换正式版本指针之前的**强制前置**：用真实 plist 的环境值，把待发包在隔离端口起一次。
 * 健康 200 才允许继续部署。
 *
 * 为什么是死规矩：2026-09-24 r70 首次部署失败就栽在这。当时的隔离冒烟用的是**合成绑定的
 * 环境值**，而那一轮新增的配置键只出现在**真实配置**里——于是「读环境变量那条入口的键校验」
 * 从未被走到，换了正式指针才发现服务根本起不来（runs = 8、last exit code = 1）。
 * 详见 docs/handoff/部署失败与回滚回执-r70-2026-09-24.md。
 *
 * 安全约束：
 *  - 只输出环境变量的**键数**与健康状态，不打印任何值；
 *  - 失败时打印子进程 stderr 的前几行帮助定位，但**逐行过滤掉可能含凭据的行**；
 *  - 拒绝对正式数据文件运行，必须给副本。
 *
 * 用法：node scripts/verify-package-with-real-env.mjs <包目录> <数据副本> [端口]
 */
import { execFileSync, spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { safeDiagnosticLines } from "./deployment-diagnostic-redaction.mjs";

async function main() {
  const PLIST = path.join(process.env.HOME, "Library/LaunchAgents/com.shuaizhang.selection-review-app.plist");
  const LIVE_DATA = path.join(process.env.HOME, "Library/Application Support/今日选品评审台/data/candidates.json");

  const [appDirectory, dataCopy, port = "45973"] = process.argv.slice(2);
  if (!appDirectory || !dataCopy) {
    console.error("用法：node scripts/verify-package-with-real-env.mjs <包目录> <数据副本> [端口]");
    process.exit(64);
  }
  const resolved = file => { try { return fsSync.realpathSync(file); } catch { return path.resolve(file); } };
  if (resolved(dataCopy) === resolved(LIVE_DATA)) {
    console.error("拒绝：必须给数据副本，不能对正式数据运行。");
    process.exit(65);
  }

  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", PLIST]).toString());
  const plistEnv = plist.EnvironmentVariables ?? {};
  const env = { ...process.env, ...plistEnv, SELECTION_REVIEW_DATA_FILE: dataCopy, SELECTION_REVIEW_PORT: port };
  console.log(`用真实 plist 环境值启动（未打印任何值），环境键数 ${Object.keys(plistEnv).length}，端口 ${port}`);

  const child = spawn(process.execPath, [path.join(appDirectory, "server.mjs")],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdout.on("data", () => {});

  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) { healthy = true; break; }
    } catch { /* 还没起来，继续等 */ }
  }

  if (healthy) {
    console.log("✅ 新包用真实配置能起来，健康 HTTP 200——允许继续部署。");
    child.kill("SIGTERM");
    process.exit(0);
  }
  console.log("❌ 新包用真实配置起不来——**不要换正式版本指针**。");
  if (child.exitCode !== null) console.log(`   子进程退出码：${child.exitCode}`);
  const lines = safeDiagnosticLines(stderr);
  for (const line of lines) console.log("   " + line);
  if (lines.length === 0) console.log("   （stderr 中没有可安全打印的定位行，请直接查看服务日志）");
  child.kill("SIGKILL");
  process.exit(1);
}

await main();
