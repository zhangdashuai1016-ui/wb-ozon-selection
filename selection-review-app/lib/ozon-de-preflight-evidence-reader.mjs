import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { assertOzonDEPreflightEvidence, assertOzonDEPreflightEvidenceScope,
  OzonDEPreflightEvidenceError, OzonDEPreflightEvidenceUnavailableError } from './ozon-de-preflight-provider.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

/**
 * Reads the target authorization's immutable evidence entry. No state migration,
 * evidence import, account request or credential access occurs here.
 * A code-owned source verifier must reconstruct the record from saved controlled
 * request receipts. Without it, even a structurally valid record stays unverified.
 */
export function createRepositoryBackedOzonDEPreflightEvidenceReader({ repository, verifySourceReceipt = null }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (verifySourceReceipt !== null && typeof verifySourceReceipt !== 'function') throw new OzonDEPreflightEvidenceError('SOURCE_VERIFIER_INVALID');
  return async function readEvidence(scope) {
    assertOzonDEPreflightEvidenceScope(scope);
    const expectedScope = freeze(structuredClone(scope));
    const document = await repository.readSnapshot();
    if (!object(document.runtime)) throw new OzonDEPreflightEvidenceError('REPOSITORY_INVALID');
    if (!Object.hasOwn(document.runtime, 'ozonDEPreflightEvidence')) return null;
    const entries = document.runtime.ozonDEPreflightEvidence;
    if (!object(entries)) throw new OzonDEPreflightEvidenceError('REPOSITORY_INVALID');
    if (!Object.hasOwn(entries, scope.authorizationId)) return null;
    const record = assertOzonDEPreflightEvidence(entries[scope.authorizationId]);
    if (!isDeepStrictEqual(record.scope, expectedScope)) throw new OzonDEPreflightEvidenceError('SCOPE_MISMATCH');
    if (verifySourceReceipt === null) throw new OzonDEPreflightEvidenceUnavailableError('evidence_source_unverified');
    const result = await verifySourceReceipt(freeze(structuredClone(record)), expectedScope);
    const expectedReceipt = {
      status: 'verified', evidenceId: record.evidenceId, scope: expectedScope,
      collectedAt: record.collectedAt, expiresAt: record.expiresAt,
      readAuthorizationRef: record.provenance.readAuthorizationRef,
      softwareJobRef: record.provenance.softwareJobRef,
      officialContractRefs: record.provenance.officialContractRefs
    };
    if (!isDeepStrictEqual(result, expectedReceipt)) throw new OzonDEPreflightEvidenceError('SOURCE_RECEIPT_INVALID');
    return record;
  };
}
