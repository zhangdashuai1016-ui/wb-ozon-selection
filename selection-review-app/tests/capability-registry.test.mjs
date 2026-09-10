import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_AREAS,
  CAPABILITY_ARTIFACT_ASSIGNMENTS,
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
import {
  CURRENT_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_SHA256,
  eligibleArtifactPaths, sourceBaseline, registryReferences, buildCapabilitySourceSnapshot
} from "../scripts/capability-source-snapshot.mjs";
const snapshotPath = path.join(appDir, CURRENT_SNAPSHOT_PATH);

test("能力注册表的编号、五轴、关系门禁和主人决定边界完整", () => {
  assert.equal(assertCapabilityRegistryIntegrity(), true);
  assert.equal(CAPABILITY_REGISTRY_VERSION, "three-store-capability-registry-v3");
  assert.equal(CAPABILITY_SNAPSHOT_VERSION, "three-store-capability-snapshot-v2");
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

test("无效健康枚举和不存在的归属负责人明确拒绝", async () => {
  const source = await readFile(path.join(appDir, "lib/capability-registry.mjs"), "utf8");
  const invalidHealth = source.replace('baselineHealth: { state: "unverified"', 'baselineHealth: { state: "invalid-health"');
  assert.notEqual(invalidHealth, source);
  await assert.rejects(import(`data:text/javascript;base64,${Buffer.from(invalidHealth).toString("base64")}`), /CAPABILITY_HEALTH_INVALID/);
  const invalidOwner = source.replace('"能力注册表与快照完整性门禁",\n    ["9.10"]', '"能力注册表与快照完整性门禁",\n    ["99.99"]');
  assert.notEqual(invalidOwner, source);
  const registry = await import(`data:text/javascript;base64,${Buffer.from(invalidOwner).toString("base64")}`);
  assert.throws(() => registry.assertCapabilityRegistryIntegrity(), /CAPABILITY_REGISTRY_INVALID.*指向不存在的能力编号/);
});

test("全部第一方可执行、Schema、UI、扩展、脚本和测试产物都有明确归属", async () => {
  const eligible = await eligibleArtifactPaths(appDir);
  const registered = new Set(registeredArtifactPaths());
  const missing = eligible.filter((relativePath) => !registered.has(relativePath));
  assert.deepEqual(missing, []);

  const stale = [...registered].filter((relativePath) => relativePath !== "data/workflow-map.json" && !eligible.includes(relativePath));
  assert.deepEqual(stale, []);
  assert.equal(registered.has("data/workflow-map.json"), true, "旧动态地图数据必须登记存在但排除源码摘要");
  assert.equal(eligible.some((relativePath) => relativePath.startsWith("data/")), false);
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

test("当前快照绑定集成源码摘要，历史快照原样保留且其他副本标为未核查", async () => {
  const snapshotText = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const eligible = await eligibleArtifactPaths(appDir);
  const baseline = await sourceBaseline(appDir, eligible);

  assert.equal(snapshot.snapshotVersion, CAPABILITY_SNAPSHOT_VERSION);
  assert.equal(snapshot.registryVersion, CAPABILITY_REGISTRY_VERSION);
  assert.equal(snapshot.numbering.frozen, true);
  assert.equal(snapshot.numbering.retiredIdsMayBeReused, false);
  assert.equal(snapshot.sourceBaselines.integration.artifactCount, eligible.length);
  assert.equal(snapshot.sourceBaselines.integration.sha256, baseline.digest);
  assert.equal(snapshot.artifactCoverage.unexplainedCount, 0);
  assert.equal(snapshot.assignmentGroups.length, CAPABILITY_ARTIFACT_ASSIGNMENTS.length);
  const frozenOwnership = new Set([
    ...snapshot.capabilities.flatMap(item => item.artifacts.map(ref => ref.path)),
    ...snapshot.unplacedCapabilities.flatMap(item => item.artifacts.map(ref => ref.path)),
    ...snapshot.overlapGroups.flatMap(item => item.artifacts.map(ref => ref.path)),
    ...snapshot.assignmentGroups.flatMap(item => item.paths)
  ]);
  assert.deepEqual(eligible.filter(file => !frozenOwnership.has(file)), []);
  assert.equal(snapshot.capabilities.length, CAPABILITY_NODES.length);
  assert.equal(snapshot.unplacedCapabilities.length, UNPLACED_CAPABILITIES.length);
  assert.equal(snapshot.overlapGroups.length, CAPABILITY_OVERLAP_GROUPS.length);
  assert.deepEqual(new Set(snapshot.capabilities.map((item) => item.id)), new Set(CAPABILITY_NODES.map((item) => item.id)));
  assert.deepEqual(new Set(snapshot.unplacedCapabilities.map((item) => item.id)), new Set(UNPLACED_CAPABILITIES.map((item) => item.id)));
  assert.deepEqual(new Set(snapshot.overlapGroups.map((item) => item.id)), new Set(CAPABILITY_OVERLAP_GROUPS.map((item) => item.id)));
  assert.deepEqual(Object.keys(snapshot.sourceBaselines).sort(), ["integration", "main", "oldWorktree", "runningCopy"]);
  assert.deepEqual(snapshot, await buildCapabilitySourceSnapshot(appDir, snapshot.frozenAt));
  for (const name of ["main", "oldWorktree", "runningCopy"]) {
    assert.deepEqual(snapshot.sourceBaselines[name], { status: "not_inspected_this_snapshot" });
  }
  const historicalBytes = await readFile(path.join(appDir, HISTORICAL_SNAPSHOT_PATH));
  const historical = JSON.parse(historicalBytes);
  assert.equal(historical.snapshotVersion, "three-store-capability-snapshot-v1");
  assert.equal(historical.frozenAt, "2026-08-27T20:02:12+08:00");
  assert.equal(historical.sourceBaselines.main.gitHead, "ca1df7ffe4d80c55d05c33276f28eea3f2c1de6a");
  assert.equal(snapshot.historicalSnapshot.sha256, createHash("sha256").update(historicalBytes).digest("hex"));
  assert.equal(snapshot.historicalSnapshot.sha256, HISTORICAL_SNAPSHOT_SHA256);
  assert.equal(snapshot.historicalSnapshot.interpretation, "historical_only_not_current_runtime_evidence");
  assert.equal(snapshot.intentDocumentsUsed, false);
  assert.equal(snapshot.externalPlatformsAccessed, false);
  assert.doesNotMatch(snapshotText, /(?:\/Users\/|api[_-]?key|password|bearer\s|session[_-]?token|cookie)/i);
});
