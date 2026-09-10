import assert from "node:assert/strict";
import test from "node:test";
import { createSelectionReviewRuntimeConfiguration, normalizeC1DraftServiceBindings } from "../lib/runtime-configuration.mjs";

const binding = () => ({ schemaVersion: "c1-draft-service-binding-v1", provider: "terra", modelVersion: "gpt-5.6-terra",
  credentialAlias: "gateway-alias:synthetic", workerId: "worker:c1:synthetic", workerVersion: "worker-version:1",
  gatewayOrigin: "http://127.0.0.1:47128", configurationVersion: "configuration:synthetic:1", leaseDurationMs: 90_000 });

test("默认不配置费用或网关执行权限，技术接线只能显式加载", () => {
  const configuration = createSelectionReviewRuntimeConfiguration({ env: {}, appDir: "/synthetic/review-app", argv: [] });
  assert.deepEqual(configuration.c1DraftServiceBindings, []);
  const configured = createSelectionReviewRuntimeConfiguration({ env: { SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([binding()]) },
    appDir: "/synthetic/review-app", argv: [] });
  assert.deepEqual(configured.c1DraftServiceBindings, [binding()]);
  assert.equal(Object.hasOwn(configured.c1DraftServiceBindings[0], "quote"), false);
});

test("模型角色、别名、Worker、输入闭集与租约配置错误均明确拒绝", () => {
  for (const change of [
    value => { value.modelVersion = "gpt-5.6-sol"; },
    value => { value.credentialAlias = "Bearer private-value"; },
    value => { delete value.workerId; },
    value => { value.quote = { amount: 0 }; },
    value => { value.leaseDurationMs = 89_999; },
    value => { value.leaseDurationMs = 1_800_001; }
  ]) {
    const value = binding(); change(value);
    assert.throws(() => normalizeC1DraftServiceBindings([value], "local_development"), /C1_DRAFT_SERVICE_CONFIGURATION_INVALID/);
  }
  assert.throws(() => normalizeC1DraftServiceBindings([binding(), binding()], "local_development"), /C1_DRAFT_SERVICE_CONFIGURATION_INVALID/);
  assert.throws(() => normalizeC1DraftServiceBindings([], "unrecognized"), /C1_DRAFT_SERVICE_CONFIGURATION_INVALID/);
});

test("网关origin不能含路径、凭据或查询；中央模式不能使用回环地址", () => {
  for (const gatewayOrigin of ["http://127.0.0.1:47128/api", "http://127.0.0.1:47128/?token=private", "http://owner:private@127.0.0.1:47128", "file:///tmp/gateway"]) {
    assert.throws(() => normalizeC1DraftServiceBindings([{ ...binding(), gatewayOrigin }], "local_development"));
  }
  assert.throws(() => normalizeC1DraftServiceBindings([binding()], "central_production"), /中央模式必须/);
  assert.equal(normalizeC1DraftServiceBindings([{ ...binding(), gatewayOrigin: "https://gateway.example.test/" }], "central_production")[0].gatewayOrigin,
    "https://gateway.example.test");
});
