import { validateProductionAuthorizationRecord } from "./product-lifecycle-schema.mjs";
import { assertC2FinalMediaContent } from "./c2-media-content-rules.mjs";
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function readAuthorizedProductionSnapshot({ productionAuthorization, candidateId, candidateRevision, skuPackage, checkedAt = new Date().toISOString() } = {}) {
  if (!productionAuthorization || !candidateId || !Number.isInteger(candidateRevision) || !skuPackage) {
    throw new Error("PRODUCTION_AUTHORIZATION_CONTEXT_REQUIRED");
  }
  const validation = validateProductionAuthorizationRecord(productionAuthorization, {
    candidateId,
    candidateRevision,
    skuPackage,
    lifecycleState: "persisted"
  });
  if (!validation.valid) throw new Error(`ProductionAuthorization校验失败：${validation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  assertC2FinalMediaContent({ mediaRequirements: skuPackage.c2FinalAssets.productionAuthorizationPreparation.mediaRequirements,
    assets: productionAuthorization.lockedScope.finalUploads, checkedAt });
  return deepFreeze(structuredClone(productionAuthorization));
}
