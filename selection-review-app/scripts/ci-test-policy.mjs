/** Importing startSavedDEApi means a real API subprocess: only classified API tests may do so. */
const sharedApiFixtureImport=/import\s*\{[^}]*\bstartSavedDEApi\b[^}]*\}\s*from\s*['"]\.\/helpers\/d-e-saved-api-fixture\.mjs['"]/u;

const forbiddenPatterns = [
  ["API server entrypoint", /server\.mjs/u],
  ["child process", /node:child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|FileSync|Sync)?\s*\(/u],
  ["network server", /\bcreateServer\s*\(|\.listen\s*\(/u],
  ["network client", /\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|node:https?/u],
  ["live candidate fixture", /candidates\.json/u],
  ["isolated API fixture", sharedApiFixtureImport],
];

/** API tests may use the shared isolated subprocess fixture or the packaged launch script; inspect those implementations too. */
export function assertIsolatedApiTestSource({file,source,sharedFixtureSource,launchScriptSource}) {
  const direct=source.includes('server.mjs');
  const shared=sharedApiFixtureImport.test(source)&&
    /\bstartSavedDEApi\s*\(/u.test(source)&&typeof sharedFixtureSource==='string'&&
    sharedFixtureSource.includes('node:child_process')&&sharedFixtureSource.includes('server.mjs')&&sharedFixtureSource.includes('TEST_REQUIRES_ISOLATED_PORT');
  // Packaged: the test prepares a runtime package in temporary storage and starts it through the package's own launch script,
  // which must exec the bundled Node on server.mjs. The launch script source is inspected, not trusted by name.
  const packaged=/import\s*\{[^}]*\bprepareRuntimePackage\b[^}]*\}\s*from\s*['"]\.\.\/scripts\/runtime-package\.mjs['"]/u.test(source)&&
    /\bprepareRuntimePackage\s*\(/u.test(source)&&source.includes('scripts/launch-server.sh')&&source.includes('node:child_process')&&
    source.includes('TEST_REQUIRES_ISOLATED_PORT')&&typeof launchScriptSource==='string'&&
    /\bexec\s+"\$REVIEW_NODE"\s+"\$REVIEW_RUNTIME_ROOT\/server\.mjs"/u.test(launchScriptSource);
  if(!source.includes('mkdtemp')||!direct&&!shared&&!packaged)throw new Error(`CI_API_TEST_BOUNDARY_MISSING:${file}`);
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
