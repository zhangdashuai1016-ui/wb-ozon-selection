import assert from "node:assert/strict";
import test from "node:test";

import { readCurrentGuooTariff, selectGuooTariffRow } from "../lib/guoo-tariff-reader.mjs";
import { createLifecycleBRealEvidenceProviderRegistry } from "../lib/lifecycle-b-real-evidence-readers.mjs";
import { readCurrentCbrExchangeRate } from "../lib/official-fx-reader.mjs";

const fixedNow = () => new Date("2026-08-18T08:00:00.000Z");

function request(kind, scope) {
  return {
    requestVersion: "lifecycle-b-evidence-preparation-v1.1",
    candidateId: "TEST-001",
    candidateRevision: 1,
    kind,
    scope,
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
  rows[17] = { 3: "GUOO Economy Small PUDO\nGUOO Economy Small Courier", 4: "陆运", 6: "28.1元/千克+17.97元/票", 11: 28.1, 12: 17.97 };
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

test("real provider registry keeps Ozon credentials outside 4317 and merges only explicit project cost policy", async () => {
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    otherCosts: {
      packagingRmb: 1.5,
      labelRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingRate: 0,
      returnReserveRate: 0.05,
      damageReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1",
    },
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options?.body || null });
      if (url.startsWith("http://127.0.0.1:4173")) return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", category: "ozon:17028665:92935", salesScheme: "rfbs" },
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
    store: "dandanshu",
    category: "ozon:17028665:92935",
    salesScheme: "rfbs",
  }));
  assert.equal(pack.evidenceData.commissionRate, 0.14);
  assert.equal(pack.evidenceData.otherCosts.returnReserveRate, 0.05);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).match(/Api-Key|token|cookie/i), null);
});

test("owner-authorized estimate resolves the exact category once and remains marked estimated", async () => {
  const calls = [];
  const registry = createLifecycleBRealEvidenceProviderRegistry({
    ozonServiceUrl: "http://127.0.0.1:4173",
    otherCosts: {
      packagingRmb: 1.5,
      labelRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingRate: 0,
      returnReserveRate: 0.05,
      damageReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1",
    },
    commissionEstimate: {
      authorized: true,
      confirmedBy: "owner",
      commissionRate: 0.2,
      authorizationRef: "owner-a-confirmation:commission-estimate:TEST-001",
    },
    now: fixedNow,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return httpJson({
        ok: true,
        evidence: {
          current: true,
          scope: { platform: "ozon", store: "dandanshu", category: "ozon-competitor:4403916892", ruleVersion: "ozon-current" },
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
    store: "dandanshu",
    category: "ozon-competitor:4403916892",
    salesScheme: "rfbs",
  }));
  const schema = await registry.schema(request("schema", {
    platform: "ozon",
    store: "dandanshu",
    category: "ozon-competitor:4403916892",
    ruleVersion: "ozon-current",
  }));
  assert.equal(commission.evidenceData.commissionRate, 0.2);
  assert.equal(commission.evidenceData.commissionEvidenceMode, "estimated");
  assert.equal(commission.evidenceData.estimateAuthorized, true);
  assert.equal(commission.evidenceData.exactCommissionRequiredAtC, true);
  assert.equal(commission.evidenceData.descriptionCategoryId, 17030000);
  assert.equal(schema.evidenceData.typeId, 90000);
  assert.equal(calls.length, 1, "schema identity must be reused instead of reread");
  assert.equal(calls[0].body.kind, "schema");
});

test("commission estimate is rejected without an exact owner authorization", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({
    otherCosts: {
      packagingRmb: 1.5,
      labelRmb: 1.5,
      fixedOtherRmb: 0,
      advertisingRate: 0,
      returnReserveRate: 0.05,
      damageReserveRate: 0.05,
      withdrawalFeeRate: 0.02,
      targetMarginRate: 0.15,
      minimumUnitProfitRmb: 20,
      priceIncrementCny: 1,
      thresholdLogic: "any",
      pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1",
    },
    commissionEstimate: { authorized: false, commissionRate: 0.2 },
  }), /B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED/);
});

test("real provider registry refuses missing cost policy instead of filling zeroes", () => {
  assert.throws(() => createLifecycleBRealEvidenceProviderRegistry({ otherCosts: {} }), /B_EVIDENCE_COST_POLICY_INCOMPLETE/);
});
