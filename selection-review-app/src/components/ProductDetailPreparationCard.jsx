import { useState } from 'react';
import { errorMessage, safeWebUrl } from '../formState.js';

const labels={ozon_detail:'Ozon 商品详情',supplier_detail:'1688 供应详情'};
const statuses={queued:'等待软件执行',claimed:'正在读取',waiting_platform:'等待查询结果',completed:'详情回执已保存',
  failed:'本次读取失败，已停止',unknown_outcome:'请求结果未知，需核对'};
const newKey=()=>`product-detail:${crypto.randomUUID()}`;

export default function ProductDetailPreparationCard({view,onAuthorize,onContinue}) {
  const [expiresAt,setExpiresAt]=useState(''),[confirmed,setConfirmed]=useState(false),[key,setKey]=useState(newKey);
  const [saving,setSaving]=useState(false),[error,setError]=useState(null);
  const expiry=Date.parse(expiresAt),binding=view.bindings.length===1?view.bindings[0]:null;
  async function run(action,input) {
    if(saving)return;
    setSaving(true);setError(null);
    try{await action(input);setConfirmed(false);}
    catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  return <section className="inspector-section" aria-label="当前商品详情准备">
    <h3>补齐这件商品的详情</h3>
    <p>本轮只读取下面两件商品各 1 次，批准上限 {view.budget.maxCredits} LinkFox 积分。实际扣费待核对；失败或空结果是否扣费尚未确认。</p>
    <ul>{view.proposedReads.map(read=><li key={read.method}>{labels[read.method]}：
      <a href={safeWebUrl(read.productUrl)} target="_blank" rel="noreferrer">{read.productId}</a></li>)}</ul>
    <p>货源按本轮搜索的既定顺序选作核验对象。同款关系和具体供应 SKU 仍由你在下方 A 卡确认。</p>
    {view.runtimeStatus==='not_configured'?<p role="status">详情服务尚未配置，当前不能发起查询。</p>:null}
    {view.runtimeStatus==='failed'?<p role="alert">详情服务因技术异常停止，请核对已保存的作业。</p>:null}
    {view.preparationBlockCode==='ALREADY_AUTHORIZED'?<p>本轮详情许可已保存，请查看各步回执。</p>:
      view.preparationBlockCode&&view.preparationBlockCode!=='ALREADY_APPLIED'?<p role="alert">当前详情准备未就绪：{view.preparationBlockCode}</p>:null}
    {view.canAuthorize&&binding?<>
      <label>本轮详情许可截止时间<input type="datetime-local" value={expiresAt}
        onChange={event=>{setExpiresAt(event.target.value);setConfirmed(false);setKey(newKey());}}/></label>
      <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
        我同意以上两次详情读取及积分上限</label>
      <button type="button" className="button primary" disabled={saving||!confirmed||!Number.isFinite(expiry)||expiry<=Date.now()}
        onClick={()=>run(onAuthorize,{candidateId:view.candidateId,expectedRevision:view.revision,...binding,
          expiresAt:new Date(expiry).toISOString(),idempotencyKey:key})}>批准并读取本轮详情</button>
    </>:null}
    {view.jobs.map(({job,receipt,canContinue})=><div key={job.jobId}>
      <p>{labels[job.scopeBinding.request.method]}：{statuses[job.status]}</p>
      {receipt?.failureClass?<p role="alert">停止原因：{receipt.failureClass}。本次请求不会自动重发。</p>:null}
      {receipt?.steps[0]?.result?.status==='true_empty'?<p>本次详情查询明确返回零结果。</p>:null}
      {canContinue?<button type="button" className="button secondary" disabled={saving}
        onClick={()=>run(onContinue,{candidateId:view.candidateId,expectedRevision:view.revision,jobId:job.jobId})}>执行已批准且尚未发送的详情读取</button>:null}
    </div>)}
    {view.applications.map(application=><p key={application.sourceRevision} role={application.status==='applied'?'status':'alert'}>
      {application.status==='applied'?'两份详情已进入下方 A 确认卡，尚未确认供应 SKU。':`详情回执已保留，更新确认卡未完成：${application.failureClass}`}</p>)}
    {view.lastAdmissionRejection?<p role="alert">作业未执行：{view.lastAdmissionRejection.code}</p>:null}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
