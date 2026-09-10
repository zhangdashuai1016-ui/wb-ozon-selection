#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, copyFile, cp } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PHASE3_AB_FRONTEND_SOURCE_FILES,
  PHASE3_AB_RUNTIME_FILES,
  fileReceipt,
  sha256,
  validateFrontendSourceDiff,
  validatePackageFileList,
  validateServerArtifactHashes,
  validateServerDiff
} from "../lib/phase3-ab-deployment-boundary.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.SELECTION_REVIEW_RUNTIME_ROOT || "/Users/shuaizhang/Library/Application Support/今日选品评审台";
const outputRoot = process.env.PHASE3_AB_PACKAGE_OUTPUT;

if (!outputRoot) throw new Error("PHASE3_AB_PACKAGE_OUTPUT_REQUIRED");
await mkdir(outputRoot, { recursive: false });

const runtimeServer = path.join(runtimeRoot, "server.mjs");
const projectServer = path.join(projectRoot, "server.mjs");
const runtimeServerBody = await readFile(runtimeServer);
const projectServerBody = await readFile(projectServer);
const serverDiffResult = spawnSync("diff", ["-u", runtimeServer, projectServer], { encoding: "utf8" });
if (![0, 1].includes(serverDiffResult.status)) throw new Error(`PHASE3_AB_DIFF_FAILED:${serverDiffResult.stderr || serverDiffResult.status}`);
const serverDiff = serverDiffResult.stdout;
const serverBoundary = validateServerDiff(serverDiff);
const runtimeServerHash = sha256(runtimeServerBody);
const targetServerHash = sha256(projectServerBody);
validateServerArtifactHashes({
  runtimeServerHash,
  targetServerHash,
  changedLinesHash: serverBoundary.changedLinesHash
});

const changedFrontendOutput = execFileSync(
  "git",
  ["diff", "--name-only", "HEAD", "--", "selection-review-app/src"],
  { cwd: path.resolve(projectRoot, ".."), encoding: "utf8" }
);
const untrackedFrontendOutput = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "--", "selection-review-app/src"],
  { cwd: path.resolve(projectRoot, ".."), encoding: "utf8" }
);
const changedFrontendFiles = `${changedFrontendOutput}\n${untrackedFrontendOutput}`
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean)
  .map((file) => file.replace(/^selection-review-app\//, ""));
const frontendBoundary = validateFrontendSourceDiff(changedFrontendFiles);

validatePackageFileList(PHASE3_AB_RUNTIME_FILES);
for (const relativePath of PHASE3_AB_RUNTIME_FILES) {
  const source = path.join(projectRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
await cp(path.join(projectRoot, "dist"), path.join(outputRoot, "dist"), { recursive: true });

const receipts = {};
for (const relativePath of PHASE3_AB_RUNTIME_FILES) {
  receipts[relativePath] = await fileReceipt(path.join(outputRoot, relativePath));
}
const distFiles = await readdir(path.join(outputRoot, "dist"), { recursive: true });
const distReceipts = {};
for (const relativePath of distFiles.filter((file) => !file.endsWith("/"))) {
  const fullPath = path.join(outputRoot, "dist", relativePath);
  try {
    distReceipts[`dist/${relativePath}`] = await fileReceipt(fullPath);
  } catch {
    // readdir may return directories on some Node versions.
  }
}

const manifest = {
  packageType: "selection-review-phase3-ab-overlay",
  generatedAt: new Date().toISOString(),
  runtimeBaseline: {
    serverSha256: runtimeServerHash
  },
  target: {
    serverSha256: targetServerHash
  },
  boundary: {
    server: serverBoundary,
    frontendSourceFiles: frontendBoundary,
    excludedDomains: ["C1_FACT_EXECUTION", "C2_ASSET_EXECUTION", "D_PLATFORM_WRITE", "E_PLATFORM_READBACK"]
  },
  overlayFiles: receipts,
  frontendBuildFiles: distReceipts
};
await writeFile(path.join(outputRoot, "phase3-ab-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
