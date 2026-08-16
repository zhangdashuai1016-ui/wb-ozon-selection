const MAX_SKUS = 200;
const MAX_ATTRIBUTES = 120;

function text(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function cleanObject(value, limit = MAX_ATTRIBUTES) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, limit)
      .map(([key, item]) => [text(key, 120), text(item, 500)])
      .filter(([key, item]) => key && item)
  );
}

export function extract1688OfferId(value) {
  const raw = text(value, 3000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname !== "detail.1688.com") return "";
    return url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  } catch {
    return raw.match(/(?:^|\/)offer\/(\d+)\.html(?:$|[?#])/i)?.[1] || "";
  }
}

export function sourceCaptureFailureMessage(code, detail = "") {
  const messages = {
    extension_not_installed: "未检测到本机1688采集扩展",
    extension_background_unavailable: "1688采集扩展已安装，但后台暂未响应",
    site_login_required: "1688页面需要先登录",
    site_verification_required: "1688页面要求完成人机或安全验证",
    wrong_offer: "打开的1688商品与当前候选不是同一个offer",
    structured_data_unavailable: "页面已打开，但没有取得可核验的结构化商品数据",
    sku_ambiguous: "已取得商品数据，但目标规格无法唯一对应一个SKU",
    exact_price_unavailable: "已找到目标SKU，但没有取得该SKU的直接价格",
    sku_limit_exceeded: "商品SKU数量超过安全读取上限，未进行截断或猜测",
    timeout: "等待1688页面加载超时",
    revision_conflict: "商品资料已变化，本次采集结果已拒绝",
    server_rejected: "评审台拒绝了本次采集结果",
    invalid_capture: "采集结果格式无效"
  };
  const base = messages[code] || "1688采集已停止";
  return detail ? `${base}：${text(detail, 800)}` : base;
}

export function sanitize1688Evidence(input, expectedOfferId) {
  if (!input || typeof input !== "object") throw new Error("invalid_capture");
  const offerId = text(input.offerId, 40);
  if (!offerId || offerId !== String(expectedOfferId)) throw new Error("wrong_offer");
  const observedAt = text(input.observedAt, 80);
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime())) throw new Error("invalid_capture");
  const rawSkus = Array.isArray(input.skus) ? input.skus : [];
  if (!rawSkus.length) throw new Error("structured_data_unavailable");
  if (rawSkus.length > MAX_SKUS) throw new Error("sku_limit_exceeded");

  const seen = new Set();
  const skus = rawSkus.map((item) => {
    const sourceSkuId = text(item?.sourceSkuId, 160);
    if (!sourceSkuId || seen.has(sourceSkuId)) throw new Error("invalid_capture");
    seen.add(sourceSkuId);
    const priceCny = positive(item?.priceCny);
    const stock = nonNegative(item?.stock);
    const priceSource = text(item?.priceSource, 180);
    const stockSource = text(item?.stockSource, 180);
    if (priceCny !== null && !priceSource) throw new Error("invalid_capture");
    if (stock !== null && !stockSource) throw new Error("invalid_capture");
    return {
      sourceSkuId,
      propPath: text(item?.propPath, 600) || null,
      attributes: cleanObject(item?.attributes, 30),
      priceCny,
      priceSource: priceCny === null ? null : priceSource,
      stock,
      stockSource: stock === null ? null : stockSource,
      inStock: typeof item?.inStock === "boolean" ? item.inStock : stock === null ? null : stock > 0,
      imageUrl: /^https:\/\//i.test(text(item?.imageUrl, 2000)) ? text(item.imageUrl, 2000) : null
    };
  });

  const priceRanges = (Array.isArray(input.priceRanges) ? input.priceRanges : [])
    .slice(0, 50)
    .map((range) => ({
      minimumQuantity: positive(range?.minimumQuantity),
      priceCny: positive(range?.priceCny),
      source: text(range?.source, 180)
    }))
    .filter((range) => range.priceCny !== null && range.source);

  return {
    offerId,
    sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
    title: text(input.title, 800),
    offerStatus: text(input.offerStatus, 120) || null,
    observedAt: new Date(observedAt).toISOString(),
    collectionMethod: "chrome_extension_structured_page_v1",
    titleSource: text(input.titleSource, 180) || null,
    offerIdSource: text(input.offerIdSource, 180) || null,
    pageSelectedSkuId: text(input.pageSelectedSkuId, 160) || null,
    priceRanges,
    supplierAttributes: cleanObject(input.supplierAttributes),
    skus
  };
}

function normalizeMatchText(value) {
  return text(value, 3000).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function desiredSkuTerms(candidate) {
  const values = [
    candidate?.codexReview?.sourceSku?.variant,
    candidate?.codexReview?.sourceSku?.sku,
    candidate?.listingPreparation?.expectedSourceSku,
    candidate?.productName
  ].map((value) => text(value, 1000)).filter(Boolean);
  const units = /\d+(?:\.\d+)?\s*(?:片|件|个|只|套|支|枚|cm|mm|厘米|毫米|克|千克|公斤|g|kg|毫升|升|ml|l)/giu;
  const terms = [];
  for (const value of values) {
    for (const match of value.matchAll(units)) terms.push(normalizeMatchText(match[0]));
  }
  return [...new Set(terms.filter(Boolean))];
}

function skuSearchText(sku) {
  return normalizeMatchText([
    sku.sourceSkuId,
    sku.propPath,
    ...Object.entries(sku.attributes || {}).flat()
  ].join(" "));
}

export function resolveCapturedSku(candidate, evidence, requestedSkuId = "") {
  const explicit = text(requestedSkuId, 160);
  if (explicit) {
    const selected = evidence.skus.find((sku) => sku.sourceSkuId === explicit) || null;
    if (!selected) return { status: "invalid_selection", choices: evidence.skus };
    if (!(selected.priceCny > 0)) return { status: "exact_price_unavailable", selected, choices: evidence.skus };
    return { status: "matched", selected, matchTerms: [], choices: evidence.skus };
  }

  const terms = desiredSkuTerms(candidate);
  const matches = terms.length
    ? evidence.skus.filter((sku) => terms.every((term) => skuSearchText(sku).includes(term)))
    : [];
  if (matches.length !== 1) {
    return { status: "needs_selection", choices: evidence.skus, matches, matchTerms: terms };
  }
  if (!(matches[0].priceCny > 0)) {
    return { status: "exact_price_unavailable", selected: matches[0], choices: evidence.skus, matchTerms: terms };
  }
  return { status: "matched", selected: matches[0], choices: evidence.skus, matchTerms: terms };
}

export function resolveCapturedSkus(evidence, requestedSkuIds = []) {
  const requested = [...new Set(
    (Array.isArray(requestedSkuIds) ? requestedSkuIds : [requestedSkuIds])
      .map((item) => text(item, 160))
      .filter(Boolean)
  )];
  if (!requested.length) return { status: "needs_selection", selected: [], choices: evidence.skus };
  const byId = new Map(evidence.skus.map((sku) => [sku.sourceSkuId, sku]));
  const selected = requested.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length !== requested.length) return { status: "invalid_selection", selected: [], choices: evidence.skus };
  return {
    status: "matched",
    selected,
    choices: evidence.skus,
    missingDirectPriceSkuIds: selected.filter((sku) => !(sku.priceCny > 0)).map((sku) => sku.sourceSkuId)
  };
}

export function sourceCaptureForDispatch(sourceCapture) {
  if (!sourceCapture || sourceCapture.status !== "verified") return null;
  const selectedSkus = Array.isArray(sourceCapture.selectedSkus)
    ? sourceCapture.selectedSkus
    : sourceCapture.selectedSku ? [sourceCapture.selectedSku] : [];
  return {
    captureId: text(sourceCapture.captureId, 100),
    status: "verified",
    offerId: text(sourceCapture.offerId, 40),
    sourceUrl: text(sourceCapture.sourceUrl, 2000),
    title: text(sourceCapture.title, 800),
    observedAt: text(sourceCapture.observedAt, 80),
    collectionMethod: text(sourceCapture.collectionMethod, 120),
    matchTerms: Array.isArray(sourceCapture.matchTerms) ? sourceCapture.matchTerms.map((item) => text(item, 100)).slice(0, 20) : [],
    selectedSkus: selectedSkus.map((sku) => ({
      sourceSkuId: text(sku.sourceSkuId, 160),
      propPath: text(sku.propPath, 600) || null,
      attributes: cleanObject(sku.attributes, 30),
      priceCny: positive(sku.priceCny),
      priceSource: text(sku.priceSource, 180) || null,
      stock: nonNegative(sku.stock),
      stockSource: text(sku.stockSource, 180) || null,
      inStock: sku.inStock ?? null
    })),
    missingDirectPriceSkuIds: selectedSkus.filter((sku) => !(sku.priceCny > 0)).map((sku) => text(sku.sourceSkuId, 160)),
    priceRanges: Array.isArray(sourceCapture.priceRanges) ? sourceCapture.priceRanges.slice(0, 50) : [],
    supplierAttributes: cleanObject(sourceCapture.supplierAttributes)
  };
}
