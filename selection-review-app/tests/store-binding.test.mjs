import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredStoreRef, assertCandidateStoreBinding } from "../lib/store-binding.mjs";
import { normalizeStoreBindings } from "../lib/runtime-configuration.mjs";
import { normalizeCandidateUserPatchInput, normalizeCandidateUserCreateInput } from "../lib/candidate-user-fields.mjs";

const binding = { targetStore: "dandanshu", platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-001", mappingVersion: "synthetic-v1" } };

test("明确店铺映射独立保存真实平台ID，重复、错平台、缺字段与占位符拒绝", () => {
  const bindings = normalizeStoreBindings([binding]);
  assert.deepEqual(resolveConfiguredStoreRef(bindings, "dandanshu"), binding.storeRef);
  assert.equal(resolveConfiguredStoreRef(bindings, "wb"), null);
  const returned = resolveConfiguredStoreRef(bindings, "dandanshu");
  returned.mappingVersion = "changed";
  assert.equal(bindings[0].storeRef.mappingVersion, "synthetic-v1");
  for (const items of [
    [binding, binding],
    [binding, { ...binding, targetStore: "miska", storeRef: { ...binding.storeRef, stableStoreId: "miska" } }],
    [{ ...binding, platform: "wb" }],
    [{ ...binding, storeRef: { ...binding.storeRef, stableStoreId: "miska" } }],
    [{ ...binding, storeRef: { ...binding.storeRef, platformStoreId: "unknown" } }],
    [{ ...binding, storeRef: { ...binding.storeRef, platformStoreId: "https://example.invalid/store/1" } }],
    [{ ...binding, storeRef: { ...binding.storeRef, platformStoreId: "待配置" } }],
    [{ ...binding, storeRef: { ...binding.storeRef, mappingVersion: "" } }],
    [{ ...binding, storeRef: { ...binding.storeRef, password: "do-not-echo" } }]
  ]) assert.throws(() => normalizeStoreBindings(items), error => /STORE_BINDINGS_INVALID/.test(error.message) && !error.message.includes("do-not-echo"));
});

test("普通店铺保存同事务投影配置，冻结身份不重绑，客户端不能提交storeRef", () => {
  const bindings = normalizeStoreBindings([binding]);
  const candidate = { id: "candidate:a", targetStore: "dandanshu", storeRef: { ...binding.storeRef, mappingVersion: "old" } };
  assert.throws(() => assertCandidateStoreBinding(candidate, bindings), error => error.extra.code === "candidate_store_binding_unavailable");
  const patch = normalizeCandidateUserPatchInput({ targetStore: "dandanshu" }, candidate, { storeBindings: bindings });
  assert.deepEqual(patch, { targetStore: "dandanshu", storeRef: binding.storeRef });
  assert.equal(candidate.storeRef.mappingVersion, "old");
  assert.doesNotThrow(() => assertCandidateStoreBinding({ ...candidate, ...patch }, bindings));
  assert.deepEqual(normalizeCandidateUserPatchInput({ notes: "saved" }, candidate, { storeBindings: bindings }), { notes: "saved" });
  const frozen = { ...candidate, lifecycleV11: { skuPackage: { skuPackageId: "sku:a" } } };
  assert.deepEqual(normalizeCandidateUserPatchInput({ targetStore: "dandanshu" }, frozen, { storeBindings: bindings }), { targetStore: "dandanshu" });
  assert.throws(() => normalizeCandidateUserPatchInput({ targetStore: "wb" }, frozen, { storeBindings: bindings }), /冻结/);
  assert.throws(() => normalizeCandidateUserPatchInput({ storeRef: binding.storeRef }, candidate, { storeBindings: bindings }), /字段不允许/);
  assert.throws(() => normalizeCandidateUserCreateInput({ targetStore: "dandanshu", productUrl: "https://example.invalid/a", storeRef: binding.storeRef }), /字段不允许/);
});
