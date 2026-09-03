import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/c1-keyword-evidence-auto-trigger.mjs",
  "lib/c1-fact-keyword-persistence.mjs",
  "schema/c1-keyword-evidence-ready-event-v1.schema.json"
]);

export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_REQUIRED_RUNTIME_DEPENDENCIES = Object.freeze([
  "lib/c1-fact-keyword-pipeline.mjs",
  "lib/c1-fact-keyword-runtime.mjs",
  "lib/c1-software-orchestrator.mjs",
  "schema/c1-fact-keyword-runtime-input-v1.schema.json"
]);

export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_SERVER_SHA256 = "00a26511dabcd5182063aaa527641fe688e2d738818578fedbaa023268d9b9c2";
export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_SERVER_SHA256 = "59d769827fdda2a7a5b3e1b5de5919dd691464eae1c5ba559e674e66c8f05d7b";
export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_CHANGED_LINES_SHA256 = "6c801dc2c30b76d83c18f99de7e277e1ab86ab67f1adee02c2cfede629f67bf9";

export const PHASE4_C1_KEYWORD_AUTO_TRIGGER_SOURCE_SHA256 = Object.freeze({
  "lib/c1-keyword-evidence-auto-trigger.mjs": "a2457796af6728b0d10c162a7e68d5cb907f5f641839a1a6493f4cf1a66e9051",
  "lib/c1-fact-keyword-persistence.mjs": "c173f54b7f77be22e4d868c00e956cf1d425c59de3dbd36c0ae36134f19a0170",
  "schema/c1-keyword-evidence-ready-event-v1.schema.json": "e75c9b5b6e4307e3328ffbfab1a812bcb2636872ba7f046944a80f5e22bd198d"
});

const REQUIRED_CHANGED_MARKERS = Object.freeze([
  "acceptC1KeywordEvidenceReadyEvent",
  "triggerReceipt = null",
  "continueC1FromKeywordEvidenceReadyEvent",
  "c1KeywordEvidenceReadyRoute",
  "keyword-evidence-ready"
]);

const FORBIDDEN_CHANGED_MARKERS = Object.freeze([
  "createC2SoftwareContainer",
  "ProductionAuthorization",
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

export function validateKeywordAutoTriggerServerDiff(unifiedDiff) {
  const changed = changedLines(unifiedDiff);
  const missing = REQUIRED_CHANGED_MARKERS.filter((marker) => !changed.includes(marker));
  const forbidden = FORBIDDEN_CHANGED_MARKERS.filter((marker) => changed.includes(marker));
  if (missing.length) throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_REQUIRED_DIFF_MISSING:${missing.join(",")}`);
  if (forbidden.length) throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_FORBIDDEN_DIFF:${forbidden.join(",")}`);
  const fingerprint = sha256(changed);
  if (fingerprint !== PHASE4_C1_KEYWORD_AUTO_TRIGGER_CHANGED_LINES_SHA256) {
    throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_SERVER_DIFF_CHANGED:${fingerprint}`);
  }
  return { changedLinesSha256: fingerprint, requiredMarkers: [...REQUIRED_CHANGED_MARKERS], forbiddenMarkers: [] };
}

export function validateKeywordAutoTriggerServerHashes({ runtimeHash, targetHash }) {
  if (runtimeHash !== PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_SERVER_SHA256) {
    throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_CHANGED:${runtimeHash}`);
  }
  if (targetHash !== PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_SERVER_SHA256) {
    throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_CHANGED:${targetHash}`);
  }
  return true;
}

export function validateKeywordAutoTriggerPackageFiles(files) {
  const expected = [...PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  }
  return actual;
}

export function validateKeywordAutoTriggerSourceHashes(receipts) {
  for (const [relativePath, expectedHash] of Object.entries(PHASE4_C1_KEYWORD_AUTO_TRIGGER_SOURCE_SHA256)) {
    if (receipts?.[relativePath]?.sha256 !== expectedHash) {
      throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_SOURCE_CHANGED:${relativePath}`);
    }
  }
  return true;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
