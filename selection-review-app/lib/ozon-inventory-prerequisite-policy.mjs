import { isCanonicalFrozenRef } from "./production-contract-primitives.mjs";

function closed(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function isExternalNumericId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function validPrerequisitePolicy(policy) {
  return closed(policy, ["schemaVersion", "policyId", "version", "officialEvidenceRef", "priceSent", "reserved", "stockRequest"]) &&
    policy.schemaVersion === "ozon-inventory-prerequisite-policy-v1" &&
    [policy.policyId, policy.version, policy.officialEvidenceRef].every(isCanonicalFrozenRef) &&
    closed(policy.priceSent, ["endpoint", "field", "acceptedValues"]) && policy.priceSent.endpoint === "/v3/product/info/list" &&
    policy.priceSent.field === "statuses.status" && Array.isArray(policy.priceSent.acceptedValues) &&
    policy.priceSent.acceptedValues.length > 0 && policy.priceSent.acceptedValues.length <= 16 &&
    policy.priceSent.acceptedValues.every(value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)) &&
    new Set(policy.priceSent.acceptedValues).size === policy.priceSent.acceptedValues.length &&
    closed(policy.reserved, ["endpoint", "sourceProtocol"]) && policy.reserved.endpoint === "/v2/product/info/stocks-by-warehouse/fbs" &&
    policy.reserved.sourceProtocol === "ozon-product-stocks-by-warehouse-fbs-v2" &&
    closed(policy.stockRequest, ["identityField", "quantSize"]) && ["offer_id", "product_id"].includes(policy.stockRequest.identityField) &&
    (policy.stockRequest.quantSize === null || isExternalNumericId(policy.stockRequest.quantSize));
}

export function assertOzonInventoryPrerequisitePolicy(policy) {
  if (!validPrerequisitePolicy(policy)) throw new Error("OZON_DE_INVENTORY_POLICY_INVALID");
  return freeze(structuredClone(policy));
}
