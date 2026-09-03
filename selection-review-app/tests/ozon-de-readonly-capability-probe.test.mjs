import assert from "node:assert/strict";
import test from "node:test";
import { probeOzonDEReadOnlyCapabilities } from "../lib/ozon-de-readonly-capability-probe.mjs";

function response(endpoint) {
  const common = { offer_id: "SAFE-SKU-1", product_id: 90001 };
  if (endpoint === "/v4/product/info/attributes") return { result: [{ ...common, id: 90001, images: ["https://cdn.example/1.jpg"] }] };
  if (endpoint === "/v3/product/info/list") return { items: [{ ...common, statuses: {}, errors: [] }] };
  if (endpoint === "/v5/product/info/prices") return { items: [{ ...common, price: { price: "100", currency_code: "CNY" } }] };
  if (endpoint === "/v4/product/info/stocks") return { items: [{ ...common, stocks: [] }] };
  if (endpoint === "/v3/product/list") return { result: { items: [] } };
  throw new Error("unexpected endpoint");
}

test("只读探针按固定顺序验证五端点且全部write=false", async () => {
  const calls = [];
  const result = await probeOzonDEReadOnlyCapabilities({
    store: "dandanshu",
    checkedAt: "2026-08-22T15:00:00.000Z",
    requestJson: async (request) => {
      calls.push(structuredClone(request));
      return response(request.endpoint);
    }
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.verifiedSteps.map((item) => item.step), ["attributes", "info", "prices", "stocks", "state_failed"]);
  assert.equal(calls.length, 5);
  assert.equal(calls.every((call) => call.write === false), true);
  assert.equal(JSON.stringify(result).includes("SAFE-SKU-1"), false);
});

test("端点传输失败只输出固定失败层且立即停止", async () => {
  const calls = [];
  await assert.rejects(() => probeOzonDEReadOnlyCapabilities({
    store: "dandanshu",
    checkedAt: "2026-08-22T15:00:00.000Z",
    requestJson: async (request) => {
      calls.push(request.endpoint);
      if (request.endpoint === "/v5/product/info/prices") throw new Error("secret remote text token=hidden");
      return response(request.endpoint);
    }
  }), (error) => {
    assert.equal(error.message, "OZON_DE_READONLY_PROBE_FAILED:prices_transport");
    assert.equal(error.message.includes("token"), false);
    return true;
  });
  assert.deepEqual(calls, ["/v4/product/info/attributes", "/v3/product/info/list", "/v5/product/info/prices"]);
});

test("响应形状或身份不一致使用固定枚举且不继续后续端点", async () => {
  const calls = [];
  await assert.rejects(() => probeOzonDEReadOnlyCapabilities({
    store: "dandanshu",
    checkedAt: "2026-08-22T15:00:00.000Z",
    requestJson: async (request) => {
      calls.push(request.endpoint);
      if (request.endpoint === "/v3/product/info/list") return { items: [] };
      return response(request.endpoint);
    }
  }), /OZON_DE_READONLY_PROBE_FAILED:info_identity/);
  assert.equal(calls.length, 2);
});
