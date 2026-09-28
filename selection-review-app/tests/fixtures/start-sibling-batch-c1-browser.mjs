import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { threeColorFixture } from './sibling-batch-final-family-fixture.mjs';
import { startSavedDEApi } from '../helpers/d-e-saved-api-fixture.mjs';
import { stopApiProcess } from '../helpers/api-process-lifecycle.mjs';

const appDirectory = fileURLToPath(new URL('../..', import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  if ([4317, 4318, 4173].includes(port)) return freePort();
  return port;
}

const [apiPort, gatewayPort, browserPort] = await Promise.all([freePort(), freePort(), freePort()]);
if (new Set([apiPort, gatewayPort, browserPort]).size !== 3) throw new Error('SIBLING_BATCH_BROWSER_PORT_CONFLICT');
process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT = String(gatewayPort);
process.env.SELECTION_REVIEW_TEST_PORT = String(apiPort);
const browserOrigin = `http://127.0.0.1:${browserPort}`;
const cleanups = [];
const testContext = { after: callback => cleanups.push(callback) };
const fixture = await threeColorFixture();
const document = await fixture.repository.readSnapshot();
const parent = document.candidates[0];
await startSavedDEApi(testContext, { directory: await mkdtemp(path.join(tmpdir(), 'sibling-c1-browser-')),
  port: apiPort, document, binding: { storeRef: parent.storeRef, platform: parent.targetPlatform },
  productionBindings: [], browserOrigin });
const vite = spawn(process.execPath, [path.join(appDirectory, 'node_modules/vite/bin/vite.js'),
  '--config', path.join(appDirectory, 'tests/fixtures/sibling-batch-c1-vite.config.mjs'),
  '--host', '127.0.0.1', '--port', String(browserPort), '--strictPort'],
{ cwd: appDirectory, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += chunk; });
vite.stderr.on('data', chunk => { viteOutput += chunk; });
async function waitForBrowser() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error(`SIBLING_BATCH_BROWSER_VITE_FAILED:${viteOutput}`);
    try {
      const response = await fetch(`${browserOrigin}/tests/fixtures/sibling-batch-c1-browser.html`);
      if (response.ok) return;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('SIBLING_BATCH_BROWSER_START_TIMEOUT');
}
try { await waitForBrowser(); }
catch (error) {
  await stopApiProcess(vite);
  for (const cleanup of cleanups.reverse()) await cleanup();
  throw error;
}
process.stdout.write(`Synthetic C1 browser: ${browserOrigin}/tests/fixtures/sibling-batch-c1-browser.html\n`);
process.stdout.write('Synthetic owner password: synthetic password for bounded saved DE HTTP tests\n');
process.stdout.write('Press Ctrl-C to stop and remove the temporary synthetic state.\n');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopApiProcess(vite);
  for (const cleanup of cleanups.reverse()) await cleanup();
  process.exitCode = 0;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
