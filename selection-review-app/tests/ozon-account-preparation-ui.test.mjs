import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
let renderer;
async function renderers(){
  if(renderer)return renderer;
  const entry=fileURLToPath(new URL('./account-preparation-ui-entry.jsx',import.meta.url)),component=fileURLToPath(new URL('../src/components/OzonAccountPreparationCard.jsx',import.meta.url));
  const built=await build({configFile:false,logLevel:'warn',plugins:[react(),{name:'account-preparation-ui-test',resolveId:id=>id===entry?entry:null,load:id=>id===entry?`
    import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import Card from ${JSON.stringify(component)};
    export const render=props=>renderToStaticMarkup(<Card {...props}/>);
    export function untouched(props){let submit;function Subject(){const tree=Card(props);function collect(e){if(!React.isValidElement(e))return;if(e.type==='form')submit=e.props.onSubmit;React.Children.forEach(e.props.children,collect);}collect(tree);return tree;}renderToStaticMarkup(<Subject/>);return submit;}
  `:null}],ssr:{noExternal:true},build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'es'}}}});
  const output=built.output.find(item=>item.type==='chunk'&&item.isEntry);assert.ok(output);renderer=await import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`);return renderer;
}
const binding={bindingId:'binding:synthetic',scopeRef:'scope:synthetic',configurationVersion:'config:synthetic',targetStore:'miska',credentialAlias:'alias:synthetic',storeName:'合成账户',clientId:'123456'};
const view=()=>({schemaVersion:'ozon-account-discovery-view-v1',bindings:[binding],preparations:[],platformWrites:0});
const item=()=>({preparation:{preparationId:'preparation:synthetic',revision:0,binding,warehouseSelections:[]},jobs:[],canAuthorize:true,warehouses:[],hasNext:null,sourceBlocker:null,canSelectWarehouse:false});
test('actual independent card has no default account, no fake SKU and no render-time action',async()=>{
  const {render,untouched}=await renderers(),calls=[],props={view:view(),onCreate:async value=>calls.push(value)};
  const html=render(props);assert.match(html,/<option value="" selected="">请选择账户，不会自动选择/);assert.doesNotMatch(html,/<option value="binding:synthetic" selected/);
  assert.match(html,/保存准备不产生读取请求/);assert.match(html,/<button[^>]*disabled=""[^>]*>保存账户准备/);assert.doesNotMatch(html,/type="checkbox"/);
  await untouched(props)({preventDefault(){}});assert.deepEqual(calls,[]);
});
test('saved preparation asks for fresh explicit read permission and fixed 20-item no-pagination bounds',async()=>{
  const {render}=await renderers(),v=view();v.preparations=[item()];const html=render({view:v,onAuthorize:async()=>{throw new Error('No render action');}});
  assert.match(html,/最多 20 个仓库，各一次，合计最多三次/);assert.match(html,/不翻页，失败即停止/);assert.match(html,/type="checkbox"/);
  assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);assert.match(html,/店铺身份尚未核实/);
});
test('partial discovery shows the actual named row with no automatic choice or additional read',async()=>{
  const {render}=await renderers(),v=view(),i=item();Object.assign(i,{canAuthorize:false,canSelectWarehouse:true,hasNext:true,sourceJobId:'job:1',sourceReceiptId:'receipt:1',
    warehouses:[{warehouseId:'10001',name:'合成仓库',warehouseType:'RFBS',status:'created'}],jobs:[{jobId:'job:1',status:'completed',requestsSent:3,canContinue:false}]});v.preparations=[i];
  const html=render({view:v,onSelectWarehouse:async()=>{throw new Error('No render action');}});assert.match(html,/平台仍有后续结果；本次不继续翻页/);
  assert.match(html,/合成仓库 · 10001 · RFBS · created/);assert.match(html,/<option value="" selected="">请选择仓库/);assert.doesNotMatch(html,/type="checkbox"/);
});
test('unknown and expired source expose no authorization or warehouse selection',async()=>{
  const {render}=await renderers(),v=view(),i=item();Object.assign(i,{canAuthorize:false,sourceBlocker:'OZON_ACCOUNT_READ_SOURCE_EXPIRED',jobs:[{jobId:'job:1',status:'unknown_outcome',requestsSent:'unknown',canContinue:false}]});v.preparations=[i];
  const html=render({view:v});assert.match(html,/请求结果待核对/);assert.match(html,/仓库来源未通过当前核验/);assert.doesNotMatch(html,/授权读取一次|保存仓库选择|继续已授权/);
});
test('removed account configuration preserves the visible record with explicit disabled actions',async()=>{
  const {render}=await renderers(),v=view(),i=item();Object.assign(i,{canAuthorize:false,configurationBlocker:'account_route_unavailable'});v.preparations=[i];
  const html=render({view:v});assert.match(html,/账户路由已停用或配置版本已变化/);assert.match(html,/preparation:synthetic/);
  assert.doesNotMatch(html,/授权读取一次|继续已授权的账户读取|保存仓库选择/);
});
