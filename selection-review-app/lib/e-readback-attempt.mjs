import { isDeepStrictEqual } from "node:util";
import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { assertCanonicalFrozenRef, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { validateEVerificationRecord } from "./e-stage-readback.mjs";

export const E_READBACK_ATTEMPT_VERSION = "e-readback-attempt-v1";
const ATTEMPT_FIELDS = ["schemaVersion", "attemptId", "candidateId", "skuPackageId", "sourceProductionRecordId",
  "sourceFingerprint", "requestedByUserId", "startedAt", "completedAt", "status", "externalRequestState", "result",
  "applicationDisposition", "automaticRetry", "platformWrites"];

function assertAttemptSoftwareJobRef(ref) {
  const fields = ["jobId", "revision", "workerId", "leaseId"];
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== fields.length ||
      fields.some(field => !Object.hasOwn(ref, field)) || !Number.isSafeInteger(ref.revision) || ref.revision < 0 ||
      ![ref.jobId, ref.workerId, ref.leaseId].every(isCanonicalFrozenRef)) throw new Error("E_READBACK_SOFTWARE_JOB_REFERENCE_INVALID");
}

function assertSystemReadbackResult(result, attempt) {
  const fields = ["schemaVersion", "status", "outcome", "verifiedAt", "sourceProductionRecordId", "gaps",
    "observation", "eVerificationRecord", "automaticRetry", "platformWrites"];
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== fields.length ||
      fields.some(field => !Object.hasOwn(result, field)) || result.schemaVersion !== "e-system-readback-v1" ||
      !["verified", "not_verified"].includes(result.status) || result.sourceProductionRecordId !== attempt.sourceProductionRecordId ||
      !Array.isArray(result.gaps) || result.gaps.some(code => typeof code !== "string" || code.trim() === "") ||
      !result.observation || typeof result.observation !== "object" || Array.isArray(result.observation) ||
      !Number.isFinite(Date.parse(result.verifiedAt)) || Date.parse(result.verifiedAt) < Date.parse(attempt.startedAt) ||
      Date.parse(result.verifiedAt) > Date.parse(attempt.completedAt) || result.automaticRetry !== false || result.platformWrites !== 0) {
    throw new Error("E_READBACK_RESULT_INVALID");
  }
  if (result.status === "not_verified") {
    if (result.outcome !== null || result.eVerificationRecord !== null || result.gaps.length === 0) throw new Error("E_READBACK_RESULT_INVALID");
    return;
  }
  const record = result.eVerificationRecord;
  if (result.outcome !== "listed_verified" || result.gaps.length !== 0 || !validateEVerificationRecord(record).valid ||
      record.verificationPath !== "system_created" || record.sourceRecordId !== attempt.sourceProductionRecordId ||
      record.skuPackageId !== attempt.skuPackageId || record.verifiedAt !== result.verifiedAt) throw new Error("E_READBACK_RESULT_INVALID");
  for (const field of ["platform", "store", "storeRef", "warehouseRef", "credentialAlias", "skuPackageId", "supplierSkuId",
    "platformProductId", "merchantSku", "currentPrice", "currentStock", "imageCount", "moderationStatus", "validationStatus",
    "saleStatus", "errors", "platformEvidenceRef", "mediaObservation", "inventoryObservation"]) {
    if (!isDeepStrictEqual(record[field], result.observation[field])) throw new Error("E_READBACK_RESULT_INVALID");
  }
}

export function assertEReadbackAttempt(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt) ||
      Object.keys(attempt).some(field => !ATTEMPT_FIELDS.includes(field) && field !== "softwareJobRef") ||
      ATTEMPT_FIELDS.some(field => !Object.hasOwn(attempt, field)) ||
      attempt.schemaVersion !== E_READBACK_ATTEMPT_VERSION ||
      !["in_flight", "verified", "not_verified", "unknown_outcome", "not_applied"].includes(attempt.status) ||
      !["not_sent", "in_flight", "succeeded", "unknown_outcome"].includes(attempt.externalRequestState) ||
      !["pending", "recorded", "applied", "source_conflict_not_applied", "reconciliation_required_not_applied"].includes(attempt.applicationDisposition) ||
      !/^[a-f0-9]{64}$/.test(attempt.sourceFingerprint) ||
      !Number.isFinite(Date.parse(attempt.startedAt)) ||
      attempt.automaticRetry !== false || attempt.platformWrites !== 0) throw new Error("E_READBACK_ATTEMPT_INVALID");
  if (Object.hasOwn(attempt, "softwareJobRef")) assertAttemptSoftwareJobRef(attempt.softwareJobRef);
  for (const field of ["attemptId", "candidateId", "skuPackageId", "sourceProductionRecordId", "requestedByUserId"]) {
    assertCanonicalFrozenRef(attempt[field], `eReadbackAttempt.${field}`);
  }
  if (attempt.attemptId !== `e-readback:${attempt.candidateId}:${attempt.sourceProductionRecordId}`) throw new Error("E_READBACK_ATTEMPT_INVALID");
  if (attempt.status === "in_flight") {
    if (attempt.completedAt !== null || attempt.result !== null || attempt.applicationDisposition !== "pending" ||
        !["not_sent", "in_flight"].includes(attempt.externalRequestState)) throw new Error("E_READBACK_ATTEMPT_INVALID");
  } else {
    if (!Number.isFinite(Date.parse(attempt.completedAt)) || Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt) ||
        !attempt.result || attempt.result.schemaVersion !== "e-system-readback-v1" ||
        attempt.result.sourceProductionRecordId !== attempt.sourceProductionRecordId || attempt.applicationDisposition === "pending" ||
        !["not_sent", "succeeded", "unknown_outcome"].includes(attempt.externalRequestState)) throw new Error("E_READBACK_ATTEMPT_INVALID");
    if ((attempt.status === "verified") !== (attempt.applicationDisposition === "applied") ||
        (attempt.status === "not_applied") !== ["source_conflict_not_applied", "reconciliation_required_not_applied"].includes(attempt.applicationDisposition) ||
        (attempt.status === "verified" && attempt.result.status !== "verified") ||
        (attempt.status === "unknown_outcome" && attempt.externalRequestState !== "unknown_outcome")) throw new Error("E_READBACK_ATTEMPT_INVALID");
    assertSystemReadbackResult(attempt.result, attempt);
  }
  if (attempt.applicationDisposition === "reconciliation_required_not_applied" && !Object.hasOwn(attempt, "softwareJobRef")) {
    throw new Error("E_READBACK_ATTEMPT_INVALID");
  }
  assertSafeRuntimeRecord(attempt, "eReadbackAttempt");
  return attempt;
}
