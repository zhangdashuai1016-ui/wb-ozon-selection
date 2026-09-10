import { createSeerfarDiscoveryRuntimeFixture } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {createADiscoveryContractFixture,createADiscoveryContractReceipt} from './fixtures/a-discovery-contract-fixture.mjs';

let renderer;
async function render(props){
  if(!renderer){
    const entry=fileURLToPath(new URL('./a-discovery-ui-entry.jsx',import.meta.url));
    const component=fileURLToPath(new URL('../src/components/ProductDiscoveryCard.jsx',import.meta.url));
    const output=await build({configFile:false,logLevel:'warn',plugins:[react(),{name:'a-discovery-ui-test',
      resolveId:id=>id===entry?entry:null,load:id=>id===entry?`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Card from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Card {...props}/>);`:null}],
      ssr:{noExternal:true},build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'es'}}}});
    const chunk=output.output.find(value=>value.type==='chunk'&&value.isEntry);assert.ok(chunk);
    renderer=await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}
const f=createADiscoveryContractFixture();
const view=()=>({schemaVersion:'a-discovery-view-v1',plans:[f.batch.plan],bindings:[{bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion}],
  canPrepare:true,configurationBlockers:[],targetStores:['miska','dandanshu'],batches:[],hasMore:false,runtimeStatus:'stopped',activeExecution:null,lastAdmissionRejection:null,platformWrites:0});
const forbidden=()=>{throw new Error('RENDER_MUST_NOT_START_WORK');};
const props=v=>({view:v,onCreate:forbidden,onAuthorize:forbidden,onContinue:forbidden,onOpenCandidate:forbidden});

test('discovery UI offers a local preparation and never preselects a paid plan or checkbox',async()=>{
  const html=await render(props(view()));
  assert.match(html,/<option value="" selected="">请选择方向/);
  assert.match(html,/<option value="" selected="">请选择目标店铺/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>准备本轮查询范围/);
  assert.match(html,/只保存本地计划，不查询商品或扣费/);
  assert.doesNotMatch(html,/type="checkbox"/);
});
test('saved batch shows exact plan limits and a separate explicit paid decision',async()=>{
  const v=view();v.batches=[{batch:f.batch,jobs:[],canAuthorize:true,candidateImport:null}];
  const html=await render(props(v));
  assert.match(html,/最多查询 3 次，批准上限 30 LinkFox 积分/);
  assert.match(html,/最多保存 1 件待核验商品/);
  assert.match(html,/详情读取需独立许可/);
  assert.match(html,/失败或空结果是否扣费尚未确认/);
  assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>批准并开始本轮搜索/);
});
test('failed and unknown queries expose no replay and imported materials remain unverified',async()=>{
  const v=view(),receipt=createADiscoveryContractReceipt(f);
  v.batches=[{batch:f.batch,canAuthorize:false,jobs:[{job:{...f.job,status:'unknown_outcome'},receipt:null,canContinue:false}],
    candidateImport:{status:'failed',candidateId:null,failureClass:'UNEXPECTED_SYSTEM_ERROR'}}];
  let html=await render(props(v));assert.match(html,/请求结果未知，需核对/);assert.match(html,/保存候选未完成/);
  assert.doesNotMatch(html,/批准并开始本轮搜索|执行已批准且尚未发送的查询|查看待核验商品/);
  v.batches[0]={...v.batches[0],jobs:[{job:{...f.job,status:'completed'},receipt,canContinue:false}],
    candidateImport:{status:'imported',candidateId:'candidate:synthetic'}};
  html=await render(props(v));assert.match(html,/查看待核验商品/);assert.match(html,/Synthetic organizer/);
  assert.doesNotMatch(html,/正式利润通过|供货方案已确认|E验证通过/);
});
test('disabled configuration and all-duplicate history stay explicit',async()=>{
  const v=view();v.plans=[];v.bindings=[];v.runtimeStatus='not_configured';v.canPrepare=false;
  v.configurationBlockers=['PLAN_NOT_CONFIGURED','CONNECTOR_NOT_CONFIGURED','SERVICE_NOT_CONFIGURED'];
  v.batches=[{batch:f.batch,jobs:[],canAuthorize:false,candidateImport:{status:'all_duplicates'}}];
  const html=await render(props(v));assert.match(html,/当前没有可执行计划/);
  assert.match(html,/未重复建卡或恢复已淘汰商品/);assert.doesNotMatch(html,/批准并开始本轮搜索/);
});

test('a connector without its worker explains the engineering gap and cannot prepare a batch',async()=>{
  const v=view();v.canPrepare=false;v.configurationBlockers=['SERVICE_NOT_CONFIGURED'];v.runtimeStatus='not_configured';
  const html=await render(props(v));assert.match(html,/查询执行程序尚未配置/);
  assert.match(html,/不需要你提供商品链接或在聊天中发送密钥/);
  assert.doesNotMatch(html,/准备本轮查询范围|批准并开始本轮搜索|type="password"/);
});

test('unsupported plans explain the capability mismatch without offering a preparation button',async()=>{
  const v=view();v.canPrepare=false;v.plans=[];v.configurationBlockers=['PLAN_NOT_SUPPORTED'];
  const html=await render(props(v));assert.match(html,/已配置服务不能执行计划中的全部查询/);
  assert.doesNotMatch(html,/准备本轮查询范围|批准并开始本轮搜索/);
});


test('Seerfar plan renders its category and three-request points budget without keyword assumptions', async t => {
  const f=await createSeerfarDiscoveryRuntimeFixture(t);
  const {service}=f.create();const created=await f.prepare(service);
  const snapshot=service.view({document:await f.repository.readSnapshot(),actor:f.owner});
  assert.equal(snapshot.batches[0].batch.batchId,created.batch.batchId);
  const html=await render(props(snapshot));
  assert.match(html,/Seerfar 点数/);
  assert.match(html,/类目 100_200/);
  assert.match(html,/三次请求/);
  assert.doesNotMatch(html,/LinkFox 积分/);
  assert.equal(f.calls.length,0);
});

 test('Seerfar material view shows raw review facts and dates but keeps legacy facts unknown', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create(); await f.authorize(service, await f.prepare(service));
  const snapshot = service.view({ document: await f.repository.readSnapshot(), actor: f.owner });
  const market = snapshot.batches[0].jobs[0].receipt.steps[1].result;
  Object.assign(market, { dateRange: { startDate: '2026-07-01', endDate: '2026-07-27' } });
  Object.assign(market.products[0], { reviewCount: 142, reviewRating: 4.8, rawSellerType: 1 });
  let html = await render(props(snapshot));
  assert.match(html, /2026-07-01 至 2026-07-27/); assert.match(html, /评价数：142；评分：4.8/);
  assert.match(html, /卖家身份未核实/); assert.match(html, /<details><summary>查看来源证据<\/summary><p>服务返回卖家原码：1；未映射为卖家身份/); assert.doesNotMatch(html, /中国跨境|近30天销量|正式利润通过/);
  market.schemaVersion = 'seerfar-discovery-market-result-v1'; delete market.dateRange;
  for (const key of ['reviewCount','reviewRating','rawSellerType']) delete market.products[0][key];
  const bytes = JSON.stringify(snapshot); html = await render(props(snapshot));
  assert.match(html, /评价数：未知；评分：未知/); assert.match(html, /卖家原码：未知/);
  assert.equal(JSON.stringify(snapshot), bytes); assert.equal(f.calls.length, 3);
});


test('changed saved batch configuration explains why new authorization is unavailable', async () => {
  const v = view();
  v.batches = [{ batch: f.batch, jobs: [], canAuthorize: false, candidateImport: null, configurationBlocker: 'PLAN_NOT_CONFIGURED' }];
  const html = await render(props(v));
  assert.match(html, /该批次的查询配置已变更或移除/);
  assert.match(html, /维护人员需核对当前计划/);
  assert.doesNotMatch(html, /批准并开始本轮搜索/);
});
