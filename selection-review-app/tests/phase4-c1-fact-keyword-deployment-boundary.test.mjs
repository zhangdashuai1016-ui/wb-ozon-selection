import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES,
  PHASE4_C1_FACT_KEYWORD_RUNTIME_SERVER_SHA256,
  PHASE4_C1_FACT_KEYWORD_TARGET_SERVER_SHA256,
  validateC1FactKeywordPackageFiles,
  validateC1FactKeywordServerDiff,
  validateC1FactKeywordServerHashes
} from "../lib/phase4-c1-fact-keyword-deployment-boundary.mjs";

test("C1事实关键词部署包锁定当前运行副本和目标服务版本", () => {
  assert.equal(validateC1FactKeywordServerHashes({
    runtimeHash: PHASE4_C1_FACT_KEYWORD_RUNTIME_SERVER_SHA256,
    targetHash: PHASE4_C1_FACT_KEYWORD_TARGET_SERVER_SHA256
  }), true);
  assert.throws(() => validateC1FactKeywordServerHashes({
    runtimeHash: "0".repeat(64), targetHash: PHASE4_C1_FACT_KEYWORD_TARGET_SERVER_SHA256
  }), /RUNTIME_CHANGED/);
});

test("部署包只含服务端接缝、三领域模块和两个Schema", () => {
  assert.deepEqual(validateC1FactKeywordPackageFiles(PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES), [...PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES].sort());
  assert.throws(() => validateC1FactKeywordPackageFiles([...PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES, "dist/index.html"]), /PACKAGE_SCOPE_MISMATCH/);
  assert.throws(() => validateC1FactKeywordPackageFiles([...PHASE4_C1_FACT_KEYWORD_RUNTIME_FILES, "lib/d-e-software-closure.mjs"]), /PACKAGE_SCOPE_MISMATCH/);
});

test("服务差异必须包含原子接缝并拒绝C2/D/E或派发夹带", () => {
  const base = "+prepareC1FactKeywordRuntime\n+buildC1FactKeywordAtomicPatch\n+prepareAndContinueC1FactKeywordEvidence\n+c1FactKeywordPipelineRoute\n+continueC1SoftwareWhenEvidenceReady(candidateId, staged.nextRevision)\n";
  assert.throws(() => validateC1FactKeywordServerDiff(base), /SERVER_DIFF_CHANGED/);
  assert.throws(() => validateC1FactKeywordServerDiff(`${base}+queueUserDispatch\n`), /FORBIDDEN_DIFF/);
});
