import {useState} from 'react';
import {errorMessage} from '../formState.js';

/** Browser loading is a display prerequisite; the server binds the decision to saved evidence. */
export default function BatchMediaReview({review,onConfirm}){
  const [loaded,setLoaded]=useState({});
  const [checks,setChecks]=useState({content:false,hero:false,order:false});
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const urls=review.pairs.flatMap(pair=>[pair.expected?.previewSrc,pair.observed?.previewSrc]).filter(Boolean);
  const allLoaded=urls.length>0&&urls.every(url=>loaded[url]===true);
  const failed=urls.some(url=>loaded[url]===false);
  const complete=checks.content&&checks.hero&&checks.order;
  async function submit(decision){
    setSaving(true);setError('');
    try{await onConfirm(review.batchId,{scope:review.scope,decision,
      confirmContent:checks.content,confirmHero:checks.hero,confirmOrder:checks.order});}
    catch(cause){setError(errorMessage(cause));}
    finally{setSaving(false);}
  }
  function picture(asset,label){
    if(!asset)return <span>{label}缺少该序号图片</span>;
    return <img src={asset.previewSrc} alt={label} referrerPolicy="no-referrer"
      style={{maxWidth:'100%',maxHeight:280,objectFit:'contain'}}
      onLoad={()=>setLoaded(current=>({...current,[asset.previewSrc]:true}))}
      onError={()=>setLoaded(current=>({...current,[asset.previewSrc]:false}))}/>;
  }
  return <section aria-label={`图片核对 ${review.candidateId}`}>
    <h5>图片核对 · {review.scope?.sourceRecord.offerId??review.candidateId}</h5>
    {review.reasonCode?<p role="status">图片核对未就绪：{review.reasonCode}</p>:null}
    {review.pairs.length?<table><thead><tr><th>顺序</th><th>已批准原图</th><th>平台回读图</th></tr></thead>
      <tbody>{review.pairs.map(pair=><tr key={pair.order}>
        <td>{pair.order===1?'1 · 首图':pair.order}</td>
        <td>{picture(pair.expected,`已批准原图 ${pair.order}`)}</td>
        <td>{picture(pair.observed,`平台回读图 ${pair.order}`)}</td>
      </tr>)}</tbody></table>:null}
    {review.status==='owner_confirmed'?<p>已保存主人核图确认。其他 E 核验结果见上表。</p>:null}
    {review.status==='owner_mismatch'?<p role="status">主人已标记图片不一致，E 验证未通过；本轮不会自动改图或重发。</p>:null}
    {review.canRecordMismatch&&onConfirm?<>
      {!allLoaded?<p role="status">{failed?'图片加载失败，当前不能确认内容。请刷新后重新核对。':'等待两侧图片完整显示。'}</p>:null}
      {[['content','图片内容与批准原图一致'],['hero','首图一致'],['order','图片数量及顺序一致']].map(([key,label])=>
        <label key={key}><input type="checkbox" checked={checks[key]} disabled={saving||!allLoaded||!review.canConfirmMatch}
          onChange={event=>setChecks(current=>({...current,[key]:event.target.checked}))}/>{label}</label>)}
      <button type="button" className="button primary" disabled={saving||!allLoaded||!complete||!review.canConfirmMatch}
        onClick={()=>void submit('matches')}>{saving?'正在保存核图结果…':'确认本款图片匹配'}</button>
      <button type="button" className="button secondary" disabled={saving||!allLoaded}
        onClick={()=>void submit('mismatch')}>图片不一致，停止验证</button>
    </>:null}
    {error?<p role="alert">核图结果未确认保存：{error}</p>:null}
  </section>;
}
