import { collect1688Page } from "./collector.js";
import { collectOzonPage } from "./collector-ozon.js";

const SOURCE_REQUEST_TYPE = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
const SALES_REQUEST_TYPE = "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const activeCaptures = new Set();

function canonicalSource(value, expectedOfferId) {
  try {
    const url = new URL(String(value || ""));
    const offerId = url.hostname === "detail.1688.com" ? url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] : "";
    if (!offerId || offerId !== String(expectedOfferId)) return null;
    return `https://detail.1688.com/offer/${offerId}.html`;
  } catch {
    return null;
  }
}

function validRequest(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.captureId || !payload.token || !payload.candidateId || !Number.isInteger(payload.dataRevision)) return false;
  return Boolean(canonicalSource(payload.sourceUrl, payload.expectedOfferId));
}

function ozonProductId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)ozon\.ru$/i.test(url.hostname)) return "";
    return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})(?:\/|$)/i)?.[1] || "";
  } catch {
    return "";
  }
}

function canonicalOzonSource(value, expectedProductId) {
  try {
    const url = new URL(String(value || ""));
    const productId = ozonProductId(url.href);
    if (!productId || productId !== String(expectedProductId)) return null;
    return `https://www.ozon.ru${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function validOzonRequest(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!payload.captureId || !payload.token || !payload.candidateId || !Number.isInteger(payload.dataRevision)) return false;
  return Boolean(canonicalOzonSource(payload.productUrl, payload.expectedProductId));
}

function waitForTab(tabId, timeoutMs = 15000, label = "页面") {
  return new Promise(async (resolve, reject) => {
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (existing?.status === "complete") return resolve(existing);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(Object.assign(new Error(`等待${label}加载超时`), { code: "timeout" }));
    }, timeoutMs);
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function ozonTabReady(tab, expectedProductId) {
  if (ozonProductId(tab?.url) !== String(expectedProductId)) return false;
  return tab?.status === "complete" || Boolean(String(tab?.title || "").trim());
}

function waitForOzonTab(tabId, expectedProductId, timeoutMs = 20000) {
  return new Promise(async (resolve, reject) => {
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (ozonTabReady(existing, expectedProductId)) return resolve(existing);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(Object.assign(new Error("等待Ozon商品页面就绪超时"), { code: "timeout" }));
    }, timeoutMs);
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || !ozonTabReady(tab, expectedProductId)) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function report(payload, result) {
  const response = await fetch(`http://127.0.0.1:4317/api/candidates/${encodeURIComponent(payload.candidateId)}/source-capture/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      captureId: payload.captureId,
      token: payload.token,
      dataRevision: payload.dataRevision,
      ...result
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `评审台返回${response.status}`), { code: "server_rejected" });
  return body;
}

async function reportOzon(payload, result) {
  const response = await fetch(`http://127.0.0.1:4317/api/candidates/${encodeURIComponent(payload.candidateId)}/sales-capture/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      captureId: payload.captureId,
      token: payload.token,
      dataRevision: payload.dataRevision,
      ...result
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `评审台返回${response.status}`), { code: "server_rejected" });
  return body;
}

async function runCapture(payload) {
  activeCaptures.add(payload.captureId);
  await chrome.storage.session.set({ [`capture:${payload.captureId}`]: { candidateId: payload.candidateId, startedAt: Date.now() } }).catch(() => undefined);
  let tabId = null;
  try {
    const sourceUrl = canonicalSource(payload.sourceUrl, payload.expectedOfferId);
    if (!sourceUrl) throw Object.assign(new Error("1688链接与候选不一致"), { code: "wrong_offer" });
    const matching = (await chrome.tabs.query({ url: "https://detail.1688.com/offer/*" }))
      .find((tab) => canonicalSource(tab.url, payload.expectedOfferId));
    const tab = matching
      ? await chrome.tabs.update(matching.id, { active: true, url: sourceUrl })
      : await chrome.tabs.create({ url: sourceUrl, active: true });
    tabId = tab.id;
    await waitForTab(tabId, 15000, "1688页面");
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collect1688Page,
      args: [String(payload.expectedOfferId)]
    });
    const collected = execution?.[0]?.result;
    if (!collected || typeof collected !== "object") throw Object.assign(new Error("页面没有返回采集结果"), { code: "structured_data_unavailable" });
    const accepted = await report(payload, collected.status === "captured"
      ? { status: "captured", evidence: collected.evidence }
      : {
          status: "failed",
          failureCode: collected.failureCode || "structured_data_unavailable",
          message: collected.message || "1688采集失败",
          observedAt: new Date().toISOString()
        });
    if (["verified", "needs_sku_selection"].includes(accepted?.candidate?.sourceCapture?.status) && tabId) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  } catch (error) {
    await report(payload, {
      status: "failed",
      failureCode: error?.code || "structured_data_unavailable",
      message: String(error?.message || error),
      observedAt: new Date().toISOString()
    }).catch(() => undefined);
  } finally {
    activeCaptures.delete(payload.captureId);
    await chrome.storage.session.remove(`capture:${payload.captureId}`).catch(() => undefined);
  }
}

async function runOzonCapture(payload) {
  activeCaptures.add(payload.captureId);
  await chrome.storage.session.set({ [`capture:${payload.captureId}`]: { candidateId: payload.candidateId, platform: "ozon", startedAt: Date.now() } }).catch(() => undefined);
  let tabId = null;
  try {
    const productUrl = canonicalOzonSource(payload.productUrl, payload.expectedProductId);
    if (!productUrl) throw Object.assign(new Error("Ozon链接与候选不一致"), { code: "wrong_product" });
    const matching = (await chrome.tabs.query({ url: "https://www.ozon.ru/product/*" }))
      .find((tab) => ozonProductId(tab.url) === String(payload.expectedProductId));
    const tab = matching
      ? await chrome.tabs.update(matching.id, { active: true, url: productUrl })
      : await chrome.tabs.create({ url: productUrl, active: true });
    tabId = tab.id;
    await waitForOzonTab(tabId, payload.expectedProductId);
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collectOzonPage,
      args: [String(payload.expectedProductId)]
    });
    const collected = execution?.[0]?.result;
    if (!collected || typeof collected !== "object") throw Object.assign(new Error("页面没有返回采集结果"), { code: "structured_data_unavailable" });
    const accepted = await reportOzon(payload, collected.status === "captured"
      ? { status: "captured", evidence: collected.evidence }
      : {
          status: "failed",
          failureCode: collected.failureCode || "structured_data_unavailable",
          message: collected.message || "Ozon采集失败",
          observedAt: collected.observedAt || new Date().toISOString()
        });
    if (accepted?.candidate?.salesCapture?.status === "verified" && tabId) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  } catch (error) {
    await reportOzon(payload, {
      status: "failed",
      failureCode: error?.code || "system_error",
      message: String(error?.message || error),
      observedAt: new Date().toISOString()
    }).catch(() => undefined);
  } finally {
    activeCaptures.delete(payload.captureId);
    await chrome.storage.session.remove(`capture:${payload.captureId}`).catch(() => undefined);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === BACKGROUND_PING) {
    sendResponse({ accepted: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (![SOURCE_REQUEST_TYPE, SALES_REQUEST_TYPE].includes(message?.type)) return false;
  const payload = message.payload;
  const isOzon = message.type === SALES_REQUEST_TYPE;
  const requestValid = isOzon ? validOzonRequest(payload) : validRequest(payload);
  if (!sender?.url?.startsWith("http://127.0.0.1:4317/") || !requestValid) {
    sendResponse({ accepted: false, error: "采集请求来源或内容无效" });
    return false;
  }
  if (activeCaptures.has(payload.captureId)) {
    sendResponse({ accepted: true });
    return false;
  }
  void (isOzon ? runOzonCapture(payload) : runCapture(payload));
  sendResponse({ accepted: true });
  return false;
});
