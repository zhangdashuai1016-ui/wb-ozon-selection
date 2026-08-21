export function toggleLocalSupplierSkuSelection(selectedSkuIds, sourceSkuId, checked) {
  const current = Array.isArray(selectedSkuIds) ? selectedSkuIds.map(String) : [];
  const id = String(sourceSkuId || "").trim();
  if (!id) return [...new Set(current)];
  if (checked) return [...new Set([...current, id])];
  return current.filter((item) => item !== id);
}
