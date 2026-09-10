import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {createAProductDetailCandidateFixture} from './fixtures/a-product-detail-evidence-fixture.mjs';

let renderer;
async function render(view){
  if(!renderer){
    const entry=fileURLToPath(new URL('./a-product-detail-ui-entry.jsx',import.meta.url));
    const component=fileURLToPath(new URL('../src/components/ProductDetailPreparationCard.jsx',import.meta.url));
    const aCard=fileURLToPath(new URL('../src/components/RealAConfirmationCard.jsx',import.meta.url));
    const output=await build({configFile:false,logLevel:'warn',plugins:[react(),{name:'a-product-detail-ui-test',
      resolveId:id=>id===entry?entry:null,load:id=>id===entry?`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Card from ${JSON.stringify(component)};import ACard from ${JSON.stringify(aCard)};
      export const render=props=>renderToStaticMarkup(<Card {...props}/>);export const renderA=card=>renderToStaticMarkup(<ACard card={card}/>);`:null}],
      ssr:{noExternal:true},build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'es'}}}});
    const chunk=output.output.find(value=>value.type==='chunk'&&value.isEntry);assert.ok(chunk);
    renderer=await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  const forbidden=()=>{throw new Error('RENDER_MUST_NOT_START_WORK');};
  return renderer.render({view,onAuthorize:forbidden,onContinue:forbidden});
}
const view=()=>({schemaVersion:'a-product-detail-view-v1',candidateId:'candidate:synthetic',revision:1,
  bindings:[{bindingId:'detail:binding',configurationVersion:'detail:version'}],budget:{unit:'linkfox_credits',maxRequests:2,maxCredits:13},
  proposedReads:[{method:'ozon_detail',productId:'123',productUrl:'https://www.ozon.ru/product/123/'},
    {method:'supplier_detail',productId:'456',productUrl:'https://detail.1688.com/offer/456.html'}],
  jobs:[],applications:[],canAuthorize:true,runtimeStatus:'stopped',preparationBlockCode:null,lastAdmissionRejection:null});

test('details show the two exact sources and separate cost decision without preselecting approval',async()=>{
  const html=await render(view());
  assert.match(html,/https:\/\/www.ozon.ru\/product\/123\//);assert.match(html,/https:\/\/detail.1688.com\/offer\/456.html/);
  assert.match(html,/各 1 次，批准上限 13 LinkFox 积分/);assert.match(html,/同款关系和具体供应 SKU 仍由你/);
  assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>批准并读取本轮详情/);
});
test('unknown result never offers replay and applied details still await the A decision',async()=>{
  const v=view();v.canAuthorize=false;v.jobs=[{job:{jobId:'job:detail',status:'unknown_outcome',scopeBinding:{request:{method:'ozon_detail'}}},
    receipt:{failureClass:'REQUEST_TIMEOUT',steps:[]},canContinue:false}];
  let html=await render(v);assert.match(html,/请求结果未知，需核对/);
  assert.doesNotMatch(html,/批准并读取本轮详情|执行已批准且尚未发送的详情读取/);
  v.jobs=[];v.preparationBlockCode='ALREADY_APPLIED';v.applications=[{status:'applied',sourceRevision:1}];html=await render(v);
  assert.match(html,/两份详情已进入下方 A 确认卡，尚未确认供应 SKU/);
  assert.doesNotMatch(html,/正式利润通过|供货方案已确认|批准并读取本轮详情/);
  assert.doesNotMatch(html,/当前详情准备未就绪|ALREADY_APPLIED/);
});
test('configuration and source failures stay visible without a paid action',async()=>{
  const v=view();v.canAuthorize=false;v.bindings=[];v.runtimeStatus='not_configured';v.preparationBlockCode='SOURCE_INVALID';
  v.applications=[{status:'blocked',sourceRevision:1,failureClass:'APPLICATION_FACTS_INCOMPLETE'}];
  const html=await render(v);assert.match(html,/详情服务尚未配置/);assert.match(html,/当前详情准备未就绪：SOURCE_INVALID/);
  assert.match(html,/详情回执已保留，更新确认卡未完成：APPLICATION_FACTS_INCOMPLETE/);
  assert.doesNotMatch(html,/批准并读取本轮详情/);
});
test('the existing A card describes provider receipts honestly and exposes brand and MOQ blockers',async()=>{
  await render(view());
  const fixture=await createAProductDetailCandidateFixture({brandName:'Synthetic Brand',moq:2});
  const html=renderer.renderA(fixture.card);
  assert.match(html,/来源为本轮已保存的 LinkFox 详情回执/);
  assert.match(html,/权利未核清/);assert.match(html,/当前方案不满足一件起订/);
  assert.doesNotMatch(html,/短链由插件只打开一次|销售快照保存后由软件调用Terra一次|页面直接价格和库存/);
  assert.match(html,/本轮尚无已保存的辅助草稿/);
});
