import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_AREAS,
  CAPABILITY_ARTIFACT_ASSIGNMENTS,
  CAPABILITY_ARTIFACT_SCAN_POLICY,
  CAPABILITY_NODES,
  CAPABILITY_OVERLAP_GROUPS,
  CAPABILITY_REGISTRY_VERSION,
  CAPABILITY_RELATIONS,
  CAPABILITY_SNAPSHOT_VERSION,
  INTEGRATION_STATES,
  MAINLINE_QUALIFICATIONS,
  PRE_FREEZE_NUMBER_MIGRATIONS,
  REGISTRATION_STATES,
  RUNTIME_SCOPES,
  SIDE_EFFECT_TYPES,
  UNPLACED_CAPABILITIES,
  VERIFICATION_STATES,
  assertCapabilityRegistryIntegrity,
  registeredArtifactPaths
} from "../lib/capability-registry.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(appDir, "capability-snapshots", "three-store-capability-snapshot-v1.json");

async function walkFiles(relativeDirectory) {
  const absoluteDirectory = path.join(appDir, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(appDir, relativePath);
    const metadata = await lstat(absolutePath);
    assert.equal(metadata.isSymbolicLink(), false, `能力源码扫描禁止跟随符号链接：${relativePath}`);
    if (metadata.isDirectory()) files.push(...await walkFiles(relativePath));
    else if (metadata.isFile()) files.push(relativePath);
  }
  return files;
}

async function eligibleArtifactPaths() {
  const paths = [];
  for (const relativePath of CAPABILITY_ARTIFACT_SCAN_POLICY.rootFiles) {
    const metadata = await lstat(path.join(appDir, relativePath));
    assert.equal(metadata.isFile(), true, `能力源码根文件不存在：${relativePath}`);
    paths.push(relativePath);
  }
  for (const relativeDirectory of CAPABILITY_ARTIFACT_SCAN_POLICY.includedDirectories) {
    paths.push(...await walkFiles(relativeDirectory));
  }
  return [...new Set(paths)].sort();
}

async function sourceBaseline(paths) {
  const files = [];
  for (const relativePath of paths) {
    const bytes = await readFile(path.join(appDir, relativePath));
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const digest = createHash("sha256")
    .update(files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""))
    .digest("hex");
  return { digest, files };
}

function registryReferences() {
  const references = [];
  for (const node of CAPABILITY_NODES) {
    for (const reference of [...node.codeRefs, ...node.uiRefs, ...node.testRefs]) references.push({ ownerId: node.id, ...reference });
  }
  for (const item of UNPLACED_CAPABILITIES) {
    for (const reference of item.evidenceRefs) references.push({ ownerId: item.id, ...reference });
  }
  return references;
}

test("能力注册表的编号、五轴、关系门禁和主人决定边界完整", () => {
  assert.equal(assertCapabilityRegistryIntegrity(), true);
  assert.equal(CAPABILITY_REGISTRY_VERSION, "three-store-capability-registry-v3");
  assert.equal(CAPABILITY_SNAPSHOT_VERSION, "three-store-capability-snapshot-v1");
  assert.equal(CAPABILITY_AREAS.length, 8);
  assert.equal(CAPABILITY_NODES.length, 49);
  assert.equal(UNPLACED_CAPABILITIES.length, 14);
  assert.equal(CAPABILITY_OVERLAP_GROUPS.length, 8);

  for (const collection of [CAPABILITY_NODES, UNPLACED_CAPABILITIES, CAPABILITY_OVERLAP_GROUPS, CAPABILITY_ARTIFACT_ASSIGNMENTS]) {
    for (const item of collection) assert.match(item.id, /^\d+\.\d+$/);
  }
  assert.deepEqual(Object.keys(REGISTRATION_STATES), ["official", "candidate", "legacy", "simulation", "experimental", "unknown", "duplicate", "retiring"]);
  assert.deepEqual(Object.keys(INTEGRATION_STATES), ["connected", "partial", "disconnected", "isolated", "not_implemented"]);
  assert.equal(Object.keys(VERIFICATION_STATES).length, 6);
  assert.equal(Object.keys(RUNTIME_SCOPES).includes("central_runtime"), true);
  assert.equal(Object.keys(MAINLINE_QUALIFICATIONS).includes("owner_decision"), true);
  assert.equal(Object.keys(SIDE_EFFECT_TYPES).includes("platform_write"), true);

  const nodeById = new Map(CAPABILITY_NODES.map((node) => [node.id, node]));
  for (const edge of CAPABILITY_RELATIONS) {
    if (edge.kind === "planned") assert.equal(edge.normalPathAllowed, false, `${edge.id} 计划线不得进入正常主线`);
    if (edge.normalPathAllowed) {
      assert.equal(nodeById.get(edge.from).normalPathAllowed, true, `${edge.id} 上游无主线资格`);
      assert.equal(nodeById.get(edge.to).normalPathAllowed, true, `${edge.id} 下游无主线资格`);
    }
  }
  assert.equal(nodeById.get("6.5").title, "把最终素材转成 Ozon 可用地址");
  assert.equal(nodeById.get("6.5").sideEffects.includes("platform_write"), false);
  assert.equal(nodeById.get("6.6").wiringStatus, "disconnected");
  assert.equal(nodeById.get("6.8").wiringStatus, "not_implemented");
  assert.equal(PRE_FREEZE_NUMBER_MIGRATIONS["registry-v2:6.6"], "6.7");
  for (const group of CAPABILITY_OVERLAP_GROUPS) assert.equal(group.currentPrimary, null);
});

test("全部第一方可执行、Schema、UI、扩展、脚本和测试产物都有明确归属", async () => {
  const eligible = await eligibleArtifactPaths();
  const registered = new Set(registeredArtifactPaths());
  const missing = eligible.filter((relativePath) => !registered.has(relativePath));
  assert.deepEqual(missing, []);

  const stale = [...registered].filter((relativePath) => relativePath !== "data/workflow-map.json" && !eligible.includes(relativePath));
  assert.deepEqual(stale, []);
  assert.equal(registered.has("data/workflow-map.json"), true, "旧动态地图数据必须登记存在但排除源码摘要");
  assert.equal(eligible.some((relativePath) => relativePath.startsWith("data/") && !relativePath.startsWith("data/logistics/")), false);
  assert.equal(eligible.some((relativePath) => relativePath.startsWith("evidence/")), false);
  assert.equal(eligible.some((relativePath) => relativePath.startsWith("dist/")), false);
  assert.equal(eligible.some((relativePath) => relativePath.endsWith(".md")), false);
});

test("能力与待归位引用能定位真实文件和当前锚点", async () => {
  for (const reference of registryReferences()) {
    assert.equal(path.isAbsolute(reference.path), false, `${reference.ownerId} 不能暴露绝对路径`);
    assert.equal(reference.path.includes(".."), false, `${reference.ownerId} 不能越出项目目录`);
    const source = await readFile(path.join(appDir, reference.path), "utf8");
    assert.equal(source.includes(reference.anchor), true, `${reference.ownerId} 的锚点已漂移：${reference.path}#${reference.anchor}`);
  }
});

test("冻结快照绑定当前源码摘要，并保留三处副本和逐能力存在性事实", async () => {
  const snapshotText = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const eligible = await eligibleArtifactPaths();
  const baseline = await sourceBaseline(eligible);

  assert.equal(snapshot.snapshotVersion, CAPABILITY_SNAPSHOT_VERSION);
  assert.equal(snapshot.registryVersion, CAPABILITY_REGISTRY_VERSION);
  assert.equal(snapshot.numbering.frozen, true);
  assert.equal(snapshot.numbering.retiredIdsMayBeReused, false);
  assert.equal(snapshot.sourceBaselines.main.artifactCount, eligible.length);
  assert.equal(snapshot.sourceBaselines.main.sha256, baseline.digest);
  assert.equal(snapshot.artifactCoverage.unexplainedCount, 0);
  assert.equal(snapshot.capabilities.length, CAPABILITY_NODES.length);
  assert.equal(snapshot.unplacedCapabilities.length, UNPLACED_CAPABILITIES.length);
  assert.equal(snapshot.overlapGroups.length, CAPABILITY_OVERLAP_GROUPS.length);
  assert.deepEqual(new Set(snapshot.capabilities.map((item) => item.id)), new Set(CAPABILITY_NODES.map((item) => item.id)));
  assert.deepEqual(new Set(snapshot.unplacedCapabilities.map((item) => item.id)), new Set(UNPLACED_CAPABILITIES.map((item) => item.id)));
  assert.deepEqual(new Set(snapshot.overlapGroups.map((item) => item.id)), new Set(CAPABILITY_OVERLAP_GROUPS.map((item) => item.id)));
  assert.deepEqual(Object.keys(snapshot.sourceBaselines).sort(), ["main", "oldWorktree", "runningCopy"]);
  assert.equal(snapshot.intentDocumentsUsed, false);
  assert.equal(snapshot.externalPlatformsAccessed, false);
  assert.doesNotMatch(snapshotText, /(?:\/Users\/|api[_-]?key|password|bearer\s|session[_-]?token|cookie)/i);
});
