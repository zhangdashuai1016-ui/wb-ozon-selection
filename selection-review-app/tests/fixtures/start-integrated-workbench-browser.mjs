import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { threeColorFixture } from './sibling-batch-final-family-fixture.mjs';
import { writeSyntheticSiblingPreparationCatalog } from './sibling-preparation-catalog-fixture.mjs';
import { startSavedDEApi } from '../helpers/d-e-saved-api-fixture.mjs';
import { allocatedTestPorts } from '../helpers/api-process-lifecycle.mjs';

// The existing local test runner applies the OS sandbox before this entry starts.
// A marker alone grants no boundary; use only the runner's dedicated browser mode.
if (process.platform !== 'darwin' || process.env.SELECTION_REVIEW_INTEGRATED_BROWSER_FIXTURE !== '1') {
  throw new Error('INTEGRATED_BROWSER_REQUIRES_LOCAL_SANDBOX_RUNNER');
}
const appDirectory = fileURLToPath(new URL('../..', import.meta.url));
const { api: apiPort, second: browserPort } = allocatedTestPorts();
const browserOrigin = `http://127.0.0.1:${browserPort}`;
const entryPath = '/tests/fixtures/integrated-workbench-browser.html';
const cleanups = [];
const testContext = { after: callback => cleanups.push(callback) };
let api = null, vite = null;
let stopping = false;
let evidenceFailure = null;

async function fixtureEvidence() {
  const document = await api.readDocument();
  return {
    schemaVersion: 'integrated-workbench-browser-evidence-v1', source: 'synthetic',
    observedAt: new Date().toISOString(), browserOrigin,
    dependencyRequests: api.dependencyRequests(), dictionaryRequests: api.dictionaryRequests(),
    serverDiagnostics: api.stderr.length,
    productionBindings: 0, externalCredentials: 0, enabledPaidServices: 0,
    automationStarted: document.meta.automationStarted,
    candidates: document.candidates.map(candidate => ({ candidateId: candidate.id,
      dataRevision: candidate.dataRevision, targetStore: candidate.targetStore,
      businessPhase: candidate.lifecycleV11?.skuPackage?.businessPhase ?? 'A' })),
    jobs: (document.runtime?.softwareJobs ?? []).map(job => ({ jobId: job.jobId, status: job.status }))
  };
}

function fixtureEvidencePlugin() {
  return {
    name: 'integrated-workbench-browser-evidence',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/__integrated-fixture/evidence') return next();
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' });
          response.end(JSON.stringify({ code: 'INTEGRATED_BROWSER_EVIDENCE_READ_ONLY' }));
          return;
        }
        fixtureEvidence().then(evidence => {
          response.writeHead(200); response.end(JSON.stringify(evidence));
        }, error => {
          evidenceFailure ??= error;
          process.stderr.write(`INTEGRATED_BROWSER_EVIDENCE_FAILED: ${error.message}\n`);
          response.writeHead(500); response.end(JSON.stringify({ code: 'INTEGRATED_BROWSER_EVIDENCE_FAILED' }));
        });
      });
    }
  };
}

async function closeFixture() {
  const failures = evidenceFailure === null ? [] : [evidenceFailure];
  if (vite !== null) {
    try { await vite.close(); }
    catch (error) { failures.push(error); }
  }
  if (api !== null) {
    try {
      process.stdout.write(`INTEGRATED_BROWSER_FINAL_EVIDENCE ${JSON.stringify(await fixtureEvidence())}\n`);
      await api.assertClean();
    } catch (error) { failures.push(error); }
  }
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'INTEGRATED_BROWSER_CLEANUP_FAILED');
}

try {
  const fixture = await threeColorFixture();
  const document = await fixture.repository.readSnapshot();
  document.meta.automationStarted = false;
  document.dispatches = [];
  assert.equal(document.runtime.softwareJobs.every(job => job.status === 'completed'), true,
    'The preview starts with no runnable software jobs.');
  const directory = await mkdtemp(path.join(tmpdir(), 'integrated-workbench-browser-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const catalog = await writeSyntheticSiblingPreparationCatalog({ document, tempDir: directory });
  const parent = document.candidates[0];
  // The domain fixture supplies captured choices; the real page also needs their capture mode and state.
  parent.sourceCapture.mode = 'a_supplier_capture';
  parent.sourceCapture.status = 'captured_waiting_owner_selection';
  const thumbnail = catalog.assets[0].previewSrc;
  for (const candidate of document.candidates) {
    candidate.imageUrl = thumbnail;
    candidate.workflowStatus = 'listing_preparation';
  }
  parent.productName = '合成三色共用来源（历史执行结果待核对）';
  api = await startSavedDEApi(testContext, { directory, catalogDirectory: directory,
    port: apiPort, document, binding: { storeRef: parent.storeRef, platform: parent.targetPlatform },
    productionBindings: [], browserOrigin });
  await api.authenticate();
  // These are the actual application reads, not substituted endpoint responses.
  for (const route of ['/api/state', '/api/stores', '/api/intake/queue', '/api/store-profiles', '/api/seerfar-selection']) {
    const response = await api.get(route);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
  }
  await api.assertClean();
  vite = await createServer({ root: appDirectory,
    configFile: path.join(appDirectory, 'tests/fixtures/integrated-workbench-vite.config.mjs'),
    configLoader: 'native', cacheDir: path.join(directory, 'node_modules', '.vite'),
    plugins: [fixtureEvidencePlugin()] });
  await vite.listen();
  const page = await fetch(`${browserOrigin}${entryPath}`);
  assert.equal(page.status, 200);
  process.stdout.write(`Integrated actual application: ${browserOrigin}${entryPath}\n`);
  process.stdout.write('Only synthetic state is loaded. Choose 蛋蛋鼠, open 进行中, and select a synthetic colour to review the three-colour workspace.\n');
  process.stdout.write(`INTEGRATED_BROWSER_READY ${JSON.stringify(await fixtureEvidence())}\n`);
  process.stdout.write('Press Ctrl-C to stop; the runner removes the isolated source and temporary state.\n');
} catch (error) {
  try { await closeFixture(); }
  catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'INTEGRATED_BROWSER_START_AND_CLEANUP_FAILED');
  }
  throw error;
}

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await closeFixture(); }
  catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
