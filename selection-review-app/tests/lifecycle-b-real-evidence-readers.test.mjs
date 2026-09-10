import { fileURLToPath } from 'node:url';
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { readCurrentGuooTariff, selectGuooTariffRow } from "../lib/guoo-tariff-reader.mjs";
import { createLifecycleBRealEvidenceProviderRegistry, createLifecycleBRealEvidenceReaders } from "../lib/lifecycle-b-real-evidence-readers.mjs";
import { readCurrentCbrExchangeRate } from "../lib/official-fx-reader.mjs";

const fixedNow = () => new Date("2026-08-18T08:00:00.000Z");

test("上游未证明完整店铺身份时拒绝；Schema缓存隔离映射和规则版本", async () => {
  const originalScope = { platform: "ozon", store: "dandanshu", storeRef: SYNTHETIC_STORE_REF, category: "shelf", ruleVersion: "v1" };
  for (const mutate of [
    value => { delete value.storeRef; },
    value => { value.storeRef.platformStoreId = "another"; },
    value => { value.storeRef.mappingVersion = "another"; }
  ]) {
    let calls = 0;
    const observed = structuredClone(originalScope); mutate(observed);
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
      fetchImpl: async () => { calls += 1; return httpJson({ ok: true, evidence: { current: true, scope: observed } }); } });
    await assert.rejects(() => registry.schema(request("schema", originalScope)), /STORE_SCOPE_UNPROVEN/);
    assert.equal(calls, 1);
  }
  const requests = [];
  const expected = [originalScope, { ...originalScope, storeRef: { ...SYNTHETIC_STORE_REF, mappingVersion: "v2" } }, { ...originalScope, ruleVersion: "v2" }];
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async (_url, options) => {
      const scope = expected[requests.length]; requests.push(JSON.parse(options.body));
      return httpJson({ ok: true, evidence: { current: true, scope, sourceType: "synthetic", sourceRef: `schema:synthetic:${requests.length}`,
        checkedAt: fixedNow().toISOString(), expiresAt: "2026-08-19T08:00:00.000Z", evidenceData: { schemaRevision: scope.ruleVersion, requiredFields: [] } } });
    } });
  for (const scope of expected) await registry.schema(request("schema", scope));
  await registry.schema(request("schema", originalScope));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(value => value.storeRef), expected.map(value => value.storeRef));
  assert.deepEqual(requests.map(value => value.ruleVersion), ["v1", "v1", "v2"]);
});

function request(kind, scope) {
  return {
    requestVersion: "lifecycle-b-evidence-preparation-v1.1",
    candidateId: "TEST-001",
    candidateRevision: 1,
    kind,
    scope,
    relatedSchemaScope: kind === "commission" ? { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: scope.category, ruleVersion: "ozon-current" } : null,
    maximumAttempts: 1,
    readOnly: true,
    platformWritesAllowed: false,
    requestedAt: "2026-08-18T08:00:00.000Z",
  };
}

function httpJson(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(String(body)),
  };
}

test("GUOO row selection matches one exact route and keeps the tariff cells", () => {
  const rows = [];
  rows[15] = { 2: "Small\n(小件)", 3: "GUOO Express Small PUDO\nGUOO Express Small Courier", 4: "空运", 6: "50.5元/千克+17.97元/票", 7: "0.001-2KG", 8: "1501-7000₽", 9: "三边之和不超150CM，单边不超60CM", 11: 50.5, 12: 17.97 };
  rows[17] = { 2: "Small\n(小件)", 7: "0.001-2KG", 8: "1501-7000₽", 9: "三边之和不超150CM，单边不超60CM", 3: "GUOO Economy Small PUDO\nGUOO Economy Small Courier", 4: "陆运", 6: "28.1元/千克+17.97元/票", 11: 28.1, 12: 17.97 };
  const selected = selectGuooTariffRow(rows, "GUOO Economy Small");
  assert.equal(selected.rowNumber, 17);
  assert.equal(selected.productType, "Small\n(小件)");
  assert.equal(selected.weightLimit, "0.001-2KG");
  assert.equal(selected.declaredValueLimit, "1501-7000₽");
  assert.equal(selected.sizeLimit, "三边之和不超150CM，单边不超60CM");
  assert.equal(selected.row[11], 28.1);
});

test("GUOO reader parses the exact current xlsx row without inventing a rounding step", async () => {
  const workbook = `<workbook xmlns:r="x"><sheets><sheet name="GUOO realFBS资费试算表" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relations = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  const strings = `<sst><si><t>Small&#10;(小件)</t></si><si><t>GUOO Express Small PUDO&#10;(特快轻小件到点)&#10;GUOO Express Small Courier&#10;(特快轻小件到门)</t></si><si><t>空运</t></si><si><t>0.001-2KG</t></si><si><t>GUOO Standard Small PUDO&#10;(标准轻小件到点)&#10;GUOO Standard Small Courier&#10;(标准轻小件到门)</t></si><si><t>GUOO Economy Small PUDO&#10;(经济轻小件到点)&#10;GUOO Economy Small Courier&#10;(经济轻小件到门)</t></si><si><t>陆运</t></si><si><t>可以运输内部装有电池的物品</t></si></sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="15"><c r="A15"/><c r="B15" t="s"><v>0</v></c><c r="C15" t="s"><v>1</v></c><c r="D15" t="s"><v>2</v></c><c r="G15" t="s"><v>3</v></c></row>
    <row r="16"><c r="A16"/><c r="B16"/><c r="C16" t="s"><v>4</v></c><c r="G16"/></row>
    <row r="17"><c r="A17"/><c r="B17"/><c r="C17" t="s"><v>5</v></c><c r="D17" t="s"><v>6</v></c><c r="G17"/><c r="J17" t="s"><v>7</v></c><c r="K17"><v>28.1</v></c><c r="L17"><v>17.97</v></c></row>
  </sheetData><mergeCells><mergeCell ref="B15:B17"/><mergeCell ref="G15:G17"/></mergeCells></worksheet>`;
  const execFileImpl = async (_command, args) => {
    if (args[0] === "-Z1") return { stdout: "xl/workbook.xml\nxl/_rels/workbook.xml.rels\nxl/sharedStrings.xml\nxl/worksheets/sheet1.xml\n" };
    const entry = args.at(-1);
    if (entry === "xl/workbook.xml") return { stdout: workbook };
    if (entry === "xl/_rels/workbook.xml.rels") return { stdout: relations };
    if (entry === "xl/sharedStrings.xml") return { stdout: strings };
    if (entry === "xl/worksheets/sheet1.xml") return { stdout: sheet };
    throw new Error(`unexpected ${entry}`);
  };
  const result = await readCurrentGuooTariff({
    scope: { route: "GUOO Economy Small", ruleVersion: "guoo-2026-07-20" },
    filePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx",
    execFileImpl,
    readFileImpl: async () => Buffer.from("fixture-xlsx"),
    now: fixedNow,
  });
  assert.equal(result.evidenceData.perKgRmb, 28.1);
  assert.equal(result.current, false);
  assert.equal(result.reasonCode, "guoo_settlement_rules_unverified");
  assert.equal(result.evidenceData.calculationRuleStatus, "legacy_unverified");
  assert.equal(result.evidenceData.perParcelRmb, 17.97);
  assert.equal(result.evidenceData.weightRoundingRule, "none");
  assert.equal(result.evidenceData.weightRoundingKg, null);
  assert.equal(result.evidenceData.batteryTransportRule, "可以运输内部装有电池的物品");
});

test("CBR reader returns current official RUB/CNY and stops on another pair", async () => {
  const xml = `<?xml version="1.0"?><ValCurs Date="18.08.2026"><Valute ID="R01375"><Nominal>1</Nominal><Value>12,3456</Value></Valute></ValCurs>`;
  const result = await readCurrentCbrExchangeRate({
    scope: { pair: "RUB/CNY" },
    fetchImpl: async () => httpJson(xml),
    now: fixedNow,
  });
  assert.equal(result.evidenceData.rubPerCny, 12.3456);
  assert.equal(result.evidenceData.rateDate, "2026-08-18");
  await assert.rejects(() => readCurrentCbrExchangeRate({
    scope: { pair: "USD/CNY" },
    fetchImpl: async () => { throw new Error("must not call"); },
  }), /CBR_FX_PAIR_UNSUPPORTED/);
});

test("real provider registry preserves commission source without embedding SKU costs", async () => {
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options?.body || null });
      if (url.startsWith("http://127.0.0.1:4173")) return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon:17028665:92935", salesScheme: "rfbs" },
          sourceType: "ozon_seller_api_same_type_commission",
          sourceRef: "ozon-seller-api:/v5/product/info/prices:17028665:92935:rfbs",
          checkedAt: "2026-08-18T08:00:00.000Z",
          expiresAt: "2026-08-19T08:00:00.000Z",
          evidenceData: { commissionRate: 0.14 },
        },
      });
      throw new Error(`unexpected ${url}`);
    },
  });
  const pack = await registry.commission(request("commission", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon:17028665:92935",
    salesScheme: "rfbs",
  }));
  assert.equal(pack.evidenceData.commissionRate, 0.14);
  assert.equal(Object.hasOwn(pack.evidenceData, "otherCosts"), false);
  assert.equal(pack.sourceType, "ozon_seller_api_same_type_commission");
  assert.equal(pack.sourceRef, "ozon-seller-api:/v5/product/info/prices:17028665:92935:rfbs");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).match(/Api-Key|token|cookie/i), null);
});

test("owner-authorized estimate resolves the exact category once after explicit exact unavailability", async () => {
  const calls = [];
  const estimateScope = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon-competitor:4403916892", salesScheme: "rfbs" };
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    commissionEstimate: {
      authorized: true,
      confirmedBy: "owner",
      commissionRate: 0.2,
      authorizationRef: "owner-a-confirmation:commission-estimate:TEST-001",
      candidateId: "TEST-001", candidateRevision: 1, scope: estimateScope,
    },
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (calls.at(-1).body.kind === "commission") return httpJson({ ok: true, evidence: {
        status: "data_unavailable", current: false, reasonCode: "exact_commission_unavailable", scope: estimateScope,
        sourceType: "synthetic", sourceRef: "source:commission-unavailable", checkedAt: fixedNow().toISOString(), evidenceData: {}
      } });
      return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "ozon-competitor:4403916892", ruleVersion: "ozon-current" },
          sourceType: "ozon_seller_api_current_schema",
          sourceRef: "ozon-seller-api:/v1/description-category/attribute:17030000:90000",
          checkedAt: "2026-08-18T08:00:00.000Z",
          expiresAt: "2026-08-19T08:00:00.000Z",
          evidenceData: {
            schemaRevision: "ozon-schema-test",
            requiredFields: [],
            descriptionCategoryId: 17030000,
            typeId: 90000,
          },
        },
      });
    },
  });
  const commission = await registry.commission(request("commission", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon-competitor:4403916892",
    salesScheme: "rfbs",
  }));
  const schema = await registry.schema(request("schema", {
    platform: "ozon",
    store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF),
    category: "ozon-competitor:4403916892",
    ruleVersion: "ozon-current",
  }));
  assert.equal(commission.evidenceData.commissionRate, 0.2);
  assert.equal(commission.evidenceData.commissionEvidenceMode, "estimated");
  assert.equal(Object.hasOwn(commission.evidenceData, "otherCosts"), false);
  assert.equal(commission.evidenceData.estimateAuthorized, true);
  assert.deepEqual(commission.evidenceData.commissionEstimateAuthorization, {
    schemaVersion: "commission-estimate-authorization-v1", candidateId: "TEST-001", candidateRevision: 1,
    authorizationRef: "owner-a-confirmation:commission-estimate:TEST-001", commissionRate: 0.2,
  });
  assert.equal(commission.evidenceData.exactCommissionRequiredAtC, true);
  assert.equal(commission.evidenceData.descriptionCategoryId, 17030000);
  assert.equal(schema.evidenceData.typeId, 90000);
  assert.equal(calls.length, 2, "one exact query and one cached schema query");
  assert.deepEqual(calls.map(value => value.body.kind), ["commission", "schema"]);
});

test("commission estimate is rejected without an exact owner authorization", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({
    commissionEstimate: { authorized: false, commissionRate: 0.2 },
  }), /B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED/);
});

test("real provider registry rejects misplaced legacy SKU costs", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({ otherCosts: {} }), /B_EVIDENCE_COST_POLICY_MISPLACED/);
});

test("估算佣金关联的Schema必须同平台、完整店铺与类目，读取前拒绝错绑", async () => {
  const scope = { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "shelf", salesScheme: "rfbs" };
  for (const change of [
    value => { value.platform = "wb"; }, value => { value.store = "miska"; value.storeRef.stableStoreId = "miska"; },
    value => { value.storeRef.platformStoreId = "another"; }, value => { value.storeRef.mappingVersion = "another"; },
    value => { value.category = "another"; }, value => { value.kind = "commission"; }
  ]) {
    let calls = 0;
    const input = request("commission", structuredClone(scope)); change(input.relatedSchemaScope);
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: "http://127.0.0.1:4173",
      commissionEstimate: { authorized: true, confirmedBy: "owner", commissionRate: 0.2, authorizationRef: "owner-estimate:synthetic" },
      fetchImpl: async () => { calls += 1; throw new Error("must not read"); } });
    await assert.rejects(() => registry.commission(input), /SCOPE_INVALID/);
    assert.equal(calls, 0);
  }
});

test('explicit connector failure cannot be relabelled as exact commission evidence', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const status of ['system_error', 'permission_required', 'unknown', 'success']) {
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      fetchImpl: async () => httpJson({ ok: true, evidence: { status, current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic',
        checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } } }) });
    await assert.rejects(registry.commission(request('commission', scope)), /OZON_LOCAL_EVIDENCE_STATUS_INVALID/);
  }
});

test('valid exact commission wins over an optional estimate without a schema call', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic', effectiveFrom: '2026-08-16T08:00:00.000Z', effectiveTo: '2026-08-17T08:00:00.000Z' },
    fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind);return httpJson({ ok: true, evidence: {
      current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic', checkedAt: fixedNow().toISOString(),
      expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } } }); } });
  const pack = await registry.commission(request('commission', scope));
  assert.equal(pack.evidenceData.commissionRate, 0.14); assert.equal(pack.evidenceData.commissionEvidenceMode, 'exact');
  assert.deepEqual(calls, ['commission']);
});


test('only an exact unavailable receipt and matching estimate scope permit conditional evidence', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  const unavailable = { status: 'data_unavailable', current: false, reasonCode: 'exact_commission_unavailable', scope,
    sourceType: 'synthetic', sourceRef: 'source:unavailable', checkedAt: fixedNow().toISOString(), evidenceData: {} };
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope };
  for (const mutate of [
    value => { value.evidence.current = true; },
    value => { value.evidence.reasonCode = 'system_error'; },
    value => { value.evidence.evidenceData.commissionRate = 0.1; },
    value => { value.evidence.checkedAt = '2026-08-17T08:00:00.000Z'; },
    value => { value.evidence.scope.category = 'other'; },
    value => { value.estimate.candidateId = 'OTHER'; },
    value => { value.estimate.candidateRevision = 2; },
    value => { value.estimate.scope.category = 'other'; },
    value => { delete value.estimate.scope; },
    value => { value.estimate.effectiveFrom = '2026-08-16T08:00:00.000Z'; value.estimate.effectiveTo = '2026-08-17T08:00:00.000Z'; }
  ]) {
    const values = { evidence: structuredClone(unavailable), estimate: structuredClone(estimate) }; mutate(values); const calls = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      commissionEstimate: values.estimate, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind); return httpJson({ ok: true, evidence: values.evidence }); } });
    await assert.rejects(registry.commission(request('commission', scope)), /UNAVAILABLE_INVALID|STORE_SCOPE_UNPROVEN|ESTIMATE_NOT_AUTHORIZED|ESTIMATE_EXPIRED/);
    assert.deepEqual(calls, ['commission']);
  }
});

test('bad JSON network failure and missing permission never trigger the estimate path', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const response of [async () => { throw new Error('synthetic network failure'); }, async () => ({ ok: true, text: async () => '{' }),
    async () => httpJson({ ok: false }, 403)]) {
    const calls = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      commissionEstimate: { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic', candidateId: 'TEST-001', candidateRevision: 1, scope },
      fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body).kind); return response(); } });
    await assert.rejects(registry.commission(request('commission', scope)), /synthetic network failure|INVALID_JSON|EVIDENCE_FAILED/);
    assert.deepEqual(calls, ['commission']);
  }
});


test('residual estimate fields and stale exact receipts are rejected, never cleared into exact', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  for (const mutate of [value => { value.evidenceData.estimateAuthorized = true; },
    value => { value.evidenceData.commissionEvidenceMode = 'estimated'; },
    value => { value.evidenceData.exactCommissionRequiredAtC = true; },
    value => { value.expiresAt = '2026-08-17T08:00:00.000Z'; }]) {
    const evidence = { current: true, scope, sourceType: 'synthetic', sourceRef: 'source:synthetic', checkedAt: fixedNow().toISOString(),
      expiresAt: '2026-08-19T08:00:00.000Z', evidenceData: { commissionRate: 0.14 } }; mutate(evidence);
    let calls = 0;
    const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      fetchImpl: async () => { calls++; return httpJson({ ok: true, evidence }); } });
    await assert.rejects(registry.commission(request('commission', scope)), /B_EVIDENCE_COMMISSION_INVALID/);
    assert.equal(calls, 1);
  }
});


test('WB commission lookup uses only explicit subject identity and current local version, never the Ozon connector', async () => {
  let network = 0, versions = 0;
  let versionStatus = 'active';
  const readers = createLifecycleBRealEvidenceReaders({ozonServiceUrl:'http://127.0.0.1:4173',
    now:()=>new Date('2026-09-09T06:00:00.000Z'),fetchImpl:async()=>{network++;throw new Error('NO_NETWORK_ALLOWED');},
    wbCommissionReference:{catalogPath:fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.json',import.meta.url)),
      sourcePath:fileURLToPath(new URL('../data/commissions/wb-china-2026-09-09.source.json',import.meta.url)),sellerRegion:'CN',
      readVersionState:async()=>{versions++;return {catalogId:'wb-china-commission',catalogVersion:'2026-09-09T05:02:34.628109Z',status:versionStatus};}}});
  const scope={platform:'wb',store:'wb',storeRef:{stableStoreId:'wb',platformStoreId:'platform:wb-synthetic',mappingVersion:'mapping:synthetic'},category:'wb:subject:5267',salesScheme:'synthetic-wb-scheme'};
  for(const category of ['镜子','5267','ozon:17030000:5267','wb:subject:9007199254740992']) {
    await assert.rejects(readers.commission({scope:{...scope,category}}),/B_EVIDENCE_WB_SUBJECT_ID_REQUIRED/);
  }
  assert.equal(versions,0);
  await assert.rejects(readers.commission({scope}),error=>{
    assert.equal(error.code,'B_EVIDENCE_WB_COMMISSION_NOT_FORMAL');
    assert.equal(error.reference.status,'matched_with_gaps');assert.equal(error.reference.commissionRate,0.2);
    assert.equal(error.reference.formalApplicability,false);assert.equal(error.reference.source.effectiveTo,null);return true;
  });
  versionStatus='invalidated';
  await assert.rejects(readers.commission({scope}),error=>{
    assert.equal(error.reference.status,'invalidated');assert.equal(error.reference.commissionRate,null);return true;
  });
  await assert.rejects(readers.commission({scope:{...scope,platform:'WB'}}), /B_EVIDENCE_WB_COMMISSION_NOT_FORMAL/);
  await assert.rejects(readers.commission({scope:{...scope,platform:'other'}}), /B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED/);
  assert.equal(versions,3);assert.equal(network,0);
});


test('current exact source cannot smuggle SKU costs into a reusable commission pack', async () => {
  const scope = { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: 'shelf', salesScheme: 'rfbs' };
  let calls = 0;
  const registry = createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    fetchImpl: async () => { calls++; return httpJson({ ok: true, evidence: {
      current: true, scope, sourceType: 'ozon_seller_api_same_type_commission', sourceRef: 'source:synthetic-official',
      checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z',
      evidenceData: { commissionRate: 0.14, otherCosts: { packagingRmb: 1 } }
    } }); }
  });
  await assert.rejects(registry.commission(request('commission', scope)), /B_EVIDENCE_COMMISSION_COSTS_UNEXPECTED/);
  assert.equal(calls, 1);
});

const OFFICIAL_SCOPE = { platform: 'ozon', store: 'dandanshu', storeRef: SYNTHETIC_STORE_REF, category: 'ozon:17030000:90000', salesScheme: 'rfbs' };
const OFFICIAL_SHA = 'a'.repeat(64);

function officialCommissionScope() {
  return { ...structuredClone(OFFICIAL_SCOPE), storeRef: structuredClone(SYNTHETIC_STORE_REF) };
}

function officialReferenceConfiguration() {
  return { catalogPath: '/owner/ozon-official-commission.json', sellerRegion: 'CN',
    versionState: { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' } };
}

function officialReferenceRead(overrides = {}) {
  return {
    schemaVersion: 'ozon-commission-reference-read-v1', platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs',
    priceRub: 2490, priceTier: '1500_5000', commissionRate: 0.155,
    matchedRows: [{ row: 4210, typeRu: 'Лежанки для животных', typeZh: '宠物躺床', typeEn: 'Pet beds',
      category3Zh: '猫咪用品', mpCategoryZh: '宠物用品', brand: 'All' }],
    source: { sourceUrl: 'https://docs.ozon.ru/common/pravila-raboty/komissii/', sourcePage: 'Full ChinaHK',
      effectiveFrom: '2026-08-01', fileSha256: OFFICIAL_SHA, fileLastModified: '2026-07-30T10:00:00.000Z',
      downloadedAt: '2026-08-02T09:00:00.000Z', catalogSchemaVersion: 'ozon-official-commission-reference-v1' },
    versionState: { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' },
    checkedAt: fixedNow().toISOString(), gaps: [], ...overrides
  };
}

function officialEvidenceService(scope, calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.kind);
    if (body.kind === 'commission') {
      return httpJson({ ok: true, evidence: { status: 'data_unavailable', current: false, reasonCode: 'exact_commission_unavailable',
        scope, sourceType: 'ozon_seller_api_current_products', sourceRef: 'ozon-seller-api:/v3/product/info/list:no-listed-product',
        checkedAt: fixedNow().toISOString(), evidenceData: {} } });
    }
    return httpJson({ ok: true, evidence: { current: true,
      scope: { platform: 'ozon', store: 'dandanshu', storeRef: structuredClone(SYNTHETIC_STORE_REF), category: scope.category, ruleVersion: 'ozon-current' },
      sourceType: 'ozon_seller_api_current_schema', sourceRef: 'ozon-seller-api:/v1/description-category/attribute:17030000:90000',
      checkedAt: fixedNow().toISOString(), expiresAt: '2026-08-19T08:00:00.000Z',
      evidenceData: { schemaRevision: 'ozon-schema-test', requiredFields: [], descriptionCategoryId: 17030000, typeId: 90000 } } });
  };
}

function officialCommissionRequest(scope, commissionReferenceScope) {
  return { ...request('commission', scope), commissionReferenceScope };
}

test('店铺没有同类目在售商品时，按已保存的官方佣金表版本成交并留下版本引用', async () => {
  const scope = officialCommissionScope();
  const calls = [];
  const observed = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    ozonCommissionReference: officialReferenceConfiguration(),
    readOzonCommissionReferenceImpl: async (input) => { observed.push(structuredClone(input)); return officialReferenceRead(); },
    fetchImpl: officialEvidenceService(scope, calls)
  });
  const pack = await registry.commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  assert.deepEqual(calls, ['commission', 'schema']);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].catalogPath, '/owner/ozon-official-commission.json');
  assert.equal(observed[0].asOf, '2026-08-18T08:00:00.000Z');
  assert.deepEqual(observed[0].versionState, { fileSha256: OFFICIAL_SHA, effectiveFrom: '2026-08-01', status: 'active' });
  assert.deepEqual(observed[0].scope, { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', priceRub: 2490, typeIdentity: { typeZh: '宠物躺床' } });
  assert.equal(pack.sourceType, 'ozon_official_commission_table');
  assert.equal(pack.sourceRef, `ozon-official-commission:2026-08-01:sha256:${OFFICIAL_SHA}:1500_5000`);
  assert.equal(pack.checkedAt, '2026-08-18T08:00:00.000Z');
  assert.equal(pack.expiresAt, '2026-08-19T08:00:00.000Z');
  assert.deepEqual(pack.commissionCatalogRef, { effectiveFrom: '2026-08-01', fileSha256: OFFICIAL_SHA,
    sourceUrl: 'https://docs.ozon.ru/common/pravila-raboty/komissii/', priceTier: '1500_5000',
    matchedRow: { typeRu: 'Лежанки для животных', typeZh: '宠物躺床', mpCategoryZh: '宠物用品' } });
  assert.deepEqual(pack.evidenceData, { commissionRate: 0.155, commissionEvidenceMode: 'official_reference',
    officialCommissionBinding: { schemaVersion: 'ozon-official-commission-binding-v1', candidateId: 'TEST-001', candidateRevision: 1, priceRub: 2490 },
    estimateAuthorized: false, exactCommissionRequiredAtC: true, descriptionCategoryId: 17030000, typeId: 90000 });
});

test('官方费表按俄语类型名称和成交价档查询，缺少价格或类型名称时只记缺口不猜测', async () => {
  const scope = officialCommissionScope();
  const cases = [
    { inputs: { priceRub: 990, typeName: 'Лежанки для животных' }, expected: { priceRub: 990, typeIdentity: { typeRu: 'Лежанки для животных' } } },
    { inputs: { priceRub: 6100, typeName: 'Pet beds' }, expected: { priceRub: 6100, typeIdentity: { typeEn: 'Pet beds' } } }
  ];
  for (const item of cases) {
    const observed = [];
    const registry = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(),
      readOzonCommissionReferenceImpl: async (input) => { observed.push(structuredClone(input)); return officialReferenceRead(); },
      fetchImpl: officialEvidenceService(scope, [])
    });
    await registry.commission(officialCommissionRequest(scope, item.inputs));
    assert.equal(observed[0].scope.priceRub, item.expected.priceRub);
    assert.deepEqual(observed[0].scope.typeIdentity, item.expected.typeIdentity);
  }
  for (const inputs of [null, { priceRub: 2490, typeName: '  ' }, { priceRub: 0, typeName: '宠物躺床' }, { typeName: '宠物躺床' }]) {
    let called = 0;
    const registry = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(),
      readOzonCommissionReferenceImpl: async () => { called += 1; return officialReferenceRead(); },
      fetchImpl: officialEvidenceService(scope, [])
    });
    await assert.rejects(registry.commission(officialCommissionRequest(scope, inputs)),
      /OFFICIAL_TABLE_PRICE_MISSING|OFFICIAL_TABLE_TYPE_IDENTITY_MISSING/);
    assert.equal(called, 0, '缺少每SKU输入时不读本地费表');
  }
});

test('官方费表有阻断缺口或读取失败时，原样回到主人授权估算路径并说明缺口', async () => {
  const scope = officialCommissionScope();
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope: officialCommissionScope() };
  const readers = [
    async () => officialReferenceRead({ commissionRate: null, matchedRows: [], gaps: [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true }] }),
    async () => officialReferenceRead({ commissionRate: null, gaps: [{ code: 'CATALOG_VERSION_MISMATCH', field: 'versionState', blocking: true }] }),
    async () => { throw Object.assign(new Error('OZON_COMMISSION_REFERENCE_CATALOG_UNREADABLE'), { code: 'CATALOG_UNREADABLE' }); }
  ];
  const withoutReference = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: estimate, fetchImpl: officialEvidenceService(scope, []) })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  for (const readOzonCommissionReferenceImpl of readers) {
    const fallback = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(), readOzonCommissionReferenceImpl, commissionEstimate: estimate,
      fetchImpl: officialEvidenceService(scope, []) })
      .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
    assert.deepEqual(fallback, withoutReference, '有缺口时估算证据必须与未配置费表时完全一致');
    assert.equal(fallback.evidenceData.commissionEvidenceMode, 'estimated');
  }
  for (const [readOzonCommissionReferenceImpl, expected] of [[readers[0], /TYPE_NOT_FOUND/], [readers[2], /OFFICIAL_TABLE_CATALOG_UNREADABLE/]]) {
    await assert.rejects(createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
      ozonCommissionReference: officialReferenceConfiguration(), readOzonCommissionReferenceImpl,
      fetchImpl: officialEvidenceService(scope, []) })
      .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' })), expected);
  }
});

test('未配置官方费表时佣金路径完全不变，也不读本地费表', async () => {
  const scope = officialCommissionScope();
  let called = 0;
  const calls = [];
  const estimate = { authorized: true, confirmedBy: 'owner', commissionRate: 0.2, authorizationRef: 'estimate:synthetic',
    candidateId: 'TEST-001', candidateRevision: 1, scope: officialCommissionScope() };
  const pack = await createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173', now: fixedNow,
    commissionEstimate: estimate, readOzonCommissionReferenceImpl: async () => { called += 1; return officialReferenceRead(); },
    fetchImpl: officialEvidenceService(scope, calls) })
    .commission(officialCommissionRequest(scope, { priceRub: 2490, typeName: '宠物躺床' }));
  assert.equal(called, 0);
  assert.deepEqual(calls, ['commission', 'schema']);
  assert.equal(pack.sourceType, 'owner_authorized_commission_estimate');
  assert.equal(pack.evidenceData.commissionEvidenceMode, 'estimated');
  assert.equal(Object.hasOwn(pack, 'commissionCatalogRef'), false);
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({ ozonServiceUrl: 'http://127.0.0.1:4173',
    ozonCommissionReference: { catalogPath: '/owner/ozon.json', sellerRegion: 'RU' } }),
    /B_EVIDENCE_OZON_COMMISSION_REFERENCE_INVALID/);
});
