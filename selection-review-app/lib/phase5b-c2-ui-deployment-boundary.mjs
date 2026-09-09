import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const PHASE5B_RUNTIME_SERVER_SHA256 = "550a4ca9913dc5d8bc871a849260692ff2322b4439d03e6c9361750b34b6c1fb";
export const PHASE5B_TARGET_SERVER_SHA256 = "002eb8ca3701daeb63bf3b4d3e0d03fc5d07fb4b0928d364a141bc49d6c83272";
export const PHASE5B_SERVER_CHANGED_LINES_SHA256 = "f4569d54b9ed902b28206014663ae1c08a3a719af661f7015c254cca63f9ed5a";

export const PHASE5B_RUNTIME_DIST = Object.freeze({
  "dist/index.html": "fdd5b49be006569cfa93341a1f6bcfb73c54c3f081fe65a5014b70437785387a",
  "dist/assets/index-Qy6wl1u4.js": "a150a4c5e9ad12f6188cf792354ff0a2232558185afd7ec2b6a49dc8afeb85c9",
  "dist/assets/index-DwnIEDUr.css": "2a98d480ca765e71992a0e50a4de5bc16cf17d996a8eb1eba9e47af3827b5df1"
});

export const PHASE5B_TARGET_DIST = Object.freeze({
  "dist/index.html": "1ee342253563ac0a2593defd65e6056741b2cf47fa84b26e017f09149e4a1915",
  "dist/assets/index-DfRQ0KLP.js": "f8ed71c1cac1847df78213b58086950e93c84a6867e5f4ae37d1246b5a86d3f5",
  "dist/assets/index-Dx5VXPLK.css": "db86a69f596d7b546b1e2cb2fe45cb533dc6edf9dce0d358f66ef2e5b4e7b60a"
});

const REQUIRED_SERVER_MARKERS = Object.freeze([
  "c2FinalUploadsDir",
  "genericC2FinalAssetUploadRoute",
  "verifyAndAuthorizeStagedC2Assets",
  "businessStateChanged: false",
  "platformWrites: 0"
]);

const FORBIDDEN_CHANGED_MARKERS = Object.freeze([
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

export function validatePhase5BServerDiff(unifiedDiff) {
  const changed = changedLines(unifiedDiff);
  const missing = REQUIRED_SERVER_MARKERS.filter((marker) => !changed.includes(marker));
  const forbidden = FORBIDDEN_CHANGED_MARKERS.filter((marker) => changed.includes(marker));
  if (missing.length) throw new Error(`PHASE5B_REQUIRED_DIFF_MISSING:${missing.join(",")}`);
  if (forbidden.length) throw new Error(`PHASE5B_FORBIDDEN_DIFF:${forbidden.join(",")}`);
  const fingerprint = sha256(changed);
  if (fingerprint !== PHASE5B_SERVER_CHANGED_LINES_SHA256) throw new Error(`PHASE5B_SERVER_DIFF_CHANGED:${fingerprint}`);
  return { changedLinesSha256: fingerprint, requiredMarkers: [...REQUIRED_SERVER_MARKERS], forbiddenMarkers: [] };
}

export function validatePhase5BServerHashes(runtimeHash, targetHash) {
  if (runtimeHash !== PHASE5B_RUNTIME_SERVER_SHA256) throw new Error(`PHASE5B_RUNTIME_SERVER_CHANGED:${runtimeHash}`);
  if (targetHash !== PHASE5B_TARGET_SERVER_SHA256) throw new Error(`PHASE5B_TARGET_SERVER_CHANGED:${targetHash}`);
  return true;
}

export async function validateExactFileHashes(root, expected) {
  const receipts = {};
  for (const [relativePath, expectedHash] of Object.entries(expected)) {
    const body = await readFile(path.join(root, relativePath));
    const actualHash = sha256(body);
    if (actualHash !== expectedHash) throw new Error(`PHASE5B_FILE_CHANGED:${relativePath}:${actualHash}`);
    receipts[relativePath] = { sha256: actualHash, bytes: body.byteLength };
  }
  return receipts;
}
