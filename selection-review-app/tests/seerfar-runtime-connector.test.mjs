import assert from "node:assert/strict";
import test from "node:test";

import {
  SEERFAR_KEYCHAIN_ACCOUNT,
  SEERFAR_KEYCHAIN_SERVICE,
  createSeerfarFetchTransport,
  inspectSeerfarKeychainEntry,
  inspectSeerfarRuntimeConfiguration,
  readSeerfarKeychainSecret
} from "../lib/seerfar-runtime-connector.mjs";

test("执行器读取固定钥匙串秘密，状态检查只验证条目存在且不读取秘密", async () => {
  let seen;
  const secret = await readSeerfarKeychainSecret({ execFileImpl: async (...args) => { seen = args; return { stdout: "test-secret\n" }; } });
  assert.equal(secret, "test-secret");
  assert.equal(seen[0], "/usr/bin/security");
  assert.deepEqual(seen[1], ["find-generic-password", "-w", "-s", SEERFAR_KEYCHAIN_SERVICE, "-a", SEERFAR_KEYCHAIN_ACCOUNT]);
  let inspectionArgs;
  const entryExists = await inspectSeerfarKeychainEntry({ execFileImpl: async (...args) => { inspectionArgs = args; return { stdout: "metadata only" }; } });
  assert.equal(entryExists, true);
  assert.equal(inspectionArgs[0], "/usr/bin/security");
  assert.deepEqual(inspectionArgs[1], ["find-generic-password", "-s", SEERFAR_KEYCHAIN_SERVICE, "-a", SEERFAR_KEYCHAIN_ACCOUNT]);
  assert.equal(inspectionArgs[1].includes("-w"), false);
  const status = await inspectSeerfarRuntimeConfiguration({ keychainEntryReader: async () => true });
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes("test-secret"), false);
  assert.equal(status.secretExposed, false);
});

test("钥匙串缺失只返回统一不可用语义，不暴露系统错误", async () => {
  await assert.rejects(
    () => readSeerfarKeychainSecret({ execFileImpl: async () => { throw new Error("sensitive stderr"); } }),
    (error) => error.code === "SEERFAR_KEYCHAIN_SECRET_UNAVAILABLE" && !error.message.includes("sensitive")
  );
  const status = await inspectSeerfarRuntimeConfiguration({ keychainEntryReader: async () => { throw new Error("sensitive"); } });
  assert.deepEqual([status.configured, status.credentialLocation], [false, "not_configured"]);
});

test("HTTP运行时只允许固定Seerfar白名单且不跟随重定向", async () => {
  const calls = [];
  const transport = createSeerfarFetchTransport({
    now: () => "2026-08-24T10:00:00.000Z",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { status: 200, headers: { get: () => "request-safe-1" }, text: async () => JSON.stringify({ code: 200, data: {} }) };
    }
  });
  const result = await transport({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: { Authorization: "Bearer test-only" }, body: null, redirect: "error", attempt: 1 });
  assert.equal(result.requestId, "request-safe-1");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(JSON.stringify(result).includes("test-only"), false);
  await assert.rejects(() => transport({ url: "https://evil.test/open-api/quota", method: "GET", redirect: "error", attempt: 1 }), /ENDPOINT_REJECTED/);
});

test("超时和非法JSON保留精确失败层且不返回请求秘密", async () => {
  const timeout = createSeerfarFetchTransport({ timeoutMs: 1, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("secret"), { name: "AbortError" })))) });
  await assert.rejects(() => timeout({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: { Authorization: "Bearer hidden" }, redirect: "error", attempt: 1 }), (error) => error.code === "network_timeout" && !error.message.includes("hidden"));
  const invalid = createSeerfarFetchTransport({ fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => "not-json" }) });
  await assert.rejects(() => invalid({ url: "https://api.seerfar.cn/open-api/quota", method: "GET", headers: {}, redirect: "error", attempt: 1 }), (error) => error.failureKind === "schema_error");
});
