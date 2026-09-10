import { isDeepStrictEqual } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { LINKFOX_DISCOVERY_CONTRACT_VERSION, LINKFOX_DISCOVERY_GATEWAY, LINKFOX_DISCOVERY_METHODS,
  LinkfoxDiscoveryError, buildLinkfoxDiscoveryRequest, normalizeLinkfoxDiscoveryResponse } from './linkfox-discovery-api.mjs';
import { LINKFOX_DETAIL_CONTRACT_VERSION, buildLinkfoxProductDetailRequest, normalizeLinkfoxProductDetailResponse } from './linkfox-product-detail-api.mjs';
const contracts = Object.freeze({
  [LINKFOX_DISCOVERY_CONTRACT_VERSION]: { methods: LINKFOX_DISCOVERY_METHODS, fields: ['requestId','method','keywords','pageSize'], build: buildLinkfoxDiscoveryRequest, normalize: normalizeLinkfoxDiscoveryResponse },
  [LINKFOX_DETAIL_CONTRACT_VERSION]: { methods: ['ozon_detail','supplier_detail'], fields: ['requestId','method','productId'], build: buildLinkfoxProductDetailRequest, normalize: normalizeLinkfoxProductDetailResponse }
});
const MAX_RESPONSE_BYTES = 1024 * 1024;
export function assertLinkfoxGatewayBinding(binding) {
  const keys = ['provider', 'bindingId', 'configurationVersion', 'gatewayOrigin', 'credentialAlias', 'contractVersion', 'allowedMethods', 'timeoutMs', 'budgetPolicyRef'];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== keys.length ||
      keys.some(key => !Object.hasOwn(binding, key)) || binding.provider !== 'linkfox' || binding.gatewayOrigin !== LINKFOX_DISCOVERY_GATEWAY ||
      !Object.hasOwn(contracts,binding.contractVersion) ||
      !['bindingId', 'configurationVersion', 'credentialAlias', 'budgetPolicyRef'].every(key => isCanonicalFrozenRef(binding[key])) ||
      !Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs < 1 || binding.timeoutMs > 150000 ||
      !Array.isArray(binding.allowedMethods) || !binding.allowedMethods.length || binding.allowedMethods.length > 2 ||
      new Set(binding.allowedMethods).size !== binding.allowedMethods.length || binding.allowedMethods.some(value => !contracts[binding.contractVersion].methods.includes(value))) {
    throw new LinkfoxDiscoveryError('BINDING_INVALID');
  }
  return structuredClone(binding);
}
async function readBoundedResponse(response, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new LinkfoxDiscoveryError('RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let bytes = 0, cancellation;
  const cancel = () => { cancellation = reader.cancel(signal.reason); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new LinkfoxDiscoveryError('RESPONSE_LIMIT'); }
      chunks.push(value.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try { if (cancellation) await cancellation; } finally { reader.releaseLock(); }
  }
  const body = Buffer.concat(chunks, bytes).toString('utf8');
  try { return JSON.parse(body); } catch (error) { if (error instanceof SyntaxError) throw new LinkfoxDiscoveryError('RESPONSE_INVALID'); throw error; }
}
/** One connector instance per persisted job. Neither construction nor configuration reads credentials or sends requests. */
export function createLinkfoxGatewayTransport({ binding, readSecret, fetchImpl = fetch, beforeRequestSend, signal,
  serverClock = () => new Date().toISOString() }) {
  const route = assertLinkfoxGatewayBinding(binding);
  if (typeof readSecret !== 'function' || typeof fetchImpl !== 'function' || typeof beforeRequestSend !== 'function' || typeof serverClock !== 'function') {
    throw new TypeError('LINKFOX_GATEWAY_DEPENDENCY_INVALID');
  }
  let attempted = false;
  return Object.freeze({ async request(input) {
    const contract=contracts[route.contractVersion];
    if(!input||typeof input!=='object')throw new LinkfoxDiscoveryError('INPUT_INVALID');
    const request=contract.build(Object.fromEntries(contract.fields.map(field=>[field,input[field]])));
    if(!isDeepStrictEqual(request,input))throw new LinkfoxDiscoveryError('INPUT_INVALID');
    if (!route.allowedMethods.includes(request.method)) throw new LinkfoxDiscoveryError('BINDING_INVALID');
    if (attempted) throw new LinkfoxDiscoveryError('ALREADY_ATTEMPTED');
    attempted = true;
    const controller = new AbortController();
    const assertActive = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    const cancel = () => controller.abort(signal.reason);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    let timer, abortListener;
    const deadline = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(() => controller.abort(new LinkfoxDiscoveryError('TIMEOUT')), route.timeoutMs);
      if (controller.signal.aborted) abortListener();
    });
    const execute = async () => {
      assertActive();
      const secret = await readSecret({ credentialAlias: route.credentialAlias, provider: route.provider, signal: controller.signal });
      assertActive();
      if (typeof secret !== 'string' || !secret.length || secret.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(secret)) throw new LinkfoxDiscoveryError('CREDENTIAL_MISSING');
      // Trusted runtime closure rechecks the persisted job, lease, plan, budget and route here.
      await beforeRequestSend({ requestId: request.requestId, method: request.method, bindingId: route.bindingId,
        configurationVersion: route.configurationVersion, budgetPolicyRef: route.budgetPolicyRef });
      assertActive();
      let response;
      try {
        response = await fetchImpl(`${route.gatewayOrigin}${request.endpoint}`, { method: 'POST', redirect: 'error',
          headers: { Authorization: secret, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal: controller.signal });
        if (controller.signal.aborted) {
          if (response.body) await response.body.cancel(controller.signal.reason);
          assertActive();
        }
        // Known HTTP failures need no raw error body to classify or persist.
        if (response.status !== 200) {
          if (response.body) await response.body.cancel();
          return contract.normalize({ request, httpStatus: response.status, response: null, observedAt: serverClock() });
        }
        const decoded = await readBoundedResponse(response, controller.signal); assertActive();
        return contract.normalize({ request, httpStatus: response.status, response: decoded, observedAt: serverClock() });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.cause?.code ?? error?.code)) {
          throw new LinkfoxDiscoveryError('NETWORK_FAILED');
        }
        throw error;
      }
    };
    try { return await Promise.race([execute(), deadline]); }
    finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener);
      signal?.removeEventListener('abort', cancel);
    }
  } });
}
