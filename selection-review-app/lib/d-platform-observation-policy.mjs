import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
const fields=['schemaVersion','policyRef','version','maxQueries','intervalMs','expiresAt','requestTimeoutMs'];
/** Capacity limits prevent unbounded work and timer overflow; they are not production query defaults. */
export function assertDPlatformObservationPolicy(policy) {
 if(!policy || typeof policy!=='object' || Array.isArray(policy) || Object.keys(policy).length!==fields.length ||
  !fields.every(key=>Object.hasOwn(policy,key)) || policy.schemaVersion!=='d-platform-observation-policy-v1' ||
  !isCanonicalFrozenRef(policy.policyRef) || !isCanonicalFrozenRef(policy.version) ||
  typeof policy.expiresAt!=='string' || !Number.isFinite(Date.parse(policy.expiresAt)) ||
  !Number.isSafeInteger(policy.maxQueries) || policy.maxQueries<1 || policy.maxQueries>100 ||
  !Number.isSafeInteger(policy.intervalMs) || policy.intervalMs<0 || policy.intervalMs>2147483647 ||
  !Number.isSafeInteger(policy.requestTimeoutMs) || policy.requestTimeoutMs<1 || policy.requestTimeoutMs>2147483647) {
  throw new Error('D_PLATFORM_OBSERVATION_POLICY_INVALID');
 }
 return policy;
}
