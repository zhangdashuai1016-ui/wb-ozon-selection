import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createMusicBoxCandidate } from './helpers/legacy-candidate-fixture.mjs';

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.ok(![4317, 4318, 4173].includes(port));
  return port;
}

// A still-current synthetic official rate, declared by this test only. The tariff table is deliberately absent, so the
// route must report a missing freight input instead of inventing one.
const FX_PACK = { id: 'evidence:synthetic-fx-supplier-draft', kind: 'exchange_rate', status: 'active',
  scope: { pair: 'RUB/CNY' }, sourceRef: 'cbr-xml-daily:R01375:2026-09-10', sourceType: 'bank_of_russia_official_daily_xml',
  checkedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  evidenceData: { rubPerCny: 12.7373, rateDate: '2026-09-10', nominal: 1, officialValueRub: 12.7373 } };

const draftInput = (dataRevision, extra = {}) => ({ dataRevision,
  sourceUrl: 'https://detail.1688.com/offer/876240928352.html', goodsPriceRmb: 15.9, domesticShippingRmb: 2.96,
  packedWeightKg: 1.3, dimensionsCm: { length: 75, width: 21, height: 4 }, targetSalePriceRub: 1850, ...extra });

test('找货资料接口只接受已登录主人的封闭输入和当前修订号，保存后立刻回报估算', async t => {
  const fixture = await productionOwnerDecisionHttpFixture();
  const candidate = createMusicBoxCandidate();
  delete candidate.lifecycleV11;
  delete candidate.sourceCapture;
  candidate.workflowStatus = 'needs_user_data';
  candidate.storeRef = structuredClone(fixture.binding.storeRef);
  candidate.targetStore = fixture.binding.storeRef.stableStoreId;
  candidate.sourceUrl = '';
  const document = { ...fixture.document, candidates: [candidate], evidencePacks: [structuredClone(FX_PACK)],
    runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [], operationAudit: [], idempotencyRecords: [] } };
  const directory = await mkdtemp(path.join(tmpdir(), 'supplier-draft-api-'));
  const port = await freePort();
  let dependencyPort = await freePort();
  while (port === dependencyPort) dependencyPort = await freePort();
  const closedPort = await freePort();
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    // The declared tariff file does not exist in this isolated run, and the rate URL points at a closed loopback port.
    SELECTION_REVIEW_GUOO_TARIFF_FILE: path.join(directory, 'GUOO-2026.8.19-absent.xlsx'),
    SELECTION_REVIEW_CBR_FX_URL: `http://127.0.0.1:${closedPort}/scripts/XML_daily.asp`,
    SELECTION_REVIEW_A_DISCOVERY_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_DISCOVERY_CREDENTIAL_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_DISCOVERY_PLANS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_A_PRODUCT_DETAIL_CONNECTOR_BINDINGS_JSON: '[]',
    SELECTION_REVIEW_A_PRODUCT_DETAIL_CREDENTIAL_BINDINGS_JSON: '[]' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: fixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const route = `/api/candidates/${candidate.id}/lifecycle/supplier-draft`;

  assert.equal((await api.get(route)).status, 401);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision), { authenticated: false })).status, 401);
  await api.authenticate();

  const bytesBeforeRead = await api.readBytes();
  const empty = await api.get(route);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.schemaVersion, 'supplier-draft-view-v1');
  assert.equal(empty.body.candidateId, candidate.id);
  assert.equal(empty.body.dataRevision, candidate.dataRevision);
  assert.equal(empty.body.supplierDraftV1, null);
  assert.equal(empty.body.supplierDraftEstimateV1, null);
  // This candidate already carries a real page read and no discovery receipt, so the derived projection never runs.
  assert.equal(empty.body.marketSnapshot.snapshotId, candidate.salesSnapshotsV11[0].snapshotId);
  assert.equal(empty.body.marketSnapshot.collectorMode, 'real_page_read_only');
  assert.equal(empty.body.marketSnapshot.source ?? null, null);
  assert.deepEqual(await api.readBytes(), bytesBeforeRead, '只读打开找货不得改写业务数据');

  assert.equal((await api.get(`/api/candidates/candidate:missing/lifecycle/supplier-draft`)).status, 404);
  const extraKey = await api.post(route, { ...draftInput(candidate.dataRevision), ownerSupplyConfirmed: true });
  assert.equal(extraKey.status, 400);
  assert.equal(extraKey.body.code, 'supplier_draft_field_forbidden');
  const badUrl = await api.post(route, draftInput(candidate.dataRevision, { sourceUrl: 'https://item.taobao.com/item.htm?id=1' }));
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.code, 'supplier_draft_source_url_invalid');
  assert.equal((await api.post(route, draftInput(candidate.dataRevision + 1))).status, 409);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api.post(route, draftInput(candidate.dataRevision),
    { headers: { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(await api.readBytes(), bytesBeforeRead, '被拒绝的提交不得写入任何数据');

  const saved = await api.post(route, draftInput(candidate.dataRevision, { note: '卖家说一件可买' }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.dataRevision, candidate.dataRevision + 1);
  const draft = saved.body.supplierDraftV1;
  assert.equal(draft.schemaVersion, 'supplier-draft-v1');
  assert.equal(draft.declaredBy, 'owner');
  assert.equal(draft.provenance, 'owner_declared');
  assert.equal(draft.sourceUrl, 'https://detail.1688.com/offer/876240928352.html');
  assert.equal(draft.offerId, '876240928352');
  assert.equal(draft.allInPurchaseRmb, 18.86);
  assert.equal(draft.targetSalePriceRub, 1850);
  assert.deepEqual(draft.dimensionsCm, { length: 75, width: 21, height: 4 });
  assert.ok(Number.isFinite(Date.parse(draft.declaredAt)));
  const estimate = saved.body.supplierDraftEstimateV1;
  assert.equal(estimate.schemaVersion, 'supplier-draft-estimate-v1');
  assert.equal(estimate.estimate.status, 'incomplete');
  assert.equal(estimate.profitAtDeclaredPurchase, null);
  assert.deepEqual(estimate.estimate.missing, ['官方佣金', '可行物流线路']);
  assert.equal(estimate.routeBlock.code, 'no_feasible_route');
  assert.equal(estimate.inputs.fxSourceRef, FX_PACK.sourceRef);
  assert.equal(estimate.inputs.tariffRuleVersion, null);
  assert.equal(estimate.estimate.fx.rubPerCny, 12.7373);

  const persisted = (await api.readDocument()).candidates[0];
  assert.equal(persisted.dataRevision, candidate.dataRevision + 1);
  assert.deepEqual(persisted.supplierDraftV1, draft);
  // The same declaration also fills the per-field owner columns the older cards read, so nothing regresses.
  assert.equal(persisted.sourceUrl, draft.sourceUrl);
  assert.equal(persisted.purchasePriceRmb, 18.86);
  assert.equal(persisted.domesticShippingRmb, 2.96);
  assert.equal(persisted.packedWeightKg, 1.3);
  assert.deepEqual(persisted.dimensionsCm, { length: 75, width: 21, height: 4 });
  assert.equal(persisted.expectedPriceRub, 1850);
  assert.equal(persisted.supplierDraftEstimateV1.schemaVersion, 'supplier-draft-estimate-v1');
  assert.ok(persisted.history.some(entry => entry.action === 'supplierDraftDeclared'));
  assert.equal(persisted.lifecycleV11 ?? null, null, '保存找货资料不得创建生命周期');

  const stale = await api.post(route, draftInput(candidate.dataRevision));
  assert.equal(stale.status, 409);
  const reread = await api.get(route);
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.body.supplierDraftV1, draft);
  assert.equal(reread.body.supplierDraftEstimateV1.estimate.status, 'incomplete');
  assert.equal(reread.body.candidate.supplierDraftV1.provenance, 'owner_declared');
  await api.assertClean();
});
