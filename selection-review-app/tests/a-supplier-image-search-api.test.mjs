import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(![4317, 4318, 4173].includes(port));
  return port;
}

test('unconfigured image search HTTP reports readiness and rejects authorization with no business or external effects', async t => {
  const fixture = await productionOwnerDecisionHttpFixture(), candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  const document = { ...fixture.document, candidates: [candidate],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'image-search-api-state-'));
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'image-search-api-probe-'));
  const probe = path.join(probeDirectory, 'counts.json'), preload = path.join(probeDirectory, 'deny-external.mjs');
  await writeFile(probe, JSON.stringify({ credentials: 0, network: 0 }));
  await writeFile(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
  const port = await freePort(); let dependencyPort = await freePort();
  while (port === dependencyPort) dependencyPort = await freePort();
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  t.after(async () => {
    assert.deepEqual(JSON.parse(await readFile(probe, 'utf8')), { credentials: 0, network: 0 });
    await rm(probeDirectory, { recursive: true, force: true });
  });
  const route = `/api/candidates/${candidate.id}/supplier-image-search`;
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision };
  const bytes = await api.readBytes();
  assert.equal((await api.get(`${route}?revision=${candidate.dataRevision}`)).status, 401);
  assert.equal((await api.post(`${route}/authorize`, input, { headers: { 'X-Owner-Confirmed': 'true' } })).status, 401);
  await api.authenticate();
  const preparation = await api.get(`${route}?revision=${candidate.dataRevision}`);
  assert.equal(preparation.status, 200, JSON.stringify(preparation.body));
  assert.deepEqual(preparation.body, { schemaVersion: 'a-supplier-image-search-availability-v1', status: 'not_configured',
    canAuthorize: false, pageContractStatus: 'unverified', browserWorkerStatus: 'unverified', blockCode: 'PAGE_CONTRACT_UNCONFIGURED',
    candidateId: candidate.id, revision: candidate.dataRevision });
  const state = await api.get('/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.candidates.find(row => row.id === candidate.id).supplierImageSearchPreparation,
    { schemaVersion: 'a-supplier-image-search-availability-v1', status: 'not_configured', canAuthorize: false,
      pageContractStatus: 'unverified', browserWorkerStatus: 'unverified', blockCode: 'PAGE_CONTRACT_UNCONFIGURED' });
  const blocked = await api.post(`${route}/authorize`, input);
  assert.equal(blocked.status, 503); assert.equal(blocked.body.code, 'PAGE_CONTRACT_UNCONFIGURED');
  for (const revision of ['', '01', '-1', 'abc', '9007199254740992']) {
    assert.equal((await api.get(`${route}?revision=${revision}`)).status, 400);
  }
  assert.equal((await api.get(`${route}?revision=${candidate.dataRevision + 1}`)).status, 409);
  assert.equal((await api.post(`${route}/authorize`, { ...input, expectedRevision: candidate.dataRevision + 1 })).status, 409);
  assert.equal((await api.post(`${route}/authorize`, { ...input, candidateId: 'candidate:other' })).status, 400);
  assert.equal((await api.post(`${route}/authorize`, { ...input, pageContractVerified: true })).status, 400);
  assert.equal((await api.post(`${route}/authorize`, input, { authenticated: false })).status, 401);
  assert.equal((await api.post(`${route}/authorize`, input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(`${route}/authorize`, input, { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(await api.readBytes(), bytes);
  const saved = await api.readDocument();
  assert.equal(saved.candidates[0].dataRevision, candidate.dataRevision);
  assert.deepEqual(saved.runtime.softwareJobs, []);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords, []);
  await api.assertClean();
});
