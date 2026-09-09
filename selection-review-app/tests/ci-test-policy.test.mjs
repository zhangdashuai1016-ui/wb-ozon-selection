import assert from "node:assert/strict";
import test from "node:test";
import { assertSelfContainedTestSource,assertIsolatedApiTestSource } from "../scripts/ci-test-policy.mjs";
import { readFile } from 'node:fs/promises';
import { API_PROCESS_TESTS } from '../scripts/ci-test-suites.mjs';

test('classified API tests prove direct or shared isolated server construction',async()=>{
  const sharedFixtureSource=await readFile(new URL('./helpers/d-e-saved-api-fixture.mjs',import.meta.url),'utf8');
  for(const file of API_PROCESS_TESTS) {
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    assertIsolatedApiTestSource({file,source,sharedFixtureSource});
  }
});

test('shared API test classification refuses missing temporary storage or an uninspected helper',()=>{
  const source="import {startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs'; const dir=await mkdtemp('isolated'); await startSavedDEApi(t,{directory:dir});";
  for(const sharedFixtureSource of [undefined,'export function startSavedDEApi(){}','node:'+'child_process server.'+'mjs'])
    assert.throws(()=>assertIsolatedApiTestSource({file:'case.test.mjs',source,sharedFixtureSource}),/CI_API_TEST_BOUNDARY_MISSING/);
  assert.throws(()=>assertIsolatedApiTestSource({file:'case.test.mjs',source:'server.'+'mjs'}),/CI_API_TEST_BOUNDARY_MISSING/);
});

test("temporary candidate fixtures may use a local candidates file", () => {
  assert.doesNotThrow(() => assertSelfContainedTestSource({
    file: "temporary-fixture.test.mjs",
    source: 'const directory = await mkdtemp("fixture-"); const file = "candidates.' + 'json";',
    allowTemporaryCandidateFixture: true,
  }));
});

test("temporary candidate fixtures still reject network clients", () => {
  assert.throws(
    () => assertSelfContainedTestSource({
      file: "temporary-fixture.test.mjs",
      source: 'await fe\u0074ch("https://example.invalid");',
      allowTemporaryCandidateFixture: true,
    }),
    /CI_TEST_REQUIRES_CLASSIFICATION:network client/u,
  );
});

test("temporary candidate fixtures still reject network servers", () => {
  assert.throws(
    () => assertSelfContainedTestSource({
      file: "temporary-fixture.test.mjs",
      source: 'create' + 'Server(() => {}).lis' + 'ten(0);',
      allowTemporaryCandidateFixture: true,
    }),
    /CI_TEST_REQUIRES_CLASSIFICATION:network server/u,
  );
});

test("temporary candidate fixtures still reject child processes", () => {
  assert.throws(
    () => assertSelfContainedTestSource({
      file: "temporary-fixture.test.mjs",
      source: 'sp\u0061wn("node", []);',
      allowTemporaryCandidateFixture: true,
    }),
    /CI_TEST_REQUIRES_CLASSIFICATION:child process/u,
  );
});

test("temporary candidate fixtures still reject server entrypoints", () => {
  assert.throws(
    () => assertSelfContainedTestSource({
      file: "temporary-fixture.test.mjs",
      source: 'await import("../server.' + 'mjs");',
      allowTemporaryCandidateFixture: true,
    }),
    /CI_TEST_REQUIRES_CLASSIFICATION:API server entrypoint/u,
  );
});

test("ordinary self-contained tests reject live candidate fixtures", () => {
  assert.throws(
    () => assertSelfContainedTestSource({
      file: "ordinary.test.mjs",
      source: 'const file = "candidates.' + 'json";',
    }),
    /CI_TEST_REQUIRES_CLASSIFICATION:live candidate fixture/u,
  );
});
