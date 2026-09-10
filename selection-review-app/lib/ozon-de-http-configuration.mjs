import { STORE_PLATFORMS, isCompleteStoreRef } from "./store-binding.mjs";
import { assertNoProductionSecrets, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";

/** Safe transport facts only. An HTTP failure does not prove that a platform business write did not occur. */
export class OzonDEHttpTransportError extends Error {
  constructor(code, { layer = "configuration", externalRequestState = "not_sent", requestTransmission = "not_attempted", httpStatus = null } = {}) {
    super(code); this.name = "OzonDEHttpTransportError"; this.code = code; this.layer = layer;
    this.externalRequestState = externalRequestState; this.requestTransmission = requestTransmission;
    this.httpStatus = httpStatus; this.retryAllowed = false;
  }
}

const credentialFields = ["credentialAlias", "clientId", "keychainService", "keychainAccount"];
const productionFields = ["bindingId", "configurationVersion", "platform", "storeRef", "storeName", "warehouseName", "warehouseRef", "warehouseId", "credentialAlias", "verification"];
const discoveryFields = ['bindingId','configurationVersion','platform','targetStore','storeName','credentialAlias','workerId','workerVersion','leaseDurationMs'];
const ref = value => isCanonicalFrozenRef(value) && !["unknown", "null", "undefined", "not_applicable", "missing"].includes(value.toLowerCase());
export const isOzonDEHttpClosedObject = (value, fields) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), "value"));

function invalid() { return new OzonDEHttpTransportError("OZON_DE_HTTP_CONFIGURATION_INVALID"); }
function assertSafeConfiguration(value) {
  try { assertNoProductionSecrets(value, "ozonDEConfiguration"); }
  catch (error) {
    if (error?.constructor === Error && /^(?:PRODUCTION_AUTHORIZATION_SECRET_REJECTED|PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED):/.test(error.message)) throw invalid();
    throw error;
  }
}

export function assertOzonDECredentialBinding(binding) {
  if (!isOzonDEHttpClosedObject(binding, credentialFields) || !["credentialAlias", "keychainService", "keychainAccount"].every(field => ref(binding[field])) ||
      typeof binding.clientId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(binding.clientId)) throw invalid();
  assertSafeConfiguration(binding);
  return binding;
}

/** Validate routing identity only; configuration evidence is not a current platform health observation or write permission. */
export function assertOzonDEProductionBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 100) throw invalid();
  const ids = new Set();
  for (const binding of bindings) {
    if (!isOzonDEHttpClosedObject(binding, productionFields) || !["bindingId", "configurationVersion", "warehouseRef", "credentialAlias"].every(field => ref(binding[field])) ||
        ids.has(binding.bindingId) || !["ozon", "wb"].includes(binding.platform) || STORE_PLATFORMS[binding.storeRef?.stableStoreId] !== binding.platform ||
        !isCompleteStoreRef(binding.storeRef, binding.storeRef?.stableStoreId) ||
        typeof binding.warehouseId !== "string" || !/^[1-9][0-9]{0,29}$/.test(binding.warehouseId)) throw invalid();
    assertSafeConfiguration(binding); ids.add(binding.bindingId);
  }
  return bindings;
}

/** Non-secret declarations; importing or validating them never reads a credential or probes a service. */
export function assertOzonAccountDiscoveryBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 100) throw invalid();
  const ids = new Set(), workers = new Set();
  for (const binding of bindings) {
    if (!isOzonDEHttpClosedObject(binding, discoveryFields) || binding.platform !== 'ozon' ||
        STORE_PLATFORMS[binding.targetStore] !== 'ozon' ||
        !['bindingId','configurationVersion','credentialAlias','workerId','workerVersion'].every(field => ref(binding[field])) ||
        typeof binding.storeName !== 'string' || binding.storeName.trim() !== binding.storeName ||
        binding.storeName.length < 1 || binding.storeName.length > 100 || /[\u0000-\u001f\u007f]/u.test(binding.storeName) ||
        !Number.isInteger(binding.leaseDurationMs) || binding.leaseDurationMs < 1000 || binding.leaseDurationMs > 1800000 ||
        ids.has(binding.bindingId) || workers.has(binding.workerId)) throw invalid();
    assertSafeConfiguration(binding); ids.add(binding.bindingId); workers.add(binding.workerId);
  }
  return bindings;
}

export function normalizeOzonDECredentialBindings(bindings, productionBindings, discoveryBindings = []) {
  assertOzonDEProductionBindings(productionBindings);
  assertOzonAccountDiscoveryBindings(discoveryBindings);
  if (!Array.isArray(bindings) || bindings.length > 100) throw invalid();
  const aliases = new Set();
  return Object.freeze(bindings.map(binding => {
    assertOzonDECredentialBinding(binding);
    const matches = productionBindings.filter(production => production.credentialAlias === binding.credentialAlias);
    const stores = new Set(matches.map(production => JSON.stringify([production.platform, production.storeRef.stableStoreId,
      production.storeRef.platformStoreId, production.storeRef.mappingVersion])));
    const discovery = discoveryBindings.filter(route => route.credentialAlias === binding.credentialAlias);
    const targets = new Set([...matches.map(route => route.storeRef.stableStoreId), ...discovery.map(route => route.targetStore)]);
    if (aliases.has(binding.credentialAlias) || matches.length + discovery.length === 0 ||
        matches.some(production => production.platform !== "ozon") || stores.size > 1 || targets.size !== 1) throw invalid();
    aliases.add(binding.credentialAlias);
    return Object.freeze(structuredClone(binding));
  }));
}
