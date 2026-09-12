import { collect1688Page } from "./collector.js";
import { collectOzonPage } from "./collector-ozon.js";
import {
  classify1688NavigationOutcome,
  classify1688Source,
  observed1688TabAddress,
  shouldWaitFor1688Destination,
  validateResolved1688Source
} from "./source-routing.js";
import {
  canonicalOzonCaptureSource,
  isReviewSender,
  isOzonCaptureJob,
  validateCaptureStartSignal,
  validateOzonCaptureRequest,
  validateSupplierCaptureRequest
} from "./capture-request.js";

export const HEARTBEAT_ALARM = "selection-review-extension-heartbeat";
const API_ORIGIN = "http://127.0.0.1:4317"; // Explicit local-development adapter, not central identity.
const BACKGROUND_PING = "SELECTION_REVIEW_EXTENSION_BACKGROUND_PING";
const START_TYPES = new Set(["SELECTION_REVIEW_1688_CAPTURE_REQUEST", "SELECTION_REVIEW_OZON_CAPTURE_REQUEST"]);
const FAILURE_CODES = new Set([
  "wrong_offer", "wrong_product", "structured_data_unavailable", "site_login_required",
  "site_verification_required", "short_link_resolution_failed", "timeout", "sku_limit_exceeded",
  "precise_price_missing", "exact_price_unavailable", "invalid_capture", "system_error"
]);
const safeFailureCode = (code) => FAILURE_CODES.has(code) ? code : "system_error";
const failure = (code) => Object.assign(new Error(code), { code });

function inspectCaptureTab(tab, payload) {
  if (isOzonCaptureJob(payload)) {
    const address = observed1688TabAddress(tab).value;
    if (!address) return null;
    const sourceUrl = canonicalOzonCaptureSource(address, payload.expectedProductId);
    if (!sourceUrl) throw failure("wrong_product");
    return tab.status === "complete" && !tab.pendingUrl ? { sourceUrl, productId: payload.expectedProductId } : null;
  }
  const address = observed1688TabAddress(tab).value;
  if (!address) return null;
  const resolved = validateResolved1688Source(payload.sourceUrl, address, payload.expectedOfferId);
  if (resolved && tab.status === "complete" && !tab.pendingUrl) return resolved;
  const diagnostics = classify1688NavigationOutcome(address, {
    expectedOfferId: payload.expectedOfferId,
    navigationStage: tab.status === "complete" ? "page_complete" : "redirect_observed"
  });
  if (diagnostics.redirectClassification === "different_offer") throw failure("wrong_offer");
  if (shouldWaitFor1688Destination(diagnostics, tab.status)) return null;
  if (diagnostics.redirectClassification === "login_required") throw failure("site_login_required");
  if (diagnostics.redirectClassification === "verification_required") throw failure("site_verification_required");
  throw failure("short_link_resolution_failed");
}

// Listen before reading the tab: a completion event between those steps must not be lost.
export function waitForCaptureTab(chromeApi, tabId, payload, { timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      chromeApi.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const inspect = (tab) => {
      if (settled) return;
      try {
        const result = inspectCaptureTab(tab, payload);
        if (result) finish(null, result);
      } catch (error) {
        finish(error);
      }
    };
    const listener = (updatedId, _changeInfo, tab) => { if (updatedId === tabId) inspect(tab); };
    const abort = () => finish(failure("timeout"));
    if (signal?.aborted) { reject(failure("timeout")); return; }
    chromeApi.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", abort, { once: true });
    // The 15s navigation budget leaves time inside the server's 60s execution lease.
    timer = setTimer(() => finish(failure("timeout")), timeoutMs);
    chromeApi.tabs.get(tabId).then(inspect, () => finish(failure("system_error")));
  });
}

function validatedCollectedResult(collected, resolved, payload) {
  if (!collected || typeof collected !== "object") throw failure("structured_data_unavailable");
  if (collected.status !== "captured") throw failure(safeFailureCode(collected.failureCode));
  const evidence = collected.evidence;
  if (isOzonCaptureJob(payload)) {
    if (evidence?.productId !== payload.expectedProductId ||
        canonicalOzonCaptureSource(evidence?.productUrl, payload.expectedProductId) !== resolved.sourceUrl) {
      throw failure("wrong_product");
    }
    return { status: "captured", evidence: { ...evidence, productUrl: resolved.sourceUrl } };
  }
  const source = classify1688Source(evidence?.sourceUrl);
  if (evidence?.offerId !== resolved.offerId || source?.type !== "detail" || source.sourceUrl !== resolved.sourceUrl) {
    throw failure("wrong_offer");
  }
  return { status: "captured", resolvedSourceUrl: resolved.sourceUrl, evidence: { ...evidence, sourceUrl: resolved.sourceUrl } };
}

/**
 * Browser APIs and transport are injectable only to exercise the worker with offline fixtures.
 * ISOLATED protects JS built-ins from page overrides; the shared DOM is still untrusted evidence.
 * Server authentication, durable lease/revision validation and no-replay remain mandatory.
 */
export function createCaptureRuntime({ chromeApi, fetchImpl, clock = () => new Date().toISOString(), waitOptions,
  // Chrome's global timer functions refuse to run with anything but the global as their receiver: held as plain
  // properties and then called as jobTimerOptions.setTimer(…), they throw TypeError: Illegal invocation. That threw
  // where the capture deadline was created and again in the finally that cleared it, so the deadline never existed,
  // the opened 1688 tab was never closed, no result was ever sent, and the worker stayed "capturing" for good — four
  // captures the owner watched time out on 2026-09-11/12. The wrappers keep the calls on the global.
  jobTimerOptions = { setTimer: (handler, delay) => setTimeout(handler, delay), clearTimer: timer => clearTimeout(timer) } } = {}) {
  let heartbeatPending = null;
  let alarmPending = null;
  let activeCapture = null;
  const seenCaptureIds = new Set();
  let cleanupBlocked = "";
  let lastHeartbeat = { ok: false, code: "heartbeat_not_observed", observedAt: null };
  let lastCaptureCode = "";
  const version = chromeApi.runtime.getManifest().version;
  const status = () => {
    // Transport health TTL matches the existing local heartbeat contract, not product evidence age.
    const fresh = lastHeartbeat.ok && Date.parse(clock()) - Date.parse(lastHeartbeat.observedAt) <= 75000;
    return {
      accepted: fresh && !cleanupBlocked,
      backgroundReady: !cleanupBlocked,
      serviceConnected: fresh,
      code: cleanupBlocked || (lastHeartbeat.ok && !fresh ? "heartbeat_stale" : lastHeartbeat.code),
      observedAt: lastHeartbeat.observedAt,
      captureActive: Boolean(activeCapture),
      lastCaptureCode,
      version
    };
  };

  async function sendResult(payload, result) {
    const route = isOzonCaptureJob(payload) ? "sales-capture" : "source-capture";
    const response = await fetchImpl(`${API_ORIGIN}/api/candidates/${encodeURIComponent(payload.candidateId)}/${route}/result`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captureId: payload.captureId, token: payload.token, dataRevision: payload.dataRevision, ...result })
    });
    if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "result_rejected");
  }

  async function executeCapture(payload) {
    let tabId = null;
    let result;
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const assertNotCancelled = () => { if (signal.aborted) throw failure("timeout"); };
    const closeOwnedTab = async (id) => {
      let closeTimer;
      try {
        await Promise.race([
          chromeApi.tabs.remove(id),
          new Promise((_resolve, reject) => {
            closeTimer = jobTimerOptions.setTimer(() => reject(failure("tab_cleanup_failed")), 3000);
          })
        ]);
      } catch { cleanupBlocked = "tab_cleanup_failed"; lastCaptureCode = "tab_cleanup_failed"; }
      finally { jobTimerOptions.clearTimer(closeTimer); }
    };
    // 30s includes tab creation, navigation, extraction and final browser identity readback.
    // With one 10s result POST this leaves room inside the existing 60s server lease.
    let deadlineTimer;
    const deadline = new Promise((_resolve, reject) => {
      deadlineTimer = jobTimerOptions.setTimer(() => {
        cancellation.abort();
        reject(failure("timeout"));
      }, 30000);
    });
    const capture = async () => {
      const url = isOzonCaptureJob(payload)
        ? canonicalOzonCaptureSource(payload.productUrl, payload.expectedProductId)
        : classify1688Source(payload.sourceUrl).sourceUrl;
      const tab = await chromeApi.tabs.create({ url, active: false });
      if (!Number.isInteger(tab.id)) throw failure("system_error");
      if (signal.aborted) {
        // Creation may resolve after the deadline. Its only allowed effect is closing this tab.
        await closeOwnedTab(tab.id);
        throw failure("timeout");
      }
      tabId = tab.id;
      const resolved = await waitForCaptureTab(chromeApi, tabId, payload, { ...waitOptions, signal });
      assertNotCancelled();
      const isOzon = isOzonCaptureJob(payload);
      const execution = await chromeApi.scripting.executeScript({
        target: { tabId }, world: "ISOLATED",
        func: isOzon ? collectOzonPage : collect1688Page,
        args: [isOzon ? payload.expectedProductId : resolved.offerId]
      });
      assertNotCancelled();
      // Re-read the browser identity after extraction, not the page's self-reported location.
      const current = inspectCaptureTab(await chromeApi.tabs.get(tabId), payload);
      assertNotCancelled();
      if (!current || current.sourceUrl !== resolved.sourceUrl) throw failure(isOzon ? "wrong_product" : "wrong_offer");
      return validatedCollectedResult(execution?.[0]?.result, resolved, payload);
    };
    try {
      result = await Promise.race([capture(), deadline]);
    } catch (error) {
      result = { status: "failed", failureCode: safeFailureCode(error?.code), observedAt: clock() };
      if (signal.aborted && tabId === null) cleanupBlocked = "tab_creation_unconfirmed";
    } finally {
      jobTimerOptions.clearTimer(deadlineTimer);
      if (tabId !== null) await closeOwnedTab(tabId);
    }
    try {
      // A transport failure has unknown delivery outcome: never send a second/fallback result.
      await sendResult(payload, result);
      lastCaptureCode = result.status === "failed" ? result.failureCode : "capture_reported";
    } catch (error) {
      lastCaptureCode = ["extension_identity_rejected", "result_rejected"].includes(error?.code) ? error.code : "result_delivery_unconfirmed";
      if (error?.code === "extension_identity_rejected") lastHeartbeat = { ok: false, code: "extension_identity_rejected", observedAt: clock() };
    } finally {
      activeCapture = null;
    }
  }

  function heartbeat() {
    if (heartbeatPending) return heartbeatPending;
    heartbeatPending = (async () => {
      try {
        const response = await fetchImpl(`${API_ORIGIN}/api/extension/heartbeat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ version, backgroundReady: !cleanupBlocked, observedAt: clock() })
        });
        if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "heartbeat_unavailable");
        const body = await response.json();
        if (body?.accepted !== true) throw failure("heartbeat_rejected");
        lastHeartbeat = { ok: true, code: "", observedAt: clock() };
        // Even an older service returning a job cannot start work from a heartbeat.
        return status();
      } catch (error) {
        lastHeartbeat = { ok: false, code: error?.code === "extension_identity_rejected" ? "extension_identity_rejected" : "heartbeat_unavailable", observedAt: clock() };
        return status();
      } finally { heartbeatPending = null; }
    })();
    return heartbeatPending;
  }

  async function claimCapture(message) {
    if (seenCaptureIds.has(message.captureId)) return { accepted: false, code: "capture_replay_rejected" };
    if (seenCaptureIds.size >= 256) return { accepted: false, code: "capture_session_limit_reached" };
    seenCaptureIds.add(message.captureId);
    activeCapture = message.captureId;
    try {
      const response = await fetchImpl(`${API_ORIGIN}/api/extension/capture-jobs/${encodeURIComponent(message.captureId)}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ version })
      });
      if (!response.ok) throw failure([401, 403].includes(response.status) ? "extension_identity_rejected" : "capture_job_not_claimed");
      const body = await response.json();
      const payload = body?.captureJob;
      const validation = isOzonCaptureJob(payload)
        ? validateOzonCaptureRequest({ payload, manifestVersion: version })
        : validateSupplierCaptureRequest({ payload, manifestVersion: version });
      const expectedOzon = message.type === "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";
      if (body?.accepted !== true || !validation.ok || payload.captureId !== message.captureId ||
          isOzonCaptureJob(payload) !== expectedOzon) throw failure("capture_job_invalid");
      void executeCapture(payload);
      return { accepted: true, claimedCaptureId: message.captureId };
    } catch (error) {
      activeCapture = null;
      lastCaptureCode = ["extension_identity_rejected", "capture_job_not_claimed", "capture_job_invalid"].includes(error?.code)
        ? error.code : "capture_claim_unconfirmed";
      return { accepted: false, code: lastCaptureCode };
    }
  }

  function ensureHeartbeatAlarm() {
    if (alarmPending) return alarmPending;
    alarmPending = (async () => {
      try {
        const existing = await chromeApi.alarms.get(HEARTBEAT_ALARM);
        if (!existing) await chromeApi.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
      } finally { alarmPending = null; }
    })();
    return alarmPending;
  }

  function handleMessage(message, sender, sendResponse) {
    if (message?.type !== BACKGROUND_PING && !START_TYPES.has(message?.type)) return false;
    if (!isReviewSender(sender?.url)) {
      sendResponse({ accepted: false, code: "request_origin_invalid" });
      return false;
    }
    if (message.type === BACKGROUND_PING) {
      sendResponse(status()); // No network, no lease claim, no capture from a health inquiry.
      return false;
    }
    if (!validateCaptureStartSignal(message).ok) {
      sendResponse({ accepted: false, code: "start_signal_invalid" });
      return false;
    }
    if (activeCapture || cleanupBlocked) {
      sendResponse({ accepted: false, code: "capture_busy" });
      return false;
    }
    void claimCapture(message).then(sendResponse);
    return true;
  }

  function install() {
    const start = () => {
      void ensureHeartbeatAlarm().then(heartbeat, () => {
        lastHeartbeat = { ok: false, code: "alarm_unavailable", observedAt: clock() };
      });
    };
    chromeApi.runtime.onMessage.addListener(handleMessage);
    chromeApi.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEARTBEAT_ALARM) void heartbeat(); });
    chromeApi.runtime.onInstalled.addListener(start);
    chromeApi.runtime.onStartup.addListener(start);
    // A cold worker can be woken by a status PING. Module loading must never claim work.
    void ensureHeartbeatAlarm().catch(() => {
      lastHeartbeat = { ok: false, code: "alarm_unavailable", observedAt: clock() };
    });
  }
  return { status, heartbeat, handleMessage, ensureHeartbeatAlarm, install };
}

if (globalThis.chrome?.runtime?.id) {
  createCaptureRuntime({ chromeApi: globalThis.chrome, fetchImpl: globalThis.fetch.bind(globalThis) }).install();
}
