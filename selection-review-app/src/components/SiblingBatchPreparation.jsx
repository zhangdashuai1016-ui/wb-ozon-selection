import { useState } from 'react';
import { errorMessage } from '../formState.js';
import { siblingBatchReview } from '../siblingBatchReview.js';
import { siblingBatchAuthorizationInput } from '../siblingBatchAuthorizationInput.js';
import { inForceSkuUniformSupply, capturedSkuWeightKg } from '../../lib/sku-choice-estimate.mjs';

const numberOrNull = value => value === '' ? null : Number(value);

function initialInputs(parent, review) {
  const draft = parent.supplierDraftV1 ?? {};
  const uniform = inForceSkuUniformSupply(parent);
  const basis = uniform?.basisAtDeclaration?.goodsPriceRmb === draft.goodsPriceRmb &&
    uniform?.basisAtDeclaration?.packedWeightKg === draft.packedWeightKg ? uniform : null;
  return { shared: { targetSalePriceRub: draft.targetSalePriceRub ?? '',
    unitDomesticFreight: draft.domesticShippingRmb ?? '', otherPurchaseCosts: '',
    packagingCostRmb: parent.packagingCostRmb ?? '',
    route: parent.lifecycleEvidenceContextV11?.route ?? '', quantityOneEvidenceSourceNote: '',
    dimensionsCm: { length: draft.dimensionsCm?.length ?? '', width: draft.dimensionsCm?.width ?? '',
      height: draft.dimensionsCm?.height ?? '' }, confirmExactSkuSupply: false, confirmSalesReview: false },
  members: Object.fromEntries(review.rows.map(row => {
    const choice = parent.sourceCapture.skuChoices.find(item => item.sourceSkuId === row.sourceSkuId);
    const declared = basis?.sourceSkuIds.includes(row.sourceSkuId);
    return [row.sourceSkuId, { unitProductPrice: choice?.priceCny ?? (declared ? draft.goodsPriceRmb : ''),
      weightKg: capturedSkuWeightKg(choice) ?? (declared ? draft.packedWeightKg : ''),
      targetSalePriceRub: '', merchantSku: '', stock: '' }];
  })) };
}

export default function SiblingBatchPreparation({ parent, siblings, onConfirmA, onConfirmC1, onReadColorDictionary,
  onAuthorize, onUploadAsset, onLinkAsset, onConfirmC2 }) {
  const review = siblingBatchReview(parent, siblings);
  const [draft, setDraft] = useState(() => initialInputs(parent, review));
  const [bindingId, setBindingId] = useState('');
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharedAssetId, setSharedAssetId] = useState('');
  const [c2Confirmed, setC2Confirmed] = useState(false);
  const [c1Confirmed, setC1Confirmed] = useState(false);
  const [rightsExpiresAt, setRightsExpiresAt] = useState('');
  const [colorMappings, setColorMappings] = useState({});
  const [error, setError] = useState('');
  if (!review?.rows.length) return null;
  const allCreated = review.rows.every(row => row.candidateId !== null);
  const allAtA = allCreated && review.rows.every(row => !siblings.find(child => child.id === row.candidateId)?.lifecycleV11?.skuPackage);
  const first = siblings.find(child => child.id === review.rows[0].candidateId);
  const sales = first?.realAConfirmationCard?.salesReview;
  const bindings = first?.productionOwnerPreparation?.executionBindings ?? [];
  const finalInput = siblingBatchAuthorizationInput(parent, siblings, bindingId);
  const c2Rows = review.rows.map(row => ({ row, child: siblings.find(item => item.id === row.candidateId) }));
  const allAtC1 = c2Rows.length > 0 && c2Rows.every(({ child }) =>
    child?.lifecycleV11?.skuPackage?.businessPhase === 'C1' &&
    child.lifecycleV11.skuPackage.c1ProductPlan?.status === 'inputs_ready');
  const dictionarySource = c2Rows.map(({ child }) => child).find(child =>
    child?.lifecycleV11?.c1ColorDictionaryReadsV1?.['10096']?.status === 'succeeded') ?? null;
  const officialColors = dictionarySource?.lifecycleV11?.c1ColorDictionaryReadsV1?.['10096']?.evidence?.values ?? [];
  const allAtC2 = c2Rows.length > 0 && c2Rows.every(({ child }) =>
    child?.lifecycleV11?.skuPackage?.businessPhase === 'C2' &&
    child.lifecycleV11.skuPackage.c2FinalAssets?.status === 'awaiting_final_uploads');
  const firstChild = c2Rows[0]?.child;
  const sharedPool = firstChild?.lifecycleV11?.c2UploadDraft?.uploads?.filter(item => item.status === 'ready' &&
    item.assetId !== firstChild.lifecycleV11.c2UploadDraft.selection?.[0]?.assetId) ?? [];
  function sharedField(key, value) { setDraft(current => ({ ...current,
    shared: { ...current.shared, [key]: value } })); }
  function dimensionField(key, value) { setDraft(current => ({ ...current,
    shared: { ...current.shared, dimensionsCm: { ...current.shared.dimensionsCm, [key]: value } } })); }
  function memberField(id, key, value) { setDraft(current => ({ ...current,
    members: { ...current.members, [id]: { ...current.members[id], [key]: value } } })); }
  async function submitA(event) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      if (!sales || !allAtA || !draft.shared.confirmExactSkuSupply || !draft.shared.confirmSalesReview) {
        throw new Error('整批供应身份、销售快照或主人确认缺失');
      }
      const payload = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
        shared: { targetSalePriceRub: Number(draft.shared.targetSalePriceRub),
          unitDomesticFreight: Number(draft.shared.unitDomesticFreight),
          otherPurchaseCosts: numberOrNull(draft.shared.otherPurchaseCosts), route: draft.shared.route,
          packagingCostRmb: numberOrNull(draft.shared.packagingCostRmb),
          minimumOrderQuantity: 1, quantityOneEvidenceSourceNote: draft.shared.quantityOneEvidenceSourceNote,
          confirmExactSkuSupply: true, confirmSalesReview: true, salesReview: { snapshotId: sales.snapshotId,
            comparability: 'comparable', validityStatus: 'current', confidence: 'limited' },
          dimensionsCm: Object.fromEntries(Object.entries(draft.shared.dimensionsCm).map(([key, value]) => [key, numberOrNull(value)])) },
        members: review.rows.map(row => {
          const child = siblings.find(item => item.id === row.candidateId);
          const values = draft.members[row.sourceSkuId];
          return { candidateId: child.id, candidateRevision: child.dataRevision,
            sourceSkuId: row.sourceSkuId, unitProductPrice: numberOrNull(values.unitProductPrice),
            weightKg: numberOrNull(values.weightKg), targetSalePriceRub: numberOrNull(values.targetSalePriceRub),
            merchantSku: values.merchantSku.trim(), stock: numberOrNull(values.stock) };
        }) };
      await onConfirmA(payload);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function submitFinal(event) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      if (!finalConfirmed || !finalInput.ready) throw new Error(finalInput.reason || '请核对整批最终内容');
      await onAuthorize(finalInput.input);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function readBatchColors() {
    if (!onReadColorDictionary || !allAtC1 || dictionarySource) return;
    setError(''); setSaving(true);
    try { await onReadColorDictionary(c2Rows[0].child); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function submitC1(event) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      if (!allAtC1 || !dictionarySource || !c1Confirmed || !rightsExpiresAt) {
        throw new Error('本批官方颜色字典、素材权利或逐行颜色确认尚未完成');
      }
      const expiresAt = new Date(rightsExpiresAt).toISOString();
      const members = c2Rows.map(({ row, child }) => ({ candidateId: child.id,
        candidateRevision: child.dataRevision, colorMappings: {
          '10096': colorMappings[row.sourceSkuId]?.['10096'] ?? '',
          '10097': (colorMappings[row.sourceSkuId]?.['10097'] ?? '').trim() } }));
      if (members.some(member => !officialColors.some(item => item.value === member.colorMappings['10096']) ||
        !member.colorMappings['10097'])) throw new Error('请逐行选择官方颜色，并填写准确颜色名称');
      await onConfirmC1({ parentCandidateId: parent.id, parentRevision: parent.dataRevision,
        dictionarySourceCandidateId: dictionarySource.id, confirmed: true,
        rightsDeclaration: { brand: { status: 'unbranded', name: null },
          rights: { status: 'verified', basis: 'no_third_party_rights_identified' },
          reviewedAt: new Date().toISOString(), expiresAt }, members });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function uploadFor(child, file, share = false) {
    if (!file || !child || !onUploadAsset) return;
    setError(''); setSaving(true);
    try {
      const draftRevision = child.lifecycleV11?.c2UploadDraft?.revision ?? 0;
      const result = await onUploadAsset(child.id, { dataRevision: child.dataRevision, draftRevision, file });
      if (share) setSharedAssetId(result.asset.assetId);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function applyShared() {
    if (!sharedAssetId || !firstChild || !onLinkAsset) return;
    const sourceAsset = sharedPool.find(asset => asset.assetId === sharedAssetId);
    if (!sourceAsset) { setError('共用图片已变化，请重新选择'); return; }
    setError(''); setSaving(true);
    try {
      for (const { child } of c2Rows.slice(1)) {
        const draft = child.lifecycleV11?.c2UploadDraft;
        if (!draft?.selection?.length) throw new Error(`${child.productName || child.id} 缺少本色主图`);
        if (draft.uploads.some(asset => asset.status === 'ready' && asset.sha256 === sourceAsset.sha256)) continue;
        await onLinkAsset(child.id, { dataRevision: child.dataRevision, draftRevision: draft.revision,
          sourceCandidateId: firstChild.id, sourceDataRevision: firstChild.dataRevision,
          sourceAssetId: sharedAssetId, role: 'gallery_image' });
      }
    } catch (cause) { setError(`${errorMessage(cause)}。已完成的素材引用会保留，请刷新后核对缺项。`); }
    finally { setSaving(false); }
  }
  async function confirmBatchC2() {
    if (!allAtC2 || !c2Confirmed || !onConfirmC2) return;
    setError(''); setSaving(true);
    try {
      await onConfirmC2({ parentCandidateId: parent.id, parentRevision: parent.dataRevision,
        confirmed: true, members: c2Rows.map(({ child }) => ({ candidateId: child.id,
          candidateRevision: child.dataRevision, draftRevision: child.lifecycleV11.c2UploadDraft?.revision ?? 0,
          approvedAssetIds: child.lifecycleV11.c2UploadDraft?.selection?.map(item => item.assetId) ?? [] })) });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  return <section className="product-section" aria-label="同款规格批量准备与确认">
    <h3>整批共用资料与逐行差异</h3>
    {allAtA ? <form onSubmit={submitA}>
      <p>当前销售快照：{sales?.title || '缺少有效快照'}。确认前逐行核对数量 1 单价、打包重量、颜色和商家货号；本批不重读供应页。</p>
      <div className="product-batch-common">
        <label>共用目标成交价 RUB<input required type="number" min="0.01" step="0.01" value={draft.shared.targetSalePriceRub}
          onChange={event => sharedField('targetSalePriceRub', event.target.value)} /></label>
        <label>国内运费 ¥<input required type="number" min="0" step="0.01" value={draft.shared.unitDomesticFreight}
          onChange={event => sharedField('unitDomesticFreight', event.target.value)} /></label>
        <label>其他采购费用 ¥<input required type="number" min="0" step="0.01" value={draft.shared.otherPurchaseCosts}
          onChange={event => sharedField('otherPurchaseCosts', event.target.value)} /></label>
        <label>每单额外操作费 ¥<input required type="number" min="0" step="0.01" value={draft.shared.packagingCostRmb}
          onChange={event => sharedField('packagingCostRmb', event.target.value)} /></label>
        <label>已核对线路<input required value={draft.shared.route} onChange={event => sharedField('route', event.target.value)} /></label>
        {['length', 'width', 'height'].map(key => <label key={key}>包装{({ length: '长', width: '宽', height: '高' })[key]} cm
          <input required type="number" min="0.01" step="0.01" value={draft.shared.dimensionsCm[key]}
            onChange={event => dimensionField(key, event.target.value)} /></label>)}
        <label>各规格一件起订及单价的核对来源<input required maxLength={1000}
          value={draft.shared.quantityOneEvidenceSourceNote}
          onChange={event => sharedField('quantityOneEvidenceSourceNote', event.target.value)} /></label>
      </div>
      <table><thead><tr><th>颜色与供应 SKU</th><th>单价 ¥</th><th>打包重量 kg</th><th>成交价覆盖 RUB</th><th>商家货号</th><th>库存</th></tr></thead>
        <tbody>{review.rows.map(row => { const values = draft.members[row.sourceSkuId]; return <tr key={row.sourceSkuId}>
          <td>{row.color} · {row.sourceSkuId}</td>
          <td><input aria-label={`${row.color} 单价`} required type="number" min="0.01" step="0.01" value={values.unitProductPrice}
            onChange={event => memberField(row.sourceSkuId, 'unitProductPrice', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 重量`} required type="number" min="0.001" step="0.001" value={values.weightKg}
            onChange={event => memberField(row.sourceSkuId, 'weightKg', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 成交价覆盖`} type="number" min="0.01" step="0.01" value={values.targetSalePriceRub}
            onChange={event => memberField(row.sourceSkuId, 'targetSalePriceRub', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 商家货号`} required value={values.merchantSku}
            onChange={event => memberField(row.sourceSkuId, 'merchantSku', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 库存`} required type="number" min="0" step="1" value={values.stock}
            onChange={event => memberField(row.sourceSkuId, 'stock', event.target.value)} /></td>
        </tr>; })}</tbody></table>
      <label><input type="checkbox" checked={draft.shared.confirmExactSkuSupply}
        onChange={event => sharedField('confirmExactSkuSupply', event.target.checked)} />
        我已逐行核对所选规格为精确同款、每个规格一件起订，以及上方价格、重量、包装和来源。</label>
      <label><input type="checkbox" checked={draft.shared.confirmSalesReview}
        onChange={event => sharedField('confirmSalesReview', event.target.checked)} />
        我已核对共用销售快照仍适用且商品可比；它只作为各规格的市场证据。</label>
      <button className="button secondary" type="submit" disabled={saving || !sales ||
        !draft.shared.confirmExactSkuSupply || !draft.shared.confirmSalesReview}>
        {saving ? '正在保存…' : '整批确认供货并分别计算正式利润'}</button>
    </form> : null}
    {allAtC1 ? <form onSubmit={submitC1} aria-label="整批 C1 事实与颜色确认">
      <h4>同页核对官方颜色和共用上架文字</h4>
      <p>先读取一次本批当前类目的官方颜色候选，再按行选择。共用文字只在本行采用的事实完全相同时复用；不一致会整批停下并保留原记录。</p>
      {dictionarySource ? <p role="status">已保存官方颜色候选：{officialColors.length} 个，来源规格 {dictionarySource.id}</p>
        : <button className="button secondary" type="button" disabled={saving || !onReadColorDictionary}
          onClick={readBatchColors}>读取本批官方颜色候选</button>}
      <table><thead><tr><th>供应规格</th><th>官方颜色</th><th>准确颜色名称</th><th>当前缺项</th></tr></thead>
        <tbody>{c2Rows.map(({ row, child }) => {
          const mapping = colorMappings[row.sourceSkuId] ?? {};
          return <tr key={row.sourceSkuId}><td>{row.color} · {row.sourceSkuId}</td>
            <td><select aria-label={`${row.color} 官方颜色`} value={mapping['10096'] ?? ''}
              onChange={event => setColorMappings(current => ({ ...current,
                [row.sourceSkuId]: { ...current[row.sourceSkuId], '10096': event.target.value } }))}>
              <option value="">请选择</option>{officialColors.map(item => <option key={item.dictionaryValueId} value={item.value}>{item.valueZh || item.value}</option>)}
            </select></td>
            <td><input aria-label={`${row.color} 准确颜色名称`} value={mapping['10097'] ?? ''}
              onChange={event => setColorMappings(current => ({ ...current,
                [row.sourceSkuId]: { ...current[row.sourceSkuId], '10097': event.target.value } }))} /></td>
            <td>{child?.lifecycleV11?.skuPackage?.c1ProductPlan?.status === 'inputs_ready'
              ? '待核对本色映射与共用文案事实' : 'C1 输入未就绪'}</td></tr>;
        })}</tbody></table>
      <label>权利核对有效至<input aria-label="权利核对有效至" required type="datetime-local" value={rightsExpiresAt}
        onChange={event => setRightsExpiresAt(event.target.value)} /></label>
      <label><input type="checkbox" checked={c1Confirmed} onChange={event => setC1Confirmed(event.target.checked)} />
        我已核对本批为无第三方品牌权利冲突，逐行官方颜色与准确颜色名称相符，且共用文字仅适用于相同已证实事实。</label>
      <button className="button secondary" type="submit" disabled={saving || !c1Confirmed || !dictionarySource}>
        一次确认本批 C1 差异并进入素材准备</button>
    </form> : null}
    {allCreated && !allAtA ? <form onSubmit={submitFinal}>
      <p>所有规格的 C1 事实、官方颜色属性和 C2 本色最终图通过后，可在此一次核对整批最终内容。</p>
      <label>已核验仓库<select value={bindingId} onChange={event => { setBindingId(event.target.value); setFinalConfirmed(false); }}>
        <option value="">请选择仓库</option>
        {bindings.map(item => <option key={item.bindingId} value={item.bindingId}>{item.warehouseName}</option>)}
      </select></label>
      <label><input type="checkbox" checked={finalConfirmed} disabled={!finalInput.ready}
        onChange={event => setFinalConfirmed(event.target.checked)} />我已核对本批每行商品、价格、库存、仓库、主图和执行范围。</label>
      <button className="button primary" type="submit" disabled={saving || !finalConfirmed || !finalInput.ready}>
        {saving ? '正在保存整批授权…' : '一次确认整批最终内容'}</button>
      {!finalInput.ready ? <p role="status">{finalInput.reason}</p> : null}
    </form> : null}
    {allAtC2 ? <div aria-label="整批最终素材">
      <h4>按颜色上传主图，共用图库只上传一次</h4>
      <p>每个颜色的首图分别确认；同色不同尺码可在已上传素材中建立独立引用。上传只是暂存，最终素材仍需整批核对。</p>
      {c2Rows.map(({ row, child }) => <label key={row.sourceSkuId}>{row.color} 主图
        <input aria-label={`${row.color} 主图文件`} type="file" accept="image/jpeg,image/png,image/webp"
          disabled={saving || Boolean(child.lifecycleV11?.c2UploadDraft?.selection?.length)}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void uploadFor(child, file); }} />
        {child.lifecycleV11?.c2UploadDraft?.selection?.length ? ' 已暂存本色主图' : ' 缺少本色主图'}
      </label>)}
      <label>共用图库文件<input aria-label="共用图库文件" type="file" accept="image/jpeg,image/png,image/webp"
        disabled={saving || !firstChild?.lifecycleV11?.c2UploadDraft?.selection?.length}
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void uploadFor(firstChild, file, true); }} /></label>
      <label>已上传的共用图片<select value={sharedAssetId} onChange={event => setSharedAssetId(event.target.value)}>
        <option value="">请选择共用图库图</option>{sharedPool.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.fileName}</option>)}
      </select></label>
      <button type="button" className="button secondary" disabled={saving || !sharedAssetId ||
        c2Rows.some(({ child }) => !child.lifecycleV11?.c2UploadDraft?.selection?.length)} onClick={applyShared}>
        将共用图片引用到其余规格</button>
      <label><input type="checkbox" checked={c2Confirmed} onChange={event => setC2Confirmed(event.target.checked)} />
        我已核对每个规格的最终素材来源权利、图片顺序和本色主图。</label>
      <button type="button" className="button primary" disabled={saving || !c2Confirmed ||
        c2Rows.some(({ child }) => !child.lifecycleV11?.c2UploadDraft?.selection?.length)} onClick={confirmBatchC2}>
        一次确认整批最终素材并生成各自方案卡</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
