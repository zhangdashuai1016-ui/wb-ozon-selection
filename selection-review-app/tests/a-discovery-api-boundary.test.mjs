import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {productionOwnerDecisionHttpFixture,startSavedDEApi} from './helpers/d-e-saved-api-fixture.mjs';
async function freePort(){
  const server=http.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  assert.ok(![4317,4318,4173].includes(port));return port;
}

test('real default-off discovery API enforces owner, source and closed input without credential or external access',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'a-discovery-http-probe-')),directory=await mkdtemp(path.join(tmpdir(),'a-discovery-http-state-'));
  const probe=path.join(root,'counts.json'),preload=path.join(root,'deny-external.mjs');
  await writeFile(probe,JSON.stringify({credentials:0,network:0}));
  await writeFile(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}cp.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');`);
  const fixture=await productionOwnerDecisionHttpFixture(),document={...fixture.document,candidates:[]};
  delete document.runtime;
  const port=await freePort();let dependencyPort=await freePort();while(port===dependencyPort)dependencyPort=await freePort();
  const env={SELECTION_REVIEW_TEST_GATEWAY_PORT:String(dependencyPort),NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`,
    SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON:'[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON:'[]',SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON:'[]'};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));let api;
  try{Object.assign(process.env,env);api=await startSavedDEApi(t,{directory,port,document,binding:fixture.binding});}
  finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  t.after(async()=>{assert.deepEqual(JSON.parse(await readFile(probe,'utf8')),{credentials:0,network:0});await rm(root,{recursive:true,force:true});});
  assert.equal((await api.get('/api/product-discovery')).status,401);
  assert.equal((await api.post('/api/product-discovery/create',{}, {authenticated:false})).status,401);
  await api.authenticate();
  const bytes=await api.readBytes(),view=await api.get('/api/product-discovery');assert.equal(view.status,200);
  assert.equal(view.body.runtimeStatus,'not_configured');assert.equal(view.body.canPrepare,false);
  assert.deepEqual(view.body.configurationBlockers,['PLAN_NOT_CONFIGURED','CONNECTOR_NOT_CONFIGURED','SERVICE_NOT_CONFIGURED']);assert.deepEqual(view.body.plans,[]);assert.deepEqual(view.body.bindings,[]);
  assert.deepEqual(view.body.batches,[]);assert.equal(view.body.activeExecution,null);assert.equal(view.body.platformWrites,0);
  const input={planId:'plan:unconfigured',planVersion:'version:1',targetStore:'miska',bindingId:'binding:unconfigured',configurationVersion:'version:1',idempotencyKey:'create:one'};
  assert.equal((await api.post('/api/product-discovery/create',input)).status,503);
  assert.equal((await api.post('/api/product-discovery/create',{...input,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/create',input,{headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await api.post('/api/product-discovery/create',input,{headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await api.post('/api/product-discovery/create',{payload:'x'.repeat(9000)})).status,413);
  for(const route of ['authorize','continue','select'])assert.equal((await api.post(`/api/product-discovery/${route}`,{verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/select',{batchId:'a-discovery-batch:none',expectedRevision:0,marketProductId:'1'},{authenticated:false})).status,401);
  assert.equal((await api.post('/api/product-discovery/select',{batchId:'a-discovery-batch:none',expectedRevision:0,marketProductId:'1'})).status,409);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0},{authenticated:false})).status,(await api.post('/api/product-discovery/create',{},{authenticated:false})).status);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/translate',{batchId:'a-discovery-batch:none',expectedRevision:0})).status,409);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0},{authenticated:false})).status,(await api.post('/api/product-discovery/create',{},{authenticated:false})).status);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0,verified:true})).status,400);
  assert.equal((await api.post('/api/product-discovery/estimate',{batchId:'a-discovery-batch:none',expectedRevision:0})).status,409);
  assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
  await api.restart();await api.authenticate('login');
  assert.equal((await api.get('/api/product-discovery')).body.runtimeStatus,'not_configured');
  assert.deepEqual(await api.readBytes(),bytes);await api.assertClean();
});
