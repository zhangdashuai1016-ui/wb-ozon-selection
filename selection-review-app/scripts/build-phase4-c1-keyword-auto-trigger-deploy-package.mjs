#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PHASE4_C1_KEYWORD_AUTO_TRIGGER_REQUIRED_RUNTIME_DEPENDENCIES,
  PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES,
  fileReceipt,
  sha256,
  validateKeywordAutoTriggerPackageFiles,
  validateKeywordAutoTriggerServerDiff,
  validateKeywordAutoTriggerServerHashes,
  validateKeywordAutoTriggerSourceHashes
} from "../lib/phase4-c1-keyword-auto-trigger-deployment-boundary.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.SELECTION_REVIEW_RUNTIME_ROOT || "/Users/shuaizhang/Library/Application Support/今日选品评审台";
const outputRoot = process.env.PHASE4_C1_KEYWORD_AUTO_TRIGGER_PACKAGE_OUTPUT;
if (!outputRoot) throw new Error("PHASE4_C1_KEYWORD_AUTO_TRIGGER_PACKAGE_OUTPUT_REQUIRED");
await mkdir(outputRoot, { recursive: false });

for (const relativePath of PHASE4_C1_KEYWORD_AUTO_TRIGGER_REQUIRED_RUNTIME_DEPENDENCIES) {
  await access(path.join(runtimeRoot, relativePath));
}

const runtimeServer = path.join(runtimeRoot, "server.mjs");
const projectServer = path.join(projectRoot, "server.mjs");
const runtimeBody = await readFile(runtimeServer);
const targetBody = await readFile(projectServer);
const diff = spawnSync("diff", ["-u", runtimeServer, projectServer], { encoding: "utf8" });
if (diff.status !== 1) throw new Error(`PHASE4_C1_KEYWORD_AUTO_TRIGGER_DIFF_FAILED:${diff.stderr || diff.status}`);
const serverBoundary = validateKeywordAutoTriggerServerDiff(diff.stdout);
validateKeywordAutoTriggerServerHashes({ runtimeHash: sha256(runtimeBody), targetHash: sha256(targetBody) });

validateKeywordAutoTriggerPackageFiles(PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES);
const receipts = {};
for (const relativePath of PHASE4_C1_KEYWORD_AUTO_TRIGGER_RUNTIME_FILES) {
  const source = path.join(projectRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  receipts[relativePath] = await fileReceipt(destination);
}
validateKeywordAutoTriggerSourceHashes(receipts);

const manifest = {
  packageType: "selection-review-phase4-c1-keyword-auto-trigger-overlay",
  generatedAt: new Date().toISOString(),
  runtimeBaseline: { serverSha256: sha256(runtimeBody) },
  target: { serverSha256: sha256(targetBody) },
  boundary: {
    server: serverBoundary,
    requiredRuntimeDependencies: [...PHASE4_C1_KEYWORD_AUTO_TRIGGER_REQUIRED_RUNTIME_DEPENDENCIES],
    frontendIncluded: false,
    excludedDomains: ["C2_ASSET_EXECUTION", "D_PLATFORM_WRITE", "E_PLATFORM_READBACK", "CODEX_DISPATCH", "REAL_PRODUCT_EXECUTION"]
  },
  overlayFiles: receipts
};
await writeFile(path.join(outputRoot, "phase4-c1-keyword-auto-trigger-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
