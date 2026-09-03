import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_K3_C1_RUNTIME_FILES,
  PHASE4_K3_C1_RUNTIME_SERVER_SHA256,
  PHASE4_K3_C1_TARGET_SERVER_SHA256,
  validateK3C1PackageFiles,
  validateK3C1ServerDiff,
  validateK3C1ServerHashes
} from "../lib/phase4-k3-c1-deployment-boundary.mjs";

test("K3到C1部署包只允许当前运行副本上的精确接缝差异", () => {
  assert.equal(validateK3C1ServerHashes({
    runtimeHash: PHASE4_K3_C1_RUNTIME_SERVER_SHA256,
    targetHash: PHASE4_K3_C1_TARGET_SERVER_SHA256
  }), true);
  assert.throws(() => validateK3C1ServerHashes({ runtimeHash: "0".repeat(64), targetHash: PHASE4_K3_C1_TARGET_SERVER_SHA256 }), /RUNTIME_CHANGED/);
});

test("K3到C1部署包严格排除C2、D、E与前端", () => {
  assert.deepEqual(validateK3C1PackageFiles(PHASE4_K3_C1_RUNTIME_FILES), [...PHASE4_K3_C1_RUNTIME_FILES].sort());
  assert.throws(() => validateK3C1PackageFiles([...PHASE4_K3_C1_RUNTIME_FILES, "dist/index.html"]), /PACKAGE_SCOPE_MISMATCH/);
  assert.throws(() => validateK3C1PackageFiles([...PHASE4_K3_C1_RUNTIME_FILES, "lib/d-e-software-closure.mjs"]), /PACKAGE_SCOPE_MISMATCH/);
});

test("服务差异必须含K3快照接缝且拒绝生产路径夹带", () => {
  const incomplete = "+resolveC1K3RuntimeEvidence\n+k3KeywordEvidenceSnapshot\n+k3CurrentBinding\n";
  assert.throws(() => validateK3C1ServerDiff(incomplete), /REQUIRED_DIFF_MISSING/);
  assert.throws(() => validateK3C1ServerDiff(`${incomplete}+legacySavedKeywordEvidenceReadOnly\n+createPlatformDraft\n`), /FORBIDDEN_DIFF/);
});
