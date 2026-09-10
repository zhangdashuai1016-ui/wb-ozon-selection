import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapabilitySourceSnapshot, checkCapabilitySourceSnapshot, CURRENT_SNAPSHOT_PATH, writeCapabilitySnapshot } from "./capability-source-snapshot.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("Usage: generate-capability-snapshot.mjs [--check]");
const checking = args[0] === "--check";
const snapshot = checking
  ? await checkCapabilitySourceSnapshot(appDir)
  : await buildCapabilitySourceSnapshot(appDir, new Date().toISOString());
if (!checking) await writeCapabilitySnapshot(appDir, snapshot);
console.log(`${args[0] === "--check" ? "Verified" : "Saved"} ${CURRENT_SNAPSHOT_PATH}: ${snapshot.sourceBaselines.integration.artifactCount} source artifacts; no runtime or platform observations`);
