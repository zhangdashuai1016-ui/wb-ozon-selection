import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function SiblingBatchEvidencePreparation({ parent, draft, dirty, scopeKey, onReadiness }) {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(0);
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision, draftRevision: draft?.draftRevision };
  async function read() {
    const token = ++active.current;
    setBusy(true); setError(''); setView(null); onReadiness({ scopeKey, ready: false });
    try {
      const response = await api.getSiblingPreparationEvidence(parent.id, input);
      if (active.current !== token) return;
      setView(response); onReadiness({ scopeKey, ready: response.ready === true });
      if (response.failure) setError(response.failure.message);
    } catch (cause) { if (active.current === token) setError(cause.message); }
    finally { if (active.current === token) setBusy(false); }
  }
  useEffect(() => {
    if (draft && !dirty) void read();
    else { ++active.current; setView(null); setBusy(false); onReadiness({ scopeKey, ready: false }); }
    return () => { ++active.current; };
  }, [scopeKey, dirty]);
  async function prepare() {
    if (busy || dirty || !draft) return;
    const token = ++active.current;
    setBusy(true); setError(''); setView(null); onReadiness({ scopeKey, ready: false });
    try {
      const attempt = await api.prepareSiblingLocalEvidence(parent.id, input);
      if (active.current !== token) return;
      const response = attempt.result === 'failed'
        ? await api.getSiblingPreparationEvidence(parent.id, input)
        : attempt;
      if (active.current !== token) return;
      setView(response); onReadiness({ scopeKey, ready: response.ready === true });
      if (response.failure) setError(response.failure.message);
    } catch (cause) {
      if (active.current === token) setError(`${cause.message}。请先只读核对保存结果。`);
    } finally { if (active.current === token) setBusy(false); }
  }
  return <section aria-label="本批费用证据准备">
    <h4>供货确认前的费用核对</h4>
    <p>{dirty || !draft ? '先保存本批草稿，再核对各规格的费用证据。' : busy ? '正在核对本批费用证据…' :
      error ? '本轮费用状态未核实，请查看错误并只读核对。' :
      view?.ready ? '本批费用证据已备齐，仍待你确认供货后分别计算正式利润。' : '正式利润所需证据尚有缺项。'}</p>
    <p>本地准备只查询已配置的官方费表并复用已保存证据；不会读取店铺、确认供货或上架。</p>
    {view?.members.map(member => <div key={member.candidateId}>
      <strong>{draft?.values.members.find(item => item.candidateId === member.candidateId)?.colorRu ?? member.sourceSkuId}</strong>
      {member.missing.map((gap,index) => <p key={`${gap.field}:${index}`}>{gap.reason}</p>)}
    </div>)}
    <button type="button" disabled={busy || dirty || !draft || view?.localPreparationAvailable !== true} onClick={prepare}>准备本批本地费用证据</button>
    <button type="button" disabled={busy || dirty || !draft} onClick={read}>只读核对费用准备结果</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
