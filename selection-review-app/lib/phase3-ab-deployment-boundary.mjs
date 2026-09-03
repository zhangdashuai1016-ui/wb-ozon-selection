import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE3_AB_RUNTIME_FILES = Object.freeze([
  "server.mjs",
  "lib/a-stage-terra-gateway.mjs",
  "lib/sales-snapshot.mjs",
  "lib/profit-model.mjs",
  "lib/real-a-b-c1-flow.mjs",
  "lib/real-a-b-evidence-orchestration.mjs",
  "lib/real-a-confirmation-card.mjs",
  "schema/sales-snapshot-v1.1.schema.json"
]);

export const PHASE3_AB_FRONTEND_SOURCE_FILES = Object.freeze([
  "src/App.jsx",
  "src/components/CandidateDetail.jsx",
  "src/components/ExecutionRuntimeCard.jsx",
  "src/components/ProcessingBreakdown.jsx",
  "src/components/RealAConfirmationCard.jsx",
  "src/executionRuntimeView.js",
  "src/styles.css"
]);

export const PHASE3_AB_REQUIRED_SERVER_MARKERS = Object.freeze([
  "./lib/a-stage-terra-gateway.mjs",
  "enrichCapturedSalesSnapshotWithTerra",
  "A_TERRA_SALES_ASSIST",
  "idempotentReplay",
  "B_DETERMINISTIC_PROFIT"
]);

export const PHASE3_AB_FORBIDDEN_DIFF_MARKERS = Object.freeze([
  "ozon-seller-api-production-adapter",
  "createPlatformDraft",
  "readbackPlatformDraft",
  "ProductionAuthorization",
  "ProductionPlan",
  "draft-production-execution",
  "productionRecord",
  "listing-readback",
  "platform-write-preflight"
]);

export const PHASE3_AB_RUNTIME_SERVER_BASE_SHA256 = "6446c284e273ac16a5c4a3b29643544a77e59a88758f96523b10a288516ce9df";
export const PHASE3_AB_TARGET_SERVER_SHA256 = "eaf02107838e1138aa7f6deccb01d7dde86e940d044f22c24ddd3aed3ef88c77";
export const PHASE3_AB_AUTHORIZED_CHANGED_LINES_SHA256 = "763db565c3f1f1ce945ecf4895f1608f5a86e7b1bff7480cc6ca8a5951defdda";

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
  const missingMarkers = PHASE3_AB_REQUIRED_SERVER_MARKERS.filter((marker) => !changedLines.includes(marker));
  const forbiddenMarkers = PHASE3_AB_FORBIDDEN_DIFF_MARKERS.filter((marker) => changedLines.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`PHASE3_AB_REQUIRED_DIFF_MISSING:${missingMarkers.join(",")}`);
  }
  if (forbiddenMarkers.length > 0) {
    throw new Error(`PHASE3_AB_FORBIDDEN_DIFF:${forbiddenMarkers.join(",")}`);
  }
  return {
    changedLinesHash: sha256(changedLines),
    requiredMarkers: [...PHASE3_AB_REQUIRED_SERVER_MARKERS],
    forbiddenMarkers: []
  };
}

export function validateServerArtifactHashes({ runtimeServerHash, targetServerHash, changedLinesHash }) {
  if (runtimeServerHash !== PHASE3_AB_RUNTIME_SERVER_BASE_SHA256) {
    throw new Error(`PHASE3_AB_RUNTIME_BASE_CHANGED:${runtimeServerHash}`);
  }
  if (targetServerHash !== PHASE3_AB_TARGET_SERVER_SHA256) {
    throw new Error(`PHASE3_AB_TARGET_SERVER_CHANGED:${targetServerHash}`);
  }
  if (changedLinesHash !== PHASE3_AB_AUTHORIZED_CHANGED_LINES_SHA256) {
    throw new Error(`PHASE3_AB_SERVER_DIFF_CHANGED:${changedLinesHash}`);
  }
  return true;
}

export function validateFrontendSourceDiff(changedFiles) {
  const allowed = new Set(PHASE3_AB_FRONTEND_SOURCE_FILES);
  const unexpected = [...changedFiles].filter((file) => !allowed.has(file)).sort();
  if (unexpected.length > 0) {
    throw new Error(`PHASE3_AB_FRONTEND_SCOPE_EXPANDED:${unexpected.join(",")}`);
  }
  return [...changedFiles].sort();
}

export function validatePackageFileList(files) {
  const expected = [...PHASE3_AB_RUNTIME_FILES].sort();
  const actual = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PHASE3_AB_PACKAGE_SCOPE_MISMATCH:${actual.join(",")}`);
  }
  return actual;
}

export async function fileReceipt(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}
