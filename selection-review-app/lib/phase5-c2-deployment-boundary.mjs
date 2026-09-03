import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE5_C2_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/c2-asset-lifecycle.mjs",
  "lib/c2-software-orchestrator.mjs",
  "schema/c2-asset-lifecycle-v1.1.schema.json",
  "schema/c2-software-input-v1.schema.json"
]);

export const PHASE5_C2_REQUIRED_RUNTIME_DEPENDENCIES = Object.freeze([
  "lib/c1-seo-draft.mjs",
  "lib/final-product-plan-confirmation-card.mjs",
  "lib/product-lifecycle-schema.mjs",
  "lib/software-execution-state.mjs"
]);

export const PHASE5_C2_REQUIRED_SERVER_MARKERS = Object.freeze([
  "./lib/c2-software-orchestrator.mjs",
  "createC2SoftwareContainer",
  "C2_OWNER_FINAL_ASSETS",
  "prepareC2FinalUploadManifest",
  "confirmC2SoftwareFinalUploads",
  "c2_waiting_final_uploads"
]);

export const PHASE5_C2_FORBIDDEN_DIFF_MARKERS = Object.freeze([
  "createProductionAuthorization(",
  "reviseProductionAuthorization(",
  "createPlatformDraft(",
  "verifySystemCreatedListing(",
  "verifyExternalListing(",
  "listing-readback",
  "draft-production-execution",
  "ozon-seller-api-production-adapter"
]);

export const PHASE5_C2_RUNTIME_SERVER_BASE_SHA256 = "e78ead4baaefa7b44b41a122819cd8a0767400083f13d0c41071459148f56bff";
export const PHASE5_C2_TARGET_SERVER_SHA256 = "550a4ca9913dc5d8bc871a849260692ff2322b4439d03e6c9361750b34b6c1fb";
export const PHASE5_C2_AUTHORIZED_CHANGED_LINES_SHA256 = "8f3022cef71915b123f5d87d2de24265d6fe949d31956de93abb3584afba1602";

export const PHASE5_C2_SOURCE_SHA256 = Object.freeze({
  "lib/c2-asset-lifecycle.mjs": "7ce2a1fd83f5a079ca3a10945d11fa3a6064c34fa8f62dfb0a0e1b158ce2350a",
  "lib/c2-software-orchestrator.mjs": "f93a57e322469676034463caf7d65084fc55edd5f73723be32d1990f20770720",
  "schema/c2-asset-lifecycle-v1.1.schema.json": "b1483a256bda042d1930fc80ac5bd06729e91a23062cba756e5d5438d762db4f",
  "schema/c2-software-input-v1.schema.json": "e33b30f60df5cba8ee0681e5d17ddbdb1dc2c528c4d7a422578d5bcd02708f9b"
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function addedAndRemovedLines(unifiedDiff) {
  return String(unifiedDiff || "")
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .join("\n");
}

export function validateServerDiff(unifiedDiff) {
  const changedLines = addedAndRemovedLines(unifiedDiff);
  const missingMarkers = PHASE5_C2_REQUIRED_SERVER_MARKERS.filter((marker) => !changedLines.includes(marker));
  const forbiddenMarkers = PHASE5_C2_FORBIDDEN_DIFF_MARKERS.filter((marker) => changedLines.includes(marker));
  if (missingMarkers.length > 0) throw new Error(`PHASE5_C2_REQUIRED_DIFF_MISSING:${missingMarkers.join(",")}`);
  if (forbiddenMarkers.length > 0) throw new Error(`PHASE5_C2_FORBIDDEN_DIFF:${forbiddenMarkers.join(",")}`);
  return { changedLinesHash: sha256(changedLines), requiredMarkers: [...PHASE5_C2_REQUIRED_SERVER_MARKERS], forbiddenMarkers: [] };
}

export function validateServerArtifactHashes({ runtimeServerHash, targetServerHash, changedLinesHash }) {
  if (runtimeServerHash !== PHASE5_C2_RUNTIME_SERVER_BASE_SHA256) throw new Error(`PHASE5_C2_RUNTIME_BASE_CHANGED:${runtimeServerHash}`);
  if (targetServerHash !== PHASE5_C2_TARGET_SERVER_SHA256) throw new Error(`PHASE5_C2_TARGET_SERVER_CHANGED:${targetServerHash}`);
  if (changedLinesHash !== PHASE5_C2_AUTHORIZED_CHANGED_LINES_SHA256) throw new Error(`PHASE5_C2_SERVER_DIFF_CHANGED:${changedLinesHash}`);
  return true;
}

export function validatePackageFileList(files) {
  const expected = [...PHASE5_C2_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`PHASE5_C2_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  return actual;
}

export function validateSourceHashes(receipts) {
  for (const [relativePath, expectedHash] of Object.entries(PHASE5_C2_SOURCE_SHA256)) {
    if (receipts?.[relativePath]?.sha256 !== expectedHash) throw new Error(`PHASE5_C2_SOURCE_CHANGED:${relativePath}`);
  }
  return true;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
