import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SiblingBatchPreparation from '../../src/components/SiblingBatchPreparation.jsx';
import fixture from './sibling-batch-browser-data.json';

function BrowserFixture() {
  const [siblings, setSiblings] = useState(fixture.siblings);
  const [executionView, setExecutionView] = useState(null);
  const [authorizationInput, setAuthorizationInput] = useState(null);
  const [stockSaveCount, setStockSaveCount] = useState(0);
  const parent = fixture.parent;
  function saveStockDrafts(payload) {
    setSiblings(current => current.map(candidate => {
      const member = payload.members.find(item => item.candidateId === candidate.id);
      if (!member) throw new Error('浏览器夹具成员缺失');
      const next = structuredClone(candidate);
      next.dataRevision += 1;
      next.lifecycleV11.productionCommercialDraftV1.stock = member.stock;
      next.productionOwnerPreparation.commercialDraft.stock = member.stock;
      next.productionOwnerPreparation.scope.stock = member.stock;
      next.productionOwnerPreparation.source.dataRevision = next.dataRevision;
      return next;
    }));
    setStockSaveCount(value => value + 1);
    return Promise.resolve({ members: payload.members });
  }
  function authorize(input) {
    setAuthorizationInput(input);
    setExecutionView({ batchId: 'd-batch:synthetic-browser', status: 'observing', externalRequestState: 'unknown_outcome',
      excludedOfferIds: input.excludedOfferIds,
      members: input.members.map((member, index) => ({ candidateId: member.candidateId,
        offerId: member.ownerInput.merchantSku, importStatus: index === 1 ? 'unknown_outcome' : 'imported',
        importGapCode: index === 1 ? 'synthetic_unknown' : null,
        inventoryStatus: index === 0 ? 'awaiting_prerequisites' : 'not_started', inventoryReason: null,
        eStatus: index === 2 ? 'needs_owner' : 'not_started', eGaps: index === 2 ? ['synthetic_readback_gap'] : [],
        listedVerified: false })) });
    return Promise.resolve({ batch: { members: input.members } });
  }
  return <main><h1>合成三色批次最终确认</h1>
    <p id="stock-save-count">库存草稿保存次数：{stockSaveCount}</p>
    <SiblingBatchPreparation parent={parent} siblings={siblings} onAuthorize={authorize}
      onSaveStockDrafts={saveStockDrafts} executionView={executionView}
      onRefreshExecution={() => Promise.resolve(executionView)} onResumeStock={() => Promise.resolve(executionView)} />
    {authorizationInput ? <pre id="authorized-payload">{JSON.stringify(authorizationInput)}</pre> : null}
  </main>;
}

createRoot(document.getElementById('root')).render(<BrowserFixture />);
