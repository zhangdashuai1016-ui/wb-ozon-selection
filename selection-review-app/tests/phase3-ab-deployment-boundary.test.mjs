import assert from "node:assert/strict";
import test from "node:test";
import {
  PHASE3_AB_RUNTIME_FILES,
  PHASE3_AB_AUTHORIZED_CHANGED_LINES_SHA256,
  validateFrontendSourceDiff,
  validatePackageFileList,
  validateServerArtifactHashes,
  validateServerDiff
} from "../lib/phase3-ab-deployment-boundary.mjs";

const authorizedServerDiff = `
--- runtime/server.mjs
+++ project/server.mjs
@@
+import { runAStageTerraAssist } from "./lib/a-stage-terra-gateway.mjs";
+async function enrichCapturedSalesSnapshotWithTerra() {}
+const step = "A_TERRA_SALES_ASSIST";
+if (result.idempotentReplay === true) return result;
+const b = "B_DETERMINISTIC_PROFIT";
`;

test("第3阶段服务端差异必须包含A/Terra/B幂等标记且不含C/D执行路径", () => {
  const result = validateServerDiff(authorizedServerDiff);
  assert.equal(result.forbiddenMarkers.length, 0);
  assert.equal(result.requiredMarkers.length, 5);
});

test("任何生产写入或回读标记进入服务端差异都会阻止打包", () => {
  assert.throws(
    () => validateServerDiff(`${authorizedServerDiff}\n+const adapter = "createPlatformDraft";`),
    /PHASE3_AB_FORBIDDEN_DIFF/
  );
});

test("前端只允许软件执行状态与A确认卡相关文件变化", () => {
  assert.deepEqual(
    validateFrontendSourceDiff(["src/components/RealAConfirmationCard.jsx", "src/styles.css"]),
    ["src/components/RealAConfirmationCard.jsx", "src/styles.css"]
  );
  assert.throws(
    () => validateFrontendSourceDiff(["src/components/ProductionAuthorizationCard.jsx"]),
    /PHASE3_AB_FRONTEND_SCOPE_EXPANDED/
  );
});

test("部署覆盖清单不能增加C/D文件，也不能遗漏A/B文件", () => {
  assert.deepEqual(validatePackageFileList(PHASE3_AB_RUNTIME_FILES), [...PHASE3_AB_RUNTIME_FILES].sort());
  assert.throws(
    () => validatePackageFileList([...PHASE3_AB_RUNTIME_FILES, "lib/draft-production-execution.mjs"]),
    /PHASE3_AB_PACKAGE_SCOPE_MISMATCH/
  );
});

test("运行基线、目标服务和完整差异指纹必须同时匹配", () => {
  assert.equal(PHASE3_AB_AUTHORIZED_CHANGED_LINES_SHA256.length, 64);
  assert.throws(
    () => validateServerArtifactHashes({ runtimeServerHash: "changed", targetServerHash: "changed", changedLinesHash: "changed" }),
    /PHASE3_AB_RUNTIME_BASE_CHANGED/
  );
});
