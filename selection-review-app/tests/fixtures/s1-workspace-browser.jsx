import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from '../../src/api.js';
import {createPreparationSaveState,createPreparationValues} from '../../src/siblingPreparationState.js';
import SiblingBatchPreparation from '../../src/components/SiblingBatchPreparation.jsx';
import '../../src/styles.css';

function WorkspaceTest(){
 const [preparationSaveState]=useState(createPreparationSaveState);
 const [document,setDocument]=useState(null),[logged,setLogged]=useState(false),[error,setError]=useState('');
 const [shown,setShown]=useState(true),[evidence,setEvidence]=useState(null),[formalAttempts,setFormalAttempts]=useState(0);
 const refresh=async()=>{const result=await api.getState();setDocument(result);
   if(result.runtimeArchitecture?.currentUser?.authenticated)setLogged(true);return result;};
 useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
 async function login(){try{const access=await api.getOwnerAccess();
   if(access.status==='setup_required')await api.setupOwnerAccess({password:'synthetic password for bounded saved DE HTTP tests'});
   else await api.loginOwnerAccess({password:'synthetic password for bounded saved DE HTTP tests'});
   setLogged(true);await refresh();}catch(e){setError(e.message);}}
 const parent=document?.candidates.find(c=>c.id==='candidate:synthetic-parent');
 const siblings=document?.candidates.filter(c=>c.siblingSourceV1?.parentCandidateId===parent?.id)??[];
 async function controls(action){try{
   const response=await fetch(`/__s1-fixture/${action}`,{method:action==='evidence'?'GET':'POST'});
   if(!response.ok)throw new Error(`S1_FIXTURE_CONTROL_FAILED:${response.status}`);
   setEvidence(await response.json());
 }catch(e){setError(e.message);}}
 async function competingSave(){try{
   const current=await api.getSiblingPreparation(parent.id);
   const values=current.draft?.values??createPreparationValues(current.catalog,parent,siblings,current.supplyPreparation);
   await api.saveSiblingPreparation(parent.id,{parentCandidateId:parent.id,parentRevision:parent.dataRevision,
     memberRevisions:siblings.map(c=>({candidateId:c.id,revision:c.dataRevision})),
     expectedDraftRevision:current.draft?.draftRevision??0,idempotencyKey:`synthetic:competing:${crypto.randomUUID()}`,values});
   await controls('evidence');
 }catch(e){setError(e.message);}}
 function forbidFormal(){setFormalAttempts(count=>count+1);throw new Error('合成验收禁止正式供货、阶段确认和店铺执行');}
 return <main style={{maxWidth:1300,margin:'24px auto',padding:20}}>
   <h1>S1 实际组件 · 隔离合成验收</h1>
   <p>真实 React、API 和 JSON 适配器；只有合成记录，店铺执行绑定为空。</p>
   <button onClick={login}>登录合成主人身份</button>
   <button onClick={()=>refresh().catch(e=>setError(e.message))}>刷新已保存状态</button>
   <button onClick={()=>setShown(value=>!value)}>{shown?'关闭商品页':'重新进入商品页'}</button>
   <button onClick={()=>controls('lost-receipt')}>隔离测试：丢失下一次保存回执</button>
   <button disabled={!logged} onClick={competingSave}>隔离测试：另一页保存同批草稿</button>
   <button onClick={()=>controls('evidence')}>独立读取合成持久结果</button>
   <p id="formal-attempts">正式动作调用次数：{formalAttempts}</p>
   {logged&&parent&&shown?<SiblingBatchPreparation key={parent.id} preparationSaveState={preparationSaveState}
     parent={parent} siblings={siblings} onConfirmA={forbidFormal} onConfirmC1={forbidFormal}
     onConfirmC2={forbidFormal} onAuthorize={forbidFormal}/>:null}
   {error?<p role="alert">{error}</p>:null}
   {evidence?<pre id="saved-evidence">{JSON.stringify(evidence,null,2)}</pre>:null}
 </main>;
}
// This explicit mode tests React state only. Controlled DTOs and promises are not C2 receipts;
// the isolated HTTP suite independently tests registration, persistence and final confirmation.
function stageScope(label) {
 const id=`fixture:stage:${label}`,supplierSkuIds=[`${label}:black`,`${label}:cp`,`${label}:black-cp`];
 const parent={id,dataRevision:4,targetPlatform:'ozon',sourceCapture:{offerId:`fixture:offer:${label}`,
   selectedSkuIds:[`${label}:parent`,...supplierSkuIds],
   skuChoices:supplierSkuIds.map(sourceSkuId=>({sourceSkuId,attributes:{颜色:sourceSkuId}}))},
   lifecycleV11:{skuPackage:{supplierSkuId:`${label}:parent`}}};
 const siblings=supplierSkuIds.map((supplierSkuId,index)=>({id:`${id}:child:${index}`,dataRevision:4,
   siblingSourceV1:{parentCandidateId:id,supplierSkuId},sourceCapture:{skuChoices:[{sourceSkuId:supplierSkuId,attributes:{颜色:supplierSkuId}}]},
   lifecycleV11:{skuPackage:{supplierSkuId,businessPhase:'C2',c1ProductPlan:{status:'seo_draft_ready'},
     c2FinalAssets:{status:'awaiting_final_uploads'}}}}));
 const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=';
 const catalog={catalogId:`fixture:catalog:${label}`,version:1,supplierSkuIds,offerId:parent.sourceCapture.offerId,
   defaults:{goods:'18',freight:'6.5',other:'0',packaging:'0',weight:'0.2',length:'20',width:'30',height:'5',price:'848',stock:'100',route:'fixture',
     titleRu:'Synthetic title',titleZh:'合成标题',descriptionRu:'Synthetic description',descriptionZh:'合成描述',bulletRu:'Synthetic bullet',bulletZh:'合成要点',rightsExpiresAt:'2099-01-01T00:00'},
   colors:Object.fromEntries(supplierSkuIds.map((sku,index)=>[sku,{name:`合成${label}-${index}`,colorRu:`color-${index}`,platformColors:['synthetic'],defaultOrder:[`image:${index}`]}])),
   assets:supplierSkuIds.map((sku,index)=>({assetId:`image:${index}`,name:`合成图${index}`,fileName:`synthetic-${index}.png`,contentType:'image/png',
     sha256:String(index+1).repeat(64),onlySourceSkuId:sku,previewSrc:pixel}))};
 const values=createPreparationValues(catalog,parent,siblings);
 values.page=2;values.supplyReviewed=true;values.members.forEach(member=>{member.hero=member.order[0];});
 const draft={schemaVersion:'sibling-preparation-draft-v1',parentCandidateId:id,sourceRevision:parent.dataRevision,
   catalogId:catalog.catalogId,catalogVersion:catalog.version,draftRevision:1,values,
   memberRevisions:siblings.map(child=>({candidateId:child.id,revision:child.dataRevision})),productionAuthorizationGranted:false};
 const uploads=new Map(siblings.map((child,index)=>[child.id,{revision:1,
   uploads:[{assetId:`fixture:asset:${label}:${index}`,sha256:catalog.assets[index].sha256,status:'ready'}],
   selection:[{assetId:`fixture:asset:${label}:${index}`,order:1}]}]));
 return {parent,siblings,catalog,draft,uploads};
}

function StageBoundaryFixture(){
 const [scopes]=useState(()=>new Map(['A','B'].map(label=>[label,stageScope(label)])));
 const [label,setLabel]=useState('A'),[shown,setShown]=useState(true),[records,setRecords]=useState([]),[attempts,setAttempts]=useState(0);
 const [saveState]=useState(createPreparationSaveState);
 const pending=useRef(new Map()),sequence=useRef(0),modes=useRef(new Map([['A','delay'],['B','delay']]));
 const [ready,setReady]=useState(false);
 useEffect(()=>{
   const old={getSiblingPreparation:api.getSiblingPreparation,getC2UploadDraft:api.getC2UploadDraft,saveC2UploadDraft:api.saveC2UploadDraft};
   const scopeFor=id=>{
     const scope=[...scopes.values()].find(item=>item.parent.id===id||item.siblings.some(child=>child.id===id));
     if(!scope)throw new Error('SYNTHETIC_UI_SCOPE_UNKNOWN');return scope;
   };
   api.getSiblingPreparation=async id=>{const scope=scopeFor(id);return structuredClone({configured:true,catalog:scope.catalog,draft:scope.draft,
     supplyPreparation:{otherPurchaseCosts:0,rows:[],gaps:[],costSourceRef:'synthetic:ui-only'}});};
   api.getC2UploadDraft=async id=>({candidateId:id,dataRevision:4,draft:structuredClone(scopeFor(id).uploads.get(id))});
   api.saveC2UploadDraft=async(id,input)=>{
     const scope=scopeFor(id),scopeLabel=scope.parent.id.endsWith(':A')?'A':'B';
     if(modes.current.get(scopeLabel)==='delay'){
       modes.current.set(scopeLabel,'automatic');const requestId=++sequence.current;
       await new Promise((resolve,reject)=>{pending.current.set(requestId,{resolve,reject});
         setRecords(previous=>[...previous,{requestId,label:scopeLabel,status:'pending'}]);});
     }
     const draft=scope.uploads.get(id);
     if(input.dataRevision!==4||input.draftRevision!==draft.revision)throw new Error('SYNTHETIC_UI_REVISION_CONFLICT');
     draft.selection=structuredClone(input.selection);draft.revision+=1;
     return {candidateId:id,dataRevision:4,draft:structuredClone(draft)};
   };
   setReady(true);
   return()=>{Object.assign(api,old);};
 },[scopes]);
 function settle(requestId,reject){
   const request=pending.current.get(requestId);
   if(!request)throw new Error('SYNTHETIC_UI_REQUEST_NOT_PENDING');
   pending.current.delete(requestId);
   setRecords(previous=>previous.map(record=>record.requestId===requestId?{...record,status:reject?'rejected':'completed'}:record));
   if(reject)request.reject(new Error('合成素材暂存失败：未确认当前文件'));
   else request.resolve();
 }
 const scope=scopes.get(label);
 return <main style={{maxWidth:1300,margin:'24px auto',padding:20}}>
   <h1>C2 暂存 React 状态边界 · 合成验收</h1>
   <p>只验证真实组件状态；受控暂存请求不保存业务、不访问店铺，正式 HTTP 合同另由隔离 API 测试验证。</p>
   <p id="stage-active">当前合成批次：{label}</p>
   <button onClick={()=>setLabel(value=>value==='A'?'B':'A')}>切换合成批次</button>
   <button onClick={()=>setShown(value=>!value)}>{shown?'卸载合成商品页':'重新挂载合成商品页'}</button>
   <button onClick={()=>modes.current.set(label,'delay')}>延迟下一次暂存</button>
   <p id="stage-confirmations">C2 确认回调次数：{attempts}</p>
   {records.map(record=><p key={record.requestId} data-request-id={record.requestId}>请求 {record.requestId} · {record.label} · {record.status}
     {record.status==='pending'?<><button onClick={()=>settle(record.requestId,false)}>完成请求 {record.requestId}</button>
       <button onClick={()=>settle(record.requestId,true)}>拒绝请求 {record.requestId}</button></>:null}</p>)}
   {ready&&shown?<SiblingBatchPreparation key={scope.parent.id} parent={scope.parent} siblings={scope.siblings}
     preparationSaveState={saveState} onConfirmC2={async()=>setAttempts(value=>value+1)}
     onUploadAsset={()=>{throw new Error('SYNTHETIC_UI_UNEXPECTED_FILE_UPLOAD');}}/>:null}
 </main>;
}

const stageBoundaryMode=new URLSearchParams(location.search).get('stage-ui')==='1';
createRoot(document.getElementById('root')).render(stageBoundaryMode?<StageBoundaryFixture/>:<WorkspaceTest/>);
