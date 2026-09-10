import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE5B_RUNTIME_SERVER_SHA256,
  PHASE5B_TARGET_SERVER_SHA256,
  sha256,
  validatePhase5BServerDiff,
  validatePhase5BServerHashes,
  validateExactFileHashes
} from "../lib/phase5b-c2-ui-deployment-boundary.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("历史包指纹不随源码更新而重写，当前源码保留C2入口", async () => {
  const sourceBody = await readFile(path.join(appDir, "server.mjs"), "utf8");
  for (const marker of ["c2FinalUploadsDir", "genericC2FinalAssetUploadRoute", "verifyAndAuthorizeStagedC2Assets", "prepareC2FinalUploadManifest", "confirmC2SoftwareFinalUploads"]) {
    assert.match(sourceBody, new RegExp(marker));
  }
  assert.notEqual(sha256(sourceBody), PHASE5B_TARGET_SERVER_SHA256);
});

test("指定文件核验使用合成目录，内容变化和缺失必须失败", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "deployment-hashes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "sample.txt");
  const body = Buffer.from("synthetic deployment file");
  await writeFile(file, body);
  const expected = { "sample.txt": sha256(body) };
  assert.deepEqual(await validateExactFileHashes(root, expected), { "sample.txt": { sha256: sha256(body), bytes: body.length } });
  await writeFile(file, "changed");
  await assert.rejects(validateExactFileHashes(root, expected), /PHASE5B_FILE_CHANGED/);
  await rm(file);
  await assert.rejects(validateExactFileHashes(root, expected), { code: "ENOENT" });
});
