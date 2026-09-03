import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  C2_STABLE_ASSET_TRANSPORT_CAPABILITY,
  C2_STABLE_ASSET_TRANSPORT_JOB_TYPE,
  enqueueC2StableAssetTransport
} from "../lib/c2-stable-asset-transport-use-case.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createLocalDevelopmentActor } from "../lib/runtime-identity.mjs";

const NOW = "2026-09-01T06:00:00.000Z";

test("B3-0a公开边界只声明唯一SoftwareJob类型和专用Worker能力", async () => {
  assert.equal(C2_STABLE_ASSET_TRANSPORT_JOB_TYPE, "c2_stable_asset_transport");
  assert.equal(C2_STABLE_ASSET_TRANSPORT_CAPABILITY, "stable-asset-transport");
  const source = await readFile(new URL("../lib/c2-stable-asset-transport-use-case.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    "server.mjs", "aliyun-oss", "production-plan", "execution-intent", "worker-registry", "workerRegistry",
    "fetch(", "http.request", "https.request"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes("createSoftwareJobEnvelope"), false);
  assert.equal(source.includes("executeBusinessMutation"), true);
  assert.equal(source.includes("executeSoftwareJobSettlementMutation"), true);
  assert.equal(source.includes("serverClock"), true);
  assert.equal(source.includes("jobInput"), true);
  assert.equal(source.includes("createJob:"), false);
  assert.equal(source.includes("mutate: ({ candidate: current, observedAt })"), true);
  assert.equal(source.includes("stagedAt: observedAt"), true);
  assert.equal(source.includes("createdAt:"), false);
  assert.equal(source.includes("createdAt: serverTime"), false);
  assert.equal(source.includes("settledAt: observedAt"), false);
  assert.equal(source.includes("stagedAt: serverTime"), false);
  assert.equal(source.includes("completedCandidateOutcome"), false);
  assert.equal(source.includes("validateC2StableAssetTransportResult"), false);
  assert.equal(source.includes("settleC2StableAssetTransport({"), false);

  const transactionSource = await readFile(new URL("../lib/business-mutation-transaction.mjs", import.meta.url), "utf8");
  assert.equal(transactionSource.includes("createSoftwareJobEnvelope({ ...structuredClone(effect.jobInput), createdAt: observedAt })"), true);
  assert.equal(transactionSource.includes("effect.createJob"), false);
});

test("缺失正式C2领域包时排队fail-closed且Repository逐字不变", async () => {
  const repository = createMemoryBusinessStateRepository({
    candidates: [{ id: "C-1", dataRevision: 4, lifecycleV11: { skuPackage: null } }],
    runtime: { operationAudit: [], idempotencyRecords: [], softwareJobs: [] }
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => enqueueC2StableAssetTransport({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW }),
    candidateId: "C-1",
    expectedCandidateRevision: 4,
    stagedAssets: [],
    ownerStagingConfirmation: null,
    transportAuthorizationRef: "transport-authz:c2:missing",
    credentialAlias: "credential-alias:oss:missing",
    allowedStableAssetHosts: ["assets.example.com"],
    serverTime: NOW
  }), /C2_STABLE_TRANSPORT_CANDIDATE_INVALID/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("超深或循环输入在fingerprint前有界拒绝且Repository不变", async () => {
  const repository = createMemoryBusinessStateRepository({
    candidates: [{ id: "C-1", dataRevision: 4, lifecycleV11: { skuPackage: null } }],
    runtime: { operationAudit: [], idempotencyRecords: [], softwareJobs: [] }
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const before = await repository.readSnapshot();
  await assert.rejects(() => enqueueC2StableAssetTransport({
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW }),
    candidateId: "C-1",
    expectedCandidateRevision: 4,
    stagedAssets: [cyclic],
    ownerStagingConfirmation: null,
    transportAuthorizationRef: "transport-authz:c2:bounded",
    credentialAlias: "credential-alias:oss:bounded",
    allowedStableAssetHosts: ["assets.example.com"],
    serverTime: NOW
  }), /resource-limit|RESOURCE_LIMIT|C2_STABLE_TRANSPORT_INPUT_REJECTED/);
  assert.deepEqual(await repository.readSnapshot(), before);
});
