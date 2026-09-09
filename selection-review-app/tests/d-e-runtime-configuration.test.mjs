import assert from "node:assert/strict";
import test from "node:test";
import { createSelectionReviewRuntimeConfiguration, normalizeDEServiceBindings, normalizeProductionBindings,
  normalizeStoreBindings } from "../lib/runtime-configuration.mjs";

const APP_DIR = "/synthetic-unavailable-directory/de-runtime-configuration";
const clone = value => structuredClone(value);
const storeBindings = normalizeStoreBindings(["dandanshu", "miska", "wb"].map(targetStore => ({
  targetStore, platform: targetStore === "wb" ? "wb" : "ozon",
  storeRef: { stableStoreId: targetStore, platformStoreId: `synthetic-${targetStore}`, mappingVersion: "stores-v1" }
})));

function production(index = 0, store = storeBindings[0]) {
  return { bindingId: `binding:synthetic:${index}`, configurationVersion: "production-config-v3", platform: store.platform,
    storeRef: clone(store.storeRef), storeName: `合成${store.targetStore}店铺`, warehouseName: "合成仓库",
    warehouseRef: `warehouse:synthetic:${index}`, warehouseId: String(70001 + index), credentialAlias: `alias:synthetic:${index}`,
    verification: { evidenceRef: `evidence:synthetic:config:${index}`, checkedAt: "2026-08-22T07:00:00.000Z", expiresAt: "2026-08-22T08:00:00.000Z" } };
}

function service(index = 0) {
  return { schemaVersion: "d-e-service-binding-v1", serviceId: `service:synthetic:${index}`, configurationVersion: "service-config-v5",
    productionBindingId: `binding:synthetic:${index}`, productionConfigurationVersion: "production-config-v3",
    workerId: `worker:synthetic:${index}`, workerVersion: "worker-version-v2", leaseDurationMs: 60_000 };
}

const productionBindings = normalizeProductionBindings([production(0), production(1, storeBindings[1])], storeBindings);
const baseEnv = { SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify(storeBindings),
  SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: JSON.stringify(productionBindings) };
const configuration = (env = {}) => createSelectionReviewRuntimeConfiguration({ env, appDir: APP_DIR, argv: [] });
const invalid = error => /DE_SERVICE_CONFIGURATION_INVALID/.test(error.message) && !error.message.includes("synthetic-private-value");

test("D/E默认空接线，配置加载不读取不存在的业务目录、不调用网络或证明凭据健康", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected configuration network request"); });
  const result = configuration();
  assert.deepEqual(result.deServiceBindings, []); assert.ok(Object.isFrozen(result.deServiceBindings));
  assert.deepEqual(result.ozonDECredentialBindings, []);
  assert.equal(result.ossRuntimeConfiguration, null);
  const configured = configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([service()]) });
  assert.deepEqual(configured.deServiceBindings, [service()]);
  assert.equal(fetch.mock.callCount(), 0);
  for (const field of ["health", "credentialVerified", "authorizationRecord", "paymentAuthorization", "transport"]) {
    assert.equal(Object.hasOwn(configured.deServiceBindings[0], field), false);
  }
  // Loading preserves a declaration even after its evidence expires. Current admission owns freshness.
  assert.equal(configured.productionBindings[0].verification.expiresAt, productionBindings[0].verification.expiresAt);
});

test("正式提供器的非秘密配置显式加载，未知JSON不静默回落", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider configuration request"); });
  const credentials = [{ credentialAlias: productionBindings[0].credentialAlias, clientId: "700123",
    keychainService: "synthetic-service", keychainAccount: "synthetic-seller-api" }];
  const oss = { region: "oss-cn-beijing", endpoint: "https://oss-cn-beijing.aliyuncs.com",
    bucket: "synthetic-review-assets", publicBaseUrl: "https://synthetic-review-assets.oss-cn-beijing.aliyuncs.com",
    objectPrefix: "final-assets/", keychainService: "synthetic-oss",
    keychainAccounts: { accessKeyId: "synthetic-key-id-account", accessKeySecret: "synthetic-key-secret-account" } };
  const configured = configuration({ ...baseEnv,
    SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: JSON.stringify(credentials),
    SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON: JSON.stringify(oss) });
  assert.deepEqual(configured.ozonDECredentialBindings, credentials);
  assert.deepEqual(configured.ossRuntimeConfiguration, oss);
  assert.ok(Object.isFrozen(configured.ozonDECredentialBindings));
  assert.ok(Object.isFrozen(configured.ossRuntimeConfiguration));
  assert.equal(fetch.mock.callCount(), 0);
  for (const name of ["SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON", "SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON"]) {
    assert.throws(() => configuration({ ...baseEnv, [name]: "{synthetic-private-invalid-json" }),
      error => error.message.startsWith("RUNTIME_CONFIGURATION_INVALID:") && !error.message.includes("synthetic-private"));
  }
});

test("两个店铺服务独立绑定，服务版本与生产版本分开并返回不可变副本", () => {
  const bindings = [service(), service(1)], before = clone(bindings);
  const result = normalizeDEServiceBindings(bindings, productionBindings);
  assert.deepEqual(result, bindings); assert.deepEqual(bindings, before); assert.notEqual(result, bindings);
  assert.ok(Object.isFrozen(result)); assert.ok(result.every(Object.isFrozen));
  assert.notEqual(result[0].configurationVersion, result[0].productionConfigurationVersion);
  assert.notEqual(result[0].workerId, result[1].workerId);
  assert.notEqual(productionBindings[0].storeRef.platformStoreId, productionBindings[1].storeRef.platformStoreId);
  assert.deepEqual(configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify(bindings) }).deServiceBindings, result);
});

test("新增D/E配置不改变已配置C1网关及其余运行配置", () => {
  const c1 = { schemaVersion: "c1-draft-service-binding-v1", provider: "terra", modelVersion: "gpt-5.6-terra",
    credentialAlias: "alias:synthetic:c1", workerId: "worker:synthetic:c1", workerVersion: "worker-v1",
    gatewayOrigin: "http://127.0.0.1:4318", configurationVersion: "gateway-v1", leaseDurationMs: 90_000 };
  const env = { ...baseEnv, SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([c1]) };
  const { deServiceBindings: absent, ...baseline } = configuration(env);
  const { deServiceBindings: present, ...withDE } = configuration({ ...env, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: JSON.stringify([service()]) });
  assert.deepEqual(absent, []); assert.deepEqual(present, [service()]);
  assert.deepEqual(withDE, baseline); assert.deepEqual(withDE.c1DraftServiceBindings, [c1]);
});

test("服务、Worker与生产绑定引用分别唯一，未知或失配生产版本及WB拒绝", () => {
  for (const field of ["serviceId", "workerId", "productionBindingId"]) {
    const other = service(1); other[field] = service()[field];
    assert.throws(() => normalizeDEServiceBindings([service(), other], productionBindings), invalid);
  }
  for (const change of [b => { b.productionBindingId = "binding:unknown"; }, b => { b.productionConfigurationVersion += "-other"; }]) {
    const binding = service(); change(binding); assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  assert.throws(() => normalizeDEServiceBindings([service()], [productionBindings[0], productionBindings[0]]), invalid);
  assert.throws(() => normalizeDEServiceBindings([service()], []), invalid);
  const wb = normalizeProductionBindings([production(0, storeBindings[2])], storeBindings);
  assert.throws(() => normalizeDEServiceBindings([service()], wb), invalid);
});

test("闭集必填字段、schema、引用与秘密输入严格拒绝且错误不回显输入", () => {
  for (const field of Object.keys(service())) {
    const binding = service(); delete binding[field]; assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  for (const field of ["serviceId", "configurationVersion", "productionBindingId", "productionConfigurationVersion", "workerId", "workerVersion"]) {
    for (const value of [null, "", "unknown", "not_applicable", "x".repeat(257), " leading-space", "https://example.com/reference",
      "token=synthetic-private-value", "Bearer synthetic-private-value", "ref%0asecret"]) {
      assert.throws(() => normalizeDEServiceBindings([{ ...service(), [field]: value }], productionBindings), invalid);
    }
  }
  for (const binding of [{ ...service(), schemaVersion: "d-e-service-binding-v2" }, { ...service(), token: "synthetic-private-value" },
    { ...service(), rawResponse: {} }, { ...service(), health: "ready" }, { ...service(), amount: 1 }]) {
    assert.throws(() => normalizeDEServiceBindings([binding], productionBindings), invalid);
  }
  for (const value of [null, {}, false, "[]"]) assert.throws(() => normalizeDEServiceBindings(value, productionBindings), invalid);
  for (const value of [null, {}, false]) assert.throws(() => normalizeDEServiceBindings([], value), invalid);
});

test("租约使用既有generic作业1000至1800000毫秒边界，拒绝小数和隐式转换", () => {
  for (const leaseDurationMs of [1000, 1_800_000]) {
    assert.equal(normalizeDEServiceBindings([{ ...service(), leaseDurationMs }], productionBindings)[0].leaseDurationMs, leaseDurationMs);
  }
  for (const leaseDurationMs of [999, 1_800_001, 0, -1, 1000.5, "1000", null, NaN, Infinity]) {
    assert.throws(() => normalizeDEServiceBindings([{ ...service(), leaseDurationMs }], productionBindings), invalid);
  }
});

test("最多100项接线与生产配置上限一致", () => {
  const productions = normalizeProductionBindings(Array.from({ length: 100 }, (_, index) => production(index)), storeBindings);
  const services = Array.from({ length: 100 }, (_, index) => service(index));
  assert.equal(normalizeDEServiceBindings(services, productions).length, 100);
  assert.throws(() => normalizeDEServiceBindings([...services, service(100)], productions), invalid);
  assert.throws(() => normalizeDEServiceBindings([], [...productions, production(100)]), invalid);
});

test("环境变量无效JSON或非数组显式失败，不回落空配置，不吞未知解析异常", () => {
  for (const value of ["", "broken-json", "null", "{}", "false", "1", JSON.stringify([{ ...service(), secret: "synthetic-private-value" }])]) {
    assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: value }), invalid);
  }
  assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "broken-json" }),
    /SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON必须是有效JSON数组/);
  const unexpected = new TypeError("synthetic conversion error");
  assert.throws(() => configuration({ ...baseEnv, SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: { toString() { throw unexpected; } } }), error => error === unexpected);
});
