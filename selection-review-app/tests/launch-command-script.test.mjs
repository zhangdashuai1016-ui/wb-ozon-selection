import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "selection-review-launch-")));
  const binDir = path.join(root, "bin");
  const appDir = path.join(root, "app");
  const runtimeRoot = path.join(root, "runtime");
  const logFile = path.join(root, "calls.log");
  await mkdir(binDir);
  await mkdir(appDir);
  await mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  await writeExecutable(path.join(binDir, "curl"), `#!/bin/bash
printf 'curl %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
printf '%s\\n' "$SELECTION_REVIEW_LAUNCH_TEST_HEALTH_BODY"
exit "\${SELECTION_REVIEW_LAUNCH_TEST_CURL_EXIT:-0}"
`);
  await writeExecutable(path.join(binDir, "open"), `#!/bin/bash
printf 'open %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "launchctl"), `#!/bin/bash
printf 'launchctl %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "sleep"), `#!/bin/bash
printf 'sleep %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(binDir, "osascript"), `#!/bin/bash
printf 'osascript %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  await writeExecutable(path.join(runtimeRoot, "scripts", "launch-server.sh"), `#!/bin/bash
printf 'starter %s\\n' "$*" >> "$SELECTION_REVIEW_LAUNCH_TEST_LOG"
exit 0
`);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    appDir,
    root,
    runtimeRoot,
    logFile,
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      SELECTION_REVIEW_LAUNCH_NODE: process.execPath,
      SELECTION_REVIEW_APP_DIR: appDir,
      SELECTION_REVIEW_RUNTIME_ROOT: runtimeRoot,
      SELECTION_REVIEW_REVIEW_ORIGIN: "http://127.0.0.1:48991/",
      SELECTION_REVIEW_SERVICE: "gui/test.selection-review-app",
      SELECTION_REVIEW_LAUNCH_TEST_LOG: logFile,
      SELECTION_REVIEW_LAUNCH_TEST_HEALTH_BODY: healthBody
    }
  };
}

test("启动脚本健康检查使用单斜杠URL且校验服务响应", async (t) => {
  const { env, logFile } = await mockEnvironment(t, {
    healthBody: '{"ok":true,"service":"selection-review-app","version":2,"dataVersion":2}'
  });
  await execFileAsync("/bin/bash", [commandPath], { env, timeout: 5000 });
  const log = await readFile(logFile, "utf8");
  assert.match(log, /curl .*http:\/\/127\.0\.0\.1:48991\/api\/health/);
  assert.match(log, /--connect-timeout 2 --max-time 5 --noproxy \*/);
  assert.doesNotMatch(log, /\/\/api\/health/);
  assert.match(log, /open http:\/\/127\.0\.0\.1:48991\//);
  assert.doesNotMatch(log, /launchctl/);
  assert.doesNotMatch(log, /starter/);
});

test("启动脚本不把任意200健康响应当作评审台已就绪", async (t) => {
  const { env, logFile } = await mockEnvironment(t, {
    healthBody: '{"ok":true,"service":"wrong-service"}'
  });
  await assert.rejects(execFileAsync("/bin/bash", [commandPath], { env, timeout: 5000 }), { code: 69 });
  const log = await readFile(logFile, "utf8");
  assert.doesNotMatch(log, /launchctl|starter|open |sleep /);
});

for (const healthBody of ["invalid JSON", '{"ok":true,"service":"selection-review-app","version":1,"dataVersion":2}', '{"ok":false,"service":"selection-review-app","version":2,"dataVersion":2}']) {
  test(`桌面入口拒绝无效健康合同：${healthBody}`, async t => {
    const { env, logFile } = await mockEnvironment(t, { healthBody });
    await assert.rejects(execFileAsync("/bin/bash", [commandPath], { env, timeout: 5000 }), { code: 69 });
    assert.doesNotMatch(await readFile(logFile, "utf8"), /launchctl|starter|open |sleep /);
  });
}

test("桌面入口网络失败只查询一次，不启动或重启服务", async t => {
  const { env, logFile } = await mockEnvironment(t, { healthBody: "" });
  env.SELECTION_REVIEW_LAUNCH_TEST_CURL_EXIT = "7";
  await assert.rejects(execFileAsync("/bin/bash", [commandPath], { env, timeout: 5000 }), { code: 69 });
  const log = await readFile(logFile, "utf8");
  assert.equal(log.split("\n").filter(line => line.startsWith("curl ")).length, 1);
  assert.doesNotMatch(log, /launchctl|starter|open |sleep /);
});

test("桌面入口拒绝非本机地址，校验失败前不执行请求", async t => {
  const { env, logFile } = await mockEnvironment(t, { healthBody: "" });
  env.SELECTION_REVIEW_REVIEW_ORIGIN = "https://synthetic.invalid/";
  await assert.rejects(execFileAsync("/bin/bash", [commandPath], { env, timeout: 5000 }), { code: 64 });
  await assert.rejects(readFile(logFile), { code: "ENOENT" });
});

test("桌面入口缺显式服务地址时停止，不访问旧默认端口", async t => {
  const { env, logFile } = await mockEnvironment(t, { healthBody: "" });
  for (const origin of [undefined, ""]) {
    const launchEnv = { ...env };
    if (origin === undefined) delete launchEnv.SELECTION_REVIEW_REVIEW_ORIGIN;
    else launchEnv.SELECTION_REVIEW_REVIEW_ORIGIN = origin;
    await assert.rejects(execFileAsync("/bin/bash", [commandPath], { env: launchEnv, timeout: 5000 }), error => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /必须明确提供 SELECTION_REVIEW_REVIEW_ORIGIN/);
      assert.equal(error.stdout, "");
      return true;
    });
    await assert.rejects(readFile(logFile), { code: "ENOENT" });
  }
});

async function syntheticLauncher(t) {
  const fixture = await mockEnvironment(t, { healthBody: "" });
  await mkdir(path.join(fixture.runtimeRoot, "runtime"));
  await copyFile(path.join(path.dirname(commandPath), "scripts/launch-server.sh"), path.join(fixture.runtimeRoot, "scripts/launch-server.sh"));
  await writeExecutable(path.join(fixture.runtimeRoot, "runtime/node"), '#!/bin/bash\nexec "$SELECTION_REVIEW_TEST_NODE" "$@"\n');
  await writeFile(path.join(fixture.runtimeRoot, "server.mjs"), 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),port:process.env.SELECTION_REVIEW_PORT,apiPort:process.env.SELECTION_REVIEW_API_PORT,autoDeliver:process.env.SELECTION_REVIEW_AUTO_DELIVER,dispatch:process.env.SELECTION_REVIEW_CODEX_DISPATCH,nodePath:process.env.NODE_PATH??null,nodeOptions:process.env.NODE_OPTIONS??null}));\n');
  const dataFile = path.join(fixture.root, "synthetic-state.json");
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2 }, candidates: [] }));
  return {
    ...fixture, dataFile, entry: path.join(fixture.runtimeRoot, "scripts/launch-server.sh"),
    env: { ...fixture.env, SELECTION_REVIEW_TEST_NODE: process.execPath, SELECTION_REVIEW_DATA_FILE: dataFile, SELECTION_REVIEW_PORT: "48991" }
  };
}

test("运行包启动器使用显式参数、默认关闭派发并清除外部Node加载设置", async t => {
  const fixture = await syntheticLauncher(t);
  const before = await readFile(fixture.dataFile, "utf8");
  const env = { ...fixture.env, NODE_OPTIONS: "--require ./must-not-load.cjs", NODE_PATH: fixture.appDir };
  const { stdout, stderr } = await execFileAsync("/bin/bash", [fixture.entry, "--api-only"], { env, timeout: 5000 });
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.deepEqual(result, { args: ["--api-only"], cwd: fixture.runtimeRoot, port: "48991", apiPort: "48991", autoDeliver: "off", dispatch: "off", nodePath: null, nodeOptions: null });
  assert.equal(stderr, "");
  assert.equal(await readFile(fixture.dataFile, "utf8"), before);
});

test("运行包启动器缺显式参数或候选结构错误时退出且不暴露内容", async t => {
  const fixture = await syntheticLauncher(t);
  const env = { ...fixture.env };
  delete env.SELECTION_REVIEW_DATA_FILE;
  await assert.rejects(execFileAsync("/bin/bash", [fixture.entry], { env, timeout: 5000 }), { code: 64 });
  for (const port of ["0", "65536", "99999999999999999999999999999", "unexpected"]) {
    await assert.rejects(execFileAsync("/bin/bash", [fixture.entry], { env: { ...fixture.env, SELECTION_REVIEW_PORT: port }, timeout: 5000 }), { code: 64 });
  }
  await writeFile(fixture.dataFile, "SYNTHETIC_PRIVATE_CONTENT");
  await assert.rejects(execFileAsync("/bin/bash", [fixture.entry], { env: fixture.env, timeout: 5000 }), error => {
    assert.equal(error.code, 65);
    assert.doesNotMatch(error.stderr, /SYNTHETIC_PRIVATE_CONTENT/);
    assert.equal(error.stdout, "");
    return true;
  });
  assert.equal(await readFile(fixture.dataFile, "utf8"), "SYNTHETIC_PRIVATE_CONTENT");
});
