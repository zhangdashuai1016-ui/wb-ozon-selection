import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE5B_RUNTIME_SERVER_SHA256,
  PHASE5B_TARGET_SERVER_SHA256,
  sha256,
  validatePhase5BServerDiff,
  validatePhase5BServerHashes
} from "../lib/phase5b-c2-ui-deployment-boundary.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeServer = "/Users/shuaizhang/Library/Application Support/今日选品评审台/server.mjs";

const validChangedLines = `
+const c2FinalUploadsDir = true;
+function genericC2FinalAssetUploadRoute() {}
+function verifyAndAuthorizeStagedC2Assets() {}
+const result = { businessStateChanged: false, platformWrites: 0 };
`;

test("第5B阶段部署边界锁定运行基线与目标服务哈希", () => {
  assert.equal(validatePhase5BServerHashes(PHASE5B_RUNTIME_SERVER_SHA256, PHASE5B_TARGET_SERVER_SHA256), true);
  assert.throws(() => validatePhase5BServerHashes("0".repeat(64), PHASE5B_TARGET_SERVER_SHA256), /RUNTIME_SERVER_CHANGED/);
  assert.throws(() => validatePhase5BServerHashes(PHASE5B_RUNTIME_SERVER_SHA256, "0".repeat(64)), /TARGET_SERVER_CHANGED/);
});

test("第5B阶段服务差异要求素材暂存、身份复核和零业务写入标记", () => {
  assert.throws(() => validatePhase5BServerDiff(validChangedLines), /SERVER_DIFF_CHANGED/);
  assert.throws(() => validatePhase5BServerDiff(`${validChangedLines}+createPlatformDraft\n`), /FORBIDDEN_DIFF/);
  assert.throws(() => validatePhase5BServerDiff("+const unrelated = true;"), /REQUIRED_DIFF_MISSING/);
});

test("第5B阶段历史包指纹保持冻结，当前运行副本继续保留已部署C2能力", async () => {
  const targetServer = path.join(appDir, "server.mjs");
  const runtimeBody = await readFile(runtimeServer, "utf8");
  const diff = spawnSync("diff", ["-u", runtimeServer, targetServer], { encoding: "utf8" });
  assert.ok([0, 1].includes(diff.status));
  if (diff.status === 1) assert.notEqual(diff.stdout, "");
  for (const marker of [
    "c2FinalUploadsDir",
    "genericC2FinalAssetUploadRoute",
    "verifyAndAuthorizeStagedC2Assets",
    "prepareC2FinalUploadManifest",
    "confirmC2SoftwareFinalUploads"
  ]) assert.match(runtimeBody, new RegExp(marker));
  assert.notEqual(sha256(await readFile(runtimeServer)), PHASE5B_TARGET_SERVER_SHA256);
  assert.notEqual(sha256(await readFile(targetServer)), PHASE5B_TARGET_SERVER_SHA256);
});
