import test from 'node:test';
import assert from 'node:assert/strict';
import { ozonDEPreflightEvidenceFixture } from './fixtures/ozon-de-preflight-evidence-fixture.mjs';
import { createOzonDEPreflightProvider } from '../lib/ozon-de-preflight-provider.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';
import { assertCurrentProductionExecutionBinding } from '../lib/platform-write-preflight.mjs';

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
    productionBinding: context.productionBinding, batch,purpose:'import_observation' });
  assert.equal(reads, 1);
  assert.equal(result.capabilities.status, 'not_ready');
  assert.ok(result.capabilities.gaps.some(gap => gap.code === 'evidence_protocol_version_outdated'));
  batch.members[0].resultRevision++;
  await assert.rejects(provider.loadBatchMemberEvidence({ candidate,
    productionBinding: context.productionBinding, batch,purpose:'import_observation' }), /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads, 1);
});

test('batch E uses current read evidence after write verification expires, and rejects drift or missing read grants', async () => {
  const {context,record}=ozonDEPreflightEvidenceFixture();
  const candidate=context.candidate,authorization=candidate.lifecycleV11.skuPackage.productionAuthorization;
  assert.equal(Object.hasOwn(candidate.lifecycleV11.skuPackage,'merchantSku'),false);
  assert.ok(authorization.lockedScope.merchantSku);
  const binding=structuredClone(context.productionBinding);
  binding.verification.expiresAt='2026-08-22T07:20:00.000Z';
  const batch={schemaVersion:'d-batch-production-authorization-v2',batchId:'d-batch:synthetic:e-read',status:'imported_awaiting_inventory',
    members:[{candidateId:candidate.id,skuPackageId:authorization.lockedScope.skuPackageId,
      offerId:authorization.lockedScope.merchantSku,authorizationId:authorization.authorizationId,
      authorizationFingerprint:fingerprintCanonicalRecord(authorization),resultRevision:candidate.dataRevision}]};
  batch.postImportScope={eReadbackOfferIds:[batch.members[0].offerId]};
  assert.throws(()=>assertCurrentProductionExecutionBinding({productionAuthorization:authorization,
    currentProductionBinding:binding,checkedAt:'2026-08-22T07:25:00.000Z'}),/PRODUCTION_EXECUTION_BINDING_UNVERIFIED/);
  record.schemaVersion='ozon-de-preflight-evidence-v3';
  record.protocols.inventoryWrite={...record.protocols.inventoryWrite,status:'denied',prerequisitePolicy:null};
  record.inspection.permissionStatus='denied';
  let reads=0;
  const provider=createOzonDEPreflightProvider({serverClock:()=> '2026-08-22T07:25:00.000Z',
    readEvidence:async scope=>{reads++;assert.deepEqual(scope,record.scope);return structuredClone(record);}});
  const input={candidate,productionBinding:binding,batch,offerId:batch.members[0].offerId};
  const ready=await provider.loadBatchEReadEvidence(input);
  assert.equal(ready.capabilities.status,'read_ready');
  assert.equal(ready.capabilities.independentReadback.status,'verified');
  assert.equal(reads,1);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,warehouseId:'999999'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,productionBinding:{...binding,credentialAlias:'credential-alias:synthetic:other'}}),
    /OZON_DE_PREFLIGHT_EVIDENCE_READ_ROUTING_CHANGED/);
  await assert.rejects(provider.loadBatchEReadEvidence({...input,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  const forgedBatch=structuredClone(batch);
  forgedBatch.members[0].offerId='UNCONFIRMED-OFFER';
  forgedBatch.postImportScope.eReadbackOfferIds=['UNCONFIRMED-OFFER'];
  await assert.rejects(provider.loadBatchEReadEvidence({...input,batch:forgedBatch,offerId:'UNCONFIRMED-OFFER'}),
    /OZON_DE_PREFLIGHT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(reads,1);
  record.protocols.independentReadback.status='denied';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  record.protocols.independentReadback.status='verified';
  record.inspection.storeIdentityStatus='mismatched';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,3);
  record.inspection.storeIdentityStatus='matched';
  record.expiresAt='2026-08-22T07:25:00.000Z';
  await assert.rejects(provider.loadBatchEReadEvidence(input),/OZON_DE_PREFLIGHT_EVIDENCE_BATCH_E_READ_NOT_AUTHORIZED/);
  assert.equal(reads,4);
});
