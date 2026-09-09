export async function collectOzonPage(expectedProductId) {
  const observedAt = new Date().toISOString();
  const fail = (failureCode, message) => ({ status: "failed", failureCode, message, observedAt });
  const cleanText = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const productIdFromUrl = (value) => {
    try {
      if (typeof value !== "string") return "";
      const url = new URL(value);
      if (url.protocol !== "https:" || !["ozon.ru", "www.ozon.ru"].includes(url.hostname) || url.username || url.password || url.port) return "";
      return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})\/?$/i)?.[1] || "";
    } catch {
      return "";
    }
  };
  const currentProductId = productIdFromUrl(window.location.href);
  if (!currentProductId || currentProductId !== String(expectedProductId)) {
    return fail("wrong_product", "当前Ozon页面与评审台商品ID不一致");
  }

  // DOM remains website-controlled evidence even in ISOLATED; no claim of authenticity.
  if (document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]')) {
    return fail("site_verification_required", "Ozon页面要求人工完成验证");
  }
  if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) return fail("site_login_required", "Ozon页面要求先登录");

  const widget = (name) => document.querySelector?.(`[data-widget="${name}"]`) || null;
  const headingWidget = widget("webProductHeading");
  const priceWidget = widget("webPrice");
  const galleryWidget = widget("webGallery");
  const aspectsWidget = widget("webShortCharacteristics") || widget("webCharacteristics") || widget("webAspects");
  const breadcrumbsWidget = widget("breadCrumbs") || widget("webBreadCrumbs");
  const title = cleanText(headingWidget?.textContent || document.querySelector?.("h1")?.textContent);
  if (!title) return fail("structured_data_unavailable", "Ozon已加载页面中没有商品标题组件");

  const parsePrice = (value) => {
    let normalized = cleanText(value).replace(/\s*(?:₽|руб\.?|RUB)$/i, "");
    if (/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(normalized)) normalized = normalized.replace(/ /g, "").replace(",", ".");
    // RUB uses a decimal comma. A lone comma plus three digits (3,999) is
    // ambiguous, so only unambiguous multi-groups or explicit decimal-dot
    // grouping are accepted; never silently turn that lone comma into 3999.
    else if (/^\d{1,3}(?:(?:,\d{3}){2,}|(?:,\d{3})+\.\d{1,2})$/.test(normalized)) normalized = normalized.replace(/,/g, "");
    else if (/^\d+,\d{1,2}$/.test(normalized)) normalized = normalized.replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
  };
  const currencyFrom = (value) => {
    const text = cleanText(value);
    if (/(?:₽|руб\.?|RUB)$/i.test(text)) return "RUB";
    return "";
  };
  // The sole webPrice component is the boundary, not document.body or a nearby
  // product/recommendation block. Multiple components cannot be disambiguated.
  const priceWidgets = document.querySelectorAll?.('[data-widget="webPrice"]');
  if (priceWidgets?.length !== 1 || priceWidgets[0] !== priceWidget) return fail("precise_price_missing", "Ozon价格组件边界不明确");
  const maxPriceNodes = 512;
  const maxPriceDepth = 16;
  const maxPriceText = 16000;
  const priceElements = [];
  const priceTexts = [];
  const visited = new Set();
  const pending = [{ node: priceWidget, depth: 0 }];
  const allowedPriceTags = new Set(["DIV", "SPAN", "P", "SECTION", "BUTTON", "S", "DEL", "SMALL", "STRONG", "B", "EM", "I", "A"]);
  let textLength = 0;
  // Traverse childNodes (including direct sibling/ancestor text), not an
  // unbounded querySelectorAll followed by a sliced sample. No partial scans.
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (!node || visited.has(node) || visited.size >= maxPriceNodes || depth > maxPriceDepth) return fail("precise_price_missing", "Ozon价格组件结构或读取预算不明确");
    visited.add(node);
    if (node.nodeType === 3) {
      if (typeof node.textContent !== "string") return fail("precise_price_missing", "Ozon价格组件文字无效");
      textLength += node.textContent.length;
      if (textLength > maxPriceText) return fail("precise_price_missing", "Ozon价格组件超出文字预算");
      priceTexts.push(node);
      continue;
    }
    if (node.nodeType === 8) continue; // Comments are not displayed price conditions.
    if (node.nodeType !== 1 || !allowedPriceTags.has(node.tagName) || node.shadowRoot || !node.childNodes) return fail("precise_price_missing", "Ozon价格组件含未支持结构");
    priceElements.push(node);
    if (node.childNodes.length + pending.length + visited.size > maxPriceNodes) return fail("precise_price_missing", "Ozon价格组件超出节点预算");
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child?.parentNode !== node || child?.parentElement !== node) return fail("precise_price_missing", "Ozon价格组件父链不一致");
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  const hasPriceAncestor = (node, predicate) => {
    for (let current = node; current && visited.has(current); current = current.parentElement) if (predicate(current)) return true;
    return false;
  };
  const priceSpans = priceElements.filter((node) => node !== priceWidget && visited.has(node.parentElement) && node.tagName === "SPAN" && node.children.length === 0 && currencyFrom(node.textContent));
  const isCrossedOut = (node) => hasPriceAncestor(node, (ancestor) => ancestor.tagName === "S" || ancestor.tagName === "DEL");
  const pricedLeaves = priceSpans.filter((node) => !isCrossedOut(node));
  // An aria-label may omit visible purchase conditions; it cannot override
  // the complete local DOM label containing this price.
  const priceLabel = (node) => cleanText(node?.parentElement?.textContent);
  const ordinaryPrices = pricedLeaves.filter((node) => {
    const label = priceLabel(node).toLowerCase();
    const priceText = cleanText(node?.textContent).toLowerCase();
    // Absence of a button is not evidence of the non-card price. Require a
    // complete unconditional local label. Extra words (starting price,
    // installments, quantity/coupon conditions) are not an ordinary sale price.
    // Unknown wording stays unavailable instead of a broad substring fallback.
    return ["без карты ozon", "без ozon карты"].some((nonCardLabel) =>
      label === `${priceText} ${nonCardLabel}` || label === `${nonCardLabel} ${priceText}`
    );
  });
  const values = ordinaryPrices.map((node) => parsePrice(node.textContent));
  const distinctValues = new Set(values);
  if (!ordinaryPrices.length || values.includes(null) || distinctValues.size !== 1) {
    return fail("precise_price_missing", "Ozon已加载价格组件中没有普通买家当前价格");
  }
  const currentPrice = values[0];
  const currency = "RUB";
  const bankNodes = pricedLeaves.filter((node) => {
    const label = priceLabel(node).toLowerCase();
    const priceText = cleanText(node.textContent).toLowerCase();
    return ["с картой ozon", "с ozon картой"].some((bankLabel) => label === `${priceText} ${bankLabel}` || label === `${bankLabel} ${priceText}`) && parsePrice(node.textContent) !== null;
  });
  const understoodLabels = new Set([...ordinaryPrices, ...bankNodes].map((node) => node.parentElement));
  for (const node of priceSpans) if (isCrossedOut(node) && parsePrice(node.textContent) !== null) understoodLabels.add(node);
  // Every displayed text fragment in this bounded component must belong to a
  // complete understood price label. Thus any outer/sibling quantity, coupon,
  // installment or unknown condition fails closed, regardless of its wording.
  // Text outside this component is never consulted or allowed to alter price.
  if (priceTexts.some((node) => cleanText(node.textContent) && !hasPriceAncestor(node, (ancestor) => understoodLabels.has(ancestor)))) return fail("precise_price_missing", "Ozon价格组件存在未确认条件或文字");
  const bankPrices = bankNodes.map((node) => parsePrice(node.textContent));
  const bankPrice = bankPrices.length && !bankPrices.includes(null) && new Set(bankPrices).size === 1 ? bankPrices[0] : null;

  const imageByKey = new Map();
  // /wcN/ denotes a width variant on the observed Ozon CDN, not a product ID.
  const imageScore = (value) => Number(value.match(/\/wc(\d+)\//i)?.[1] || 0);
  for (const image of Array.from(galleryWidget?.querySelectorAll?.("img") || [])) {
    const rawSrc = cleanText(image?.currentSrc || image?.src || image?.getAttribute?.("src"));
    let url;
    try { url = new URL(rawSrc); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "ir.ozone.ru" || url.username || url.password || url.port) continue;
    const src = `${url.origin}${url.pathname}`;
    const key = url.pathname.replace(/\/wc\d+\//i, "/");
    const previous = imageByKey.get(key);
    if (!previous || imageScore(src) > imageScore(previous)) imageByKey.set(key, src);
  }
  const imageRefs = [...imageByKey.values()].slice(0, 40);

  const attributes = {};
  const directRows = Array.from(aspectsWidget?.children || []).flatMap((container) => Array.from(container?.children || []));
  for (const row of directRows) {
    const parts = Array.from(row?.children || []);
    if (parts.length < 2) continue;
    const name = cleanText(parts[0]?.textContent);
    const value = cleanText(parts[1]?.textContent);
    if (!name || !value || name === value || name.length > 160 || value.length > 1000) continue;
    if (/^(о товаре|характеристики)$/i.test(name) || /перейти к описанию/i.test(value)) continue;
    attributes[name] = value;
    if (Object.keys(attributes).length >= 120) break;
  }
  if (bankPrice) attributes["Ozon bank price"] = `${bankPrice} ${currency}`;

  const categoryPath = Array.from(breadcrumbsWidget?.querySelectorAll?.("a") || [])
    .map((node) => cleanText(node?.textContent))
    .filter(Boolean)
    .join(" > ") || "unknown";

  return {
    status: "captured",
    evidence: {
      productId: currentProductId,
      productUrl: `https://www.ozon.ru/product/${currentProductId}/`,
      title,
      imageRefs,
      currentPrice,
      currency,
      categoryPath,
      attributes,
      // No supported seller identity source is implemented. Country of manufacture
      // and product text cannot establish seller country; retain unknown downstream.
      sellerIdentitySignals: [],
      marketScope: "ozon_general_market",
      observedAt,
      source: "ozon_loaded_page_widgets"
    }
  };
}
