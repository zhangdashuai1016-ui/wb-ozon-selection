import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolatedApiTestEnvironment } from "./ci-api-boundary.mjs";
import { API_PROCESS_TESTS, SOURCE_CONTRACT_TESTS, SUBPROCESS_TESTS, ISOLATED_TESTS } from "./ci-test-suites.mjs";
import { assertIsolatedApiTestSource } from './ci-test-policy.mjs';

assertIsolatedApiTestEnvironment({
  env: process.env,
  platform: process.platform,
  uid: process.getuid?.(),
  interfaces: networkInterfaces(),
});

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const sharedFixtureSource=await readFile(path.join(appDirectory,'tests','helpers','d-e-saved-api-fixture.mjs'),'utf8');
const launchScriptSource=await readFile(path.join(appDirectory,'scripts','launch-server.sh'),'utf8');
if (new Set(ISOLATED_TESTS).size !== ISOLATED_TESTS.length) throw new Error("CI_TEST_CLASSIFICATION_OVERLAP");
for (const file of ISOLATED_TESTS) {
  const location = path.join(appDirectory, "tests", file);
  if (!(await lstat(location)).isFile()) throw new Error(`CI_API_TEST_FILE_INVALID:${file}`);
  const source = await readFile(location, "utf8");
  if(API_PROCESS_TESTS.includes(file))assertIsolatedApiTestSource({file,source,sharedFixtureSource,launchScriptSource});
  if ((SOURCE_CONTRACT_TESTS.includes(file) && !source.includes("readFile") && !source.includes("server.mjs")) ||
      (SUBPROCESS_TESTS.includes(file) && !source.includes("node:child_process"))) {
    throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
  }
}

// Classified API tests refuse to guess ports (TEST_REQUIRES_ISOLATED_PORT). Like scripts/run-local-api-tests.mjs,
// the runner reserves distinct loopback ports and hands them to the single sequential test process. It also points the
// server's default public origin (otherwise fixed to port 4317) at the API test port, so the write-origin gate accepts the
// tests' own loopback origin without overriding any explicit allowed-origin configuration a test declares itself.
async function reserveLoopbackPort(taken) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return [4317, 4318, 4173].includes(port) || taken.includes(port) ? reserveLoopbackPort(taken) : port;
}
const ports = [];
for (let i = 0; i < 3; i++) ports.push(await reserveLoopbackPort(ports));
const [apiPort, secondPort, gatewayPort] = ports;

console.log(`Running all ${ISOLATED_TESTS.length} classified test files in the isolated container on loopback ports ${apiPort}, ${secondPort}, ${gatewayPort}.`);
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-timeout=60000",
  ...ISOLATED_TESTS.map((file) => path.join("tests", file)),
], {
  cwd: appDirectory,
  env: {
    ...process.env,
    SELECTION_REVIEW_TEST_PORT: String(apiPort),
    SELECTION_REVIEW_TEST_SECOND_PORT: String(secondPort),
    SELECTION_REVIEW_TEST_GATEWAY_PORT: String(gatewayPort),
    SELECTION_REVIEW_PUBLIC_PORT: String(apiPort),
  },
  stdio: "inherit",
  timeout: 15 * 60 * 1000,
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`CI_API_TEST_PROCESS_TERMINATED:${result.signal}`);
process.exitCode = result.status ?? 1;
