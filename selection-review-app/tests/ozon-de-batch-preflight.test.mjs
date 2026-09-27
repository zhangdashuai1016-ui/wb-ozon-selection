import test from 'node:test';
import assert from 'node:assert/strict';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

test('batch member reads only its saved authorization and scope without a single D job', async () => {
  const { context, record } = ozonDEPreflightEvidenceFixture();
  const candidate = context.candidate;
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
  const batch = { schemaVersion: 'd-batch-production-authorization-v1', batchId: 'd-batch:synthetic',
    status: 'authorized', members: [{ candidateId: candidate.id, skuPackageId: context.job.skuPackageId,
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: fingerprintCanonicalRecord(authorization), resultRevision: candidate.dataRevision }] };
  let reads = 0;
  const provider = createOzonDEPreflightProvider({ serverClock: () => '2026-08-22T07:25:00.000Z',
    readEvidence: async () => { reads++; return record; } });
  const result = await provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch });
  assert.equal(reads, 1);
  assert.equal(result.capabilities.status, 'not_ready');
  assert.ok(result.capabilities.gaps.some(gap => gap.code === 'evidence_protocol_version_outdated'));
  batch.members[0].resultRevision++;
  await assert.rejects(provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch }), /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads, 1);
});
