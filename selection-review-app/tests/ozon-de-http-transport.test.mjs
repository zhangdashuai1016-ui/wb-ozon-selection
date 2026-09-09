import test from "node:test";
import assert from "node:assert/strict";
import { createOzonDEHttpTransport, normalizeOzonDECredentialBindings, readOzonDEKeychainSecret,
  OzonDEHttpTransportError } from "../lib/ozon-de-http-transport.mjs";

const clone = value => structuredClone(value);
const storeRef = { stableStoreId: "dandanshu", platformStoreId: "synthetic-platform-store:777", mappingVersion: "mapping:1" };
const production = { bindingId: "binding:ozon:1", configurationVersion: "production:1", platform: "ozon", storeRef,
  storeName: "合成店铺", warehouseName: "合成仓库", warehouseRef: "warehouse:1", warehouseId: "10001", credentialAlias: "credential-alias:ozon:1",
  verification: { evidenceRef: "evidence:configuration:1", checkedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } };
const credential = { credentialAlias: production.credentialAlias, clientId: "123456", keychainService: "test.ozon.service", keychainAccount: "test.ozon.account" };
const request = (patch = {}) => ({ platform: "ozon", store: "dandanshu", storeRef: clone(storeRef), warehouseRef: production.warehouseRef,
  credentialAlias: production.credentialAlias, method: "POST", endpoint: "/v3/product/info/list", body: { offer_id: ["SYNTHETIC-SKU"] },
  write: false, executionKey: null, ...patch });
function harness(overrides = {}) {
  const keys = [], calls = [];
  const transport = createOzonDEHttpTransport({ productionBindings: [clone(production)], credentialBindings: [clone(credential)],
    readSecret: async (...args) => { keys.push(args); return "synthetic-api-key"; },
    fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ result: { accepted: true } }), { status: 200 }); }, ...overrides });
  return { transport, keys, calls };
}
function failure(code, state, transmission, status = null) {
  return error => {
    assert.ok(error instanceof OzonDEHttpTransportError); assert.equal(error.code, code);
    assert.equal(error.externalRequestState, state); assert.equal(error.requestTransmission, transmission); assert.equal(error.httpStatus, status);
    assert.equal(error.retryAllowed, false); assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(JSON.stringify(error).includes("synthetic-api-key"), false); return true;
  };
}

test("constructing the configured transport performs no credential or network I/O, and current declarations are detached", async () => {
  const productionBindings = [clone(production)], credentialBindings = [clone(credential)];
  const f = harness({ productionBindings, credentialBindings }); assert.equal(f.keys.length, 0); assert.equal(f.calls.length, 0);
  productionBindings[0].credentialAlias = "credential-alias:edited"; credentialBindings[0].clientId = "999999";
  assert.deepEqual(await f.transport.requestJson(request()), { result: { accepted: true } });
  assert.equal(f.keys.length, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.keys[0][0], credential); assert.ok(Object.isFrozen(f.keys[0][0]));
  assert.equal(f.keys[0][1].runtimeMode, "local_development"); assert.ok(f.keys[0][1].signal instanceof AbortSignal);
  const [url, options] = f.calls[0]; assert.equal(url, "https://api-seller.ozon.ru/v3/product/info/list");
  assert.equal(options.method, "POST"); assert.equal(options.redirect, "manual");
  assert.equal(options.headers["Client-Id"], "123456"); assert.notEqual(options.headers["Client-Id"], storeRef.platformStoreId);
  assert.equal(options.headers["Api-Key"], "synthetic-api-key"); assert.equal(options.body, JSON.stringify(request().body));
  assert.ok(options.signal instanceof AbortSignal);
});

test("only the existing eight D/E endpoints plus the three explicit preflight reads are sent once", async () => {
  const f = harness();
  const endpoints = [["/v3/product/import", true], ["/v2/products/stocks", true], ["/v1/product/import/info", false],
    ["/v4/product/info/attributes", false], ["/v3/product/info/list", false], ["/v5/product/info/prices", false],
    ["/v4/product/info/stocks", false], ["/v3/product/list", false], ["/v1/roles", false], ["/v2/warehouse/list", false], ["/v1/seller/info", false]];
  for (const [endpoint, write] of endpoints) {
    await f.transport.requestJson(request({ endpoint, write, executionKey: write ? "execution:synthetic:1" : null, body: ["/v1/roles", "/v1/seller/info"].includes(endpoint) ? null : {} }));
  }
  assert.equal(f.calls.length, 11); assert.equal(f.keys.length, 11);
  assert.deepEqual(f.calls.map(([url]) => new URL(url).pathname), endpoints.map(([endpoint]) => endpoint));
});

test("wrong store, mapping, warehouse, alias, endpoint and write intent fail before all credential/network access", async () => {
  const f = harness();
  for (const patch of [{ platform: "wb" }, { store: "miska" }, { storeRef: { ...storeRef, mappingVersion: "mapping:other" } },
    { warehouseRef: "warehouse:other" }, { credentialAlias: "credential-alias:other" }, { extra: true }, { method: "GET" },
    { endpoint: "https://untrusted.example/v1/roles" }, { endpoint: "/v1/roles?redirect=other" }, { endpoint: "/v1/../roles" },
    { endpoint: "/v1/product/archive" }, { endpoint: "/v1/warehouse/list" }, { endpoint: "/v1/roles", write: true }, { endpoint: "/v3/product/import", write: false },
    { endpoint: "/v3/product/import", write: true, executionKey: null }, { body: { "Api-Key": "forged-key" } }]) {
    await assert.rejects(() => f.transport.requestJson(request(patch)), error => {
      assert.ok(error instanceof OzonDEHttpTransportError); assert.equal(error.externalRequestState, "not_sent");
      assert.equal(error.requestTransmission, "not_attempted"); return true;
    });
  }
  assert.equal(f.keys.length, 0); assert.equal(f.calls.length, 0);
});

test("credential configuration is closed, unique, explicitly client-bound and rejects shared aliases across stores", () => {
  assert.deepEqual(normalizeOzonDECredentialBindings([credential], [production]), [credential]);
  for (const credentials of [[{ ...credential, clientId: 123456 }], [{ ...credential, clientId: "123\r\nInjected: true" }],
    [{ ...credential, apiKey: "raw-key" }], [{ ...credential, keychainAccount: "" }], [credential, credential],
    [{ ...credential, credentialAlias: "credential-alias:unbound" }]]) {
    assert.throws(() => normalizeOzonDECredentialBindings(credentials, [production]), OzonDEHttpTransportError);
  }
  const other = { ...clone(production), bindingId: "binding:ozon:2", storeRef: { ...storeRef, stableStoreId: "miska", platformStoreId: "platform:other" } };
  assert.throws(() => normalizeOzonDECredentialBindings([credential], [production, other]), OzonDEHttpTransportError);
  for (const baseUrl of ["http://api-seller.ozon.ru", "https://untrusted.example", "https://api-seller.ozon.ru/path", "https://user@api-seller.ozon.ru", "https://api-seller.ozon.ru?secret=value"]) {
    assert.throws(() => harness({ baseUrl }), OzonDEHttpTransportError);
  }
  assert.throws(() => createOzonDEHttpTransport({ productionBindings: [production], credentialBindings: [credential], runtimeMode: "central_production" }), OzonDEHttpTransportError);
  assert.doesNotThrow(() => harness({ runtimeMode: "central_test" }));
});

test("normal three-store configuration may contain a WB production binding while credentials are restricted to exact Ozon aliases", async () => {
  const wb = { ...clone(production), bindingId: "binding:wb:1", platform: "wb", credentialAlias: "credential-alias:wb:1",
    storeRef: { stableStoreId: "wb", platformStoreId: "synthetic-wb-store:1", mappingVersion: "mapping:1" } };
  const otherOzon = { ...clone(production), bindingId: "binding:ozon:2", credentialAlias: "credential-alias:ozon:2",
    storeRef: { stableStoreId: "miska", platformStoreId: "synthetic-miska-store:1", mappingVersion: "mapping:1" } };
  const productionBindings = [production, otherOzon, wb];
  assert.deepEqual(normalizeOzonDECredentialBindings([credential], productionBindings), [credential]);
  const f = harness({ productionBindings }); await f.transport.requestJson(request()); assert.equal(f.calls.length, 1);
  assert.throws(() => normalizeOzonDECredentialBindings([{ ...credential, credentialAlias: wb.credentialAlias }], productionBindings), OzonDEHttpTransportError);
});

test("non-JSON request structures and invalid options are rejected without invoking accessors or reading credentials", async () => {
  const cycle = {}; cycle.self = cycle;
  let getterCalls = 0; const accessor = Object.defineProperty({}, "hidden", { enumerable: true, get() { getterCalls += 1; return "value"; } });
  const f = harness();
  for (const body of [cycle, accessor, { list: new Array(10_001) }, { list: [undefined] }, { value: Infinity },
    { value: () => "hidden" }, { value: "x".repeat(2 * 1024 * 1024 + 1) }]) {
    await assert.rejects(() => f.transport.requestJson(request({ body })), OzonDEHttpTransportError);
  }
  await assert.rejects(() => f.transport.requestJson(request(), { signal: "not-a-signal" }), OzonDEHttpTransportError);
  await assert.rejects(() => f.transport.requestJson(request(), { retry: true }), OzonDEHttpTransportError);
  assert.equal(getterCalls, 0); assert.equal(f.keys.length, 0); assert.equal(f.calls.length, 0);
});

test("the default local secret reader uses only exact execFile arguments and returns a string without exposing failures", async () => {
  const controller = new AbortController(), calls = [];
  const value = await readOzonDEKeychainSecret(credential, { runtimeMode: "local_development", signal: controller.signal,
    execFileImpl: async (...args) => { calls.push(args); return { stdout: "synthetic-api-key\n", stderr: "" }; } });
  assert.equal(value, "synthetic-api-key"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/security", ["find-generic-password", "-w", "-s", credential.keychainService, "-a", credential.keychainAccount]]);
  assert.equal(calls[0][2].signal, controller.signal); assert.ok(calls[0][2].maxBuffer <= 16 * 1024);
  const privateError = Object.assign(new Error("RAW_PRIVATE_STDERR"), { code: 44, stderr: "RAW_PRIVATE_STDERR", stdout: "synthetic-api-key" });
  await assert.rejects(() => readOzonDEKeychainSecret(credential, { execFileImpl: async () => { throw privateError; } }), error => {
    assert.ok(error instanceof OzonDEHttpTransportError); assert.equal(error.externalRequestState, "not_sent");
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("RAW_PRIVATE_STDERR"), false); return true;
  });
  for (const stdout of ["", "  ", {}, "{\"Api-Key\":\"value\"}", "key\nInjected: value"]) {
    await assert.rejects(() => readOzonDEKeychainSecret(credential, { execFileImpl: async () => ({ stdout, stderr: "" }) }),
      failure("OZON_DE_CREDENTIAL_VALUE_INVALID", "not_sent", "not_attempted"));
  }
  let forbiddenCalls = 0;
  await assert.rejects(() => readOzonDEKeychainSecret(credential, { runtimeMode: "central_test",
    execFileImpl: async () => { forbiddenCalls += 1; } }), OzonDEHttpTransportError); assert.equal(forbiddenCalls, 0);
});

test("invalid secret values stop before fetch and unknown reader programming errors retain their identity", async () => {
  for (const value of [null, {}, "", "key\r\nInjected: value"]) {
    const f = harness({ readSecret: async () => value });
    await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_CREDENTIAL_VALUE_INVALID", "not_sent", "not_attempted"));
    assert.equal(f.calls.length, 0);
  }
  const bug = new TypeError("synthetic reader bug"), f = harness({ readSecret: async () => { throw bug; } });
  await assert.rejects(() => f.transport.requestJson(request()), error => error === bug); assert.equal(f.calls.length, 0);
  const disguised = Object.assign(new TypeError("synthetic reader bug"), { code: "ECONNRESET" });
  await assert.rejects(() => harness({ readSecret: async () => { throw disguised; } }).transport.requestJson(request()), error => error === disguised);
});

test("pre-cancellation and cancellation during the secret read cause no fetch or retry", async () => {
  const controller = new AbortController(), f = harness(); controller.abort(new Error("private cancellation detail"));
  await assert.rejects(() => f.transport.requestJson(request(), { signal: controller.signal }),
    failure("OZON_DE_HTTP_CANCELLED", "not_sent", "not_attempted")); assert.equal(f.keys.length, 0); assert.equal(f.calls.length, 0);
  const during = new AbortController(); let announce, observedSignal;
  const entered = new Promise(resolve => { announce = resolve; });
  const g = harness({ readSecret: async (_binding, { signal }) => { observedSignal = signal; announce(); return new Promise(() => {}); } });
  const pending = g.transport.requestJson(request(), { signal: during.signal }); await entered; during.abort();
  await assert.rejects(() => pending, failure("OZON_DE_HTTP_CANCELLED", "not_sent", "not_attempted"));
  assert.equal(observedSignal.aborted, true); assert.equal(g.calls.length, 0);
});

test("fetch timeout and cancellation report only an attempted transmission, never confirmed supplier arrival", async () => {
  let calls = 0, observedSignal;
  const f = harness({ timeoutMs: 20, fetchImpl: async (_url, options) => { calls += 1; observedSignal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_HTTP_TIMEOUT", "unknown_outcome", "attempted"));
  assert.equal(calls, 1); assert.equal(observedSignal.aborted, true);
  const controller = new AbortController(); let entered;
  const start = new Promise(resolve => { entered = resolve; });
  const g = harness({ fetchImpl: async () => { calls += 1; entered(); return new Promise(() => {}); } });
  const pending = g.transport.requestJson(request(), { signal: controller.signal }); await start; controller.abort();
  await assert.rejects(() => pending, failure("OZON_DE_HTTP_CANCELLED", "unknown_outcome", "attempted")); assert.equal(calls, 2);
});

test("the total deadline also bounds a stalled secret reader and accurately records that no request was attempted", async () => {
  let signal;
  const f = harness({ timeoutMs: 20, readSecret: async (_binding, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_HTTP_TIMEOUT", "not_sent", "not_attempted"));
  assert.equal(signal.aborted, true); assert.equal(f.calls.length, 0);
});

test("the same deadline includes response body consumption after successful HTTP headers", async () => {
  let calls = 0, signal;
  const f = harness({ timeoutMs: 20, fetchImpl: async (_url, options) => {
    calls += 1; signal = options.signal; return new Response(new ReadableStream({ start() {} }), { status: 200 });
  } });
  await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_HTTP_TIMEOUT", "unknown_outcome", "response_received", 200));
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test("already-ready work cannot bypass the total deadline by starving the timer callback", async () => {
  let calls = 0;
  const f = harness({ timeoutMs: 5, fetchImpl: async () => {
    calls += 1; const end = performance.now() + 15;
    while (performance.now() < end) { /* Simulate synchronous provider work before its response resolves. */ }
    return new Response("{}");
  } });
  await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_HTTP_TIMEOUT", "unknown_outcome", "response_received", 200));
  assert.equal(calls, 1);
});

test("HTTP failure and redirect preserve received response facts without exposing body or following another request", async () => {
  for (const status of [301, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const f = harness({ fetchImpl: async () => { calls += 1; return new Response("RAW_PRIVATE_RESPONSE synthetic-api-key", {
      status, headers: { Location: "https://untrusted.example/private" } }); } });
    await assert.rejects(() => f.transport.requestJson(request()), error => {
      failure(status < 400 ? "OZON_DE_HTTP_REDIRECT_REJECTED" : "OZON_DE_HTTP_STATUS_FAILED", "failed", "response_received", status)(error);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("RAW_PRIVATE_RESPONSE"), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test("known network failures are sanitized unknown outcomes while unexpected fetch programming errors are not hidden", async () => {
  let calls = 0;
  const network = new TypeError("fetch failed", { cause: Object.assign(new Error("RAW_PRIVATE_SOCKET"), { code: "ECONNRESET" }) });
  const f = harness({ fetchImpl: async () => { calls += 1; throw network; } });
  await assert.rejects(() => f.transport.requestJson(request()), error => {
    failure("OZON_DE_HTTP_CONNECTION_FAILED", "unknown_outcome", "attempted")(error);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("RAW_PRIVATE_SOCKET"), false); return true;
  });
  assert.equal(calls, 1);
  const bug = new TypeError("synthetic fetch implementation bug"), g = harness({ fetchImpl: async () => { throw bug; } });
  await assert.rejects(() => g.transport.requestJson(request()), error => error === bug);
});

test("oversized, malformed, empty and non-object response bodies are rejected with received-response evidence", async () => {
  for (const [response, code] of [
    [new Response("{}", { headers: { "Content-Length": "9999" } }), "OZON_DE_HTTP_RESPONSE_TOO_LARGE"],
    [new Response("x".repeat(65)), "OZON_DE_HTTP_RESPONSE_TOO_LARGE"],
    [new Response("RAW_PRIVATE_INVALID_JSON"), "OZON_DE_HTTP_RESPONSE_JSON_INVALID"],
    [new Response(""), "OZON_DE_HTTP_RESPONSE_JSON_INVALID"],
    [new Response("null"), "OZON_DE_HTTP_RESPONSE_STRUCTURE_INVALID"],
    [new Response("[]"), "OZON_DE_HTTP_RESPONSE_STRUCTURE_INVALID"]
  ]) {
    let calls = 0;
    const f = harness({ maxResponseBytes: 64, fetchImpl: async () => { calls += 1; return response; } });
    await assert.rejects(() => f.transport.requestJson(request()), error => {
      failure(code, "unknown_outcome", "response_received", 200)(error);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("RAW_PRIVATE_INVALID_JSON"), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test("a partial response stream failure and invalid UTF-8 are explicit received-response failures with no retry", async () => {
  let calls = 0;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"value":'));
    controller.error(Object.assign(new Error("RAW_PRIVATE_STREAM"), { code: "ECONNRESET" }));
  } }));
  const f = harness({ fetchImpl: async () => { calls += 1; return response; } });
  await assert.rejects(() => f.transport.requestJson(request()), failure("OZON_DE_HTTP_CONNECTION_FAILED", "unknown_outcome", "response_received", 200));
  assert.equal(calls, 1);
  const g = harness({ fetchImpl: async () => new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])) });
  await assert.rejects(() => g.transport.requestJson(request()), failure("OZON_DE_HTTP_RESPONSE_ENCODING_INVALID", "unknown_outcome", "response_received", 200));
});

test('documented bodyless account methods omit HTTP body and reject invented bodies',async()=>{
 for(const endpoint of ['/v1/roles','/v1/seller/info']){
  const f=harness();await f.transport.requestJson(request({endpoint,body:null}));assert.equal(Object.hasOwn(f.calls[0][1],'body'),false);
  await assert.rejects(()=>f.transport.requestJson(request({endpoint,body:{}})),OzonDEHttpTransportError);assert.equal(f.calls.length,1);
 }
 const f=harness();await assert.rejects(()=>f.transport.requestJson(request({endpoint:'/v2/warehouse/list',body:null})),OzonDEHttpTransportError);assert.equal(f.keys.length,0);
});
test('bounded send hook runs after credentials before fetch without receiving secrets; historical routes reject it',async()=>{
 const order=[];const f=harness({readSecret:async()=>{order.push('credential');return 'synthetic-api-key';},fetchImpl:async()=>{order.push('fetch');return new Response('{}');}});
 await f.transport.requestJson(request({endpoint:'/v1/roles',body:null}),{beforeRequestSend:async(...args)=>{assert.deepEqual(args,[]);order.push('persist');}});
 assert.deepEqual(order,['credential','persist','fetch']);
 await assert.rejects(()=>f.transport.requestJson(request({endpoint:'/v4/product/info/stocks'}),{beforeRequestSend:async()=>{throw new Error('must not run');}}),OzonDEHttpTransportError);assert.equal(order.length,3);
});
test('rejected account send hook keeps zero fetches and preserves the programming or persistence error',async()=>{
 for(const error of [new TypeError('hook defect'),Object.assign(new Error('repository unavailable'),{code:'ECONNRESET'})]){
  const f=harness();await assert.rejects(()=>f.transport.requestJson(request({endpoint:'/v1/roles',body:null}),{beforeRequestSend:async()=>{throw error;}}),e=>e===error);assert.equal(f.keys.length,1);assert.equal(f.calls.length,0);
 }
});
test('cancellation and deadline during account hook prevent late fetch after hook settles',async()=>{
 const controller=new AbortController(),f=harness();
 await assert.rejects(()=>f.transport.requestJson(request({endpoint:'/v1/roles',body:null}),{signal:controller.signal,beforeRequestSend:async()=>{controller.abort();}}),failure('OZON_DE_HTTP_CANCELLED','not_sent','not_attempted'));assert.equal(f.calls.length,0);
 let finish;const g=harness({timeoutMs:5});
 await assert.rejects(()=>g.transport.requestJson(request({endpoint:'/v1/seller/info',body:null}),{beforeRequestSend:()=>new Promise(resolve=>{finish=resolve;})}),failure('OZON_DE_HTTP_TIMEOUT','not_sent','not_attempted'));
 finish();await Promise.resolve();assert.equal(g.calls.length,0);
});

test('exact warehouse endpoint remains read-only while supporting its independently authorized send hook',async()=>{
 const f=harness(),body={offer_id:['SYNTHETIC-SKU'],limit:10,cursor:''};
 await f.transport.requestJson(request({endpoint:'/v2/product/info/stocks-by-warehouse/fbs',body}));
 assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0][0]).pathname,'/v2/product/info/stocks-by-warehouse/fbs');assert.equal(f.calls[0][1].body,JSON.stringify(body));
 await assert.rejects(()=>f.transport.requestJson(request({endpoint:'/v2/product/info/stocks-by-warehouse/fbs',body,write:true,executionKey:'execution:synthetic:1'})),OzonDEHttpTransportError);
 let guards=0;await f.transport.requestJson(request({endpoint:'/v2/product/info/stocks-by-warehouse/fbs',body}),{beforeRequestSend:async()=>{guards+=1;}});
 assert.equal(guards,1);assert.equal(f.calls.length,2);assert.equal(f.keys.length,2);
});

test('each asynchronous D phase supports its own bounded send guard and cancellation before sending', async () => {
  for (const [endpoint, write] of [['/v3/product/import', true], ['/v1/product/import/info', false], ['/v2/products/stocks', true], ['/v3/product/info/list', false]]) {
    const f = harness(), controller = new AbortController();
    await assert.rejects(() => f.transport.requestJson(request({ endpoint, write, executionKey: 'execution:synthetic:async' }),
      { signal: controller.signal, beforeRequestSend: async () => { controller.abort(); } }), failure('OZON_DE_HTTP_CANCELLED', 'not_sent', 'not_attempted'));
    assert.equal(f.keys.length, 1); assert.equal(f.calls.length, 0);
  }
});

const discoveryBinding = { bindingId: 'account-route:miska', configurationVersion: 'account-route-v1', platform: 'ozon',
  targetStore: 'miska', storeName: 'Miska', credentialAlias: credential.credentialAlias,
  workerId: 'worker:account:1', workerVersion: 'worker-account-v1', leaseDurationMs: 30000 };

test('account discovery routes without a manufactured store or warehouse and sends only the three fixed reads', async () => {
  const { fingerprintCanonicalRecord } = await import('../lib/production-contract-primitives.mjs');
  const base = { schemaVersion: 'ozon-account-discovery-request-v1', subject: { kind: 'account_preparation', preparationId: 'preparation:miska:1', revision: 1 },
    accountRoute: { bindingId: discoveryBinding.bindingId, configurationVersion: discoveryBinding.configurationVersion,
      targetStore: 'miska', credentialAlias: credential.credentialAlias, clientIdRef: `ozon-client-configuration:${fingerprintCanonicalRecord(credential)}` },
    platform: 'ozon', method: 'POST', endpoint: '/v1/roles', body: null, write: false, executionKey: 'account-discovery:1' };
  const f = harness({ productionBindings: [], discoveryBindings: [discoveryBinding] });
  for (const endpoint of ['/v1/roles', '/v1/seller/info', '/v2/warehouse/list']) {
    await f.transport.requestJson({ ...base, endpoint, body: endpoint === '/v2/warehouse/list' ? { limit: 20 } : null }, { beforeRequestSend: async () => {} });
  }
  assert.equal(f.calls.length, 3); assert.equal(f.keys.length, 3);
  assert.equal(Object.hasOwn(f.calls[0][1], 'body'), false);
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { limit: 20 });
  for (const patch of [{ storeRef }, { warehouseRef: 'warehouse:invented' }, { write: true }, { endpoint: '/v3/product/info/list', body: {} },
    { endpoint: '/v2/warehouse/list', body: { limit: 20, warehouse_ids: ['10001'] } },
    { endpoint: '/v2/warehouse/list', body: { limit: 20, cursor: '' } }, { endpoint: '/v2/warehouse/list', body: { limit: 1 } },
    { accountRoute: { ...base.accountRoute, clientIdRef: 'client:changed' } }, { accountRoute: { ...base.accountRoute, targetStore: 'other' } },
    { subject: { ...base.subject, revision: 1.5 } }]) {
    await assert.rejects(() => f.transport.requestJson({ ...base, ...patch }), OzonDEHttpTransportError);
  }
  assert.equal(f.calls.length, 3); assert.equal(f.keys.length, 3);
});


test('the discovery discriminator cannot invoke an accessor before rejecting malformed requests', async () => {
  const f = harness(); let reads = 0;
  const malformed = request();
  Object.defineProperty(malformed, 'schemaVersion', { enumerable: true, get() { reads += 1; return 'ozon-account-discovery-request-v1'; } });
  await assert.rejects(() => f.transport.requestJson(malformed), OzonDEHttpTransportError);
  assert.equal(reads, 0); assert.equal(f.keys.length, 0); assert.equal(f.calls.length, 0);
});
