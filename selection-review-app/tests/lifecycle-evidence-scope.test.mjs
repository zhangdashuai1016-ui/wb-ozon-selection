import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvidenceScope, evidenceScopeMatches, evidenceScopeKey } from "../lib/lifecycle-evidence-scope.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";

test("证据范围保留嵌套映射；属性顺序不改变键，店铺ID或版本改变必须隔离", () => {
  const scope = { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, category: "shelf", ruleVersion: "v1" };
  const normalized = normalizeEvidenceScope("schema", scope);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)).storeRef, SYNTHETIC_STORE_REF);
  const reordered = { ...scope, storeRef: Object.fromEntries(Object.entries(SYNTHETIC_STORE_REF).reverse()) };
  assert.equal(evidenceScopeKey("schema", scope), evidenceScopeKey("schema", reordered));
  for (const field of ["platformStoreId", "mappingVersion"]) {
    const changed = { ...scope, storeRef: { ...SYNTHETIC_STORE_REF, [field]: "changed" } };
    assert.notEqual(evidenceScopeKey("schema", scope), evidenceScopeKey("schema", changed));
    assert.equal(evidenceScopeMatches("schema", scope, changed), false);
  }
  const old = { ...scope }; delete old.storeRef;
  assert.equal(evidenceScopeMatches("schema", old, scope), false);
  assert.throws(() => normalizeEvidenceScope("schema", old), /EVIDENCE_SCOPE_INVALID/);
  assert.equal(evidenceScopeMatches("exchange_rate", { pair: "RUB/CNY" }, { pair: "rub/cny" }), true);
  assert.equal(evidenceScopeMatches("logistics_tariff", { route: "GUOO Economy Small", ruleVersion: "v1" }, { route: "guoo economy small", ruleVersion: "v1" }), true);
});

test("证据适用范围拒绝额外控制字段", () => {
  for (const extra of [{ kind: "schema" }, { arbitrary: "value" }]) {
    assert.throws(() => normalizeEvidenceScope("exchange_rate", { pair: "RUB/CNY", ...extra }), /EVIDENCE_SCOPE_INVALID/);
  }
});
