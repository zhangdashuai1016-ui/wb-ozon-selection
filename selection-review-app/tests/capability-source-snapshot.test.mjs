import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CAPABILITY_ARTIFACT_SCAN_POLICY, CAPABILITY_SNAPSHOT_VERSION } from "../lib/capability-registry.mjs";
import {
  eligibleArtifactPaths, sourceBaseline, writeCapabilitySnapshot, readCapabilitySnapshot,
  buildCapabilitySourceSnapshot, checkCapabilitySourceSnapshot, CURRENT_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_PATH
} from "../scripts/capability-source-snapshot.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
async function emptySource(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "capability-source-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const root of CAPABILITY_ARTIFACT_SCAN_POLICY.rootFiles) await fs.writeFile(path.join(dir, root), "source");
  for (const child of CAPABILITY_ARTIFACT_SCAN_POLICY.includedDirectories) await fs.mkdir(path.join(dir, child));
  return dir;
}

test("source traversal excludes nested private and non-source content and rejects source links", async t => {
  const dir = await emptySource(t);
  for (const relativePath of ["tests/.env.local", "scripts/logs/local.log", "lib/README.md", "src/photo.png", "tests/credentials.json"]) {
    await fs.mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
    await fs.writeFile(path.join(dir, relativePath), "must never be hashed");
  }
  const files = await eligibleArtifactPaths(dir);
  assert.deepEqual(files, [...CAPABILITY_ARTIFACT_SCAN_POLICY.rootFiles].sort());
  await assert.rejects(sourceBaseline(dir, ["tests/.env.local"]), /CAPABILITY_SOURCE_EXCLUDED/);
  await fs.symlink(path.join(dir, "package.json"), path.join(dir, "lib/linked.mjs"));
  await assert.rejects(eligibleArtifactPaths(dir), /CAPABILITY_SOURCE_SYMLINK/);
  await fs.unlink(path.join(dir, "lib/linked.mjs"));
  await fs.symlink(path.join(dir, "src"), path.join(dir, "lib/linked-dir"));
  await assert.rejects(eligibleArtifactPaths(dir), /CAPABILITY_SOURCE_SYMLINK/);
  await fs.writeFile(path.join(dir, "src/hidden.mjs"), "must never be read through a parent link");
  await assert.rejects(sourceBaseline(dir, ["lib/linked-dir/hidden.mjs"]), /CAPABILITY_SOURCE_SYMLINK/);
  await fs.unlink(path.join(dir, "lib/linked-dir"));
  await fs.writeFile(path.join(dir, "lib/new-unregistered.mjs"), "export const newSource = true;");
  await assert.rejects(buildCapabilitySourceSnapshot(dir, "2026-09-07T00:00:00.000Z"), /CAPABILITY_SOURCE_COVERAGE_INVALID.*new-unregistered/);
});

test("snapshot writes reject links and failed replacement preserves the existing snapshot", async t => {
  const dir = await emptySource(t);
  const snapshot = { snapshotVersion: CAPABILITY_SNAPSHOT_VERSION, evidence: "synthetic" };
  await writeCapabilitySnapshot(dir, snapshot);
  const old = await readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH);
  await assert.rejects(writeCapabilitySnapshot(dir, { ...snapshot, evidence: "changed" }, {
    fileSystem: { ...fs, rename: async () => { throw new Error("SYNTHETIC_RENAME_FAILURE"); } }
  }), /SYNTHETIC_RENAME_FAILURE/);
  assert.deepEqual(await readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH), old);
  assert.deepEqual((await fs.readdir(path.join(dir, "capability-snapshots"))).sort(), [path.basename(CURRENT_SNAPSHOT_PATH)]);
  const target = path.join(dir, CURRENT_SNAPSHOT_PATH);
  const historical = path.join(dir, HISTORICAL_SNAPSHOT_PATH);
  await fs.writeFile(historical, "untouched historical bytes");
  await fs.unlink(target);
  await fs.symlink(historical, target);
  await assert.rejects(writeCapabilitySnapshot(dir, snapshot), /CAPABILITY_SOURCE_SYMLINK/);
  assert.equal(await fs.readFile(historical, "utf8"), "untouched historical bytes");
  await fs.unlink(target);
  const external = path.join(dir, "outside.json");
  await fs.writeFile(external, "untouched other bytes");
  await fs.symlink(external, target);
  await assert.rejects(writeCapabilitySnapshot(dir, snapshot), /CAPABILITY_SOURCE_SYMLINK/);
  await assert.rejects(readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH), /CAPABILITY_SOURCE_SYMLINK/);
  assert.equal(await fs.readFile(external, "utf8"), "untouched other bytes");
  await fs.rm(path.join(dir, "capability-snapshots"), { recursive: true });
  await fs.mkdir(path.join(dir, "external-directory"));
  await fs.symlink(path.join(dir, "external-directory"), path.join(dir, "capability-snapshots"));
  await assert.rejects(writeCapabilitySnapshot(dir, snapshot), /CAPABILITY_SOURCE_SYMLINK/);
  assert.deepEqual(await fs.readdir(path.join(dir, "external-directory")), []);
});

test("changing any preserved historical bytes is rejected without rewriting either snapshot", async t => {
  const dir = await emptySource(t);
  for (const relativePath of await eligibleArtifactPaths(appDir)) {
    await fs.mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
    await fs.copyFile(path.join(appDir, relativePath), path.join(dir, relativePath));
  }
  await fs.mkdir(path.join(dir, "capability-snapshots"));
  const historicalBytes = await readCapabilitySnapshot(appDir, HISTORICAL_SNAPSHOT_PATH);
  await fs.writeFile(path.join(dir, HISTORICAL_SNAPSHOT_PATH), historicalBytes);
  await writeCapabilitySnapshot(dir, await buildCapabilitySourceSnapshot(dir, "2026-09-07T00:00:00.000Z"));
  const currentBytes = await readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH);
  await checkCapabilitySourceSnapshot(dir);
  const html = await fs.readFile(path.join(dir, "index.html"));
  await fs.appendFile(path.join(dir, "index.html"), "\n<!-- synthetic source change -->\n");
  await assert.rejects(checkCapabilitySourceSnapshot(dir), /CAPABILITY_SNAPSHOT_DRIFT/);
  assert.deepEqual(await readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH), currentBytes);
  assert.deepEqual(await readCapabilitySnapshot(dir, HISTORICAL_SNAPSHOT_PATH), historicalBytes);
  await fs.writeFile(path.join(dir, "index.html"), html);
  const historical = JSON.parse(historicalBytes);
  historical.purpose += " changed";
  const changedBytes = JSON.stringify(historical);
  await fs.writeFile(path.join(dir, HISTORICAL_SNAPSHOT_PATH), changedBytes);
  await assert.rejects(buildCapabilitySourceSnapshot(dir, "2026-09-07T00:00:00.000Z"), /CAPABILITY_HISTORY_CHANGED/);
  await assert.rejects(checkCapabilitySourceSnapshot(dir), /CAPABILITY_HISTORY_CHANGED/);
  assert.equal(await fs.readFile(path.join(dir, HISTORICAL_SNAPSHOT_PATH), "utf8"), changedBytes);
  assert.deepEqual(await readCapabilitySnapshot(dir, CURRENT_SNAPSHOT_PATH), currentBytes);
  assert.deepEqual((await fs.readdir(path.join(dir, "capability-snapshots"))).sort(), [path.basename(HISTORICAL_SNAPSHOT_PATH), path.basename(CURRENT_SNAPSHOT_PATH)]);
});
