import assert from "node:assert/strict";
import test from "node:test";

import { assertWorkerRegistryBoundary, createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";

test("本地Worker注册表按能力与心跳时效选择，且不冒充中央注册表", () => {
  let now = "2026-08-25T07:00:00.000Z";
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => now, heartbeatTtlMs: 30_000 });
  assert.deepEqual(assertWorkerRegistryBoundary(registry), {
    persistenceClass: "local_development_ephemeral", multiUserReady: false
  });
  registry.register({
    workerId: "worker-1", capabilities: ["chrome", "1688-login"], version: "1.0.0", observedAt: now
  });
  assert.throws(() => registry.register({
    workerId: "worker-future", capabilities: ["image-processing"], version: "1.0.0", observedAt: "2026-08-25T07:00:01.000Z"
  }), /WORKER_REGISTRY_OBSERVED_AT_IN_FUTURE/);
  assert.throws(() => registry.register({
    workerId: "worker-1", capabilities: ["image-processing"], version: "other", observedAt: now
  }), /WORKER_REGISTRY_DUPLICATE_WORKER/);
  assert.equal(registry.findEligible(["1688-login"]).length, 1);
  now = "2026-08-25T07:00:30.000Z";
  assert.equal(registry.findEligible(["1688-login"]).length, 1);
  now = "2026-08-25T07:00:31.000Z";
  assert.equal(registry.findEligible(["1688-login"]).length, 0);
  registry.heartbeat({ workerId: "worker-1", capabilities: ["chrome", "1688-login"], version: "1.0.0" });
  assert.equal(registry.findEligible(["chrome", "1688-login"]).length, 1);
  registry.markOffline("worker-1");
  assert.equal(registry.findEligible(["1688-login"]).length, 0);
});
