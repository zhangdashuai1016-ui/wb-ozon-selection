import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/c1-fact-keyword-pipeline.mjs",
  "lib/c1-fact-keyword-runtime.mjs",
  "lib/c1-fact-keyword-persistence.mjs",
  "schema/c1-fact-keyword-pipeline-v1.schema.json",
  "schema/c1-fact-keyword-runtime-input-v1.schema.json"
]);

export const PHASE4_C1_FACT_KEYWORD_REQUIRED_RUNTIME_DEPENDENCIES = Object.freeze([
  "lib/c1-product-plan.mjs",
  "lib/keyword-evidence-orchestrator.mjs",
  "lib/keyword-evidence-scoring.mjs",
  "lib/c1-software-input-preparation.mjs",
  "lib/c1-software-evidence-stage.mjs",
  "lib/c1-software-orchestrator.mjs"
]);

export const PHASE4_C1_FACT_KEYWORD_RUNTIME_SERVER_SHA256 = "20d6bb8f3b8ed6c10a38fa5117e9a99d7aa6511d8e325d5f909ae55d4894e87d";
export const PHASE4_C1_FACT_KEYWORD_TARGET_SERVER_SHA256 = "00a26511dabcd5182063aaa527641fe688e2d738818578fedbaa023268d9b9c2";
export const PHASE4_C1_FACT_KEYWORD_CHANGED_LINES_SHA256 = "fcf653e4b021537d46cc8634bcddd31633916b7899b5363529c83f7b5f2f58d4";

export const PHASE4_C1_FACT_KEYWORD_SOURCE_SHA256 = Object.freeze({
  "lib/c1-fact-keyword-pipeline.mjs": "353446909e6e4c45844f875e805f55a8f4aea261677c4ac586bfe088ecfe5a64",
  "lib/c1-fact-keyword-runtime.mjs": "67c27c7eedb07fb774fd3e51ce4b851afa65c47d8ea4afb8cdd57964444b474a",
  "lib/c1-fact-keyword-persistence.mjs": "6a6ff3383a4540c078c88f749815f5fdf38f1e85472b6c8237be751031142741",
  "schema/c1-fact-keyword-pipeline-v1.schema.json": "539d0fc29d0cab8d5b3e86ee997935e76844dbadaad66509c5e156d0db31f8e5",
  "schema/c1-fact-keyword-runtime-input-v1.schema.json": "c99621888977687329ad63f703cc8e1c7a5702408f6147685c9754674808e753"
});

const REQUIRED_CHANGED_MARKERS = Object.freeze([
  "prepareC1FactKeywordRuntime",
  "buildC1FactKeywordAtomicPatch",
  "prepareAndContinueC1FactKeywordEvidence",
  "c1FactKeywordPipelineRoute",
  "continueC1SoftwareWhenEvidenceReady(candidateId, staged.nextRevision)"
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

export function validateC1FactKeywordServerDiff(unifiedDiff) {
  const changed = changedLines(unifiedDiff);
  const missing = REQUIRED_CHANGED_MARKERS.filter((marker) => !changed.includes(marker));
  const forbidden = FORBIDDEN_CHANGED_MARKERS.filter((marker) => changed.includes(marker));
  if (missing.length) throw new Error(`PHASE4_C1_FACT_KEYWORD_REQUIRED_DIFF_MISSING:${missing.join(",")}`);
  if (forbidden.length) throw new Error(`PHASE4_C1_FACT_KEYWORD_FORBIDDEN_DIFF:${forbidden.join(",")}`);
  const fingerprint = sha256(changed);
  if (fingerprint !== PHASE4_C1_FACT_KEYWORD_CHANGED_LINES_SHA256) {
    throw new Error(`PHASE4_C1_FACT_KEYWORD_SERVER_DIFF_CHANGED:${fingerprint}`);
  }
  return { changedLinesSha256: fingerprint, requiredMarkers: [...REQUIRED_CHANGED_MARKERS], forbiddenMarkers: [] };
}

export function validateC1FactKeywordServerHashes({ runtimeHash, targetHash }) {
  if (runtimeHash !== PHASE4_C1_FACT_KEYWORD_RUNTIME_SERVER_SHA256) throw new Error(`PHASE4_C1_FACT_KEYWORD_RUNTIME_CHANGED:${runtimeHash}`);
  if (targetHash !== PHASE4_C1_FACT_KEYWORD_TARGET_SERVER_SHA256) throw new Error(`PHASE4_C1_FACT_KEYWORD_TARGET_CHANGED:${targetHash}`);
  return true;
}

export function validateC1FactKeywordPackageFiles(files) {
  const expected = [...PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`PHASE4_C1_FACT_KEYWORD_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  return actual;
}

export function validateC1FactKeywordSourceHashes(receipts) {
  for (const [relativePath, expectedHash] of Object.entries(PHASE4_C1_FACT_KEYWORD_SOURCE_SHA256)) {
    if (receipts?.[relativePath]?.sha256 !== expectedHash) throw new Error(`PHASE4_C1_FACT_KEYWORD_SOURCE_CHANGED:${relativePath}`);
  }
  return true;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
