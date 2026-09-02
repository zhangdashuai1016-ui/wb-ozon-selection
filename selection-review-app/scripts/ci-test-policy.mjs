const forbiddenPatterns = [
  ["API server entrypoint", /server\.mjs/u],
  ["child process", /node:child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|FileSync|Sync)?\s*\(/u],
  ["network server", /\bcreateServer\s*\(|\.listen\s*\(/u],
  ["network client", /\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\b|node:https?/u],
  ["live candidate fixture", /candidates\.json/u],
];

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
