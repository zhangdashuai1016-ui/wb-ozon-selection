export const POST_LAUNCH_THRESHOLDS = Object.freeze({
  firstReviewDay: 14,
  insufficientTrafficVisitors: 30,
  engagementVisitorsMin: 50,
  engagementVisitorsMax: 100,
  failureReviewDayMin: 21,
  failureReviewDayMax: 30,
  failureVisitors: 100,
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function observationDays(listedAt, observedAt) {
  const start = Date.parse(listedAt || "");
  const end = Date.parse(observedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000);
}

export function evaluatePostLaunchObservation({
  listedAt,
  observedAt = new Date().toISOString(),
  visitors,
  addToCarts,
  orders,
  stableForSale,
} = {}) {
  const days = observationDays(listedAt, observedAt);
  const traffic = finiteNonNegative(visitors);
  const carts = finiteNonNegative(addToCarts);
  const paidOrders = finiteNonNegative(orders);
  const metricsComplete = traffic !== null && carts !== null && paidOrders !== null;

  if (days === null) return { status: "missing_listed_at", days: null, metricsComplete, label: "缺上架时间，不能开始计时" };
  if (stableForSale === false) return { status: "not_stable", days, metricsComplete, label: "未稳定在售，先排除审核、库存或配送问题" };
  if (!metricsComplete) return { status: "missing_metrics", days, metricsComplete, label: "等待接入当前访客、加购和订单数据" };
  if (paidOrders > 0) return { status: "ordered", days, metricsComplete, label: "已经出单，继续观察利润、退货和评价" };
  if (days >= POST_LAUNCH_THRESHOLDS.failureReviewDayMin &&
      traffic > POST_LAUNCH_THRESHOLDS.failureVisitors) {
    return { status: "test_failed", days, metricsComplete, label: "达到失败门槛：应降价、重做卖点或停止测试" };
  }
  if (days >= POST_LAUNCH_THRESHOLDS.firstReviewDay &&
      traffic >= POST_LAUNCH_THRESHOLDS.engagementVisitorsMin &&
      traffic <= POST_LAUNCH_THRESHOLDS.engagementVisitorsMax && carts === 0) {
    return { status: "listing_problem", days, metricsComplete, label: "有流量但零加购：优先查主图、价格、配送和吸引力" };
  }
  if (days >= POST_LAUNCH_THRESHOLDS.firstReviewDay &&
      traffic < POST_LAUNCH_THRESHOLDS.insufficientTrafficVisitors) {
    return { status: "insufficient_traffic", days, metricsComplete, label: "流量不足，不能判定选品失败" };
  }
  return {
    status: days < POST_LAUNCH_THRESHOLDS.firstReviewDay ? "learning" : "observing",
    days,
    metricsComplete,
    label: days < POST_LAUNCH_THRESHOLDS.firstReviewDay ? "前14天学习期，继续观察" : "证据尚未达到问题或失败门槛",
  };
}
