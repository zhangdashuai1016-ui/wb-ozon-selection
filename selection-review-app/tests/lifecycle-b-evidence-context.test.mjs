import assert from "node:assert/strict";
import test from "node:test";

import { applyLifecycleBEvidenceContext } from "../lib/lifecycle-b-evidence-context.mjs";

function candidate(overrides = {}) {
  return {
    id: "CONTEXT-001",
    dataRevision: 7,
    targetStore: "dandanshu",
    packedWeightKg: 0.4,
    salesSnapshotsV11: [{
      schemaVersion: "sales-snapshot-v1.1",
      snapshotId: "sales-snapshot:context-001",
      sourceDataRevision: 7,
      platform: "ozon",
      marketScope: "ozon_general_market",
      sellerType: "unknown",
      sellerIdentityEvidence: {
        status: "unverified",
        signals: [],
        evidenceRef: "fixture:context-sales:seller"
      },
      productUrl: "https://www.ozon.ru/product/123/",
      title: "Музыкальная шкатулка",
      imageRefs: [],
      currentPrice: 1462,
      currency: "RUB",
      categoryPath: "Дом и сад > Декор и интерьер > Музыкальная шкатулка",
      attributes: {},
      collectedAt: "2026-08-18T08:00:00.000Z",
      evidenceRef: "fixture:context-sales",
      collectorMode: "real_page_read_only",
      collectorVersion: "real-ozon-sales-snapshot-v1",
      readOnly: true
    }],
    ...overrides
  };
}

test("服务端从候选、销售快照和当前系统策略锁定B证据范围", () => {
  const source = candidate();
  const before = JSON.stringify(source);
  const result = applyLifecycleBEvidenceContext(source, {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  assert.deepEqual(result.context, {
    platform: "ozon",
    store: "dandanshu",
    category: "Дом и сад > Декор и интерьер > Музыкальная шкатулка",
    salesScheme: "rfbs",
    route: "GUOO Economy Small",
    logisticsRuleVersion: "guoo-2026-07-20",
    exchangePair: "RUB/CNY",
    schemaRuleVersion: "ozon-current"
  });
  assert.equal(result.ownerActionRequired, false);
  assert.equal(result.platformWrites, 0);
  assert.equal(JSON.stringify(source), before);
});

test("主人在A卡提交的重量可供系统选线路，不要求另填技术范围", () => {
  const source = candidate({ packedWeightKg: null });
  const result = applyLifecycleBEvidenceContext(source, {
    submission: { supplierConfirmation: { weightKg: 0.8 } },
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  assert.equal(result.context.route, "GUOO Economy Small");
  assert.equal(result.sources.route, "server_policy:guoo_economy_small_upto_2kg");
});

test("Ozon页面同时提供类目路径和商品类型时生成可唯一解析的类目选择器", () => {
  const source = candidate();
  source.salesSnapshotsV11[0].categoryPath = "Дом и сад > Декор и интерьер > Шкатулки > TipToPolis";
  source.salesSnapshotsV11[0].attributes = { "Тип": "Музыкальная шкатулка" };
  const result = applyLifecycleBEvidenceContext(source, {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  assert.equal(
    result.context.category,
    "Дом и сад > Декор и интерьер > Шкатулки > TipToPolis > Музыкальная шкатулка"
  );
  assert.match(result.sources.category, /category_and_type/);
});

test("页面已有Ozon精确类目与类型ID时优先使用稳定token", () => {
  const source = candidate();
  source.salesSnapshotsV11[0].attributes = { description_category_id: 17028665, type_id: 92935 };
  const result = applyLifecycleBEvidenceContext(source, {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  });
  assert.equal(result.context.category, "ozon:17028665:92935");
});

test("系统不覆盖冲突店铺，也不为超2kg商品猜其他物流线路", () => {
  assert.throws(() => applyLifecycleBEvidenceContext(candidate({
    lifecycleEvidenceContextV11: { store: "miska" }
  }), {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  }), /B_EVIDENCE_CONTEXT_CONFLICT/);
  assert.throws(() => applyLifecycleBEvidenceContext(candidate({ packedWeightKg: 2.1 }), {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  }), /ROUTE_UNRESOLVED/);
});

test("没有可追溯类目时停止，不用标题或图片猜类目", () => {
  assert.throws(() => applyLifecycleBEvidenceContext(candidate({ salesSnapshotsV11: [] }), {
    guooFilePath: "/tmp/GUOO产品资费测算表【2026.7.20更新】.xlsx"
  }), /B_EVIDENCE_CONTEXT_INCOMPLETE.*当前类目/);
});
