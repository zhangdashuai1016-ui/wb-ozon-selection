import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
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
if (new Set(ISOLATED_TESTS).size !== ISOLATED_TESTS.length) throw new Error("CI_TEST_CLASSIFICATION_OVERLAP");
for (const file of ISOLATED_TESTS) {
  const location = path.join(appDirectory, "tests", file);
  if (!(await lstat(location)).isFile()) throw new Error(`CI_API_TEST_FILE_INVALID:${file}`);
  const source = await readFile(location, "utf8");
  if(API_PROCESS_TESTS.includes(file))assertIsolatedApiTestSource({file,source,sharedFixtureSource});
  if ((SOURCE_CONTRACT_TESTS.includes(file) && !source.includes("readFile") && !source.includes("server.mjs")) ||
      (SUBPROCESS_TESTS.includes(file) && !source.includes("node:child_process"))) {
    throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
  }
}

console.log(`Running all ${ISOLATED_TESTS.length} classified test files in the isolated container.`);
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-timeout=60000",
  ...ISOLATED_TESTS.map((file) => path.join("tests", file)),
], {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit",
  timeout: 15 * 60 * 1000,
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`CI_API_TEST_PROCESS_TERMINATED:${result.signal}`);
process.exitCode = result.status ?? 1;
