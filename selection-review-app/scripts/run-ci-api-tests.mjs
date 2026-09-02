import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolatedApiTestEnvironment } from "./ci-api-boundary.mjs";
import { API_PROCESS_TESTS } from "./ci-test-suites.mjs";

assertIsolatedApiTestEnvironment({
  env: process.env,
  platform: process.platform,
  uid: process.getuid?.(),
  interfaces: networkInterfaces(),
});

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
for (const file of API_PROCESS_TESTS) {
  const location = path.join(appDirectory, "tests", file);
  if (!(await lstat(location)).isFile()) throw new Error(`CI_API_TEST_FILE_INVALID:${file}`);
  const source = await readFile(location, "utf8");
  if (!source.includes("server.mjs") || !source.includes("mkdtemp")) {
    throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
  }
}

console.log(`Running all ${API_PROCESS_TESTS.length} API-process test files in the isolated container.`);
const result = spawnSync(process.execPath, [
  "--test", "--test-concurrency=1", "--test-timeout=60000",
  ...API_PROCESS_TESTS.map((file) => path.join("tests", file)),
], {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit",
  timeout: 15 * 60 * 1000,
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`CI_API_TEST_PROCESS_TERMINATED:${result.signal}`);
process.exitCode = result.status ?? 1;
