import { isCompleteStoreRef, sameStoreRef } from "./store-binding.mjs";
import { isCanonicalFrozenRef } from "./production-contract-primitives.mjs";

const FIELDS = Object.freeze({
  commission: ["platform", "store", "storeRef", "category", "salesScheme"],
  schema: ["platform", "store", "storeRef", "category", "ruleVersion"],
  logistics_tariff: ["route", "ruleVersion"], exchange_rate: ["pair"],
  electrical_rule: ["platform", "route", "ruleVersion"]
});
const invalid = () => Object.assign(new Error("EVIDENCE_SCOPE_INVALID: 证据适用范围或店铺身份不完整"), { code: "EVIDENCE_SCOPE_INVALID" });

export function normalizeEvidenceScope(kind, scope) {
  const fields = FIELDS[kind];
  if (!fields || !scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).length !== fields.length || fields.some(field => !Object.hasOwn(scope, field))) throw invalid();
  const result = {};
  for (const key of Object.keys(scope).sort()) {
    const value = scope[key];
    if (key === "storeRef") {
      if (!isCompleteStoreRef(value, scope.store) || Object.values(value).some(item => !isCanonicalFrozenRef(item))) throw invalid();
      result.storeRef = { stableStoreId: value.stableStoreId, platformStoreId: value.platformStoreId, mappingVersion: value.mappingVersion };
    } else {
      if (typeof value !== "string" || !value.trim()) throw invalid();
      result[key] = value.trim().toLowerCase();
    }
  }
  return result;
}

export function evidenceScopeMatches(kind, actual, expected) {
  let left, right;
  try {
    left = normalizeEvidenceScope(kind, actual);
    right = normalizeEvidenceScope(kind, expected);
  } catch (error) {
    if (error.code !== "EVIDENCE_SCOPE_INVALID") throw error;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length && Object.entries(right).every(([key, value]) =>
    key === "storeRef" ? sameStoreRef(left.storeRef, value) : left[key] === value);
}

export function evidenceScopeKey(kind, scope) {
  return `${kind}|${JSON.stringify(normalizeEvidenceScope(kind, scope))}`;
}

export function buildExpectedEvidenceScope(kind, context) {
  let scope;
  if (kind === "commission" || kind === "schema") {
    scope = { platform: context.platform, store: context.store, storeRef: structuredClone(context.storeRef), category: context.category,
      ...(kind === "commission" ? { salesScheme: context.salesScheme } : { ruleVersion: context.schemaRuleVersion }) };
  } else if (kind === "logistics_tariff") scope = { route: context.route, ruleVersion: context.logisticsRuleVersion };
  else if (kind === "exchange_rate") scope = { pair: context.exchangePair };
  else throw invalid();
  return normalizeEvidenceScope(kind, scope);
}

export function normalizeRelatedSchemaScope(commissionScope, schemaScope) {
  const commission = normalizeEvidenceScope("commission", commissionScope);
  const schema = normalizeEvidenceScope("schema", schemaScope);
  if (["platform", "store", "category"].some(key => commission[key] !== schema[key]) || !sameStoreRef(commission.storeRef, schema.storeRef)) throw invalid();
  return schema;
}
