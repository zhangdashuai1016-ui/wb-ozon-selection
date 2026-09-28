import { useState } from 'react';
import { errorMessage } from '../formState.js';
import { siblingBatchReview } from '../siblingBatchReview.js';
import { siblingBatchAuthorizationInput } from '../siblingBatchAuthorizationInput.js';
import { siblingMerchantSkuSuggestions, siblingBatchMemberDefaults } from '../siblingBatchFormDefaults.js';
import { inForceSkuUniformSupply, capturedSkuWeightKg } from '../../lib/sku-choice-estimate.mjs';

const numberOrNull = value => value === '' ? null : Number(value);
const executionStatusNames = Object.freeze({ not_started: '未开始', not_sent: '未发送', intent: '已记录发送意图',
  accepted: '请求已受理', imported: '已导入', failed: '明确失败', unknown_outcome: '结果未知，待对账',
  awaiting_prerequisites: '等待库存前置核验', prerequisites_in_flight: '正在核验库存前置条件',
  ready_to_write: '已核验，库存尚未发送', stock_intent: '库存请求结果待观察',
  stock_accepted: '库存请求已受理', inventory_deferred: '按授权暂不写库存',
  needs_owner: '需要主人处理', precheck_failed: '前置核验失败', prewrite_blocked: '已确认未发送，写入前停止',
  succeeded: '已完成', verified: '已独立核验' });
const executionStatusLabel = status => executionStatusNames[status] ?? `未识别状态（${status}）`;

function initialInputs(parent, review, merchantSkus) {
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
  members: Object.fromEntries((review?.rows ?? []).map(row => {
    const choice = parent.sourceCapture.skuChoices.find(item => item.sourceSkuId === row.sourceSkuId);
    const declared = basis?.sourceSkuIds.includes(row.sourceSkuId);
    return [row.sourceSkuId, { unitProductPrice: choice?.priceCny ?? (declared ? draft.goodsPriceRmb : ''),
      weightKg: capturedSkuWeightKg(choice) ?? (declared ? draft.packedWeightKg : ''),
      ...siblingBatchMemberDefaults(row.sourceSkuId, merchantSkus) }];
  })) };
}

export default function SiblingBatchPreparation({ parent, siblings, onConfirmA, onConfirmC1, onPreviewC1, onReadColorDictionary,
  onAuthorize, onSaveStockDrafts, executionView, executionError, executionLoading = false,
  onRefreshExecution, onResumeStock,
  onUploadAsset, onLinkAsset, onConfirmC2 }) {
  const review = siblingBatchReview(parent, siblings);
  let merchantSkuSuggestions;
  let merchantSkuError = '';
  try { merchantSkuSuggestions = siblingMerchantSkuSuggestions(parent, review?.rows ?? []); }
  catch (cause) { merchantSkuError = errorMessage(cause); }
  const [draft, setDraft] = useState(() => initialInputs(parent, review, merchantSkuSuggestions));
  const [bindingId, setBindingId] = useState('');
  const [inventoryAction, setInventoryAction] = useState('');
  const [sharedStock, setSharedStock] = useState('');
  const [stockEdits, setStockEdits] = useState({});
  const [finalConfirmed, setFinalConfirmed] = useState('');
  const [saving, setSaving] = useState(false);
  const [sharedAssetId, setSharedAssetId] = useState('');
  const [c2Confirmed, setC2Confirmed] = useState(false);
  const [c1Confirmed, setC1Confirmed] = useState(false);
  const [rightsExpiresAt, setRightsExpiresAt] = useState('');
  const [colorMappings, setColorMappings] = useState({});
  const [c1Preview, setC1Preview] = useState(null);
  const [error, setError] = useState('');
  if (!review?.rows.length) return null;
  const allCreated = review.rows.every(row => row.candidateId !== null);
  const allAtA = allCreated && review.rows.every(row => !siblings.find(child => child.id === row.candidateId)?.lifecycleV11?.skuPackage);
  const first = siblings.find(child => child.id === review.rows[0].candidateId);
  const sales = first?.realAConfirmationCard?.salesReview;
  const bindings = review.executionBindings;
  const finalInput = siblingBatchAuthorizationInput(parent, siblings, bindingId, { inventoryAction });
  const effectiveStock = row => stockEdits[row.sourceSkuId] ?? (row.stock ?? '');
  const stockDirty = review.rows.some(row => String(effectiveStock(row)) !== String(row.stock ?? ''));
  const validStock = review.rows.every(row => effectiveStock(row) !== '' &&
    Number.isSafeInteger(Number(effectiveStock(row))) && Number(effectiveStock(row)) >= 0);
  const allPricesRub = [...new Set(review.rows.map(row => row.buyerPriceRub))];
  const allPricesCny = [...new Set(review.rows.map(row => row.writePriceCny))];
  const confirmationKey = JSON.stringify({ parentRevision: parent.dataRevision,
    members: review.rows.map(row => { const child = siblings.find(candidate => candidate.id === row.candidateId);
      return [row.sourceSkuId, row.candidateId, child?.dataRevision, child?.lifecycleV11?.skuPackage?.dataRevision,
        row.merchantSku, row.buyerPriceRub, row.writePriceCny, row.stock]; }),
    bindingId, inventoryAction });
  const isFinalConfirmed = finalConfirmed === confirmationKey;
  const c2Rows = review.rows.map(row => ({ row, child: siblings.find(item => item.id === row.candidateId) }));
  const allAtC1 = c2Rows.length > 0 && c2Rows.every(({ child }) =>
    child?.lifecycleV11?.skuPackage?.businessPhase === 'C1' &&
    child.lifecycleV11.skuPackage.c1ProductPlan?.status === 'inputs_ready');
  const dictionarySource = c2Rows.map(({ child }) => child).find(child =>
    child?.lifecycleV11?.c1ColorDictionaryReadsV1?.['10096']?.status === 'succeeded') ?? null;
  const officialColors = dictionarySource?.lifecycleV11?.c1ColorDictionaryReadsV1?.['10096']?.evidence?.values ?? [];
  const c1InputKey = JSON.stringify({ parentRevision: parent.dataRevision, dictionarySourceId: dictionarySource?.id,
    members: c2Rows.map(({ child }) => [child?.id, child?.dataRevision]), colorMappings, rightsExpiresAt });
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
      if (merchantSkuError) throw new Error(merchantSkuError);
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
      if (stockDirty) throw new Error('库存改动尚未保存为本批新版本，请先保存并重新核对。');
      if (executionError) throw new Error('本批历史执行结果未能读取，先恢复读取再确认，避免重复生产。');
      if (executionLoading) throw new Error('正在读取本批历史执行结果，请稍后核对。');
      if (!isFinalConfirmed || !finalInput.ready) throw new Error(finalInput.reason || '请核对整批最终内容');
      await onAuthorize(finalInput.input);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function saveBatchStock() {
    setError(''); setSaving(true);
    try {
      if (!validStock || !stockDirty || !onSaveStockDrafts) throw new Error('本批库存不完整或没有待保存的改动');
      const members = review.rows.map(row => {
        const child = siblings.find(candidate => candidate.id === row.candidateId);
        const sku = child?.lifecycleV11?.skuPackage;
        if (!child || !sku || !row.merchantSku) throw new Error(`${row.color} 的商家货号或规格身份缺失`);
        return { candidateId: child.id, expectedRevision: child.dataRevision,
          skuPackageId: sku.skuPackageId, merchantSku: row.merchantSku, stock: Number(effectiveStock(row)) };
      });
      await onSaveStockDrafts({ parentCandidateId: parent.id, parentRevision: parent.dataRevision, members });
      setFinalConfirmed('');
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
  async function previewC1() {
    setError(''); setSaving(true);
    try {
      if (!allAtC1 || !dictionarySource || !rightsExpiresAt) {
        throw new Error('本批官方颜色字典、素材权利或逐行颜色确认尚未完成');
      }
      const expiresAt = new Date(rightsExpiresAt).toISOString();
      const members = c2Rows.map(({ row, child }) => ({ candidateId: child.id,
        candidateRevision: child.dataRevision, colorMappings: {
          '10096': colorMappings[row.sourceSkuId]?.['10096'] ?? '',
          '10097': (colorMappings[row.sourceSkuId]?.['10097'] ?? '').trim() } }));
      const missingSupplier = c2Rows.find(({ child }) => !child?.sourceCapture?.skuChoices?.[0]?.attributes?.颜色);
      if (missingSupplier) throw new Error(`${missingSupplier.row.sourceSkuId} 缺少已确认供应原色；先修订 A 阶段供应事实，再在本页重预览`);
      const missingOfficial = members.find(member => !officialColors.some(item => item.value === member.colorMappings['10096']));
      if (missingOfficial) throw new Error(`${missingOfficial.candidateId} 缺少 10096 官方颜色；请在本页逐行选择`);
      const missingName = members.find(member => !member.colorMappings['10097']);
      if (missingName) throw new Error(`${missingName.candidateId} 缺少 10097 准确颜色名称；请在本页填写`);
      const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision,
        dictionarySourceCandidateId: dictionarySource.id,
        rightsDeclaration: { brand: { status: 'unbranded', name: null },
          rights: { status: 'verified', basis: 'no_third_party_rights_identified' },
          reviewedAt: new Date().toISOString(), expiresAt }, members };
      const result = await onPreviewC1(input);
      setC1Preview({ input, result, key: c1InputKey });
      setC1Confirmed(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function submitC1(event) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      if (!c1Confirmed || !c1Preview || c1Preview.key !== c1InputKey) {
        throw new Error('本批预览已变化，请重新预览并核对');
      }
      await onConfirmC1({ ...c1Preview.input, confirmed: true,
        previewFingerprint: c1Preview.result.previewFingerprint });
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
      <p>商家货号建议只适用于首件已冻结的 Ozon／1688 同族货号规则，可逐行修改；尚未核验 Ozon 平台是否占用。库存初始填写 100，仅是待确认草稿，不代表授权或已写入平台。</p>
      {merchantSkuError ? <p role="alert">{merchantSkuError}</p> : null}
      <table><thead><tr><th>颜色与供应 SKU</th><th>单价 ¥</th><th>打包重量 kg</th><th>本规格目标成交价 RUB（不同于共用价时填写）</th><th>商家货号</th><th>库存</th></tr></thead>
        <tbody>{review.rows.map(row => { const values = draft.members[row.sourceSkuId]; return <tr key={row.sourceSkuId}>
          <td>{row.color} · {row.sourceSkuId}</td>
          <td><input aria-label={`${row.color} 单价`} required type="number" min="0.01" step="0.01" value={values.unitProductPrice}
            onChange={event => memberField(row.sourceSkuId, 'unitProductPrice', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 重量`} required type="number" min="0.001" step="0.001" value={values.weightKg}
            onChange={event => memberField(row.sourceSkuId, 'weightKg', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 本规格目标成交价`} type="number" min="0.01" step="0.01" value={values.targetSalePriceRub}
            onChange={event => memberField(row.sourceSkuId, 'targetSalePriceRub', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 商家货号`} required value={values.merchantSku}
            onChange={event => memberField(row.sourceSkuId, 'merchantSku', event.target.value)} /></td>
          <td><input aria-label={`${row.color} 库存`} required type="number" min="0" step="1" value={values.stock}
            onChange={event => memberField(row.sourceSkuId, 'stock', event.target.value)} /></td>
        </tr>; })}</tbody></table>
      <p>本规格目标成交价留空时沿用上方共用目标成交价。</p>
      <label className="sibling-batch-confirmation"><input type="checkbox" checked={draft.shared.confirmExactSkuSupply}
        onChange={event => sharedField('confirmExactSkuSupply', event.target.checked)} />
        我已逐行核对所选规格为精确同款、每个规格一件起订，以及上方价格、重量、包装和来源。</label>
      <label className="sibling-batch-confirmation"><input type="checkbox" checked={draft.shared.confirmSalesReview}
        onChange={event => sharedField('confirmSalesReview', event.target.checked)} />
        我已核对共用销售快照仍适用且商品可比；它只作为各规格的市场证据。</label>
      <button className="button secondary" type="submit" disabled={saving || !sales || Boolean(merchantSkuError) ||
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
            <td>{!child?.sourceCapture?.skuChoices?.[0]?.attributes?.颜色
              ? '供应原色缺失；须先修订 A 阶段供应事实'
              : child?.lifecycleV11?.skuPackage?.c1ProductPlan?.status !== 'inputs_ready'
                ? 'C1 输入未就绪'
                : !dictionarySource ? '10096 官方候选尚未读取'
                  : !mapping['10096'] ? '10096 官方颜色未选'
                    : !mapping['10097']?.trim() ? '10097 准确颜色名称未填'
                      : '可预览本色属性和共用文案'}</td></tr>;
        })}</tbody></table>
      <label>权利核对有效至<input aria-label="权利核对有效至" required type="datetime-local" value={rightsExpiresAt}
        onChange={event => setRightsExpiresAt(event.target.value)} /></label>
      <button className="button secondary" type="button" disabled={saving || !dictionarySource || !onPreviewC1}
        onClick={previewC1}>预览整批俄语文案与逐规格差异</button>
      {c1Preview?.key === c1InputKey ? <section aria-label="整批 C1 文案预览">
        <p>共用文案沿用首件已确认的共同事实与文字，仅移除首件颜色片段及其关键词和事实引用；颜色仍逐规格保存为属性。预览不调用模型或外部平台。</p>
        {c1Preview.result.members.map(member => <article key={member.candidateId}>
          <h5>{member.color} · {member.sourceSkuId}</h5>
          <p>俄语标题：{member.content.seoTitleDraft.text}</p>
          <p>中文标题复核：{member.content.seoTitleDraft.reviewZh ?? '来源未提供中文复核文字'}</p>
          <p>俄语描述：{member.content.descriptionDraft.text}</p>
          <p>中文描述复核：{member.content.descriptionDraft.reviewZh ?? '来源未提供中文复核文字'}</p>
          <p>俄语要点：{member.content.bulletPointsDraft.map(piece => piece.text).join('；')}</p>
          <p>中文要点复核：{member.content.bulletPointsDraft.map(piece => piece.reviewZh ?? '来源未提供中文复核文字').join('；')}</p>
          <p>搜索词：{member.content.searchKeywordsDraft.keywords.map(piece => piece.query).join('；')}</p>
          <p>中文搜索词复核：{member.content.searchKeywordsDraft.keywords.map(piece => piece.reviewZh ?? '来源未提供中文复核文字').join('；')}</p>
          <p>共用俄语属性：{member.content.russianAttributes.map(item => `${item.valueRu}（${item.reviewZh}）`).join('；') || '无'}</p>
          <p>中文差异说明：{member.differences.title ? '标题移除了首件颜色文字；' : '标题沿用首件已确认事实；'}
            {member.differences.description ? '描述移除了首件颜色文字；' : '描述沿用首件已确认事实；'}
            移除颜色专属关键词 {member.differences.removedKeywords.length} 个；本色官方颜色与准确名称单独保留。</p>
          <p>来源：{member.sourceCandidateId} 修订 {member.sourceCandidateRevision}；本规格修订 {member.candidateRevision}；采用事实：{member.adoptedFactPaths.join('、')}</p>
        </article>)}
      </section> : null}
      <label><input type="checkbox" checked={c1Confirmed} disabled={c1Preview?.key !== c1InputKey}
        onChange={event => setC1Confirmed(event.target.checked)} />
        我已核对本批为无第三方品牌权利冲突，逐行官方颜色与准确颜色名称相符，并核对预览中的俄语文案与中文差异说明。</label>
      <button className="button secondary" type="submit" disabled={saving || !c1Confirmed || c1Preview?.key !== c1InputKey}>
        一次确认本批 C1 差异并进入素材准备</button>
    </form> : null}
    {allCreated && !allAtA && !executionView ? <form onSubmit={submitFinal}>
      <h4>整批最终清单</h4>
      <p>逐行核对正式 B 价格、商家货号、库存、C1 与 C2 缺项。共用目标价：{allPricesRub.length === 1 && allPricesRub[0] !== null ? `${allPricesRub[0]} RUB` : '逐行不同或缺失'}；共用后台价：{allPricesCny.length === 1 && allPricesCny[0] !== null ? `${allPricesCny[0]} CNY` : '逐行不同或缺失'}。价格逐行覆盖已在 A/B 版本化利润流程完成；如需改价，须重新完成正式利润与最终卡。</p>
      <label>批量库存<input aria-label="批量库存" type="number" min="0" step="1" value={sharedStock}
        onChange={event => { const value = event.target.value; setSharedStock(value);
          setStockEdits(Object.fromEntries(review.rows.map(row => [row.sourceSkuId, value])));
          setFinalConfirmed(''); }} /></label>
      <table><thead><tr><th>颜色与供应 SKU</th><th>商家货号</th><th>买家目标价 RUB</th><th>后台写入价 CNY</th><th>库存调整</th><th>本行缺项</th></tr></thead>
        <tbody>{review.rows.map(row => <tr key={row.sourceSkuId}>
          <td>{row.color} · {row.sourceSkuId}</td><td>{row.merchantSku ?? '待填写商家货号'}</td>
          <td>{row.buyerPriceRub ?? '缺失'} RUB</td><td>{row.writePriceCny ?? '缺失'} CNY</td>
          <td><input aria-label={`${row.color} 库存调整`} type="number" min="0" step="1"
            value={effectiveStock(row)} onChange={event => { setStockEdits(current => ({ ...current,
              [row.sourceSkuId]: event.target.value })); setFinalConfirmed(''); }} /></td>
          <td>{row.gaps.length ? row.gaps.join('；') : '无缺项'}</td>
        </tr>)}</tbody></table>
      <button type="button" className="button secondary" disabled={saving || !stockDirty || !validStock || !onSaveStockDrafts}
        onClick={saveBatchStock}>保存本批库存新版本</button>
      {stockDirty ? <p role="status">库存改动尚未保存，保存后请重新核对当前版本。</p> : null}
      <label>已核验仓库<select value={bindingId} onChange={event => { setBindingId(event.target.value); setFinalConfirmed(''); }}>
        <option value="">请选择本批共同仓库</option>
        {bindings.map(item => <option key={`${item.bindingId}:${item.configurationVersion}`} value={item.bindingId}>{item.warehouseName}</option>)}
      </select></label>
      <fieldset><legend>导入后库存动作</legend>
        <label><input type="radio" name="batch-inventory-action" checked={inventoryAction === 'create_only'}
          onChange={() => { setInventoryAction('create_only'); setFinalConfirmed(''); }} />仅创建商品</label>
        <label><input type="radio" name="batch-inventory-action" checked={inventoryAction === 'write_authorized_stock'}
          onChange={() => { setInventoryAction('write_authorized_stock'); setFinalConfirmed(''); }} />写入已授权库存</label>
      </fieldset>
      <p>全成员 E 独立回读范围：{review.rows.map(row => row.merchantSku ?? `${row.color} 货号缺失`).join('、')}。首件历史导入不在本批范围。</p>
      <label><input type="checkbox" checked={isFinalConfirmed} disabled={!finalInput.ready || stockDirty || Boolean(executionError) || executionLoading}
        onChange={event => setFinalConfirmed(event.target.checked ? confirmationKey : '')} />我已核对本批全部规格的商品、RUB 买家价、CNY 写入价、库存、共同仓库、最终图及导入后动作，一次确认全部成员。</label>
      <button className="button primary" type="submit" disabled={saving || stockDirty || Boolean(executionError) || executionLoading || !isFinalConfirmed || !finalInput.ready}>
        {saving ? '正在保存整批授权…' : '一次确认整批最终内容'}</button>
      {!finalInput.ready ? <p role="status">{finalInput.reason}</p> : null}
      {executionLoading ? <p role="status">正在核对本批是否已有生产记录。</p> : null}
    </form> : null}
    {executionView ? <section aria-label="本批逐项执行结果">
      <h4>本批逐项执行结果</h4><p>批次：{executionView.batchId} · 请求状态：{executionStatusLabel(executionView.externalRequestState)}。以下为软件记录，是否上架以 E 独立回读为准。</p>
      <p>本批排除的历史首件：{executionView.excludedOfferIds?.join('、') || '无'}</p>
      <table><thead><tr><th>商家货号</th><th>建卡导入</th><th>库存</th><th>E 回读</th><th>结果与卡点</th></tr></thead>
        <tbody>{executionView.members.map(member => <tr key={member.candidateId}>
          <td>{member.offerId}</td><td>{executionStatusLabel(member.importStatus)}</td><td>{executionStatusLabel(member.inventoryStatus)}</td>
          <td>{executionStatusLabel(member.eStatus)}</td><td>{member.importGapCode || member.inventoryReason || member.eGaps?.map(gap =>
            typeof gap === 'string' ? gap : gap.message || gap.code).join('；') ||
            (member.listedVerified ? 'E 已独立核验上架' : '尚未独立确认上架')}</td>
        </tr>)}</tbody></table>
      <button type="button" className="button secondary" disabled={saving || !onRefreshExecution}
        onClick={async () => { setError(''); setSaving(true); try { await onRefreshExecution(executionView.batchId); }
          catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); } }}>刷新逐项结果</button>
      {executionView.members.some(member => ['awaiting_prerequisites', 'ready_to_write'].includes(member.inventoryStatus)) && onResumeStock ?
        <button type="button" className="button secondary" disabled={saving}
          onClick={async () => { setError(''); setSaving(true); try { await onResumeStock(executionView.batchId); }
            catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); } }}>
          恢复明确未发送的库存续作</button> : null}
    </section> : null}
    {executionError ? <p role="alert">本批执行结果读取失败：{executionError}</p> : null}
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
