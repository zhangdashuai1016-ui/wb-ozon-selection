import assert from "node:assert/strict";
import test from "node:test";
import {
  PHASE4_C1_AUTHORIZED_CHANGED_LINES_SHA256,
  PHASE4_C1_RUNTIME_FILES,
  validatePackageFileList,
  validateServerArtifactHashes,
  validateServerDiff,
  validateSourceHashes
} from "../lib/phase4-c1-deployment-boundary.mjs";

const authorizedServerDiff = `
--- runtime/server.mjs
+++ project/server.mjs
@@
+import { runC1SoftwareOrchestration } from "./lib/c1-software-orchestrator.mjs";
+async function continueC1SoftwareWhenEvidenceReady() {}
+const preparation = "C1_SOFTWARE_PREPARATION";
+const ai = "C1_AI_SEO_DRAFT";
+const legacy = process.env.SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT;
`;

test("第4阶段服务端差异只接受C1软件编排必要标记", () => {
  const result = validateServerDiff(authorizedServerDiff);
  assert.equal(result.requiredMarkers.length, 5);
  assert.deepEqual(result.forbiddenMarkers, []);
});

test("C2、D、E或生产回读字段进入本轮差异必须拒绝", () => {
  for (const marker of ["completeC2AndCreateConfirmationCard", "productionRecord", "listing-readback", "createPlatformDraft"]) {
    assert.throws(() => validateServerDiff(`${authorizedServerDiff}\n+const leaked = "${marker}";`), /PHASE4_C1_FORBIDDEN_DIFF/);
  }
});

test("部署包只包含server、C1领域模块和C1 Schema，不包含前端或生产适配器", () => {
  assert.deepEqual(validatePackageFileList(PHASE4_C1_RUNTIME_FILES), [...PHASE4_C1_RUNTIME_FILES].sort());
  assert.throws(
    () => validatePackageFileList([...PHASE4_C1_RUNTIME_FILES, "lib/draft-production-execution.mjs"]),
    /PHASE4_C1_PACKAGE_SCOPE_MISMATCH/
  );
  assert.throws(
    () => validatePackageFileList([...PHASE4_C1_RUNTIME_FILES, "dist/index.html"]),
    /PHASE4_C1_PACKAGE_SCOPE_MISMATCH/
  );
});

test("运行基线、C1目标server和授权差异指纹必须同时匹配", () => {
  assert.equal(PHASE4_C1_AUTHORIZED_CHANGED_LINES_SHA256.length, 64);
  assert.throws(
    () => validateServerArtifactHashes({ runtimeServerHash: "changed", targetServerHash: "changed", changedLinesHash: "changed" }),
    /PHASE4_C1_RUNTIME_BASE_CHANGED/
  );
});

test("C1源文件任何一个发生漂移都不能继续打包", () => {
  assert.throws(
    () => validateSourceHashes({ "lib/c1-ai-draft-contract.mjs": { sha256: "changed" } }),
    /PHASE4_C1_SOURCE_CHANGED/
  );
});
