export async function collect1688Page(expectedOfferId) {
  const limitText = (value, limit = 800) => String(value ?? "").trim().slice(0, limit);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const numberFrom = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "object") {
      for (const key of ["value", "amount", "price", "count", "stock"]) {
        const nested = numberFrom(value[key]);
        if (nested !== null) return nested;
      }
      return null;
    }
    const match = String(value).replace(/\s+/g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const first = (...values) => values.find((value) => value !== null && value !== undefined && String(value).trim() !== "");
  const pageOfferId = window.location.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  if (pageOfferId && pageOfferId !== String(expectedOfferId)) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: pageOfferId };
  }
  const bodyText = () => limitText(document.body?.innerText || "", 12000);
  const modelRoot = () => window.context?.result?.global?.globalData?.model || window.__INIT_DATA?.globalData || null;
  const skuRowsPresent = () => document.querySelectorAll?.("#skuSelection .ant-table-tbody tr[data-row-key]")?.length > 0;

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !modelRoot() && !skuRowsPresent()) await sleep(250);

  const root = modelRoot();
  const offerBaseInfo = root?.offerBaseInfo || null;
  const tradeModel = root?.tradeModel || null;
  const skuModel = root?.skuModel || null;
  const structuredOfferId = limitText(first(offerBaseInfo?.offerId, window.context?.result?.data?.offerId), 40);
  const actualOfferId = structuredOfferId || pageOfferId;
  if (!actualOfferId || actualOfferId !== String(expectedOfferId) || (pageOfferId && pageOfferId !== String(expectedOfferId))) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: actualOfferId || pageOfferId };
  }

  if (!root && !skuRowsPresent()) {
    const pageText = bodyText();
    if (/安全验证|人机验证|验证码|滑块|security check|verify/i.test(pageText)) {
      return { status: "failed", failureCode: "site_verification_required", message: "1688要求完成安全验证", offerId: actualOfferId };
    }
    if (/欢迎登录|密码登录|短信登录|请登录|login/i.test(pageText)) {
      return { status: "failed", failureCode: "site_login_required", message: "1688要求先登录", offerId: actualOfferId };
    }
    return { status: "failed", failureCode: "structured_data_unavailable", message: "页面没有可核验的SKU结构化数据", offerId: actualOfferId };
  }

  const supplierAttributes = {};
  const attributeLists = [
    root?.offerAttributeModel?.offerAttrs,
    window.context?.result?.data?.productAttributes?.fields?.attributes
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
    const direct = first(rawSku?.specAttrs, rawSku?.specAttr, rawSku?.attributes);
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

  const directField = (object, fields, positiveOnly = false) => {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(object || {}, field)) continue;
      const parsed = numberFrom(object[field]);
      if (parsed !== null && (!positiveOnly || parsed > 0)) return { value: parsed, source: field };
    }
    return { value: null, source: null };
  };

  const rawSkuEntries = [];
  const addEntries = (value, source) => {
    if (Array.isArray(value)) value.forEach((item, index) => rawSkuEntries.push({ item, fallbackId: "", source: `${source}[${index}]` }));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => rawSkuEntries.push({ item, fallbackId: key, source: `${source}.${key}` }));
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
  addEntries(window.__INIT_DATA?.skuModel?.skuInfoMap, "__INIT_DATA.skuModel.skuInfoMap");
  addEntries(window.__INIT_DATA?.skuModel?.skuMap, "__INIT_DATA.skuModel.skuMap");
  addEntries(window.__INIT_DATA?.skuModel?.skuInfos, "__INIT_DATA.skuModel.skuInfos");
  addEntries(window.__INIT_DATA?.skuModel?.skuList, "__INIT_DATA.skuModel.skuList");

  const skus = [];
  const skuById = new Map();
  for (const entry of rawSkuEntries) {
    const rawSku = entry.item;
    if (!rawSku || typeof rawSku !== "object") continue;
    const sourceSkuId = limitText(first(rawSku?.skuId, rawSku?.id, rawSku?.specId, entry.fallbackId), 160);
    if (!sourceSkuId) continue;
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false);
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
      imageUrl: /^https:\/\//i.test(imageUrl) ? imageUrl : null
    };
    const existing = skuById.get(sourceSkuId);
    if (!existing) {
      skuById.set(sourceSkuId, incoming);
      skus.push(incoming);
      continue;
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
      const stockValue = numberFrom(priceNodes[1]?.textContent);
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
    window.context?.result?.data?.skuId
  ), 160);
  if (!skus.length && pageSelectedSkuId) {
    const rawSku = first(skuModel?.selectedSku, skuModel?.currentSku, tradeModel?.currentSku, {});
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false);
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
      imageUrl: /^https:\/\//i.test(limitText(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image), 2000))
        ? limitText(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image), 2000)
        : null
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
      const minimumQuantity = numberFrom(first(item?.beginAmount, item?.startQuantity, item?.minQuantity, item?.amount));
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

  return {
    status: "captured",
    evidence: {
      offerId: actualOfferId,
      title: titleChoice[0],
      offerStatus: limitText(first(offerBaseInfo?.status, offerBaseInfo?.offerStatus, tradeModel?.status), 120) || null,
      observedAt: new Date().toISOString(),
      titleSource: titleChoice[1],
      offerIdSource: structuredOfferId ? "offerBaseInfo.offerId" : "location.pathname",
      pageSelectedSkuId: pageSelectedSkuId || null,
      priceRanges,
      supplierAttributes,
      skus
    }
  };
}
