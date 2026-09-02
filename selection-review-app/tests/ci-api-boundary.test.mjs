import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedApiTestEnvironment } from "../scripts/ci-api-boundary.mjs";
import { API_PROCESS_TESTS } from "../scripts/ci-test-suites.mjs";

function isolatedEnvironment() {
  return {
    platform: "linux", uid: 1000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", CI: "true", GITHUB_ACTIONS: "true",
      CI_API_TESTS: "isolated-container", NODE_OPTIONS: "--throw-deprecation",
      SELECTION_REVIEW_AUTO_DELIVER: "off", SELECTION_REVIEW_CODEX_DISPATCH: "off",
    },
    interfaces: { lo: [{ address: "127.0.0.1", internal: true }, { address: "::1", internal: true }] },
  };
}

test("API test inventory contains every separately isolated suite once", () => {
  assert.equal(API_PROCESS_TESTS.length, 14);
  assert.equal(new Set(API_PROCESS_TESTS).size, 14);
  assert.equal(Object.isFrozen(API_PROCESS_TESTS), true);
});

test("minimal non-root isolated Linux test environment is accepted", () => {
  assert.doesNotThrow(() => assertIsolatedApiTestEnvironment(isolatedEnvironment()));
});

test("API runner rejects local, root, unapproved and missing identity environments", () => {
  for (const change of [{ platform: "darwin" }, { uid: 0 }, { uid: undefined }, { env: {} }]) {
    assert.throws(() => assertIsolatedApiTestEnvironment({ ...isolatedEnvironment(), ...change }), /REQUIRE_ISOLATED_GITHUB_RUNNER/);
  }
  const value = isolatedEnvironment();
  delete value.env.CI_API_TESTS;
  assert.throws(() => assertIsolatedApiTestEnvironment(value), /REQUIRE_ISOLATED_GITHUB_RUNNER/);
});

test("API runner rejects inherited environment and enabled production defaults", () => {
  for (const change of [{ EXTRA_VALUE: "unexpected" }, { SELECTION_REVIEW_AUTO_DELIVER: "on" },
    { SELECTION_REVIEW_CODEX_DISPATCH: "on" }, { NODE_OPTIONS: "" }]) {
    const value = isolatedEnvironment();
    Object.assign(value.env, change);
    assert.throws(() => assertIsolatedApiTestEnvironment(value), /ENVIRONMENT_NOT_MINIMAL/);
  }
});

test("API runner rejects external interfaces even with otherwise correct flags", () => {
  for (const interfaces of [{}, { eth0: [{ address: "172.17.0.2", internal: false }] },
    { lo: [{ address: "10.0.0.1", internal: true }] }]) {
    assert.throws(() => assertIsolatedApiTestEnvironment({ ...isolatedEnvironment(), interfaces }), /NETWORK_NOT_ISOLATED/);
  }
});
