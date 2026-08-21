import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePostLaunchObservation } from "../lib/post-launch-observation.mjs";

const listedAt = "2026-08-01T00:00:00.000Z";

test("14天访客不足30不判失败", () => {
  const result = evaluatePostLaunchObservation({ listedAt, observedAt: "2026-08-15T00:00:00.000Z", visitors: 29, addToCarts: 0, orders: 0, stableForSale: true });
  assert.equal(result.status, "insufficient_traffic");
});

test("50到100访客零加购提示商品卡或报价问题", () => {
  const result = evaluatePostLaunchObservation({ listedAt, observedAt: "2026-08-16T00:00:00.000Z", visitors: 70, addToCarts: 0, orders: 0, stableForSale: true });
  assert.equal(result.status, "listing_problem");
});

test("21天后超过100访客仍零订单判定测试失败", () => {
  const result = evaluatePostLaunchObservation({ listedAt, observedAt: "2026-08-22T00:00:00.000Z", visitors: 101, addToCarts: 2, orders: 0, stableForSale: true });
  assert.equal(result.status, "test_failed");
});

test("已有订单优先标为继续观察经营质量", () => {
  const result = evaluatePostLaunchObservation({ listedAt, observedAt: "2026-08-25T00:00:00.000Z", visitors: 150, addToCarts: 4, orders: 1, stableForSale: true });
  assert.equal(result.status, "ordered");
});

test("缺流量指标不使用零值替代", () => {
  const result = evaluatePostLaunchObservation({ listedAt, observedAt: "2026-08-20T00:00:00.000Z", stableForSale: true });
  assert.equal(result.status, "missing_metrics");
  assert.equal(result.metricsComplete, false);
});
