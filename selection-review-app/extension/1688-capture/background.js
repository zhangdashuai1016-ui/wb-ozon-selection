import { collect1688Page } from "./collector.js";
import { collectOzonPage } from "./collector-ozon.js";
import {
  classify1688TimeoutOutcome,
  classify1688NavigationOutcome,
  classify1688Source,
  detailOfferId,
  shouldWaitFor1688Destination,
  observed1688TabAddress,
  validateResolved1688Source
} from "./source-routing.js";
import { captureRequestErrorMessage, validateSupplierCaptureRequest } from "./capture-request.js";

const SOURCE_REQUEST_TYPE = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
const SALES_REQUEST_TYPE = "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const HEARTBEAT_URL = "http://127.0.0.1:4317/api/extension/heartbeat";
const HEARTBEAT_ALARM = "selection-review-extension-heartbeat";
const activeCaptures = new Set();

async function reportHeartbeat() {
  const response = await fetch(HEARTBEAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: chrome.runtime.getManifest().version,
      backgroundReady: true,
      observedAt: new Date().toISOString()
    })
  });
  if (!response.ok) throw new Error(`评审台心跳返回${response.status}`);
  const body = await response.json().catch(() => ({}));
  const payload = body?.captureJob;
  if (payload && !activeCaptures.has(payload.captureId)) {
    const validation = validateSupplierCaptureRequest({
      payload,
      manifestVersion: chrome.runtime.getManifest().version
    });
    if (!validation.ok) {
      if (payload.captureId && payload.token && payload.candidateId && Number.isInteger(payload.dataRevision)) {
        await report(payload, {
          status: "failed",
          failureCode: validation.code,
          observedAt: new Date().toISOString()
        }).catch(() => undefined);
      }
      return body;
    }
    void runCapture(payload);
  }
  return body;
}

function reportHeartbeatQuietly() {
  void reportHeartbeat().catch(() => {});
}

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) reportHeartbeatQuietly();
});
chrome.runtime.onInstalled.addListener(reportHeartbeatQuietly);
chrome.runtime.onStartup.addListener(reportHeartbeatQuietly);
reportHeartbeatQuietly();

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

function waitFor1688Destination(tabId, originalSource, expectedOfferId, timeoutMs = 15000) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    let lastDiagnostics = null;
    const stopWithFailure = (code, diagnostics) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(Object.assign(new Error("1688短链没有落到授权的商品详情页"), {
        code,
        failureDiagnostics: diagnostics
      }));
    };
    const inspect = (tab, stage) => {
      const observation = observed1688TabAddress(tab);
      const observedUrl = observation.value;
      if (!observedUrl) return false;
      const diagnostics = {
        ...classify1688NavigationOutcome(observedUrl, {
          expectedOfferId,
          navigationStage: stage
        }),
        tabObservation: observation.tabObservation,
        lastObservedClassification: lastDiagnostics?.redirectClassification || null
      };
      lastDiagnostics = diagnostics;
      const resolved = validateResolved1688Source(originalSource, observedUrl, expectedOfferId);
      if (resolved && tab?.status === "complete") {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ tab, ...resolved });
        return true;
      }
      if (diagnostics.redirectClassification === "different_offer") {
        stopWithFailure("wrong_offer", diagnostics);
        return true;
      }
      if (shouldWaitFor1688Destination(diagnostics, tab?.status)) return false;
      const failureCode = diagnostics.redirectClassification === "login_required"
        ? "site_login_required"
        : diagnostics.redirectClassification === "verification_required"
          ? "site_verification_required"
          : "short_link_resolution_failed";
      stopWithFailure(failureCode, diagnostics);
      return true;
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      const current = await chrome.tabs.get(tabId).catch(() => null);
      const diagnostics = classify1688TimeoutOutcome(current, expectedOfferId, lastDiagnostics);
      stopWithFailure("short_link_resolution_failed", diagnostics);
    }, timeoutMs);
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || settled) return;
      inspect(tab, changeInfo.status === "complete" || tab?.status === "complete" ? "page_complete" : "redirect_observed");
    };
    chrome.tabs.onUpdated.addListener(listener);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (settled) return;
    if (inspect(existing, existing?.status === "complete" ? "page_complete" : "redirect_observed")) return;
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
    const source = classify1688Source(payload.sourceUrl);
    if (!source) throw Object.assign(new Error("1688链接不在允许范围内"), { code: "wrong_offer" });
    const matching = source.type === "detail"
      ? (await chrome.tabs.query({ url: "https://detail.1688.com/offer/*" }))
        .find((tab) => detailOfferId(tab.url) === source.offerId)
      : null;
    const tab = matching
      ? await chrome.tabs.update(matching.id, { active: true, url: source.sourceUrl })
      : await chrome.tabs.create({ url: source.sourceUrl, active: true });
    tabId = tab.id;
    const resolved = await waitFor1688Destination(tabId, source.sourceUrl, payload.expectedOfferId, 15000);
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: collect1688Page,
      args: [resolved.offerId]
    });
    const collected = execution?.[0]?.result;
    if (!collected || typeof collected !== "object") throw Object.assign(new Error("页面没有返回采集结果"), { code: "structured_data_unavailable" });
    const accepted = await report(payload, collected.status === "captured"
      ? { status: "captured", resolvedSourceUrl: resolved.sourceUrl, evidence: collected.evidence }
      : {
          status: "failed",
          failureCode: collected.failureCode || "structured_data_unavailable",
          observedAt: new Date().toISOString()
        });
    if (["verified", "needs_sku_selection", "captured_waiting_owner_selection"].includes(accepted?.candidate?.sourceCapture?.status) && tabId) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  } catch (error) {
    await report(payload, {
      status: "failed",
      failureCode: error?.code || "structured_data_unavailable",
      ...(error?.failureDiagnostics ? { failureDiagnostics: error.failureDiagnostics } : {}),
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
    void reportHeartbeat().catch(() => undefined);
    sendResponse({ accepted: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (![SOURCE_REQUEST_TYPE, SALES_REQUEST_TYPE].includes(message?.type)) return false;
  const payload = message.payload;
  const isOzon = message.type === SALES_REQUEST_TYPE;
  if (!sender?.url?.startsWith("http://127.0.0.1:4317/")) {
    sendResponse({ accepted: false, code: "request_origin_invalid", error: "采集请求不是来自本机评审台" });
    return false;
  }
  const sourceValidation = isOzon ? null : validateSupplierCaptureRequest({
    payload,
    senderUrl: sender.url,
    manifestVersion: chrome.runtime.getManifest().version
  });
  if ((!isOzon && !sourceValidation.ok) || (isOzon && !validOzonRequest(payload))) {
    const code = isOzon ? "ozon_request_invalid" : sourceValidation.code;
    sendResponse({
      accepted: false,
      code,
      error: isOzon ? "Ozon采集请求缺少必要字段或商品身份不一致" : captureRequestErrorMessage(code)
    });
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
