import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const commandPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "启动今日选品评审台.command"
);

async function writeExecutable(filePath, body) {
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

async function mockEnvironment(t, { healthBody }) {
  const root = await mkdir(path.join(tmpdir(), `selection-review-launch-${process.pid}-${Math.random().toString(36).slice(2)}`), { recursive: true });
  const binDir = path.join(root, "bin");
  const appDir = path.join(root, "app");
  const runtimeRoot = path.join(root, "runtime");
  const logFile = path.join(root, "calls.log");
  await mkdir(binDir);
  await mkdir(appDir);
  await mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  await writeExecutable(path.join(binDir, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
printf '%s\\n' "$SELECTION_REVIEW_LAUNCH_TEST_HEALTH_BODY"
exit 0
`);
  await writeExecutable(path.join(binDir, "open"), `#!/bin/sh
printf 'open %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "launchctl"), `#!/bin/sh
printf 'launchctl %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "sleep"), `#!/bin/sh
printf 'sleep %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "osascript"), `#!/bin/sh
printf 'osascript %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(runtimeRoot, "scripts", "launch-server.sh"), `#!/bin/sh
printf 'starter %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  t.after(async () => {
    await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
  });
  return {
    appDir,
    runtimeRoot,
    logFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SELECTION_REVIEW_APP_DIR: appDir,
      SELECTION_REVIEW_RUNTIME_ROOT: runtimeRoot,
      SELECTION_REVIEW_REVIEW_ORIGIN: "http://127.0.0.1:4317/",
      SELECTION_REVIEW_SERVICE: "gui/test.selection-review-app",
      SELECTION_REVIEW_LAUNCH_TEST_LOG: logFile,
      SELECTION_REVIEW_LAUNCH_TEST_HEALTH_BODY: healthBody
    }
  };
}

test("启动脚本健康检查使用单斜杠URL且校验服务响应", async (t) => {
  const { env, logFile } = await mockEnvironment(t, {
    healthBody: '{"ok":true,"service":"selection-review-app"}'
  });
  await execFileAsync("bash", [commandPath], { env });
  const log = await readFile(logFile, "utf8");
  assert.match(log, /curl --fail --silent http:\/\/127\.0\.0\.1:4317\/api\/health/);
  assert.doesNotMatch(log, /\/\/api\/health/);
  assert.match(log, /open http:\/\/127\.0\.0\.1:4317\//);
  assert.doesNotMatch(log, /launchctl/);
  assert.doesNotMatch(log, /starter/);
});

test("启动脚本不把任意200健康响应当作评审台已就绪", async (t) => {
  const { env, logFile } = await mockEnvironment(t, {
    healthBody: '{"ok":true,"service":"wrong-service"}'
  });
  await execFileAsync("bash", [commandPath], { env });
  const log = await readFile(logFile, "utf8");
  assert.match(log, /launchctl kickstart -k gui\/test\.selection-review-app/);
  assert.match(log, /starter/);
});
