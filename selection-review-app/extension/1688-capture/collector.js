export async function collect1688Page(expectedOfferId) {
  const limitText = (value, limit = 800) => (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) ? String(value).trim().slice(0, limit) : "";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const numberFrom = (value, kind = "money") => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (kind !== "count" || Number.isInteger(value)) ? value : null;
    if (typeof value !== "string") return null;
    // Parse the complete scalar, never the first number of a range, tier or SKU label.
    let scalar = kind === "count"
      ? value.trim().replace(/^库存\s*/, "").replace(/\s*件$/, "")
      : value.trim().replace(/^(?:[¥￥]|CNY)\s*/i, "").replace(/\s*(?:元|CNY)$/i, "");
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(scalar)) scalar = scalar.replace(/,/g, "");
    else if (/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/.test(scalar)) scalar = scalar.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
    else if (/^\d+,\d{1,2}$/.test(scalar)) scalar = scalar.replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(scalar)) return null;
    const parsed = Number(scalar);
    return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER && (kind !== "count" || Number.isInteger(parsed)) ? parsed : null;
  };
  const imageUrlFrom = (value) => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)alicdn\.com$/.test(url.hostname)) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  const first = (...values) => values.find((value) => limitText(value) !== "");
  const firstObject = (...values) => values.find((value) => value !== null && typeof value === "object");
  let pageOfferId = "";
  try {
    const url = new URL(window.location.href);
    if (url.protocol === "https:" && url.hostname === "detail.1688.com" && !url.username && !url.password && !url.port) pageOfferId = url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  } catch { /* Invalid page identity fails below, without returning its URL. */ }
  if (!pageOfferId || pageOfferId !== String(expectedOfferId)) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: pageOfferId };
  }
  // ISOLATED protects built-ins, not the website-controlled DOM. JSON is evidence,
  // not trusted authority; never execute scripts or read MAIN-world globals.
  const pageBlocker = () => {
    if (document.querySelector?.('[id="nc_1_wrapper"], [id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]')) return "site_verification_required";
    if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) return "site_login_required";
    return null;
  };
  const readPageData = () => {
    const models = [];
    for (const script of Array.from(document.querySelectorAll?.('script[type="application/json"]') || []).slice(0, 20)) {
      const content = script.textContent;
      if (typeof content !== "string" || content.length > 1_000_000) continue;
      let parsed;
      try { parsed = JSON.parse(content); } catch { continue; } // Non-JSON scripts are not a supported source.
      const model = parsed?.result?.global?.globalData?.model || parsed?.globalData;
      if (model && typeof model === "object" && !Array.isArray(model)) models.push({ model, data: parsed?.result?.data, init: parsed });
    }
    return models.length === 1 ? models[0] : null;
  };
  const skuRowsPresent = () => document.querySelectorAll?.("#skuSelection .ant-table-tbody tr[data-row-key]")?.length > 0;

  // 20s of in-page polling: the model JSON on a throttled background tab arrives well after the first paint.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !pageBlocker() && !readPageData() && !skuRowsPresent()) await sleep(250);

  const blocker = pageBlocker();
  if (blocker) return { status: "failed", failureCode: blocker, offerId: pageOfferId };
  const pageData = readPageData();
  const root = pageData?.model;
  const offerBaseInfo = root?.offerBaseInfo || null;
  const tradeModel = root?.tradeModel || null;
  const skuModel = root?.skuModel || null;
  const declaredOfferIds = [offerBaseInfo?.offerId, pageData?.data?.offerId].filter((value) => value !== undefined && value !== null);
  if (root && (!declaredOfferIds.length || declaredOfferIds.some((value) => limitText(value, 40) !== String(expectedOfferId)))) {
    return { status: "failed", failureCode: "wrong_offer", offerId: pageOfferId };
  }
  const structuredOfferId = limitText(first(offerBaseInfo?.offerId, pageData?.data?.offerId), 40);
  const actualOfferId = structuredOfferId || pageOfferId;
  if (!actualOfferId || actualOfferId !== String(expectedOfferId) || (pageOfferId && pageOfferId !== String(expectedOfferId))) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: actualOfferId || pageOfferId };
  }

  if (!root && !skuRowsPresent()) {
    return { status: "failed", failureCode: "structured_data_unavailable", message: "页面没有可核验的SKU结构化数据", offerId: actualOfferId };
  }

  const supplierAttributes = {};
  const attributeLists = [
    root?.offerAttributeModel?.offerAttrs,
    pageData?.data?.productAttributes?.fields?.attributes
  ];
  for (const list of attributeLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = limitText(first(item?.name, item?.attrName, item?.title, item?.key), 120);
      const value = limitText(first(item?.value, item?.attrValue, item?.content, item?.text), 500);
      if (key && value) supplierAttributes[key] = value;
    }
  }

  const skuProps = Array.isArray(skuModel?.skuProps) && skuModel.skuProps.length
    ? skuModel.skuProps
    : Array.isArray(root?.skuProps) ? root.skuProps : [];
  const propLookup = new Map();
  for (const prop of skuProps) {
    const propId = limitText(first(prop?.fid, prop?.propId, prop?.id, prop?.pid), 80);
    const propName = limitText(first(prop?.prop, prop?.propName, prop?.name, "规格"), 120);
    for (const item of Array.isArray(prop?.value) ? prop.value : []) {
      const valueId = limitText(first(item?.vid, item?.valueId, item?.id, item?.propValueId), 80);
      const valueName = limitText(first(item?.name, item?.value, item?.displayName, item?.text), 300);
      if (propId && valueId && valueName) propLookup.set(`${propId}:${valueId}`, [propName, valueName]);
    }
  }

  const attributesForSku = (rawSku) => {
    const attributes = {};
    const direct = firstObject(rawSku?.specAttrs, rawSku?.specAttr, rawSku?.attributes) || first(rawSku?.specAttrs, rawSku?.specAttr, rawSku?.attributes);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      for (const [key, value] of Object.entries(direct)) {
        const cleaned = limitText(value, 300);
        if (cleaned) attributes[limitText(key, 120)] = cleaned;
      }
    } else if (Array.isArray(direct)) {
      for (const item of direct) {
        const key = limitText(first(item?.name, item?.key, item?.propName), 120);
        const value = limitText(first(item?.value, item?.text, item?.valueName), 300);
        if (key && value) attributes[key] = value;
      }
    } else if (direct && !/^\d+:\d+(?:[;,]\d+:\d+)*$/.test(String(direct).replace(/\s+/g, ""))) {
      attributes["规格"] = limitText(direct, 500);
    }
    const propPath = limitText(first(rawSku?.propPath, rawSku?.specId, rawSku?.specAttrs), 600);
    for (const token of propPath.match(/\d+:\d+/g) || []) {
      const mapped = propLookup.get(token);
      if (mapped) attributes[mapped[0]] = mapped[1];
    }
    return { attributes, propPath: propPath || null };
  };

  const directField = (object, fields, positiveOnly = false, kind = "money") => {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(object || {}, field)) continue;
      const parsed = numberFrom(object[field], kind);
      return parsed !== null && (!positiveOnly || parsed > 0) ? { value: parsed, source: field } : { value: null, source: null };
    }
    return { value: null, source: null };
  };

  const explicitScalarField = (entries, positiveOnly = false) => {
    for (const [source, value] of entries) {
      if (value === null || value === undefined || value === "") continue;
      const parsed = numberFrom(value);
      return parsed !== null && (!positiveOnly || parsed > 0) ? { value: parsed, source } : { value: null, source: null };
    }
    return { value: null, source: null };
  };

  const rawSkuEntries = [];
  const addEntries = (value, source) => {
    if (Array.isArray(value)) value.forEach((item, index) => rawSkuEntries.push({ item, source: `${source}[${index}]` }));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => rawSkuEntries.push({ item, source: `${source}.${key}` }));
  };
  addEntries(tradeModel?.skuMap, "tradeModel.skuMap");
  addEntries(tradeModel?.skuInfoMap, "tradeModel.skuInfoMap");
  addEntries(tradeModel?.skuInfos, "tradeModel.skuInfos");
  addEntries(tradeModel?.skuList, "tradeModel.skuList");
  addEntries(tradeModel?.skuItems, "tradeModel.skuItems");
  addEntries(skuModel?.skuInfoMap, "skuModel.skuInfoMap");
  addEntries(skuModel?.skuMap, "skuModel.skuMap");
  addEntries(skuModel?.skuInfos, "skuModel.skuInfos");
  addEntries(skuModel?.skuList, "skuModel.skuList");
  addEntries(skuModel?.skuItems, "skuModel.skuItems");
  addEntries(skuModel?.skus, "skuModel.skus");
  addEntries(root?.skuMap, "root.skuMap");
  addEntries(root?.skuInfoMap, "root.skuInfoMap");
  addEntries(root?.skuInfos, "root.skuInfos");
  addEntries(root?.skuList, "root.skuList");
  addEntries(root?.offerSkuModel?.skuInfoMap, "root.offerSkuModel.skuInfoMap");
  addEntries(root?.offerSkuModel?.skuMap, "root.offerSkuModel.skuMap");
  addEntries(pageData?.init?.skuModel?.skuInfoMap, "json.skuModel.skuInfoMap");
  addEntries(pageData?.init?.skuModel?.skuMap, "json.skuModel.skuMap");
  addEntries(pageData?.init?.skuModel?.skuInfos, "json.skuModel.skuInfos");
  addEntries(pageData?.init?.skuModel?.skuList, "json.skuModel.skuList");

  const skus = [];
  const skuById = new Map();
  for (const entry of rawSkuEntries) {
    const rawSku = entry.item;
    if (!rawSku || typeof rawSku !== "object") continue;
    // specId and map keys may be property combinations, not a supplier SKU ID.
    const sourceSkuId = limitText(first(rawSku?.skuId, rawSku?.id), 160);
    if (!sourceSkuId) continue;
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false, "count");
    const details = attributesForSku(rawSku);
    const imageUrl = limitText(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image), 2000);
    const incoming = {
      sourceSkuId,
      propPath: details.propPath,
      attributes: details.attributes,
      priceCny: price.value !== null && price.value > 0 ? price.value : null,
      priceSource: price.value !== null && price.value > 0 ? `${entry.source}.${price.source}` : null,
      stock: stock.value !== null && stock.value >= 0 ? stock.value : null,
      stockSource: stock.value !== null && stock.value >= 0 ? `${entry.source}.${stock.source}` : null,
      inStock: typeof rawSku.inStock === "boolean" ? rawSku.inStock : stock.value === null ? null : stock.value > 0,
      imageUrl: imageUrlFrom(imageUrl)
    };
    const existing = skuById.get(sourceSkuId);
    if (!existing) {
      skuById.set(sourceSkuId, incoming);
      skus.push(incoming);
      continue;
    }
    if ((existing.priceCny !== null && incoming.priceCny !== null && existing.priceCny !== incoming.priceCny) ||
        (existing.stock !== null && incoming.stock !== null && existing.stock !== incoming.stock) ||
        Object.entries(incoming.attributes).some(([key, value]) => existing.attributes[key] !== undefined && existing.attributes[key] !== value)) {
      return { status: "failed", failureCode: "structured_data_unavailable", offerId: actualOfferId };
    }
    existing.propPath ||= incoming.propPath;
    existing.attributes = { ...existing.attributes, ...incoming.attributes };
    if (existing.priceCny === null && incoming.priceCny !== null) {
      existing.priceCny = incoming.priceCny;
      existing.priceSource = incoming.priceSource;
    }
    if (existing.stock === null && incoming.stock !== null) {
      existing.stock = incoming.stock;
      existing.stockSource = incoming.stockSource;
    }
    if (existing.inStock === null && incoming.inStock !== null) existing.inStock = incoming.inStock;
    existing.imageUrl ||= incoming.imageUrl;
  }

  const headers = Array.from(document.querySelectorAll?.("#skuSelection .ant-table-thead th") || []).map((node) => limitText(node.textContent, 120));
  for (const row of Array.from(document.querySelectorAll?.("#skuSelection .ant-table-tbody tr[data-row-key]") || [])) {
      const sourceSkuId = limitText(row.getAttribute?.("data-row-key"), 160);
      if (!sourceSkuId) continue;
      const attributes = {};
      const cells = Array.from(row.querySelectorAll?.("td.ant-table-cell") || []);
      cells.forEach((cell, index) => {
        const key = headers[index];
        if (!key || /价格|库存|进货数量/.test(key)) return;
        const value = limitText(cell.textContent, 300);
        if (value) attributes[key] = value;
      });
      const priceNodes = row.querySelectorAll?.(".gyp-pro-table-price span") || [];
      const priceValue = numberFrom(priceNodes[0]?.textContent);
      const stockValue = numberFrom(priceNodes[1]?.textContent, "count");
      const domSku = {
        sourceSkuId,
        propPath: limitText(row.querySelector?.(".gyp-pro-table-title p")?.textContent, 600) || null,
        attributes,
        priceCny: priceValue !== null && priceValue > 0 ? priceValue : null,
        priceSource: priceValue !== null && priceValue > 0 ? "dom.sku_table.price" : null,
        stock: stockValue !== null && stockValue >= 0 ? stockValue : null,
        stockSource: stockValue !== null && stockValue >= 0 ? "dom.sku_table.stock" : null,
        inStock: stockValue === null ? null : stockValue > 0,
        imageUrl: null
      };
      const existing = skuById.get(sourceSkuId);
      if (!existing) {
        skus.push(domSku);
        skuById.set(sourceSkuId, domSku);
        continue;
      }
      if ((existing.priceCny !== null && domSku.priceCny !== null && existing.priceCny !== domSku.priceCny) ||
          (existing.stock !== null && domSku.stock !== null && existing.stock !== domSku.stock) ||
          Object.entries(domSku.attributes).some(([key, value]) => existing.attributes[key] !== undefined && existing.attributes[key] !== value)) {
        return { status: "failed", failureCode: "structured_data_unavailable", offerId: actualOfferId };
      }
      existing.propPath ||= domSku.propPath;
      existing.attributes = { ...existing.attributes, ...domSku.attributes };
      if (existing.priceCny === null && domSku.priceCny !== null) {
        existing.priceCny = domSku.priceCny;
        existing.priceSource = domSku.priceSource;
      }
      if (existing.stock === null && domSku.stock !== null) {
        existing.stock = domSku.stock;
        existing.stockSource = domSku.stockSource;
      }
      if (existing.inStock === null && domSku.inStock !== null) existing.inStock = domSku.inStock;
    }

  const pageSelectedSkuId = limitText(first(
    skuModel?.selectedSkuId,
    skuModel?.currentSkuId,
    skuModel?.defaultSkuId,
    skuModel?.skuId,
    skuModel?.selectedSku?.skuId,
    skuModel?.currentSku?.skuId,
    tradeModel?.selectedSkuId,
    tradeModel?.defaultSkuId,
    tradeModel?.skuId,
    tradeModel?.currentSku?.skuId,
    offerBaseInfo?.skuId,
    pageData?.data?.skuId
  ), 160);
  if (!skus.length && pageSelectedSkuId) {
    const rawSku = firstObject(skuModel?.selectedSku, skuModel?.currentSku, tradeModel?.currentSku) || {};
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false, "count");
    const details = attributesForSku(rawSku);
    skus.push({
      sourceSkuId: pageSelectedSkuId,
      propPath: details.propPath,
      attributes: details.attributes,
      priceCny: price.value !== null && price.value > 0 ? price.value : null,
      priceSource: price.value !== null && price.value > 0 ? `singleSku.${price.source}` : null,
      stock: stock.value !== null && stock.value >= 0 ? stock.value : null,
      stockSource: stock.value !== null && stock.value >= 0 ? `singleSku.${stock.source}` : null,
      inStock: typeof rawSku.inStock === "boolean" ? rawSku.inStock : stock.value === null ? null : stock.value > 0,
      imageUrl: imageUrlFrom(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image))
    });
  }

  if (skus.length > 200) return { status: "failed", failureCode: "sku_limit_exceeded", message: `页面包含${skus.length}个SKU，未截断`, offerId: actualOfferId };
  if (!skus.length) return { status: "failed", failureCode: "structured_data_unavailable", message: "未取得带SKU ID的规格数据", offerId: actualOfferId };

  const priceRanges = [];
  for (const [field, list] of [
    ["tradeModel.offerPriceRanges", tradeModel?.offerPriceRanges],
    ["tradeModel.currentPrices", tradeModel?.currentPrices],
    ["tradeModel.disPriceRanges", tradeModel?.disPriceRanges]
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const priceCny = numberFrom(first(item?.price, item?.value, item?.unitPrice, item));
      const minimumQuantity = numberFrom(first(item?.beginAmount, item?.startQuantity, item?.minQuantity, item?.amount), "count");
      if (priceCny !== null && priceCny > 0) priceRanges.push({ minimumQuantity, priceCny, source: field });
    }
  }

  const rawTitleCandidates = [
    [offerBaseInfo?.subject, "offerBaseInfo.subject"],
    [offerBaseInfo?.title, "offerBaseInfo.title"],
    [offerBaseInfo?.productTitle, "offerBaseInfo.productTitle"],
    [root?.offerModel?.subject, "offerModel.subject"],
    [document.querySelector?.('meta[property="og:title"]')?.content, "dom.meta.og:title"],
    [document.title, "document.title"],
    [document.querySelector?.("h1")?.textContent, "dom.h1"]
  ].map(([value, source]) => [limitText(value, 800).replace(/\s*[-_|]\s*阿里巴巴.*$/i, "").trim(), source])
    .filter(([value]) => value);
  const titleChoice = rawTitleCandidates.find(([value]) => !/(?:有限责任公司|有限公司|个体工商户|经营部)$/.test(value)) || rawTitleCandidates[0] || ["", null];
  const pageProductPrice = explicitScalarField([
    ["offerBaseInfo.offerPrice", offerBaseInfo?.offerPrice],
    ["offerBaseInfo.price", offerBaseInfo?.price],
    ["tradeModel.offerPrice", tradeModel?.offerPrice],
    ["tradeModel.unitPrice", tradeModel?.unitPrice],
    ["tradeModel.currentPrice", tradeModel?.currentPrice]
  ], true);
  const pageDomesticFreight = explicitScalarField([
    ["tradeModel.freightPrice", tradeModel?.freightPrice],
    ["tradeModel.postFee", tradeModel?.postFee],
    ["tradeModel.freight", tradeModel?.freight],
    ["freightModel.freightPrice", root?.freightModel?.freightPrice],
    ["freightModel.postFee", root?.freightModel?.postFee],
    ["freightModel.price", root?.freightModel?.price]
  ]);

  return {
    status: "captured",
    evidence: {
      offerId: actualOfferId,
      sourceUrl: `https://detail.1688.com/offer/${actualOfferId}.html`,
      title: titleChoice[0],
      offerStatus: limitText(first(offerBaseInfo?.status, offerBaseInfo?.offerStatus, tradeModel?.status), 120) || null,
      observedAt: new Date().toISOString(),
      titleSource: titleChoice[1],
      offerIdSource: structuredOfferId ? "offerBaseInfo.offerId" : "location.pathname",
      pageSelectedSkuId: pageSelectedSkuId || null,
      priceRanges,
      pageFields: {
        unitProductPriceCny: pageProductPrice.value,
        unitProductPriceSource: pageProductPrice.source,
        unitDomesticFreightCny: pageDomesticFreight.value,
        unitDomesticFreightSource: pageDomesticFreight.source
      },
      supplierAttributes,
      skus
    }
  };
}
