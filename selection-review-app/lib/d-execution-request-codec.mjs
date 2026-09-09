import { assertDExecutableRequest, assertHistoricalDExecutableRequest } from "./d-executable-request-contract.mjs";
import { assertNoProductionSecrets, assertNoRawPersistenceKeys } from "./production-contract-primitives.mjs";
import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
const OZON_PRODUCT_IMPORT_ENDPOINT = "/v3/product/import";
const OZON_INVENTORY_WRITE_ENDPOINT = "/v2/products/stocks";
const D_PROTOCOLS = Object.freeze({ productImport: ["ozon-product-import-v3", OZON_PRODUCT_IMPORT_ENDPOINT],
  inventoryWrite: ["ozon-stock-write-v2", OZON_INVENTORY_WRITE_ENDPOINT] });

export function encodeAttempt(attempt) {
  assertDExecutableRequest(attempt.request);
  assertNoProductionSecrets(attempt); assertNoRawPersistenceKeys(attempt);
  const encoded = structuredClone(attempt);
  for (const [field, [protocolId, endpoint]] of Object.entries(D_PROTOCOLS)) {
    const transport = encoded.request[field];
    if (transport.endpoint !== endpoint || Object.hasOwn(transport, "protocolId")) throw new Error("D_PERSISTENCE_PROTOCOL_REJECTED");
    delete transport.endpoint; transport.protocolId = protocolId;
  }
  assertSafeRuntimeRecord(encoded, "dExecution.attempt");
  return encoded;
}

export function decodeAttempt(attempt, { historicalRead = false } = {}) {
  assertSafeRuntimeRecord(attempt, "dExecution.attempt");
  const decoded = structuredClone(attempt);
  for (const [field, [protocolId, endpoint]] of Object.entries(D_PROTOCOLS)) {
    const transport = decoded.request[field];
    if (transport.protocolId !== protocolId || Object.hasOwn(transport, "endpoint")) throw new Error("D_PERSISTENCE_PROTOCOL_REJECTED");
    delete transport.protocolId; transport.endpoint = endpoint;
  }
  if (historicalRead) assertHistoricalDExecutableRequest(decoded.request);
  else assertDExecutableRequest(decoded.request);
  return decoded;
}

