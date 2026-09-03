import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE4_C1_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/c1-ai-draft-contract.mjs",
  "lib/c1-ai-gateway.mjs",
  "lib/c1-software-input-preparation.mjs",
  "lib/c1-software-orchestrator.mjs",
  "schema/c1-ai-draft-receipt-v1.schema.json",
  "schema/c1-ai-draft-request-v1.schema.json",
  "schema/c1-software-input-preparation-v1.schema.json"
]);

export const PHASE4_C1_REQUIRED_RUNTIME_DEPENDENCIES = Object.freeze([
  "lib/c1-product-plan.mjs",
  "lib/product-lifecycle-schema.mjs",
  "lib/profit-model.mjs",
  "lib/software-execution-state.mjs"
]);

export const PHASE4_C1_REQUIRED_SERVER_MARKERS = Object.freeze([
  "./lib/c1-software-orchestrator.mjs",
  "continueC1SoftwareWhenEvidenceReady",
  "C1_SOFTWARE_PREPARATION",
  "C1_AI_SEO_DRAFT",
  "SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT"
]);

export const PHASE4_C1_FORBIDDEN_DIFF_MARKERS = Object.freeze([
  "completeC2AndCreateConfirmationCard",
  "createProductionAuthorization",
  "reviseProductionAuthorization",
  "createExternalListingRecord",
  "verifyExternalListing",
  "verifySystemCreatedListing",
  "ozon-seller-api-production-adapter",
  "createPlatformDraft",
  "readbackPlatformDraft",
  "draft-production-execution",
  "productionRecord",
  "listing-readback",
  "platform-write-preflight"
]);

export const PHASE4_C1_RUNTIME_SERVER_BASE_SHA256 = "eaf02107838e1138aa7f6deccb01d7dde86e940d044f22c24ddd3aed3ef88c77";
export const PHASE4_C1_TARGET_SERVER_SHA256 = "e78ead4baaefa7b44b41a122819cd8a0767400083f13d0c41071459148f56bff";
export const PHASE4_C1_AUTHORIZED_CHANGED_LINES_SHA256 = "a683c8b50a4a10853b7beaf49d0608b9b9356730d27173fb94a3bb186a4cc026";

export const PHASE4_C1_SOURCE_SHA256 = Object.freeze({
  "lib/c1-ai-draft-contract.mjs": "173750b9880c56024eb63183b63a4df908c8679b22ce0358b95b8d9429ff65f1",
  "lib/c1-ai-gateway.mjs": "3180eb10579456d3327bc5f9481b9dc2983564822e0416070089034e9a4a0282",
  "lib/c1-software-input-preparation.mjs": "b2a2a0d89a4349ec0471586464d9339613dc6d904d9ef314d988a9708ac35b04",
  "lib/c1-software-orchestrator.mjs": "d69328c670fcc9d8d09deb00cca2fd4a73f6b81730660ad701c36462a2cef40e",
  "schema/c1-ai-draft-request-v1.schema.json": "e2dd99981f13c11c8fa27a1a1935aa37ad3549ed21b5aaf09e1cdb39308ef9c6",
  "schema/c1-ai-draft-receipt-v1.schema.json": "12e91588547f64e860d4af18bb507ea1d55a4f6e4b9ad721afbd94c0532f3e90",
  "schema/c1-software-input-preparation-v1.schema.json": "6756dc733c70a80bd3b0ce3f467f6007c8e12d2246188153cc5129153d351a90"
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
  const missingMarkers = PHASE4_C1_REQUIRED_SERVER_MARKERS.filter((marker) => !changedLines.includes(marker));
  const forbiddenMarkers = PHASE4_C1_FORBIDDEN_DIFF_MARKERS.filter((marker) => changedLines.includes(marker));
  if (missingMarkers.length > 0) throw new Error(`PHASE4_C1_REQUIRED_DIFF_MISSING:${missingMarkers.join(",")}`);
  if (forbiddenMarkers.length > 0) throw new Error(`PHASE4_C1_FORBIDDEN_DIFF:${forbiddenMarkers.join(",")}`);
  return {
    changedLinesHash: sha256(changedLines),
    requiredMarkers: [...PHASE4_C1_REQUIRED_SERVER_MARKERS],
    forbiddenMarkers: []
  };
}

export function validateServerArtifactHashes({ runtimeServerHash, targetServerHash, changedLinesHash }) {
  if (runtimeServerHash !== PHASE4_C1_RUNTIME_SERVER_BASE_SHA256) {
    throw new Error(`PHASE4_C1_RUNTIME_BASE_CHANGED:${runtimeServerHash}`);
  }
  if (targetServerHash !== PHASE4_C1_TARGET_SERVER_SHA256) {
    throw new Error(`PHASE4_C1_TARGET_SERVER_CHANGED:${targetServerHash}`);
  }
  if (changedLinesHash !== PHASE4_C1_AUTHORIZED_CHANGED_LINES_SHA256) {
    throw new Error(`PHASE4_C1_SERVER_DIFF_CHANGED:${changedLinesHash}`);
  }
  return true;
}

export function validatePackageFileList(files) {
  const expected = [...PHASE4_C1_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PHASE4_C1_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  }
  return actual;
}

export function validateSourceHashes(receipts) {
  for (const [relativePath, expectedHash] of Object.entries(PHASE4_C1_SOURCE_SHA256)) {
    if (receipts?.[relativePath]?.sha256 !== expectedHash) {
      throw new Error(`PHASE4_C1_SOURCE_CHANGED:${relativePath}`);
    }
  }
  return true;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
