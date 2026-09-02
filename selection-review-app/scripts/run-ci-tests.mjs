import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSelfContainedTestSource } from "./ci-test-policy.mjs";

const appDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDirectory = path.join(appDirectory, "tests");

const apiProcessTests = new Set([
  "collaboration-api.test.mjs",
  "dispatch-api.test.mjs",
  "dispatch-delivery-integration.test.mjs",
  "extension-heartbeat-api.test.mjs",
  "lifecycle-c-stage-generic-api.test.mjs",
  "lifecycle-e-readback-generic-api.test.mjs",
  "ozon-sales-capture-api.test.mjs",
  "phase-2a-api-guards.test.mjs",
  "real-a-b-c1-api.test.mjs",
  "recovery-classification.test.mjs",
  "source-capture-api.test.mjs",
  "source-capture-job-api.test.mjs",
  "source-capture-restart-reconciliation.test.mjs",
  "structured-dispatch-integration.test.mjs",
]);

const temporaryCandidateFixtureTests = new Set([
  "atomic-json-persistence.test.mjs",
]);

function assert(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

function assertDisjoint(left, right, code) {
  for (const file of left) {
    assert(!right.has(file), `${code}:${file}`);
  }
}

const testDirectoryEntries = await readdir(testsDirectory, { withFileTypes: true });

for (const entry of testDirectoryEntries) {
  if (!entry.name.endsWith(".test.mjs")) {
    continue;
  }

  assert(entry.isFile(), `CI_TEST_FILE_TYPE_INVALID:${entry.name}`);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9-]*\.test\.mjs$/u.test(entry.name),
    `CI_TEST_FILE_NAME_INVALID:${entry.name}`,
  );
}

const testFiles = testDirectoryEntries
  .map((entry) => entry.name)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();
const knownTests = new Set(testFiles);

assertDisjoint(apiProcessTests, temporaryCandidateFixtureTests, "CI_TEST_CLASSIFICATION_OVERLAP");

for (const file of [
  ...apiProcessTests,
  ...temporaryCandidateFixtureTests,
]) {
  assert(knownTests.has(file), `CI_TEST_CLASSIFICATION_FILE_MISSING:${file}`);
}

for (const file of apiProcessTests) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assert(source.includes("server.mjs"), `CI_API_PROCESS_MARKER_MISSING:${file}`);
}

for (const file of temporaryCandidateFixtureTests) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assert(source.includes("mkdtemp"), `CI_TEMP_FIXTURE_BOUNDARY_MISSING:${file}`);
  assert(source.includes("candidates.json"), `CI_TEMP_FIXTURE_MARKER_MISSING:${file}`);
}

const selectedTests = [];
for (const file of testFiles) {
  if (apiProcessTests.has(file)) {
    continue;
  }

  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assertSelfContainedTestSource({
    file,
    source,
    allowTemporaryCandidateFixture: temporaryCandidateFixtureTests.has(file),
  });

  selectedTests.push(path.join("tests", file));
}

assert(selectedTests.length > 0, "CI_SELF_CONTAINED_TESTS_EMPTY");

console.log(
  `Running ${selectedTests.length} self-contained test files; `
    + `excluding ${apiProcessTests.size} API-process files.`,
);

const result = spawnSync(process.execPath, ["--test", ...selectedTests], {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
