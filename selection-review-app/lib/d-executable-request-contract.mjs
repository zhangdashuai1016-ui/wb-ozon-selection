import { isDeepStrictEqual } from "node:util";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { PRODUCTION_AUTHORIZATION_VERSION } from "./production-authorization-preparation.mjs";
import { projectProductionReadbackExpectation } from "./e-stage-readback.mjs";
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = fingerprintCanonicalRecord;
const EXECUTABLE_REQUEST_FIELDS = Object.freeze([
  "candidateId", "sourceProductionPlanId", "sourceProductionPlanFingerprint", "sourceAuthorizationId", "sourceAuthorizationFingerprint", "sourceAuthorizationVersion",
  "platform", "store", "storeRef", "warehouseRef", "credentialAlias", "skuPackageId", "merchantSku", "supplierSkuId", "platformWritePrice", "stock",
  "assetsFinalUploadsVersion", "finalUploads", "publishScope", "exclusions", "allowedWriteFields", "productImport", "inventoryWrite",
  "independentReadback", "protocolEvidence", "executionKey", "idempotencyKey", "executionProtocolVersion"
]);

function assertDRequestVersion(request, historicalRead) {
  const fields = historicalRead && !Object.hasOwn(request || {}, "executionProtocolVersion") ? EXECUTABLE_REQUEST_FIELDS.filter(field => field !== "executionProtocolVersion") : EXECUTABLE_REQUEST_FIELDS;
  if (!isObject(request) || Object.keys(request).length !== fields.length ||
      fields.some(field => !Object.hasOwn(request, field)) ||
      (Object.hasOwn(request, "executionProtocolVersion") && request.executionProtocolVersion !== "ozon-single-sku-d-e-v3")) throw new Error("D_EXECUTABLE_REQUEST_INVALID: 未声明的执行输入");
  if (request.sourceAuthorizationVersion !== PRODUCTION_AUTHORIZATION_VERSION) throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
  const { executionKey, idempotencyKey, ...requestCore } = request;
  const expectedKey = `d-execution:${sha256({ sourceAuthorizationFingerprint: request.sourceAuthorizationFingerprint,
    sourceProductionPlanFingerprint: request.sourceProductionPlanFingerprint, requestCore })}`;
  if (executionKey !== expectedKey || idempotencyKey !== expectedKey) throw new Error("D_EXECUTABLE_REQUEST_INVALID: 执行输入已变化");
  const expected = structuredClone(projectProductionReadbackExpectation({
    finalUploads: request.finalUploads, warehouseId: request.inventoryWrite.warehouseId
  }));
  if (historicalRead && !Object.hasOwn(request, "executionProtocolVersion") && request.independentReadback?.expectation?.schemaVersion === "production-readback-expectation-v1") {
    expected.schemaVersion = "production-readback-expectation-v1";
    expected.stockBasis = "present_minus_reserved";
  }
  if (!isDeepStrictEqual(request.independentReadback?.expectation, expected)) {
    throw new Error("D_EXECUTABLE_REQUEST_INVALID: 精确回读期望不属于冻结执行请求");
  }
  return request;
}

export function assertDExecutableRequest(request) {
  return assertDRequestVersion(request, false);
}

/** Historical decoding preserves the original request identity; execution always uses the current gate above. */
export function assertHistoricalDExecutableRequest(request) {
  return assertDRequestVersion(request, true);
}

