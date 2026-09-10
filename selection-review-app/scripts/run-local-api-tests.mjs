import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { API_PROCESS_TESTS, SOURCE_CONTRACT_TESTS, SUBPROCESS_TESTS, ISOLATED_TESTS, BUILT_RUNTIME_TESTS } from "./ci-test-suites.mjs";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const selected = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("LOCAL_API_TESTS_REQUIRE_MACOS_SANDBOX");
if (!selected.length || new Set(selected).size !== selected.length || selected.some(file => !ISOLATED_TESTS.includes(file))) {
  throw new Error("LOCAL_API_TESTS_REQUIRE_EXPLICIT_CLASSIFIED_FILES");
}
const nodeDirectory = await fs.realpath(path.dirname(process.execPath));
const nodeRuntimeRoot = path.basename(nodeDirectory) === "bin" ? path.dirname(nodeDirectory) : nodeDirectory;
const dependencyDirectory = await fs.realpath(path.join(appDirectory, "node_modules"));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  if ([4317, 4318, 4173].includes(port)) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("LOCAL_API_TEST_PORT_CONFLICT");
  }
  return { port, release: () => new Promise(resolve => server.close(resolve)) };
}

function profileFor(root, ports) {
  const quoted = value => JSON.stringify(value);
  const ancestors = new Set();
  const readDirectories = [root, nodeRuntimeRoot, dependencyDirectory, "/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/Library/Apple", "/private/etc", "/private/var/db/timezone"];
  for (const directory of readDirectories) {
    for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  return `(version 1)
(allow default)
(deny network-outbound (require-not (require-any ${ports.map(port => `(remote tcp "localhost:${port}")`).join(" ")})))
(deny network-inbound (require-not (require-any ${ports.map(port => `(local tcp "localhost:${port}")`).join(" ")})))
(deny file-write* (require-not (require-any (subpath ${quoted(root)}) (literal "/dev/null"))))
(deny file-read-data (require-not (require-any
  ${readDirectories.map(directory => `(subpath ${quoted(directory)})`).join(" ")}
  (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read-metadata (require-not (require-any
  ${readDirectories.map(directory => `(subpath ${quoted(directory)})`).join(" ")}
  ${[...ancestors].map(directory => `(literal ${quoted(directory)})`).join(" ")}
  (literal "/") (literal "/dev") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))))
(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/SystemKey"))
(deny process-exec (literal "/usr/bin/security") (literal "/bin/launchctl")
  (literal "/usr/bin/open") (literal "/usr/bin/osascript"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd"))`;
}

async function runChild(args, options) {
  // Pipes keep parent log files outside the child's writable filesystem boundary.
  const child = spawn("/usr/bin/sandbox-exec", args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let timedOut = false;
  const killGroup = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, 70000);
  const interrupt = () => killGroup("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (timedOut || result.signal) throw new Error(`LOCAL_API_TEST_TERMINATED:${timedOut ? "deadline" : result.signal}`);
    return result.code;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (child.pid) killGroup("SIGKILL");
  }
}

for (const file of selected) {
  const source = await fs.readFile(path.join(appDirectory, "tests", file), "utf8");
  if (API_PROCESS_TESTS.includes(file) && (!source.includes("SELECTION_REVIEW_TEST_PORT") || !source.includes("mkdtemp"))) {
    throw new Error(`LOCAL_API_TEST_PORT_BOUNDARY_MISSING:${file}`);
  }
  if (SUBPROCESS_TESTS.includes(file) && !source.includes("node:child_process") ||
      SOURCE_CONTRACT_TESTS.includes(file) && !source.includes("readFile") && !source.includes("server.mjs")) throw new Error(`LOCAL_API_TEST_CLASSIFICATION_INVALID:${file}`);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "selection-api-isolated-")));
  const ports = [];
  try {
    const copy = path.join(root, "app");
    await fs.mkdir(copy);
    // Copy only code and declared static configuration. Never copy candidates or machine settings.
    for (const entry of ["server.mjs", "package.json", "index.html", "启动今日选品评审台.command", "lib", "schema", "src", "extension", "tests", "scripts",
      ...(BUILT_RUNTIME_TESTS.includes(file) ? ["dist"] : [])]) {
      await fs.cp(path.join(appDirectory, entry), path.join(copy, entry), { recursive: true, dereference: false });
    }
    await fs.mkdir(path.join(copy, "data"));
    await fs.copyFile(path.join(appDirectory, "data", "workflow-map.json"), path.join(copy, "data", "workflow-map.json"));
    await fs.symlink(dependencyDirectory, path.join(copy, "node_modules"), "dir");
    await fs.mkdir(path.join(root, "home"));
    await fs.mkdir(path.join(root, "tmp"));
    for (let i = 0; i < 3; i++) ports.push(await reservePort());
    const [api, second, gateway] = ports.map(item => item.port);
    const profile = profileFor(root, [api, second, gateway]);
    const env = {
      PATH: `${nodeDirectory}:/usr/bin:/bin`, LC_ALL: "C", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), NODE_OPTIONS: "--throw-deprecation",
      SELECTION_REVIEW_TEST_PORT: String(api), SELECTION_REVIEW_TEST_SECOND_PORT: String(second), SELECTION_REVIEW_TEST_GATEWAY_PORT: String(gateway),
      SELECTION_REVIEW_PUBLIC_ORIGIN: `http://127.0.0.1:${api}`,
      SELECTION_REVIEW_ALLOWED_ORIGINS: `http://127.0.0.1:${api}`, SELECTION_REVIEW_WORKFLOW_MAP_FILE: path.join(copy, "data", "workflow-map.json"),
      SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(root, "uploads"), SELECTION_REVIEW_AI_GATEWAY_URL: `http://127.0.0.1:${gateway}`,
      SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${gateway}`,
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off"
    };
    for (const item of ports) await item.release();
    ports.length = 0;
    console.log(`Running ${file} in a temporary copy; only test ports ${api}, ${second}, ${gateway} are accessible.`);
    const code = await runChild(["-p", profile, process.execPath, "--test", "--test-concurrency=1", "--test-timeout=60000", path.join("tests", file)], { cwd: copy, env });
    if (code !== 0) { process.exitCode = code || 1; break; }
  } finally {
    for (const item of ports) await item.release();
    await fs.rm(root, { recursive: true, force: true });
  }
}
