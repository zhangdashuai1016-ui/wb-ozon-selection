import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { createSeerfarOpenApiTransport, SEERFAR_OPEN_API_BASE } from "./seerfar-open-api-transport.mjs";

export const SEERFAR_KEYCHAIN_SERVICE = "egg-ozon-operations-center";
export const SEERFAR_KEYCHAIN_ACCOUNT = "seerfar-open-api";
export const SEERFAR_RUNTIME_CONNECTOR_VERSION = "seerfar-runtime-connector-v1";

const ALLOWED_PATHS = new Set([
  "/open-api/quota",
  "/open-api/product/detail/search/ozon",
  "/open-api/product/detail/search/wb",
  "/open-api/category/detail/search/ozon",
  "/open-api/category/detail/search/wb",
  "/open-api/keyword/backSearch/ozon",
  "/open-api/keyword/backSearch/wb"
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRequestId(value) {
  if (nonEmpty(value) && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)) return value;
  return `seerfar-http:${createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 20)}`;
}

function safeError(code) {
  return Object.assign(new Error(code), { code });
}

export async function readSeerfarKeychainSecret({ execFileImpl = promisify(execFileCallback) } = {}) {
  try {
    const result = await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-s",
      SEERFAR_KEYCHAIN_SERVICE,
      "-a",
      SEERFAR_KEYCHAIN_ACCOUNT
    ], { encoding: "utf8", maxBuffer: 64 * 1024 });
    const secret = String(result?.stdout ?? result ?? "").trim();
    if (!secret) throw safeError("SEERFAR_KEYCHAIN_SECRET_UNAVAILABLE");
    return secret;
  } catch {
    throw safeError("SEERFAR_KEYCHAIN_SECRET_UNAVAILABLE");
  }
}

export async function inspectSeerfarKeychainEntry({ execFileImpl = promisify(execFileCallback) } = {}) {
  try {
    await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-s",
      SEERFAR_KEYCHAIN_SERVICE,
      "-a",
      SEERFAR_KEYCHAIN_ACCOUNT
    ], { encoding: "utf8", maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function inspectSeerfarRuntimeConfiguration({ keychainEntryReader = inspectSeerfarKeychainEntry } = {}) {
  let configured = false;
  try {
    configured = await keychainEntryReader() === true;
  } catch {
    configured = false;
  }
  return Object.freeze({
    connectorVersion: SEERFAR_RUNTIME_CONNECTOR_VERSION,
    configured,
    credentialLocation: configured ? "macos_keychain" : "not_configured",
    service: SEERFAR_KEYCHAIN_SERVICE,
    account: SEERFAR_KEYCHAIN_ACCOUNT,
    secretExposed: false
  });
}

export function createSeerfarFetchTransport({ fetchImpl = globalThis.fetch, timeoutMs = 20_000, now = () => new Date().toISOString() } = {}) {
  if (typeof fetchImpl !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof now !== "function") {
    throw new Error("SEERFAR_HTTP_RUNTIME_DEPENDENCY_INVALID");
  }
  let calls = 0;
  return async function seerfarFetchTransport(request) {
    calls += 1;
    if (!request || request.attempt !== 1 || calls > 3) throw new Error("SEERFAR_HTTP_RUNTIME_ATTEMPT_INVALID");
    const url = new URL(request.url);
    const base = new URL(SEERFAR_OPEN_API_BASE);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.search || url.hash || !ALLOWED_PATHS.has(url.pathname)) {
      throw new Error("SEERFAR_HTTP_RUNTIME_ENDPOINT_REJECTED");
    }
    if (!['GET', 'POST'].includes(request.method) || request.redirect !== "error") {
      throw new Error("SEERFAR_HTTP_RUNTIME_REQUEST_REJECTED");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers: request.headers,
        body: request.method === "POST" ? JSON.stringify(request.body ?? {}) : undefined,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw safeError("network_timeout");
      throw safeError("network_error");
    } finally {
      clearTimeout(timer);
    }
    let json;
    try {
      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > 4 * 1024 * 1024) throw new Error("oversized");
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw new Error("oversized");
      json = JSON.parse(text);
    } catch {
      throw Object.assign(safeError("provider_or_schema_error"), { failureKind: "schema_error", httpStatus: response.status });
    }
    return {
      status: response.status,
      json,
      requestId: safeRequestId(response.headers?.get?.("x-request-id") || response.headers?.get?.("request-id")),
      completedAt: now()
    };
  };
}

export function createSeerfarRuntimeTransport({
  secretReader = readSeerfarKeychainSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  clock,
  sleep
} = {}) {
  return createSeerfarOpenApiTransport({
    secretProvider: async () => secretReader(),
    httpTransport: createSeerfarFetchTransport({ fetchImpl, timeoutMs, now: () => new Date(clock?.now?.() ?? Date.now()).toISOString() }),
    ...(clock ? { clock } : {}),
    ...(sleep ? { sleep } : {})
  });
}
