import { createHash } from "node:crypto";

export const KEYWORD_EVIDENCE_SOFTWARE_JOB_STATE_VERSION = "keyword-evidence-software-job-state-v1";

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function stable(value) { return Array.isArray(value) ? value.map(stable) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value; }
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); Object.values(value).forEach(freeze); return value; }

// Legacy records are retained for audit/reconciliation, never for new execution.
export function createKeywordEvidenceSoftwareJobIntent() {
  throw new Error("KEYWORD_SOFTWARE_JOB_INTENT_RETIRED");
}

export function legacyKeywordJobBlocksPaidExecution(candidate) {
  return ["in_flight", "unknown_outcome"].includes(candidate.lifecycleV11?.keywordEvidenceSoftwareJobV1?.status);
}

export function settleKeywordEvidenceSoftwareJob({ persistedJob, outcome, settledAt }) {
  if (!isObject(persistedJob) || persistedJob.schemaVersion !== KEYWORD_EVIDENCE_SOFTWARE_JOB_STATE_VERSION || persistedJob.status !== "in_flight" ||
      !nonEmpty(settledAt) || Number.isNaN(Date.parse(settledAt)) || !isObject(outcome)) {
    throw new Error("KEYWORD_SOFTWARE_JOB_SETTLEMENT_INPUT_INVALID");
  }
  if (!['completed', 'failed', 'unknown_outcome'].includes(outcome.status)) throw new Error("KEYWORD_SOFTWARE_JOB_SETTLEMENT_STATUS_INVALID");
  const settled = {
    ...structuredClone(persistedJob),
    status: outcome.status,
    completedAt: settledAt,
    failureClass: outcome.failureClass ?? null,
    executionReceipt: outcome.executionReceipt ? structuredClone(outcome.executionReceipt) : null,
    eventId: outcome.eventId ?? null,
    retryAllowed: false
  };
  delete settled.jobFingerprint;
  settled.jobFingerprint = digest(settled);
  return freeze(settled);
}

export function reconcileKeywordEvidenceSoftwareJobAfterRestart({ persistedJob, restartedAt }) {
  if (persistedJob?.schemaVersion !== KEYWORD_EVIDENCE_SOFTWARE_JOB_STATE_VERSION || persistedJob.status !== "in_flight") return null;
  return settleKeywordEvidenceSoftwareJob({
    persistedJob,
    settledAt: restartedAt,
    outcome: { status: "unknown_outcome", failureClass: "service_restarted_during_provider_attempt", executionReceipt: null, eventId: null }
  });
}
