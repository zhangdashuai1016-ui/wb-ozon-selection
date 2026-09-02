const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH", "CI", "GITHUB_ACTIONS", "CI_API_TESTS", "NODE_OPTIONS",
  "SELECTION_REVIEW_AUTO_DELIVER", "SELECTION_REVIEW_CODEX_DISPATCH",
]);

// Fail closed on accidental local invocation. The workflow supplies the actual
// network, filesystem and privilege isolation; flags alone are not a sandbox.
export function assertIsolatedApiTestEnvironment({ env, platform, uid, interfaces }) {
  if (platform !== "linux" || uid === 0 || !Number.isInteger(uid) ||
      env.CI !== "true" || env.GITHUB_ACTIONS !== "true" || env.CI_API_TESTS !== "isolated-container") {
    throw new Error("CI_API_TESTS_REQUIRE_ISOLATED_GITHUB_RUNNER");
  }
  if (env.SELECTION_REVIEW_AUTO_DELIVER !== "off" || env.SELECTION_REVIEW_CODEX_DISPATCH !== "off" ||
      env.NODE_OPTIONS !== "--throw-deprecation" || !env.PATH ||
      Object.keys(env).some((key) => !ALLOWED_ENVIRONMENT_KEYS.has(key))) {
    throw new Error("CI_API_TEST_ENVIRONMENT_NOT_MINIMAL");
  }
  const addresses = Object.values(interfaces).flat();
  if (addresses.length === 0 || addresses.some((entry) => entry.internal !== true ||
      !["127.0.0.1", "::1"].includes(entry.address))) {
    throw new Error("CI_API_TEST_NETWORK_NOT_ISOLATED");
  }
}
