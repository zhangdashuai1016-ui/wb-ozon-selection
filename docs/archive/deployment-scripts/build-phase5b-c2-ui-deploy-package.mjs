#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PHASE5B_RUNTIME_DIST,
  PHASE5B_TARGET_DIST,
  sha256,
  validateExactFileHashes,
  validatePhase5BServerDiff,
  validatePhase5BServerHashes
} from "../lib/phase5b-c2-ui-deployment-boundary.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.SELECTION_REVIEW_RUNTIME_ROOT || "/Users/shuaizhang/Library/Application Support/今日选品评审台";
const outputRoot = process.env.PHASE5B_C2_UI_PACKAGE_OUTPUT;
if (!outputRoot) throw new Error("PHASE5B_C2_UI_PACKAGE_OUTPUT_REQUIRED");
await mkdir(outputRoot, { recursive: false });

const runtimeServerPath = path.join(runtimeRoot, "server.mjs");
const targetServerPath = path.join(projectRoot, "server.mjs");
const runtimeServer = await readFile(runtimeServerPath);
const targetServer = await readFile(targetServerPath);
validatePhase5BServerHashes(sha256(runtimeServer), sha256(targetServer));
const diff = spawnSync("diff", ["-u", runtimeServerPath, targetServerPath], { encoding: "utf8" });
if (![0, 1].includes(diff.status)) throw new Error(`PHASE5B_DIFF_FAILED:${diff.stderr || diff.status}`);
const serverBoundary = validatePhase5BServerDiff(diff.stdout);
const runtimeDist = await validateExactFileHashes(runtimeRoot, PHASE5B_RUNTIME_DIST);
const targetDist = await validateExactFileHashes(projectRoot, PHASE5B_TARGET_DIST);

await cp(targetServerPath, path.join(outputRoot, "server.mjs"));
await cp(path.join(projectRoot, "dist"), path.join(outputRoot, "dist"), { recursive: true });
const manifest = {
  packageType: "selection-review-phase5b-c2-final-assets-ui-overlay",
  generatedAt: new Date().toISOString(),
  runtimeBaseline: { serverSha256: sha256(runtimeServer), dist: runtimeDist },
  target: { serverSha256: sha256(targetServer), dist: targetDist },
  boundary: {
    server: serverBoundary,
    allowedFunctions: ["local_final_asset_stage", "owner_asset_order_confirmation", "final_plan_card_creation"],
    excludedDomains: ["PRODUCTION_AUTHORIZATION", "D_PLATFORM_WRITE", "E_PLATFORM_READBACK", "AUTOMATION", "CODEX_DISPATCH"]
  },
  overlayFiles: ["server.mjs", ...Object.keys(PHASE5B_TARGET_DIST)]
};
await writeFile(path.join(outputRoot, "phase5b-c2-ui-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
