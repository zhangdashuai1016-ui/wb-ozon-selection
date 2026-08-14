export async function collectOzonPage(expectedProductId) {
  const observedAt = new Date().toISOString();
  const fail = (failureCode, message) => ({ status: "failed", failureCode, message, observedAt });
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const productIdFromUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})(?:\/|$)/i)?.[1] || "";
    } catch {
      return "";
    }
  };
  const currentProductId = productIdFromUrl(window.location.href);
  if (!currentProductId || currentProductId !== String(expectedProductId)) {
    return fail("wrong_product", "当前Ozon页面与评审台商品ID不一致");
  }

  const bodyText = cleanText(document.body?.innerText).slice(0, 10000).toLowerCase();
  if (/captcha|verify you are human|подтвердите, что вы не робот|проверка безопасности|验证码/.test(bodyText)) {
    return fail("site_verification_required", "Ozon页面要求人工完成验证");
  }

  const widget = (name) => document.querySelector?.(`[data-widget="${name}"]`) || null;
  const headingWidget = widget("webProductHeading");
  const priceWidget = widget("webPrice");
  const galleryWidget = widget("webGallery");
  const aspectsWidget = widget("webShortCharacteristics") || widget("webCharacteristics") || widget("webAspects");
  const breadcrumbsWidget = widget("breadCrumbs") || widget("webBreadCrumbs");
  const title = cleanText(headingWidget?.textContent || document.querySelector?.("h1")?.textContent);
  if (!title) return fail("structured_data_unavailable", "Ozon已加载页面中没有商品标题组件");

  const parsePrice = (value) => {
    const normalized = cleanText(value).replace(/[\s\u00a0\u2009]/g, "").replace(",", ".");
    const match = normalized.match(/\d+(?:\.\d+)?/);
    const parsed = match ? Number(match[0]) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const currencyFrom = (value) => {
    const text = String(value || "");
    if (/₽|руб/i.test(text)) return "RUB";
    if (/¥|元|cny/i.test(text)) return "CNY";
    if (/\$|usd/i.test(text)) return "USD";
    return "";
  };
  const priceSpans = Array.from(priceWidget?.querySelectorAll?.("span") || []);
  const ordinaryPriceNode = priceSpans.find((node) => currencyFrom(node?.textContent) && !node?.closest?.("button"));
  const ordinaryPriceText = cleanText(ordinaryPriceNode?.textContent);
  const currentPrice = parsePrice(ordinaryPriceText);
  const currency = currencyFrom(ordinaryPriceText);
  if (!currentPrice || !currency) {
    return fail("precise_price_missing", "Ozon已加载价格组件中没有普通买家当前价格");
  }
  const bankPriceNode = priceSpans.find((node) => currencyFrom(node?.textContent) && node?.closest?.("button"));
  const bankPrice = parsePrice(bankPriceNode?.textContent);

  const imageByKey = new Map();
  const imageScore = (value) => Number(String(value || "").match(/\/wc(\d+)\//i)?.[1] || 0);
  for (const image of Array.from(galleryWidget?.querySelectorAll?.("img") || [])) {
    const src = String(image?.currentSrc || image?.src || image?.getAttribute?.("src") || "").trim();
    if (!/^https:\/\//i.test(src) || !/ozone|ozon/i.test(src)) continue;
    const pathname = (() => { try { return new URL(src).pathname; } catch { return src; } })();
    const key = pathname.split("/").pop() || pathname;
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
      productUrl: window.location.href,
      title,
      imageRefs,
      currentPrice,
      currency,
      categoryPath,
      attributes,
      sellerIdentitySignals: [],
      marketScope: "ozon_general_market",
      observedAt,
      source: "ozon_loaded_page_widgets"
    }
  };
}
