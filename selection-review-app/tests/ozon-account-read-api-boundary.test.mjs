import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { accountReadConcurrencyFixture } from './helpers/account-read-concurrency-fixture.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createOzonAccountReadBindingResolver } from '../lib/ozon-account-read-preparation.mjs';

const { api: port } = allocatedTestPorts();
test('real account HTTP boundary rejects anonymous, cross-origin, stale and unconfirmed requests before credentials or business changes', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'account-read-boundary-http-'));
  const api = await startSavedDEApi(t, { directory, port, document: fixture.document, binding: fixture.binding,
    accountReadServices: [{ ...fixture.service, schemaVersion: 'ozon-account-read-service-binding-v1',
      serviceId: 'service:synthetic:account-read', workerId: 'worker:synthetic:account-read' }],
    credentialBindings: [{ credentialAlias: fixture.binding.credentialAlias, clientId: '700123',
      keychainService: 'synthetic-account-boundary', keychainAccount: 'synthetic-account' }] });
  const bytes = await api.readBytes();
  const state = await api.get('/api/state'); assert.equal(state.status, 200);
  const preparation = state.body.candidates.find(candidate => candidate.id === fixture.candidate.id).ozonAccountReadPreparation;
  assert.equal(preparation.options.length, 1); assert.equal(preparation.options[0].clientId, '700123');
  assert.deepEqual(preparation.runtime, []); assert.equal(preparation.maxRequests, 3); assert.equal(preparation.platformWrites, 0);
  assert.equal(Object.hasOwn(preparation, 'selectedBindingId'), false);
  const option = preparation.options[0], route = `/api/candidates/${fixture.candidate.id}/lifecycle/account-read/authorize`;
  const input = { candidateId: fixture.candidate.id, skuPackageId: preparation.skuPackageId, expectedRevision: preparation.expectedRevision,
    bindingId: option.bindingId, configurationVersion: option.configurationVersion, scopeRef: option.scopeRef,
    confirmReadOnce: true, expiresAt: '2099-01-01T00:00:00.000Z', idempotencyKey: 'owner-read:http-boundary' };
  assert.ok([401, 403].includes((await api.post(route, input, { authenticated: false })).status));
  await api.authenticate();
  assert.equal((await api.post(route, input, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403);
  const stale = await api.post(route, { ...input, expectedRevision: input.expectedRevision - 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'OZON_ACCOUNT_READ_CANDIDATE_CHANGED');
  const unconfirmed = await api.post(route, { ...input, confirmReadOnce: false });
  assert.equal(unconfirmed.status, 422); assert.equal(unconfirmed.body.code, 'OZON_ACCOUNT_READ_INPUT_INVALID');
  assert.equal((await api.post(route, { ...input, candidateId: 'candidate:wrong' })).status, 400);
  assert.equal((await api.post(route, input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual(await api.readBytes(), bytes);
  await api.restart(); await api.authenticate('login');
  assert.deepEqual((await api.get('/api/state')).body.candidates.find(candidate => candidate.id === fixture.candidate.id).ozonAccountReadPreparation, preparation);
  assert.deepEqual(await api.readBytes(), bytes); await api.assertClean();
});

test('real HTTP refresh boundary exposes persisted expiry and rejects missing, wrong and premature refresh intent with no request or mutation',async t=>{
  const fixture=await productionOwnerDecisionHttpFixture(),repository=createMemoryBusinessStateRepository(fixture.document);
  const service={...fixture.service,schemaVersion:'ozon-account-read-service-binding-v1',
    serviceId:'service:synthetic:account-read',workerId:'worker:synthetic:account-read'};
  const credential={credentialAlias:fixture.binding.credentialAlias,clientId:'700123',
    keychainService:'synthetic-account-boundary',keychainAccount:'synthetic-account'};
  const configuration={productionBindings:[fixture.binding],ozonAccountReadServiceBindings:[service],ozonDECredentialBindings:[credential]};
  const readBinding=createOzonAccountReadBindingResolver(configuration)({document:fixture.document,candidateId:fixture.candidate.id,
    skuPackageId:fixture.candidate.lifecycleV11.skuPackage.skuPackageId,bindingId:fixture.binding.bindingId,
    configurationVersion:fixture.binding.configurationVersion});
  const account=await accountReadConcurrencyFixture({repository,clock:()=>new Date().toISOString(),
    candidateId:fixture.candidate.id,productionBinding:fixture.binding,readBinding});
  const completed=await account.run();assert.equal(completed.status,'completed');assert.equal(account.requests.length,3);
  const directory=await mkdtemp(path.join(tmpdir(),'account-refresh-boundary-http-'));
  const api=await startSavedDEApi(t,{directory,port,document:await repository.readSnapshot(),binding:fixture.binding,
    accountReadServices:[service],credentialBindings:[credential]});
  await api.authenticate();const bytes=await api.readBytes(),state=await api.get('/api/state');
  const preparation=state.body.candidates.find(candidate=>candidate.id===fixture.candidate.id).ozonAccountReadPreparation;
  const current=preparation.runtime.find(value=>value.isCurrent);
  assert.equal(current.jobId,completed.job.jobId);assert.equal(current.canRefresh,false);assert.equal(current.evidenceExpiresAt,account.input.expiresAt);
  const input={...account.input,idempotencyKey:'account:http:refresh',refreshOfJobId:completed.job.jobId};
  const route=`/api/candidates/${fixture.candidate.id}/lifecycle/account-read/authorize`;
  assert.equal((await api.post(route,input,{authenticated:false})).status,401);
  assert.equal((await api.post(route,input,{headers:{Origin:'https://unrelated.invalid'}})).status,403);
  const withoutRefresh={...input};delete withoutRefresh.refreshOfJobId;
  for(const [body,code] of [[input,'OZON_ACCOUNT_READ_REFRESH_NOT_DUE'],
    [{...input,refreshOfJobId:'account:other-job'},'OZON_ACCOUNT_READ_REFRESH_TARGET_CONFLICT'],
    [withoutRefresh,'OZON_ACCOUNT_READ_REFRESH_NOT_SUPPORTED']]){
    const result=await api.post(route,body);assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(result.body.code,code);
    assert.deepEqual(await api.readBytes(),bytes);
  }
  await api.restart();await api.authenticate('login');
  const repeated=await api.post(route,input);assert.equal(repeated.status,409);assert.equal(repeated.body.code,'OZON_ACCOUNT_READ_REFRESH_NOT_DUE');
  assert.deepEqual(await api.readBytes(),bytes);assert.equal(api.dependencyRequests(),0);await api.assertClean();
});
