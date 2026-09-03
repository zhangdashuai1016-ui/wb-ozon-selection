import assert from "node:assert/strict";
import test from "node:test";
import {
  PHASE5_C2_AUTHORIZED_CHANGED_LINES_SHA256,
  PHASE5_C2_RUNTIME_FILES,
  validatePackageFileList,
  validateServerArtifactHashes,
  validateServerDiff,
  validateSourceHashes
} from "../lib/phase5-c2-deployment-boundary.mjs";

const authorizedServerDiff = `
--- runtime/server.mjs
+++ project/server.mjs
@@
+import "./lib/c2-software-orchestrator.mjs";
+createC2SoftwareContainer();
+const step = "C2_OWNER_FINAL_ASSETS";
+prepareC2FinalUploadManifest();
+confirmC2SoftwareFinalUploads();
+const status = "c2_waiting_final_uploads";
`;

test("第5阶段差异只接受C2软件容器、manifest和主人确认接缝", () => {
  const result = validateServerDiff(authorizedServerDiff);
  assert.equal(result.requiredMarkers.length, 6);
  assert.deepEqual(result.forbiddenMarkers, []);
});

test("D写入、E回读或生产授权实现夹入本轮必须拒绝", () => {
  for (const marker of ["createProductionAuthorization(", "createPlatformDraft(", "verifySystemCreatedListing(", "listing-readback"]) {
    assert.throws(() => validateServerDiff(`${authorizedServerDiff}\n+${marker};`), /PHASE5_C2_FORBIDDEN_DIFF/);
  }
});

test("部署包只包含server、C2领域模块和C2 Schema，不含前端与D/E适配器", () => {
  assert.deepEqual(validatePackageFileList(PHASE5_C2_RUNTIME_FILES), [...PHASE5_C2_RUNTIME_FILES].sort());
  assert.throws(() => validatePackageFileList([...PHASE5_C2_RUNTIME_FILES, "lib/draft-production-execution.mjs"]), /PHASE5_C2_PACKAGE_SCOPE_MISMATCH/);
  assert.throws(() => validatePackageFileList([...PHASE5_C2_RUNTIME_FILES, "dist/index.html"]), /PHASE5_C2_PACKAGE_SCOPE_MISMATCH/);
});

test("运行基线、目标server和授权差异指纹必须同时匹配", () => {
  assert.equal(PHASE5_C2_AUTHORIZED_CHANGED_LINES_SHA256.length, 64);
  assert.throws(() => validateServerArtifactHashes({ runtimeServerHash: "changed", targetServerHash: "changed", changedLinesHash: "changed" }), /PHASE5_C2_RUNTIME_BASE_CHANGED/);
});

test("C2源文件任一漂移都不能继续打包", () => {
  assert.throws(() => validateSourceHashes({ "lib/c2-asset-lifecycle.mjs": { sha256: "changed" } }), /PHASE5_C2_SOURCE_CHANGED/);
});
