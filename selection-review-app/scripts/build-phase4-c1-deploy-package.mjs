#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PHASE4_C1_REQUIRED_RUNTIME_DEPENDENCIES,
  PHASE4_C1_RUNTIME_FILES,
  fileReceipt,
  sha256,
  validatePackageFileList,
  validateServerArtifactHashes,
  validateServerDiff,
  validateSourceHashes
} from "../lib/phase4-c1-deployment-boundary.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.SELECTION_REVIEW_RUNTIME_ROOT || "/Users/shuaizhang/Library/Application Support/今日选品评审台";
const outputRoot = process.env.PHASE4_C1_PACKAGE_OUTPUT;

if (!outputRoot) throw new Error("PHASE4_C1_PACKAGE_OUTPUT_REQUIRED");
await mkdir(outputRoot, { recursive: false });

for (const relativePath of PHASE4_C1_REQUIRED_RUNTIME_DEPENDENCIES) {
  await access(path.join(runtimeRoot, relativePath));
}

const runtimeServer = path.join(runtimeRoot, "server.mjs");
const projectServer = path.join(projectRoot, "server.mjs");
const runtimeServerBody = await readFile(runtimeServer);
const projectServerBody = await readFile(projectServer);
const serverDiffResult = spawnSync("diff", ["-u", runtimeServer, projectServer], { encoding: "utf8" });
if (![0, 1].includes(serverDiffResult.status)) throw new Error(`PHASE4_C1_DIFF_FAILED:${serverDiffResult.stderr || serverDiffResult.status}`);
const serverBoundary = validateServerDiff(serverDiffResult.stdout);
const runtimeServerHash = sha256(runtimeServerBody);
const targetServerHash = sha256(projectServerBody);
validateServerArtifactHashes({
  runtimeServerHash,
  targetServerHash,
  changedLinesHash: serverBoundary.changedLinesHash
});

validatePackageFileList(PHASE4_C1_RUNTIME_FILES);
const receipts = {};
for (const relativePath of PHASE4_C1_RUNTIME_FILES) {
  const source = path.join(projectRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  receipts[relativePath] = await fileReceipt(destination);
}
validateSourceHashes(receipts);

const manifest = {
  packageType: "selection-review-phase4-c1-overlay",
  generatedAt: new Date().toISOString(),
  runtimeBaseline: { serverSha256: runtimeServerHash },
  target: { serverSha256: targetServerHash },
  boundary: {
    server: serverBoundary,
    requiredRuntimeDependencies: [...PHASE4_C1_REQUIRED_RUNTIME_DEPENDENCIES],
    frontendIncluded: false,
    excludedDomains: ["C2_ASSET_EXECUTION", "D_PLATFORM_WRITE", "E_PLATFORM_READBACK"]
  },
  overlayFiles: receipts
};
await writeFile(path.join(outputRoot, "phase4-c1-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
