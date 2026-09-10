import { useState } from 'react';
import { STORE_LABELS } from '../constants.js';
import { errorMessage, safeWebUrl } from '../formState.js';

const statusLabels = {queued:'等待软件执行',claimed:'正在读取',waiting_platform:'等待查询结果',completed:'已保存查询结果',
  failed:'本次查询失败，已停止',unknown_outcome:'请求结果未知，需核对'};
const methodLabels = {ozon_market_search:'Ozon 市场搜索',supplier_search:'1688 货源搜索',category_detail:'Seerfar 类目商品查询'};
const configurationLabels = {
  EVIDENCE_UNAVAILABLE:'类目、查询协议或计费的当前来源尚未接入，由维护人员补齐。',
  EVIDENCE_UNVERIFIED:'查询依据尚未核实，暂不能授权执行。',
  EVIDENCE_REVOKED:'查询依据已撤销，已停止后续请求。',
  EVIDENCE_SUPERSEDED:'查询依据已被新版本替代，需核对当前计划。',
  EVIDENCE_NOT_EFFECTIVE:'查询依据尚未生效，暂不能执行。',
  EVIDENCE_EXPIRED:'查询依据已过期，已停止后续请求。',
  EVIDENCE_AMBIGUOUS:'查询依据版本存在冲突，由维护人员修复。',
  EVIDENCE_INVALID:'查询依据与当前范围或费用不一致，由维护人员核对。',
  PLAN_NOT_CONFIGURED:'查询计划尚未配置：维护人员需按已选方向接入准确的次数、范围和计费依据。',
  CONNECTOR_NOT_CONFIGURED:'数据服务尚未接入：维护人员需接入你已选择的服务商，不能自行更换。',
  SERVICE_NOT_CONFIGURED:'查询执行程序尚未配置：这项由维护人员完成。',
  PLAN_NOT_SUPPORTED:'已配置服务不能执行计划中的全部查询：维护人员需核对计划与服务能力。'
};
const newKey = () => `product-discovery:${crypto.randomUUID()}`;
const DEFAULT_PERMIT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Prefilled permit expiry for the datetime-local input: two hours ahead in the viewer's local time, still editable. */
export function defaultPermitExpiryLocal(now = Date.now()) {
  const at = new Date(now + DEFAULT_PERMIT_WINDOW_MS); at.setSeconds(0, 0);
  const pad = value => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function BatchCard({ entry, onAuthorize, onContinue, onSelect, onOpenCandidate }) {
  const {batch,jobs,canAuthorize,candidateImport} = entry;
  const imported = new Map((entry.importedCandidates ?? []).map(value=>[value.marketProductId,value.candidateId]));
  const selections = new Map((entry.selections ?? []).map(value=>[value.marketProductId,value]));
  const [expiresAt,setExpiresAt] = useState(defaultPermitExpiryLocal);
  const [confirmed,setConfirmed] = useState(false);
  const [key,setKey] = useState(newKey);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState(null);
  async function run(action,input) {
    if(saving)return;
    setSaving(true);setError(null);
    try {await action(input);setConfirmed(false);}
    catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  const expiry = Date.parse(expiresAt);
  const seerfar = batch.plan.provider === 'seerfar';
  const marketResult = receipt => seerfar ? receipt?.steps.find(step => step.method === 'category_detail')?.result : receipt?.steps[0]?.result;
  return <article className="inspector-section">
    <h3>{batch.plan.direction} · {STORE_LABELS[batch.targetStore]}</h3>
    <p>最多查询 {batch.plan.budget.maxRequests} 次，批准上限 {batch.plan.budget.maxCredits} {seerfar ? 'Seerfar 点数' : 'LinkFox 积分'}；最多保存 {batch.plan.selection.maxCandidates} 件待核验商品。</p>
    {seerfar ? <p>本轮包含查询前额度、类目商品、查询后额度三次请求；只保存待核验市场材料。</p> : null}
    <p>实际扣费待服务回执核对；失败或空结果是否扣费尚未确认。此计划仅搜索，详情读取需独立许可。</p>
    <ul>{batch.plan.requests.map(request=><li key={request.requestId}>{methodLabels[request.method]}：{seerfar ? `类目 ${request.categoryId}` : request.keywords.join('、')}，最多 {request.pageSize} 条。</li>)}</ul>
    <p>排除方向：{batch.plan.exclusions.join('、')}。具体商品仍需核实，搜索成功不代表供货确认。</p>
    {entry.configurationBlocker==='PLAN_NOT_CONFIGURED'?<p role="alert">该批次的查询配置已变更或移除，已停止新授权和未发送查询；维护人员需核对当前计划。</p>:null}
    {entry.configurationBlocker?.startsWith('EVIDENCE_')?<p role="alert">{configurationLabels[entry.configurationBlocker]}</p>:null}
    {canAuthorize?<>
      <label>本轮查询许可截止时间（已默认 2 小时后，可改）<input type="datetime-local" value={expiresAt} onChange={event=>{setExpiresAt(event.target.value);setConfirmed(false);setKey(newKey());}}/></label>
      <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
        我同意按上面的范围和积分上限执行这一轮搜索</label>
      <button type="button" className="button primary" disabled={saving||!confirmed||!Number.isFinite(expiry)||expiry<=Date.now()}
        onClick={()=>run(onAuthorize,{batchId:batch.batchId,expectedRevision:batch.revision,expiresAt:new Date(expiry).toISOString(),idempotencyKey:key})}>
        {saving?'正在保存查询许可…':'批准并开始本轮搜索'}</button>
    </>:null}
    {jobs.map(({job,receipt,canContinue})=><div key={job.jobId}>
      <p>{methodLabels[job.scopeBinding.request.method]}：{statusLabels[job.status]}</p>
      {receipt?.failureClass?<p role="alert">停止原因：{receipt.failureClass}。本次请求不会自动重发。</p>:null}
      {marketResult(receipt)?.status==='true_empty'?<p>本次查询明确返回零结果。</p>:null}
      {marketResult(receipt)?.products?.length?<details><summary>查看本次发现材料</summary>
        {seerfar ? <p>{marketResult(receipt).schemaVersion === 'seerfar-discovery-market-result-v2'
          ? `服务返回日期窗：${marketResult(receipt).dateRange.startDate ?? '起始日期未知'} 至 ${marketResult(receipt).dateRange.endDate ?? '结束日期未知'}`
          : '旧版回执未保存日期窗及评价字段。'}；类目材料尚未核实同款，不代表核心市场样本。</p> : null}
        <ul>{marketResult(receipt).products.map(product=><li key={product.productId}>
          <a href={safeWebUrl(product.productUrl)} target="_blank" rel="noreferrer">{product.title}</a> · {product.price} {product.currency ?? '币种待核实'}
          {seerfar ? <><br/>服务返回销量（估算）：{product.salesCount ?? '未知'}；评价数：{product.reviewCount ?? '未知'}；评分：{product.reviewRating ?? '未知'}
            <br/>卖家身份未核实
            <details><summary>查看来源证据</summary>
              <p>服务返回卖家原码：{product.rawSellerType ?? '未知'}；未映射为卖家身份。</p>
              <p>来源：{product.providerRecordRef}</p>
            </details></> : null}
          {imported.has(product.productId)?<><br/><span>已在评审台。</span><button type="button" className="button secondary" onClick={()=>onOpenCandidate(imported.get(product.productId))}>查看</button></>
            :selections.get(product.productId)?.status==='all_duplicates'?<><br/><span>该商品已存在于记录（含已淘汰），未重复建卡。</span></>
            :['blocked','failed'].includes(selections.get(product.productId)?.status)?<><br/><span role="alert">保存失败：{selections.get(product.productId).failureClass}</span></>
            :job.status==='completed'&&typeof onSelect==='function'?<><br/><button type="button" className="button secondary" disabled={saving}
              onClick={()=>run(onSelect,{batchId:batch.batchId,expectedRevision:batch.revision,marketProductId:product.productId})}>选这个</button></>:null}
        </li>)}</ul></details>:null}
      {canContinue?<button type="button" className="button secondary" disabled={saving}
        onClick={()=>run(onContinue,{batchId:batch.batchId,expectedRevision:batch.revision,jobId:job.jobId})}>执行已批准且尚未发送的查询</button>:null}
    </div>)}
    {candidateImport?.status==='imported'?<button type="button" className="button primary" onClick={()=>onOpenCandidate(candidateImport.candidateId)}>查看待核验商品</button>:null}
    {candidateImport?.status==='all_duplicates'?<p>本轮结果已存在于记录中，未重复建卡或恢复已淘汰商品。</p>:null}
    {['blocked','failed'].includes(candidateImport?.status)?<p role="alert">查询结果已保留，保存候选未完成：{candidateImport.failureClass}</p>:null}
    {error?<p role="alert">{error}</p>:null}
  </article>;
}

export default function ProductDiscoveryCard({view,onCreate,onAuthorize,onContinue,onSelect,onOpenCandidate}) {
  const [planKey,setPlanKey] = useState('');
  const [targetStore,setTargetStore] = useState('');
  const [key,setKey] = useState(newKey);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState(null);
  const plan = view.plans.find(value=>`${value.planId}:${value.version}`===planKey);
  const route = view.bindings.length===1?view.bindings[0]:null;
  async function create() {
    if(saving||!view.canPrepare||!plan||!route||!view.targetStores.includes(targetStore))return;
    setSaving(true);setError(null);
    try{await onCreate({planId:plan.planId,planVersion:plan.version,targetStore,bindingId:route.bindingId,configurationVersion:route.configurationVersion,idempotencyKey:key});}
    catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  return <section aria-label="软件主动发现商品">
    <h2>软件找商品</h2>
    <p>选择本轮方向，查看查询范围后再批准搜索。商品进入 A 后，准确供货方案仍由你确认。</p>
    {!view.canPrepare?<div role="status">
      <p>当前没有可执行计划。以下是接入事项，不需要你提供商品链接或在聊天中发送密钥。</p>
      <ul>{view.configurationBlockers.map(code=><li key={code}>{configurationLabels[code]}</li>)}</ul>
      <p>接入完成后，仍在本页查看本轮范围和费用，再决定是否开始。配置检查不会读取密钥或查询商品。</p>
    </div>:<>
      <label>本轮方向<select value={planKey} onChange={event=>{setPlanKey(event.target.value);setKey(newKey());}}>
        <option value="">请选择方向</option>{view.plans.map(value=><option key={`${value.planId}:${value.version}`} value={`${value.planId}:${value.version}`}>{value.direction}</option>)}</select></label>
      <label>目标店铺<select value={targetStore} onChange={event=>{setTargetStore(event.target.value);setKey(newKey());}}>
        <option value="">请选择目标店铺</option>
        {view.targetStores.map(store=><option key={store} value={store}>{STORE_LABELS[store]}</option>)}</select></label>
      <button type="button" className="button secondary" disabled={saving||!plan||!route||!view.targetStores.includes(targetStore)} onClick={create}>准备本轮查询范围</button>
      <p>准备查询范围只保存本地计划，不查询商品或扣费。</p>
    </>}
    {error?<p role="alert">{error}</p>:null}
    {view.runtimeStatus==='failed'?<p role="alert">发现服务因技术异常停止，请保留当前批次核对。</p>:null}
    {view.lastAdmissionRejection?<p role="alert">已批准作业未执行：{view.lastAdmissionRejection.code}</p>:null}
    {view.batches.map(entry=><BatchCard key={`${entry.batch.batchId}:${entry.batch.revision}`} entry={entry} onAuthorize={onAuthorize}
      onContinue={onContinue} onSelect={onSelect} onOpenCandidate={onOpenCandidate}/>) }
    {view.hasMore?<p>当前显示最近 100 个批次，更早记录仍被保留。</p>:null}
  </section>;
}
