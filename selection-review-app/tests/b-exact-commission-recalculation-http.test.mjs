import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createSavedConditionalBFixture } from './fixtures/real-a-b-flow-fixture.mjs';

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(![4317, 4318, 4173].includes(port));
  return port;
}

async function startFixture(t, { rejected = false, mutate = null } = {}) {
  const fixture = await createSavedConditionalBFixture({ rejected });
  const owner = await productionOwnerDecisionHttpFixture();
  const document = { ...owner.document, ...fixture.document };
  if (mutate) mutate(document);
  const directory = await mkdtemp(path.join(tmpdir(), 'b-exact-http-state-'));
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'b-exact-http-probe-'));
  const probe = path.join(probeDirectory, 'counts.json'), preload = path.join(probeDirectory, 'deny-external.mjs');
  await writeFile(probe, JSON.stringify({ credentials: 0, network: 0 }));
  // The isolated child uses the producer's business clock; native timers remain real.
  // Tripwires throw before any actual credential access or request, without fake success.
  await writeFile(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';
const NativeDate=Date;const at=NativeDate.parse(${JSON.stringify(fixture.at)});globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}
cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
  const port = await freePort(); let dependencyPort = await freePort();
  while (dependencyPort === port) dependencyPort = await freePort();
  const environment = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: '[]',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, environment); api = await startSavedDEApi(t, { directory, port, document, binding: owner.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  t.after(async () => { assert.deepEqual(JSON.parse(await readFile(probe, 'utf8')), { credentials: 0, network: 0 }); await rm(probeDirectory, { recursive: true, force: true }); });
  const input = { candidateId: fixture.candidate.id, expectedRevision: fixture.candidate.dataRevision,
    skuPackageId: fixture.candidate.lifecycleV11.skuPackage.skuPackageId, failureId: 'failure:b-exact',
    idempotencyKey: 'b-exact:http:1', auditEventId: 'audit:b-exact:http:1' };
  return { ...fixture, api, input, route: `/api/candidates/${input.candidateId}/lifecycle/b/exact-commission/recalculate` };
}

for (const rejected of [false, true]) {
  test(`real B HTTP ${rejected ? 'rejection' : 'pass'} preserves A, saves formal profit once and independently reads the result`, async t => {
    const { api, input, route } = await startFixture(t, { rejected });
    const original = await api.readBytes();
    assert.equal((await api.post(route, input, { authenticated: false })).status, 401);
    assert.deepEqual(await api.readBytes(), original);
    await api.authenticate();
    const before = await api.readBytes(), prior = await api.readDocument();
    const state = await api.get('/api/state');
    assert.equal(state.status, 200);
    const view = state.body.candidates.find(c => c.id === input.candidateId).bExactCommissionRuntimeView;
    assert.equal(view.canRecalculate, true);
    assert.equal(view.expectedRevision, input.expectedRevision);
    assert.deepEqual(await api.readBytes(), before, 'availability GET must not calculate or write');
    for (const attempt of [
      { input, options: { headers: { Origin: 'https://invalid.example', 'Sec-Fetch-Site': 'cross-site' } }, status: 403 },
      { input, options: { headers: { 'Content-Type': 'text/plain' } }, status: 415 },
      { input: { ...input, extra: true }, status: 400 },
      { input: { ...input, expectedRevision: String(input.expectedRevision) }, status: 400 },
      { input: { ...input, candidateId: 'wrong' }, status: 400 },
      { input: { ...input, expectedRevision: input.expectedRevision - 1 }, status: 409 },
      { input: { ...input, skuPackageId: 'wrong' }, status: 409 },
      { input: { ...input, failureId: 'wrong' }, status: 409 }
    ]) {
      const response = await api.post(route, attempt.input, attempt.options);
      assert.equal(response.status, attempt.status, JSON.stringify(response.body) + api.stderr.join(''));
      assert.deepEqual(await api.readBytes(), before);
    }
    const response = await api.post(route, input);
    assert.equal(response.status, 200, JSON.stringify(response.body) + api.stderr.join(''));
    assert.equal(response.body.recalculationStatus, 'committed');
    assert.equal(response.body.result.status, rejected ? 'rejected' : 'passed');
    const saved = await api.readDocument(), candidate = saved.candidates[0], life = candidate.lifecycleV11;
    const oldLife = prior.candidates[0].lifecycleV11;
    for (const key of ['aConfirmationReceipt', 'opportunityPackage', 'ownerSupplyConfirmation']) assert.deepEqual(life[key], oldLife[key]);
    assert.deepEqual(life.skuPackage.selectedSupplySnapshot, oldLife.skuPackage.selectedSupplySnapshot);
    assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), oldLife.skuPackage.profitModels);
    assert.equal(life.skuPackage.profitModels.length, oldLife.skuPackage.profitModels.length + 1);
    assert.equal(life.skuPackage.profitModels.at(-1).calculationType, 'formal');
    assert.equal(life.c1Handoffs.length, rejected ? 0 : 1);
    assert.equal(candidate.workflowStatus, rejected ? 'eliminated' : 'listing_preparation');
    assert.equal(candidate.executionRuntime.technicalFailure, null);
    assert.deepEqual(response.body.result.priorTechnicalFailure, prior.candidates[0].executionRuntime.technicalFailure);
    assert.deepEqual(response.body.result.priorSystemEvidenceBundle, oldLife.bSystemEvidenceBundle);
    assert.deepEqual(saved.runtime.softwareJobs, prior.runtime.softwareJobs);
    const bytes = await api.readBytes();
    const replay = await api.post(route, input);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.recalculationStatus, 'idempotent_replay');
    assert.deepEqual(replay.body.result, response.body.result);
    assert.deepEqual(await api.readBytes(), bytes);
    const readback = await api.get('/api/state');
    assert.equal(readback.status, 200);
    const reread = readback.body.candidates.find(c => c.id === input.candidateId);
    assert.equal(reread.dataRevision, candidate.dataRevision);
    assert.equal(reread.lifecycleV11.skuPackage.activeProfitModelVersion, life.skuPackage.activeProfitModelVersion);
    assert.deepEqual(reread.lifecycleV11.c1Handoffs, life.c1Handoffs);
    await api.assertClean();
  });
}

for (const scenario of [
  { name: 'missing exact commission', mutate: d => { d.evidencePacks = d.evidencePacks.filter(p => p.kind !== 'commission'); }, status: 'evidence_required' },
  { name: 'frozen supply drift', mutate: d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.actualPurchaseCost += 1; }, status: 'source_conflict' }
]) {
  test(`real B HTTP rejects ${scenario.name} without writes or external calls`, async t => {
    const { api, input, route } = await startFixture(t, scenario);
    await api.authenticate();
    const before = await api.readBytes();
    const state = await api.get('/api/state');
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const view = state.body.candidates.find(c => c.id === input.candidateId).bExactCommissionRuntimeView;
    assert.equal(view.canRecalculate, false);
    assert.equal(view.status, scenario.status);
    const response = await api.post(route, input);
    assert.equal(response.status, 409, JSON.stringify(response.body) + api.stderr.join(''));
    assert.deepEqual(await api.readBytes(), before);
    await api.assertClean();
  });
}
