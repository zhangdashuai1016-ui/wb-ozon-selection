import { useState } from 'react';
import { useSubmit } from './FormRevisionNotice.jsx';

const statusLabels={queued:'读取许可已保存',claimed:'正在读取账户资料',waiting_platform:'正在读取账户资料',completed:'账户资料已保存',failed:'本次读取已停止',unknown_outcome:'请求结果待核对'};

function Preparation({item,onAuthorize,onContinue,onSelectWarehouse}){
  const {preparation}=item, {saving,error,run}=useSubmit();
  const [expiresAt,setExpiresAt]=useState(''),[confirmed,setConfirmed]=useState(false),[warehouseId,setWarehouseId]=useState('');
  const [key,setKey]=useState(()=>`account-discovery:${crypto.randomUUID()}`);
  const binding=preparation.binding,current=item.jobs[0];
  function changeExpiry(value){setExpiresAt(value);setConfirmed(false);setKey(`account-discovery:${crypto.randomUUID()}`);}
  function authorize(event){event.preventDefault();return run(async()=>{
    if(!item.canAuthorize||!confirmed||!expiresAt||typeof onAuthorize!=='function')throw new Error('请核对账户与本次读取期限，并明确勾选许可。');
    const deadline=new Date(expiresAt);if(!Number.isFinite(deadline.getTime())||deadline.getTime()<=Date.now())throw new Error('请选择有效的读取截止时间。');
    await onAuthorize({preparationId:preparation.preparationId,expectedRevision:preparation.revision,bindingId:binding.bindingId,
      configurationVersion:binding.configurationVersion,scopeRef:binding.scopeRef,expiresAt:deadline.toISOString(),confirmReadOnce:true,idempotencyKey:key});
  });}
  return <article>
    <p>账户准备：{preparation.preparationId} · 第 {preparation.revision} 版</p>
    <p>账户路由：{binding.targetStore} · 凭据别名：{binding.credentialAlias} · 店铺身份尚未核实。</p>
    {item.configurationBlocker?<p role="alert">此账户路由已停用或配置版本已变化。已保存记录仍保留，当前不能继续读取或选择仓库。</p>:null}
    {current?<div role="status"><strong>{statusLabels[current.status]}</strong><p>已发送读取请求：{current.requestsSent==='unknown'?'待核对':`${current.requestsSent} 次`}。</p>
      {current.status==='failed'||current.status==='unknown_outcome'?<p>已保存已有资料，未自动重发。</p>:null}
      {current.canContinue?<button type="button" disabled={saving||typeof onContinue!=='function'} onClick={()=>run(()=>onContinue({preparationId:preparation.preparationId,jobId:current.jobId,expectedRevision:current.expectedRevision}))}>继续已授权的账户读取</button>:null}
    </div>:null}
    {item.canAuthorize?<form onSubmit={authorize}><fieldset disabled={saving}>
      <label>本次读取许可截止时间<input type="datetime-local" required value={expiresAt} onChange={event=>changeExpiry(event.target.value)}/></label>
      <p>读取方法权限、公司币种及最多 20 个仓库，各一次，合计最多三次；不翻页，失败即停止。</p>
      <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我确认此账户路由，允许本次独立账户准备只读查询。</label>
      <button type="submit" disabled={saving||!confirmed||!expiresAt||typeof onAuthorize!=='function'}>授权读取一次</button>
    </fieldset></form>:null}
    {item.sourceBlocker?<p role="alert">仓库来源未通过当前核验，不能据此选择。请核对已保存资料与读取许可。</p>:null}
    {item.canSelectWarehouse?<div>
      <p>{item.hasNext?'这里只展示本次最多 20 个仓库，平台仍有后续结果；本次不继续翻页。':'本次仓库列表已读取。'}</p>
      {item.warehouses.length===0?<p>平台本次明确返回零个仓库。</p>:<>
        <label>从本次来源选择仓库<select value={warehouseId} onChange={event=>{setWarehouseId(event.target.value);setKey(`account-discovery:${crypto.randomUUID()}`);}}>
          <option value="">请选择仓库</option>{item.warehouses.map(row=><option key={row.warehouseId} value={row.warehouseId}>{row.name} · {row.warehouseId} · {row.warehouseType} · {row.status}</option>)}
        </select></label>
        <button type="button" disabled={saving||!warehouseId||typeof onSelectWarehouse!=='function'} onClick={()=>run(()=>onSelectWarehouse({preparationId:preparation.preparationId,
          expectedRevision:preparation.revision,sourceJobId:item.sourceJobId,sourceReceiptId:item.sourceReceiptId,warehouseId,idempotencyKey:key}))}>保存仓库选择</button>
      </>}
    </div>:null}
    {preparation.warehouseSelections.length>0?<p>已保存选择：{preparation.warehouseSelections.at(-1).warehouse.name} · {preparation.warehouseSelections.at(-1).warehouse.warehouseId}。选择保留原始来源，不表示店铺绑定已核验。</p>:null}
    {error?<p role="alert">{error}</p>:null}
  </article>;
}

export default function OzonAccountPreparationCard({view,onCreate,onAuthorize,onContinue,onSelectWarehouse}){
  const {saving,error,run}=useSubmit(),[bindingId,setBindingId]=useState(''),[key,setKey]=useState(()=>`account-preparation:${crypto.randomUUID()}`);
  const selected=view.bindings.find(value=>value.bindingId===bindingId);
  function create(event){event.preventDefault();return run(async()=>{
    if(!selected||typeof onCreate!=='function')throw new Error('请先明确选择账户路由。');
    await onCreate({bindingId:selected.bindingId,configurationVersion:selected.configurationVersion,scopeRef:selected.scopeRef,idempotencyKey:key});
  });}
  return <section className="de-software-runtime-card" aria-label="独立账户准备">
    <header><h3>独立账户准备</h3></header>
    <p>可以先准备账户和发现仓库，无需先建立商品或供应 SKU。保存准备不产生读取请求。</p>
    {view.bindings.length===0?<p>尚未配置可选择的账户路由。</p>:<form onSubmit={create}><fieldset disabled={saving}>
      <label>准备的账户路由<select required value={bindingId} onChange={event=>{setBindingId(event.target.value);setKey(`account-preparation:${crypto.randomUUID()}`);}}>
        <option value="">请选择账户，不会自动选择</option>{view.bindings.map(value=><option key={value.bindingId} value={value.bindingId}>{value.storeName}</option>)}
      </select></label>
      {selected?<p>账户编号：{selected.clientId} · 凭据别名：{selected.credentialAlias} · 这是未核实的路由标识。</p>:null}
      <button type="submit" disabled={saving||!selected||typeof onCreate!=='function'}>保存账户准备</button>
    </fieldset></form>}
    {view.preparations.map(item=><Preparation key={`${item.preparation.preparationId}:${item.preparation.revision}:${item.jobs[0]?.jobId??'none'}`} item={item} onAuthorize={onAuthorize} onContinue={onContinue} onSelectWarehouse={onSelectWarehouse}/>)}
    {error?<p role="alert">{error}</p>:null}
    <small>账户读取和仓库选择不授权商品写入；店铺身份、后台价格币种和生产协议仍需独立核验。</small>
  </section>;
}
