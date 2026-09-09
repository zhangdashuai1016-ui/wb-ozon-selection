// Presentation only: never coerce null, empty strings, or string payloads into business facts.
export function finiteDisplayNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatMoney(value, fractionDigits = 2) {
  const number = finiteDisplayNumber(value);
  return number === null ? "未取得" : `¥${number.toFixed(fractionDigits)}`;
}

export function formatPercent(value, fractionDigits = 1) {
  const number = finiteDisplayNumber(value);
  return number === null ? "未取得" : `${(number * 100).toFixed(fractionDigits)}%`;
}
