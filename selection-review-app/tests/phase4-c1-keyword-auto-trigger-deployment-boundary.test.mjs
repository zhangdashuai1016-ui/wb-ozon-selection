import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES,
  PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_SERVER_SHA256,
  PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_SERVER_SHA256,
  validateKeywordAutoTriggerPackageFiles,
  validateKeywordAutoTriggerServerDiff,
  validateKeywordAutoTriggerServerHashes
} from "../lib/phase4-c1-keyword-auto-trigger-deployment-boundary.mjs";

test("关键词完成自动继续C1部署包锁定当前运行副本和目标版本", () => {
  assert.equal(validateKeywordAutoTriggerServerHashes({
    runtimeHash: PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_SERVER_SHA256,
    targetHash: PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_SERVER_SHA256
  }), true);
  assert.throws(() => validateKeywordAutoTriggerServerHashes({
    runtimeHash: "0".repeat(64), targetHash: PHASE4_C1_KEYWORD_AUTO_TRIGGER_TARGET_SERVER_SHA256
  }), /RUNTIME_CHANGED/);
});

test("部署包只含自动触发接缝、事件契约和原子保存扩展", () => {
  assert.deepEqual(
    validateKeywordAutoTriggerPackageFiles(PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES),
    [...PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES].sort()
  );
  assert.throws(() => validateKeywordAutoTriggerPackageFiles([
    ...PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES,
    "lib/d-e-software-closure.mjs"
  ]), /PACKAGE_SCOPE_MISMATCH/);
});

test("服务差异必须含软件事件接缝并拒绝派发及C2到E夹带", () => {
  const base = "+acceptC1KeywordEvidenceReadyEvent\n+triggerReceipt = null\n+continueC1FromKeywordEvidenceReadyEvent\n+c1KeywordEvidenceReadyRoute\n+keyword-evidence-ready\n";
  assert.throws(() => validateKeywordAutoTriggerServerDiff(base), /SERVER_DIFF_CHANGED/);
  assert.throws(() => validateKeywordAutoTriggerServerDiff(`${base}+queueUserDispatch\n`), /FORBIDDEN_DIFF/);
});
