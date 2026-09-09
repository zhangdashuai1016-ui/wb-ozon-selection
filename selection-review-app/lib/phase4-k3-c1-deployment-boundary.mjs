import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE4_K3_C1_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/c1-ai-draft-contract.mjs",
  "lib/c1-k3-keyword-adapter.mjs",
  "lib/c1-k3-runtime-bridge.mjs",
  "lib/c1-software-input-preparation.mjs",
  "lib/c1-software-orchestrator.mjs",
  "schema/c1-k3-keyword-adapter-v1.schema.json"
]);

export const PHASE4_K3_C1_REQUIRED_RUNTIME_DEPENDENCIES = Object.freeze([
  "lib/c1-product-plan.mjs",
  "lib/c1-ai-gateway.mjs",
  "lib/keyword-evidence-scoring.mjs",
  "lib/keyword-evidence-snapshot.mjs",
  "schema/keyword-evidence-snapshot-v1.schema.json",
  "schema/keyword-scoring-v1.schema.json"
]);

export const PHASE4_K3_C1_RUNTIME_SERVER_SHA256 = "0c3d96f102fbd6a78054eb3a5b73ccfcbbe0206d94023798a74f65056b40c557";
export const PHASE4_K3_C1_TARGET_SERVER_SHA256 = "4cc7327d7610ebb14f7376544476df48a4fee860aff90ab35b5b677d0617eb9b";
export const PHASE4_K3_C1_CHANGED_LINES_SHA256 = "f607129c1a758ea61b8998a4caa3696e7b90256ce67a92e0aab7867006a2d2da";

export const PHASE4_K3_C1_SOURCE_SHA256 = Object.freeze({
  "lib/c1-ai-draft-contract.mjs": "34bdd1734c5e9eafd54db4c5d095f5fa800c157df532bb9f7f7a75d2a1ea88a8",
  "lib/c1-k3-keyword-adapter.mjs": "289f55f4aabd05dc08d02ac38d6e03ea9e4bd9570285b724e93796de71e62abc",
  "lib/c1-k3-runtime-bridge.mjs": "9587799020c708258dbec2c7699b49e3e28a461df4ffb42a8d6892416f4fd511",
  "lib/c1-software-input-preparation.mjs": "a47cadd3816defb7b1b906b62e2dde0a71ce2507b6bed1931fa48428d95ecee1",
  "lib/c1-software-orchestrator.mjs": "f0c36d15bf02e86d7bac541cf70466f6c178a0945152906e20676e033b0eebcc",
  "schema/c1-k3-keyword-adapter-v1.schema.json": "92cc29bcbdbdc4630dfebaaee433121f35b9af7218fb86c90f2efe0cad759527"
});

const REQUIRED_CHANGED_MARKERS = Object.freeze([
  "resolveC1K3RuntimeEvidence",
  "k3KeywordEvidenceSnapshot",
  "k3CurrentBinding",
  "legacySavedKeywordEvidenceReadOnly"
]);

const FORBIDDEN_CHANGED_MARKERS = Object.freeze([
  "createC2SoftwareContainer",
  "ProductionAuthorization",
  "ProductionPlan",
  "createPlatformDraft",
  "listing-readback",
  "platform-write-preflight",
  "automationStarted = true",
  "queueUserDispatch"
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function changedLines(unifiedDiff) {
  return String(unifiedDiff || "").split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .join("\n");
}

export function validateK3C1ServerDiff(unifiedDiff) {
  const changed = changedLines(unifiedDiff);
  const missing = REQUIRED_CHANGED_MARKERS.filter((marker) => !changed.includes(marker));
  const forbidden = FORBIDDEN_CHANGED_MARKERS.filter((marker) => changed.includes(marker));
  if (missing.length) throw new Error(`PHASE4_K3_C1_REQUIRED_DIFF_MISSING:${missing.join(",")}`);
  if (forbidden.length) throw new Error(`PHASE4_K3_C1_FORBIDDEN_DIFF:${forbidden.join(",")}`);
  const fingerprint = sha256(changed);
  if (fingerprint !== PHASE4_K3_C1_CHANGED_LINES_SHA256) throw new Error(`PHASE4_K3_C1_SERVER_DIFF_CHANGED:${fingerprint}`);
  return { changedLinesSha256: fingerprint, requiredMarkers: [...REQUIRED_CHANGED_MARKERS], forbiddenMarkers: [] };
}

export function validateK3C1ServerHashes({ runtimeHash, targetHash }) {
  if (runtimeHash !== PHASE4_K3_C1_RUNTIME_SERVER_SHA256) throw new Error(`PHASE4_K3_C1_RUNTIME_CHANGED:${runtimeHash}`);
  if (targetHash !== PHASE4_K3_C1_TARGET_SERVER_SHA256) throw new Error(`PHASE4_K3_C1_TARGET_CHANGED:${targetHash}`);
  return true;
}

export function validateK3C1PackageFiles(files) {
  const expected = [...PHASE4_K3_C1_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`PHASE4_K3_C1_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  return actual;
}

export function validateK3C1SourceHashes(receipts) {
  for (const [relativePath, expectedHash] of Object.entries(PHASE4_K3_C1_SOURCE_SHA256)) {
    if (receipts?.[relativePath]?.sha256 !== expectedHash) throw new Error(`PHASE4_K3_C1_SOURCE_CHANGED:${relativePath}`);
  }
  return true;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
