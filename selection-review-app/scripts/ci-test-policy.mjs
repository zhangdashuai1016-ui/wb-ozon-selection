const forbiddenPatterns = [
  ["API server entrypoint", /server\.mjs/u],
  ["child process", /node:child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|FileSync|Sync)?\s*\(/u],
  ["network server", /\bcreateServer\s*\(|\.listen\s*\(/u],
  ["network client", /\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|node:https?/u],
  ["live candidate fixture", /candidates\.json/u],
];

/** API tests may use the shared isolated subprocess fixture; inspect that implementation too. */
export function assertIsolatedApiTestSource({file,source,sharedFixtureSource}) {
  const direct=source.includes('server.mjs');
  const shared=/import\s*\{[^}]*\bstartSavedDEApi\b[^}]*\}\s*from\s*['"]\.\/helpers\/d-e-saved-api-fixture\.mjs['"]/u.test(source)&&
    /\bstartSavedDEApi\s*\(/u.test(source)&&typeof sharedFixtureSource==='string'&&
    sharedFixtureSource.includes('node:child_process')&&sharedFixtureSource.includes('server.mjs')&&sharedFixtureSource.includes('TEST_REQUIRES_ISOLATED_PORT');
  if(!source.includes('mkdtemp')||!direct&&!shared)throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
}

export function assertSelfContainedTestSource({
  file,
  source,
  allowTemporaryCandidateFixture = false,
}) {
  for (const [label, pattern] of forbiddenPatterns) {
    if (label === "live candidate fixture" && allowTemporaryCandidateFixture) {
      continue;
    }

    if (pattern.test(source)) {
      throw new Error(`CI_TEST_REQUIRES_CLASSIFICATION:${label}:${file}`);
    }
  }
}
