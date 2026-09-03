import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import {
  assertValidLifecyclePackage,
  validateLifecycleTransition,
  validateProductionAuthorizationRecord
} from "./product-lifecycle-schema.mjs";
import {
  assertNoProductionSecrets,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import { validateProductionAuthorizationPreparation } from "./production-authorization-preparation.mjs";

export {
  PRODUCTION_AUTHORIZATION_FINAL_CARD_INPUT_SNAPSHOT_VERSION,
  PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION,
  PRODUCTION_AUTHORIZATION_PENDING_INPUTS_VERSION,
  PRODUCTION_AUTHORIZATION_PREPARATION_VERSION,
  createPendingProductionAuthorizationInputs,
  fingerprintC1Snapshot,
  fingerprintFinalCardInputSnapshot,
  fingerprintFinalManifest,
  fingerprintFinalUploads,
  fingerprintMediaRequirements,
  fingerprintProductionAuthorizationPreparation,
  validateProductionAuthorizationPreparation
} from "./production-authorization-preparation.mjs";

export const PRODUCTION_AUTHORIZATION_VERSION = "production-authorization-v1.1";
export const C2_D_HANDOFF_VERSION = "c2-d-handoff-v1";
export const DRAFT_ONLY_PUBLISH_SCOPE = "create_draft_only";
export const VALIDATION_MODERATION_PUBLISH_SCOPE = "create_and_allow_validation_moderation";
export const PRODUCTION_PUBLISH_SCOPES = Object.freeze([DRAFT_ONLY_PUBLISH_SCOPE, VALIDATION_MODERATION_PUBLISH_SCOPE]);
export const PRODUCTION_WRITE_FIELDS = Object.freeze([
  "create_product", "title", "description", "attributes", "price", "stock", "assets.finalUploads", "publish_scope"
]);

const NOT_APPLICABLE = "not_applicable";
const OWNER_DECISION_OPTION = "approve_for_production_authorization";
const OWNER_DECISION_KEYS = Object.freeze([
  "decisionId", "selectedOption", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint",
  "sourceConfirmationCardId", "merchantSku", "warehouseRef", "credentialAlias", "stock",
  "buyerTargetPrice", "platformWritePrice", "priceConversion", "publishScope", "allowedWriteFields", "exclusions",
  "ownerDecisionFingerprint", "ownerConfirmation"
]);
const OWNER_CONFIRMATION_KEYS = Object.freeze([
  "schemaVersion", "decisionId", "actorId", "actorType", "role", "confirmedAt",
  "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "sourceC1Fingerprint",
  "sourceCandidateRevision", "sourceSkuRevision", "ownerDecisionFingerprint"
]);
const TECHNICAL_ACTOR_KEYS = Object.freeze([
  "schemaVersion", "userId", "sessionId", "actorType", "roles", "source", "authenticatedAt"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return fingerprintCanonicalRecord(value);
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function exactKeys(value, keys) {
  return isObject(value) && sameJson(Object.keys(value).sort(), [...keys].sort());
}

function validMoney(value) {
  return isObject(value) && Number.isFinite(value.amount) && value.amount > 0 &&
    ["CNY", "RUB"].includes(value.currency) && exactKeys(value, ["amount", "currency"]);
}

function validPriceConversion(value) {
  return isObject(value) && Number.isFinite(value.rubPerCny) && value.rubPerCny > 0 &&
    nonEmptyString(value.evidenceRef) && isoDateTime(value.checkedAt) &&
    exactKeys(value, ["rubPerCny", "evidenceRef", "checkedAt"]);
}

function assertSafeString(value, path) {
  if (!nonEmptyString(value)) throw new Error(`PRODUCTION_AUTHORIZATION_INPUT_GAP:${path}`);
  const text = value.trim();
  assertNoProductionSecrets(text, path);
  return text;
}

function assertNoSecrets(value, path = "input") {
  assertNoProductionSecrets(value, path);
}

function validateOwnerDecision(ownerDecision, preparation, sourceCandidateRevision, sourceSkuRevision, snapshotContext) {
  if (!exactKeys(ownerDecision, OWNER_DECISION_KEYS) || ownerDecision.selectedOption !== OWNER_DECISION_OPTION ||
      ownerDecision.sourcePreparationFingerprint !== preparation.preparationFingerprint || ownerDecision.sourceFinalCardInputFingerprint !== preparation.finalCardInputFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED");
  }
  const owner = ownerDecision.ownerConfirmation;
  if (!exactKeys(owner, OWNER_CONFIRMATION_KEYS) || owner.schemaVersion !== "production-owner-confirmation-v1" ||
      owner.actorType !== "human" || owner.role !== "owner" || owner.decisionId !== ownerDecision.decisionId ||
      !nonEmptyString(owner.actorId) || !isoDateTime(owner.confirmedAt) ||
      owner.sourcePreparationFingerprint !== preparation.preparationFingerprint ||
      owner.sourceFinalCardInputFingerprint !== preparation.finalCardInputFingerprint ||
      owner.sourceC1Fingerprint !== preparation.sourceC1Fingerprint || owner.sourceCandidateRevision !== sourceCandidateRevision || owner.sourceSkuRevision !== sourceSkuRevision) {
    throw new Error("PRODUCTION_AUTHORIZATION_HUMAN_OWNER_CONFIRMATION_REQUIRED");
  }
  for (const field of ["decisionId", "sourceConfirmationCardId", "merchantSku", "warehouseRef", "credentialAlias"]) {
    assertSafeString(ownerDecision[field], `ownerDecision.${field}`);
    if (["unknown", "null", "undefined", NOT_APPLICABLE].includes(ownerDecision[field].trim().toLowerCase())) throw new Error(`PRODUCTION_AUTHORIZATION_INPUT_GAP:ownerDecision.${field}`);
  }
  const expectedCardId = `final-plan-card:${preparation.skuPackageId}:${preparation.resultDataRevision}`;
  if (ownerDecision.sourceConfirmationCardId !== expectedCardId) throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED:sourceConfirmationCardId");
  if (!Number.isInteger(ownerDecision.stock) || ownerDecision.stock < 0) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:stock");
  if (!validMoney(ownerDecision.buyerTargetPrice) || ownerDecision.buyerTargetPrice.currency !== "RUB" ||
      !validMoney(ownerDecision.platformWritePrice) || ownerDecision.platformWritePrice.currency !== "CNY" || !validPriceConversion(ownerDecision.priceConversion)) {
    throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:price");
  }
  const converted = ownerDecision.buyerTargetPrice.amount / ownerDecision.priceConversion.rubPerCny;
  if (Math.abs(converted - ownerDecision.platformWritePrice.amount) > 0.02) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:priceConversion");
  if (!PRODUCTION_PUBLISH_SCOPES.includes(ownerDecision.publishScope) || !Array.isArray(ownerDecision.exclusions) ||
      !Array.isArray(ownerDecision.allowedWriteFields) || ownerDecision.allowedWriteFields.length === 0 ||
      new Set(ownerDecision.allowedWriteFields).size !== ownerDecision.allowedWriteFields.length ||
      ownerDecision.allowedWriteFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field)) || ownerDecision.exclusions.some((field) => !nonEmptyString(field))) {
    throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED");
  }
  assertNoSecrets(ownerDecision, "ownerDecision");
  const ownerDecisionSnapshot = buildProductionOwnerDecisionSnapshot({
    ...snapshotContext,
    sourceCandidateRevision,
    preparation,
    ownerDecision
  });
  const expectedOwnerDecisionFingerprint = sha256(ownerDecisionSnapshot);
  if (ownerDecision.ownerDecisionFingerprint !== expectedOwnerDecisionFingerprint || owner.ownerDecisionFingerprint !== expectedOwnerDecisionFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_DECISION_DRIFT:fingerprint");
  }
  return ownerDecisionSnapshot;
}

function validateTechnicalAuthorizer(actor) {
  if (!exactKeys(actor, TECHNICAL_ACTOR_KEYS) || actor.schemaVersion !== "actor-context-v1" || actor.actorType !== "human" ||
      !nonEmptyString(actor.userId) || !nonEmptyString(actor.sessionId) || actor.source !== "authenticated_identity_provider" ||
      !isoDateTime(actor.authenticatedAt) || !Array.isArray(actor.roles) || !actor.roles.includes("production_authorizer")) {
    throw new Error("PRODUCTION_AUTHORIZATION_TECHNICAL_AUTHORIZER_REQUIRED");
  }
  assertNoSecrets(actor, "technicalAuthorizer");
  return actor;
}

export function assertIndependentProductionAuthorizationActors({ ownerConfirmation, technicalAuthorizer } = {}) {
  if (!exactKeys(ownerConfirmation, OWNER_CONFIRMATION_KEYS) || ownerConfirmation.actorType !== "human" ||
      ownerConfirmation.role !== "owner" || !nonEmptyString(ownerConfirmation.actorId)) {
    throw new Error("PRODUCTION_AUTHORIZATION_HUMAN_OWNER_CONFIRMATION_REQUIRED");
  }
  validateTechnicalAuthorizer(technicalAuthorizer);
  if (ownerConfirmation.actorId === technicalAuthorizer.userId) {
    throw new Error("PRODUCTION_AUTHORIZATION_INDEPENDENT_ACTORS_REQUIRED");
  }
  return Object.freeze({
    ownerActorId: ownerConfirmation.actorId,
    technicalAuthorizerActorId: technicalAuthorizer.userId
  });
}

export function validateProductionAuthorization(authorization, context = {}) {
  return validateProductionAuthorizationRecord(authorization, context);
}

export function assertValidProductionAuthorization(authorization, context = {}) {
  const result = validateProductionAuthorization(authorization, context);
  if (!result.valid) throw new Error(`ProductionAuthorization校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return authorization;
}

function buildAuthorizedIdentity(sourceIdentity, ownerDecision) {
  return { ...structuredClone(sourceIdentity), merchantSku: ownerDecision.merchantSku, warehouseRef: ownerDecision.warehouseRef, credentialAlias: ownerDecision.credentialAlias };
}

export function buildProductionOwnerDecisionSnapshot({ candidateId, sourceCandidateRevision, skuPackage, preparation, ownerDecision }) {
  const sourceIdentity = preparation.finalCardInputSnapshot.identity;
  const identity = buildAuthorizedIdentity(sourceIdentity, ownerDecision);
  return {
    schemaVersion: "production-owner-decision-snapshot-v1",
    decisionId: ownerDecision.decisionId,
    sourceConfirmationCardId: ownerDecision.sourceConfirmationCardId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision,
    sourceSkuRevision: skuPackage.dataRevision,
    identity: structuredClone(identity),
    buyerTargetPrice: structuredClone(ownerDecision.buyerTargetPrice),
    platformWritePrice: structuredClone(ownerDecision.platformWritePrice),
    priceConversion: structuredClone(ownerDecision.priceConversion),
    stock: ownerDecision.stock,
    publishScope: ownerDecision.publishScope,
    allowedWriteFields: structuredClone(ownerDecision.allowedWriteFields),
    exclusions: structuredClone(ownerDecision.exclusions),
    mediaRequirementsFingerprint: preparation.mediaRequirementsFingerprint,
    finalManifestSha256: preparation.finalManifestSha256,
    finalUploadsFingerprint: preparation.finalUploadsFingerprint,
    mainImageAssetId: preparation.mainImageAssetId,
    videoDisposition: preparation.videoDisposition,
    effectiveVideoRequirement: structuredClone(preparation.effectiveVideoRequirement)
  };
}

export function createProductionAuthorization({ candidateId, sourceCandidateRevision, currentCandidateRevision, skuPackage, ownerDecision, technicalAuthorizer, authorizedAt }) {
  assertValidLifecyclePackage(skuPackage);
  if (skuPackage.businessPhase !== "C2" || skuPackage.productionAuthorization !== null || skuPackage.productionRecord !== null ||
      (skuPackage.dHandoff !== null && skuPackage.dHandoff !== undefined) || skuPackage.dAssetTransport?.status === "unknown_outcome") {
    throw new Error("PRODUCTION_AUTHORIZATION_GATE_REJECTED:已有下游状态或结果未知");
  }
  if (!Number.isInteger(sourceCandidateRevision) || sourceCandidateRevision < 0 || !Number.isInteger(currentCandidateRevision) ||
      currentCandidateRevision < 0 || sourceCandidateRevision !== currentCandidateRevision || !isoDateTime(authorizedAt)) {
    throw new Error("PRODUCTION_AUTHORIZATION_REVISION_CONFLICT:currentCandidateRevision");
  }
  assertIndependentProductionAuthorizationActors({ ownerConfirmation: ownerDecision?.ownerConfirmation, technicalAuthorizer });
  if (Date.parse(technicalAuthorizer.authenticatedAt) > Date.parse(authorizedAt)) {
    throw new Error("PRODUCTION_AUTHORIZATION_TECHNICAL_AUTHENTICATION_AFTER_AUTHORIZATION");
  }
  const preparation = skuPackage.c2FinalAssets?.productionAuthorizationPreparation;
  validateProductionAuthorizationPreparation({ preparation, candidateId, skuPackage });
  const sourceIdentity = structuredClone(preparation.finalCardInputSnapshot.identity);
  const identity = buildAuthorizedIdentity(sourceIdentity, ownerDecision);
  const ownerDecisionSnapshot = validateOwnerDecision(ownerDecision, preparation, sourceCandidateRevision, skuPackage.dataRevision, {
    candidateId,
    skuPackage
  });
  if (Date.parse(ownerDecision.ownerConfirmation.confirmedAt) > Date.parse(authorizedAt)) {
    throw new Error("PRODUCTION_AUTHORIZATION_TECHNICAL_AUTHORIZATION_PRECEDES_OWNER_CONFIRMATION");
  }
  const authorizationId = `production-auth:${skuPackage.skuPackageId}:${preparation.preparationFingerprint}:${ownerDecision.decisionId}`;
  const handoffId = `d-handoff:${authorizationId}`;
  const authorization = {
    schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
    authorizationId,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByActorId: ownerDecision.ownerConfirmation.actorId,
    confirmedAt: ownerDecision.ownerConfirmation.confirmedAt,
    authorizedByActorId: technicalAuthorizer.userId,
    authorizedAt,
    ownerDecisionId: ownerDecision.decisionId,
    ownerConfirmation: structuredClone(ownerDecision.ownerConfirmation),
    ownerDecisionFingerprint: ownerDecision.ownerDecisionFingerprint,
    ownerDecisionSnapshot,
    technicalAuthorization: {
      schemaVersion: "production-technical-authorization-v1",
      actorId: technicalAuthorizer.userId,
      actorType: technicalAuthorizer.actorType,
      role: "production_authorizer",
      authorizedAt
    },
    sourceConfirmationCardId: ownerDecision.sourceConfirmationCardId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    authorizedDataRevision: skuPackage.dataRevision,
    resultDataRevision: skuPackage.dataRevision + 1,
    sourceIdentity,
    identity,
    lockedScope: {
      candidateId,
      skuPackageId: skuPackage.skuPackageId,
      variantKey: skuPackage.variantKey,
      platform: sourceIdentity.platform,
      storeRef: structuredClone(sourceIdentity.storeRef),
      merchantSku: ownerDecision.merchantSku,
      supplierSkuId: sourceIdentity.supplierSkuId,
      warehouseRef: ownerDecision.warehouseRef,
      credentialAlias: ownerDecision.credentialAlias,
      schemaRevision: preparation.targetContext.schemaRevision,
      schemaEvidenceRef: preparation.targetContext.schemaEvidenceRef,
      schemaEvidenceVersion: preparation.targetContext.schemaEvidenceVersion,
      activeProfitModelVersion: preparation.finalCardInputSnapshot.activeProfitModelVersion,
      buyerTargetPrice: structuredClone(ownerDecision.buyerTargetPrice),
      platformWritePrice: structuredClone(ownerDecision.platformWritePrice),
      priceConversion: structuredClone(ownerDecision.priceConversion),
      stock: ownerDecision.stock,
      mediaRequirementsFingerprint: preparation.mediaRequirementsFingerprint,
      finalManifestVersion: preparation.finalManifestVersion,
      finalManifestSha256: preparation.finalManifestSha256,
      finalUploadsFingerprint: preparation.finalUploadsFingerprint,
      mainImageAssetId: preparation.mainImageAssetId,
      videoDisposition: preparation.videoDisposition,
      effectiveVideoRequirement: structuredClone(preparation.effectiveVideoRequirement),
      finalUploads: structuredClone(preparation.finalUploads),
      finalCardInputSnapshot: structuredClone(preparation.finalCardInputSnapshot),
      publishScope: ownerDecision.publishScope,
      allowedWriteFields: structuredClone(ownerDecision.allowedWriteFields),
      exclusions: structuredClone(ownerDecision.exclusions)
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
  const dHandoff = {
    schemaVersion: C2_D_HANDOFF_VERSION,
    handoffId,
    status: "awaiting_explicit_d_start",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    identity: structuredClone(identity),
    variantKey: skuPackage.variantKey,
    productionAuthorizationId: authorizationId,
    ownerDecisionId: ownerDecision.decisionId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    sourceSkuRevision: skuPackage.dataRevision,
    resultSkuRevision: skuPackage.dataRevision + 1,
    createdAt: authorizedAt,
    uniqueOwner: "d_software",
    productionPlanCreated: false,
    executionIntentCreated: false,
    softwareJobCreated: false,
    dWritePermissionGranted: false,
    externalRequests: 0,
    platformWrites: 0
  };
  assertValidProductionAuthorization(authorization, {
    candidateId,
    candidateRevision: sourceCandidateRevision,
    skuPackage,
    lifecycleState: "source"
  });
  assertNoSecrets(dHandoff, "dHandoff");
  const protectedPreparation = structuredClone(preparation);
  const next = structuredClone(skuPackage);
  next.productionAuthorization = authorization;
  next.dHandoff = dHandoff;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "passed";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = authorizedAt;
  next.audit.history.push({
    event: "production_authorization_and_d_handoff_created_atomically",
    at: authorizedAt,
    authorizationId,
    handoffId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    sourceSkuRevision: skuPackage.dataRevision,
    resultSkuRevision: skuPackage.dataRevision + 1,
    productionPlanCreated: false,
    executionIntentCreated: false,
    softwareJobCreated: false,
    dWritePermissionGranted: false,
    externalRequests: 0,
    platformWrites: 0
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`PRODUCTION_AUTHORIZATION_LIFECYCLE_INVALID:${transition.errors.map((item) => item.path).join(",")}`);
  if (!sameJson(protectedPreparation, next.c2FinalAssets.productionAuthorizationPreparation)) throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_MUTATED");
  assertValidLifecyclePackage(next);
  return deepFreeze({ flowVersion: "c2-d-atomic-authorization-handoff-v1", skuPackage: next, productionAuthorization: authorization, dHandoff });
}

export async function commitProductionAuthorizationHandoff({ repository, runtimeMode, actor, candidateId, expectedCandidateRevision, ownerDecision, confirmedAt }) {
  assertIndependentProductionAuthorizationActors({ ownerConfirmation: ownerDecision?.ownerConfirmation, technicalAuthorizer: actor });
  const snapshot = await repository.readSnapshot();
  const candidate = snapshot.candidates?.find((entry) => entry.id === candidateId);
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  if (!candidate || !skuPackage) throw new Error("PRODUCTION_AUTHORIZATION_CANDIDATE_NOT_FOUND");
  const preparation = skuPackage.c2FinalAssets?.productionAuthorizationPreparation;
  if (!isObject(preparation)) throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_REQUIRED");
  const inputFingerprint = sha256({ candidateId, expectedCandidateRevision, ownerDecision });
  const idempotencyKey = `production-authz:${candidateId}:${preparation.preparationFingerprint}:${ownerDecision?.decisionId}`;
  const authorizationId = `production-auth:${skuPackage.skuPackageId}:${preparation.preparationFingerprint}:${ownerDecision?.decisionId}`;
  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["production_authorizer"],
    action: "create_production_authorization_and_d_handoff",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    expectedRevision: expectedCandidateRevision,
    idempotencyKey,
    inputFingerprint,
    auditEventId: `audit:${idempotencyKey}`,
    authorizationRef: authorizationId,
    externalRequestState: "not_sent",
    externalRequestRef: null,
    serverTime: confirmedAt,
    mutate: ({ candidate: current }) => {
      const currentSku = current.lifecycleV11?.skuPackage;
      if (!currentSku || currentSku.skuPackageId !== skuPackage.skuPackageId) throw new Error("PRODUCTION_AUTHORIZATION_IDENTITY_DRIFT:skuPackage");
      const result = createProductionAuthorization({
        candidateId,
        sourceCandidateRevision: expectedCandidateRevision,
        currentCandidateRevision: current.dataRevision,
        skuPackage: currentSku,
        ownerDecision,
        technicalAuthorizer: actor,
        authorizedAt: confirmedAt
      });
      current.lifecycleV11.skuPackage = structuredClone(result.skuPackage);
      current.lifecycleV11.status = "production_authorized_awaiting_explicit_d_start";
      current.lifecycleV11.platformWrites = 0;
      current.updatedAt = confirmedAt;
      current.lastModifiedBy = actor.userId;
      return {
        candidate: current,
        result: {
          productionAuthorization: structuredClone(result.productionAuthorization),
          dHandoff: structuredClone(result.dHandoff),
          productionPlanCreated: false,
          executionIntentCreated: false,
          softwareJobCreated: false,
          dWritePermissionGranted: false,
          externalRequests: 0,
          platformWrites: 0
        }
      };
    }
  });
}

export function reviseProductionAuthorization() {
  throw new Error("PRODUCTION_AUTHORIZATION_IMMUTABLE:必须创建新的显式授权版本，禁止覆盖当前授权");
}

export function reviseProductionAuthorizationPriceSemantics() {
  throw new Error("PRODUCTION_AUTHORIZATION_IMMUTABLE:禁止原地修复不可变授权");
}

export function readAuthorizedProductionSnapshot({ productionAuthorization, candidateId, candidateRevision, skuPackage } = {}) {
  if (!productionAuthorization || !candidateId || !Number.isInteger(candidateRevision) || !skuPackage) {
    throw new Error("PRODUCTION_AUTHORIZATION_CONTEXT_REQUIRED");
  }
  assertValidProductionAuthorization(productionAuthorization, {
    candidateId,
    candidateRevision,
    skuPackage,
    lifecycleState: "persisted"
  });
  return deepFreeze(structuredClone(productionAuthorization));
}
