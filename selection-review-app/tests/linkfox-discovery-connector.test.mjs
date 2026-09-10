import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkfoxDiscoveryConnector } from '../lib/linkfox-discovery-connector.mjs';
import { LINKFOX_DISCOVERY_CONTRACT_VERSION, LINKFOX_DISCOVERY_GATEWAY, LinkfoxDiscoveryError } from '../lib/linkfox-discovery-api.mjs';
const binding = () => ({ provider: 'linkfox', bindingId: 'binding:synthetic', configurationVersion: 'version:1',
  gatewayOrigin: LINKFOX_DISCOVERY_GATEWAY, credentialAlias: 'linkfox-account-synthetic', contractVersion: LINKFOX_DISCOVERY_CONTRACT_VERSION,
  allowedMethods: ['ozon_market_search', 'supplier_search'], timeoutMs: 1000, budgetPolicyRef: 'budget:synthetic' });
const input = () => ({ requestId: 'request:synthetic', method: 'ozon_market_search', keywords: ['organizer'], pageSize: 20 });
const response = () => new Response(JSON.stringify({ code: '200', errcode: 200, products: [], total: 0 }));
const known = code => error => error instanceof LinkfoxDiscoveryError && error.code === code;
function fixture(overrides = {}) {
  const events = [];
  const connector = createLinkfoxDiscoveryConnector({ binding: binding(), readSecret: async () => { events.push('secret'); return 'synthetic-value'; },
    beforeRequestSend: async facts => { events.push(['hook', facts]); }, fetchImpl: async (url, options) => {
      events.push(['fetch', url, options]); return response();
    }, serverClock: () => '2026-09-08T12:00:00.000Z', ...overrides });
  return { connector, events };
}
test('construction is idle; single request reads credentials then rechecks authorization immediately before fetch', async () => {
  const { connector, events } = fixture(); assert.deepEqual(events, []);
  const result = await connector.search(input()); assert.equal(result.status, 'true_empty');
  assert.deepEqual(events.map(value => Array.isArray(value) ? value[0] : value), ['secret', 'hook', 'fetch']);
  assert.deepEqual(events[1][1], { requestId: 'request:synthetic', method: 'ozon_market_search', bindingId: 'binding:synthetic',
    configurationVersion: 'version:1', budgetPolicyRef: 'budget:synthetic' });
  assert.equal(events[2][1], `${LINKFOX_DISCOVERY_GATEWAY}/seerfar/ozon/productReportSearch`);
  assert.equal(events[2][2].headers.Authorization, 'synthetic-value'); assert.equal(events[2][2].redirect, 'error');
  await assert.rejects(connector.search(input()), known('ALREADY_ATTEMPTED')); assert.equal(events.length, 3);
});
test('credential absence and unknown authorization failures send zero requests and never retry', async () => {
  const missing = fixture({ readSecret: async () => null });
  await assert.rejects(missing.connector.search(input()), known('CREDENTIAL_MISSING')); assert.deepEqual(missing.events, []);
  const original = new Error('synthetic authorization invariant');
  const blocked = fixture({ beforeRequestSend: async () => { throw original; } });
  await assert.rejects(blocked.connector.search(input()), error => error === original);
  assert.deepEqual(blocked.events, ['secret']);
  await assert.rejects(blocked.connector.search(input()), known('ALREADY_ATTEMPTED'));
});
test('cancellation during credential read or send gate prevents fetch', async () => {
  for (const boundary of ['secret', 'hook']) {
    const controller = new AbortController(), original = new Error(`cancel:${boundary}`);
    const { connector, events } = fixture({ signal: controller.signal,
      readSecret: async () => { if (boundary === 'secret') controller.abort(original); return 'synthetic-value'; },
      beforeRequestSend: async () => { if (boundary === 'hook') controller.abort(original); } });
    await assert.rejects(connector.search(input()), error => error === original); assert.deepEqual(events, []);
  }
});
test('deadline covers delayed body and cancels its reader', async () => {
  let cancelled = false;
  const { connector } = fixture({ binding: { ...binding(), timeoutMs: 20 }, fetchImpl: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; }
  })) });
  await assert.rejects(connector.search(input()), known('TIMEOUT'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});
test('deadline while credentials are pending cannot later send', async () => {
  let finish;
  const { connector, events } = fixture({ binding: { ...binding(), timeoutMs: 20 }, readSecret: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects(connector.search(input()), known('TIMEOUT')); finish('synthetic-value');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, []);
});
test('HTTP failures and known network errors are typed; unknown exceptions retain identity', async () => {
  for (const [status, code] of [[401, 'AUTHENTICATION_REQUIRED'], [402, 'BILLING_FAILED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_FAILED']]) {
    const { connector } = fixture({ fetchImpl: async () => new Response('not retained', { status }) });
    await assert.rejects(connector.search(input()), known(code));
  }
  const network = fixture({ fetchImpl: async () => { throw Object.assign(new Error('synthetic'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(network.connector.search(input()), known('NETWORK_FAILED'));
  const original = new Error('synthetic programming fault');
  const unknown = fixture({ fetchImpl: async () => { throw original; } });
  await assert.rejects(unknown.connector.search(input()), error => error === original);
});
test('malformed and oversized response bodies are explicit failures', async () => {
  for (const [body, code] of [['{', 'RESPONSE_INVALID'], ['x'.repeat(1024 * 1024 + 1), 'RESPONSE_LIMIT']]) {
    const { connector } = fixture({ fetchImpl: async () => new Response(body) });
    await assert.rejects(connector.search(input()), known(code));
  }
});
test('route changes and unsupported methods are rejected before any credential access', async () => {
  assert.throws(() => fixture({ binding: { ...binding(), gatewayOrigin: 'https://example.com' } }), known('BINDING_INVALID'));
  const { connector, events } = fixture({ binding: { ...binding(), allowedMethods: ['supplier_search'] } });
  await assert.rejects(connector.search(input()), known('BINDING_INVALID')); assert.deepEqual(events, []);
});
