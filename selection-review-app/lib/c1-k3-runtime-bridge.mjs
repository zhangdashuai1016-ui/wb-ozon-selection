export const C1_K3_RUNTIME_BRIDGE_VERSION = "c1-k3-runtime-bridge-v1";

function clone(value) {
  return value === null || value === undefined ? null : structuredClone(value);
}

export function resolveC1K3RuntimeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      bridgeVersion: C1_K3_RUNTIME_BRIDGE_VERSION,
      frozenSeoRules: null,
      k3KeywordEvidenceSnapshot: null,
      k3CurrentBinding: null,
      savedKeywordEvidence: null,
      legacySavedKeywordEvidenceReadOnly: false,
      frozenComplexityDecision: null
    };
  }

  const hasK3Snapshot = evidence.k3KeywordEvidenceSnapshot !== null &&
    evidence.k3KeywordEvidenceSnapshot !== undefined;
  const legacyReadOnly = hasK3Snapshot !== true && evidence.legacySavedKeywordEvidenceReadOnly === true;

  return {
    bridgeVersion: C1_K3_RUNTIME_BRIDGE_VERSION,
    frozenSeoRules: clone(evidence.frozenSeoRules),
    k3KeywordEvidenceSnapshot: hasK3Snapshot ? clone(evidence.k3KeywordEvidenceSnapshot) : null,
    k3CurrentBinding: hasK3Snapshot ? clone(evidence.k3CurrentBinding) : null,
    savedKeywordEvidence: legacyReadOnly ? clone(evidence.savedKeywordEvidence) : null,
    legacySavedKeywordEvidenceReadOnly: legacyReadOnly,
    frozenComplexityDecision: clone(evidence.frozenComplexityDecision)
  };
}
