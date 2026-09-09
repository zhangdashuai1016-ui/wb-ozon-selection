import { currentOtherCosts } from "./fixtures/real-a-b-flow-fixture.mjs";
import { runRealAConfirmationToBAndC1 } from '../lib/real-a-b-c1-flow.mjs';
import { addEvidenceContext, evidencePacks as syntheticEvidencePacks, confirmedAt as syntheticConfirmedAt } from './fixtures/real-a-b-flow-fixture.mjs';
import { sanitize1688Evidence } from '../lib/source-capture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import {
  buildRealAConfirmationCard,
  validateRealAConfirmationSubmission
} from "../lib/real-a-confirmation-card.mjs";
import { attachTerraAuxiliaryDraft } from "../lib/sales-snapshot.mjs";
import { buildAConfirmationInput, selectAConfirmationSku } from "../src/aConfirmationInput.js";
import { inspectLifecycleBInputReadiness } from "../lib/lifecycle-b-input-bundle.mjs";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("A卡展示已保存物流比较与确切版本，不把缺口展示成最低运费", () => {
  const candidate = createMusicBoxCandidate();
  candidate.guooRouteComparisonsV1 = [{ schemaVersion: "guoo-route-comparison-v1", ruleVersion: "guoo-2026-08-19",
    sourceRevision: candidate.dataRevision - 1, resultRevision: candidate.dataRevision, status: "blocked", globalIssues: [],
    routes: [{ route: "GUOO Economy Small PUDO", reasons: [{ code: "FEE_COVERAGE_UNKNOWN", message: "完整费用尚未确认" }] }] }];
  const before = structuredClone(candidate);
  const card = buildRealAConfirmationCard(candidate);
  assert.deepEqual(card.guooRouteComparison, candidate.guooRouteComparisonsV1[0]);
  assert.deepEqual(candidate, before);
  assert.notEqual(card.guooRouteComparison, candidate.guooRouteComparisonsV1[0]);
});

test("真实readiness和A卡组件显示完整店铺对象，缺失与冲突保持门禁状态", async () => {
  const entry = path.join(appDir, "tests", "real-a-card-render-entry.jsx");
  const componentPath = path.join(appDir, "src", "components", "RealAConfirmationCard.jsx");
  const bundle = await build({
    configFile: false, logLevel: "warn",
    plugins: [react(), {
      name: "real-a-card-render-entry",
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import Card from ${JSON.stringify(componentPath)};
        export const render = card => renderToStaticMarkup(<Card card={card} onSubmit={() => { throw new Error("render_must_not_submit"); }} />);` : null
    }],
    ssr: { noExternal: true },
    build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } }
  });
  const output = bundle.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
  const source = { id: "candidate:real-a-display", dataRevision: 1, targetStore: "dandanshu",
    storeRef: structuredClone(SYNTHETIC_STORE_REF), lifecycleEvidenceContextV11: {
      platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: "shelf",
      salesScheme: "rfbs", route: "synthetic-route", logisticsRuleVersion: "synthetic-logistics-v1",
      exchangePair: "RUB/CNY", schemaRuleVersion: "synthetic-schema-v1"
    } };
  function renderCurrent(candidate) {
    const before = structuredClone(candidate);
    const readiness = inspectLifecycleBInputReadiness({ candidate, asOf: "2026-09-07T00:00:00.000Z" });
    const card = buildRealAConfirmationCard(candidate, { systemEvidenceReadiness: readiness });
    const cardBefore = structuredClone(card);
    const html = render(card);
    assert.deepEqual(candidate, before);
    assert.deepEqual(card, cardBefore);
    assert.doesNotMatch(html, /\[object Object\]/);
    return { readiness, card, html };
  }
  const complete = renderCurrent(source);
  assert.equal(complete.readiness.contextReady, true);
  assert.equal(complete.card.storeBindingStatus, "bound");
  assert.ok(complete.html.includes(`内部店铺 ${source.storeRef.stableStoreId} · 平台店铺 ${source.storeRef.platformStoreId} · 映射版本 ${source.storeRef.mappingVersion}`));
  const quoteSource = structuredClone(source);
  quoteSource.guooRouteComparisonsV1 = [{ ruleVersion: 'guoo-2026-08-19', resultRevision: source.dataRevision,
    inputSnapshot: { salePrice: { amountRub: 2000 } }, status: 'compared', selectedRoute: 'GUOO Economy Small',
    selectedRouteLabel: '经济轻小件', transportVerified: false, globalIssues: [],
    minimumRoutes: [{ route: 'GUOO Economy Small', totalFreightRmb: 46.07 }],
    routes: [{ route: 'GUOO Economy Small', deliveryMethods: ['GUOO Economy Small PUDO', 'GUOO Economy Small Courier'], reasons: [] }] }];
  const quoted = renderCurrent(quoteSource);
  assert.equal(quoted.card.targetSalePriceRub, 2000);
  assert.match(quoted.html, /自动预填：经济轻小件/);
  assert.match(quoted.html, /46.07/);
  assert.match(quoted.html, /PUDO.*Courier/);
  assert.match(quoted.html, /商品运输限制仍需核实/);
  for (const storeRef of [null, { stableStoreId: "dandanshu", platformStoreId: "synthetic-seller" }]) {
    const missingSource = structuredClone(source);
    missingSource.storeRef = storeRef;
    delete missingSource.lifecycleEvidenceContextV11.storeRef;
    const missing = renderCurrent(missingSource);
    assert.equal(missing.readiness.contextReady, false);
    assert.notEqual(missing.card.storeBindingStatus, "bound");
    assert.match(missing.html, /<small>完整店铺身份<\/small><b>店铺身份未取得<\/b><em>待系统确定<\/em>/);
    assert.match(missing.html, /class="button primary" type="button" disabled=""/);
  }
  const conflictSource = structuredClone(source);
  conflictSource.lifecycleEvidenceContextV11.storeRef.platformStoreId = "another-seller";
  const conflict = renderCurrent(conflictSource);
  assert.equal(conflict.readiness.contextReady, false);
  assert.equal(conflict.readiness.context.fields.find(field => field.key === "storeRef").status, "conflict");
  assert.match(conflict.html, /status-conflict"><small>完整店铺身份<\/small><b>内部店铺 .*<\/b><em>存在冲突<\/em>/);
  assert.match(conflict.html, /目标店铺适用范围冲突/);
  assert.doesNotMatch(conflict.html, /another-seller|可直接进入B/);
});

async function candidate() {
  return createMusicBoxCandidate();
}

function validSubmission(card) {
  return {
    sourceCandidateId: card.sourceCandidateId, sourceDataRevision: card.sourceDataRevision, dataRevision: card.sourceDataRevision,
    targetPlatform: card.targetPlatform, storeRef: structuredClone(card.storeRef),
    decision: "confirm",
    salesReview: {
      snapshotId: card.salesReview.snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

test("正式卡到浏览器输入保留店铺绑定；未绑定可淘汰，错绑及旧修订拒绝", async () => {
  const source = await candidate();
  const card = buildRealAConfirmationCard(source);
  const form = validSubmission(card);
  const dto = buildAConfirmationInput(card, form, "confirm", source.dataRevision);
  assert.equal(card.storeBindingStatus, "bound");
  assert.deepEqual(dto.storeRef, source.storeRef);
  assert.equal(validateRealAConfirmationSubmission(card, dto).valid, true);
  for (const change of [
    value => { value.sourceCandidateId = "another"; },
    value => { value.sourceDataRevision -= 1; },
    value => { value.targetPlatform = "wb"; },
    value => { value.storeRef.mappingVersion = "changed"; },
    value => { value.storeRef.platformStoreId = "another"; }
  ]) {
    const changed = structuredClone(dto); change(changed);
    assert.equal(validateRealAConfirmationSubmission(card, changed).valid, false);
  }
  delete source.storeRef;
  const unbound = buildRealAConfirmationCard(source);
  assert.equal(unbound.storeBindingStatus, "missing");
  assert.throws(() => buildAConfirmationInput(unbound, form, "confirm", source.dataRevision), /身份/);
  const rejection = buildAConfirmationInput(unbound, form, "reject", source.dataRevision);
  assert.equal(validateRealAConfirmationSubmission(unbound, rejection).valid, true);
  assert.equal(validateRealAConfirmationSubmission(unbound, { ...rejection, sourceCandidateId: "another" }).valid, false);
});

test("真实A确认卡一次展示销售、供应、成本和包装字段且零业务写入", async () => {
  const source = await candidate();
  const before = JSON.stringify(source);
  const card = buildRealAConfirmationCard(source);
  assert.equal(card.sourceCandidateId, "CX-20260802-014");
  assert.equal(card.sourceDataRevision, source.dataRevision);
  assert.equal(card.salesReview.currentPrice, 1462);
  assert.equal(card.salesReview.sellerType, "unknown");
  assert.equal(card.supplierConfirmation.actualPurchaseCost.value, 17.3);
  assert.equal(card.supplierConfirmation.weightKg.value, 0.4);
  assert.deepEqual({
    length: card.supplierConfirmation.dimensionsCm.length.value,
    width: card.supplierConfirmation.dimensionsCm.width.value,
    height: card.supplierConfirmation.dimensionsCm.height.value
  }, { length: 12, width: 12, height: 7 });
  assert.equal(card.supplierConfirmation.unitProductPrice.value, null);
  assert.equal(card.supplierConfirmation.unitDomesticFreight.value, null);
  assert.equal(card.supplierConfirmation.otherPurchaseCosts.value, null);
  assert.equal(card.supplierConfirmation.supplierSkuId.value, null);
  assert.equal(card.confirmation.oneCardSubmission, true);
  assert.deepEqual(card.boundaries, {
    candidateWrites: 0,
    platformAccesses: 0,
    platformWrites: 0,
    taskDispatches: 0,
    automationStarted: false
  });
  assert.equal(JSON.stringify(source), before);
});

test("五输入报价的RUB成交价由本轮输入确认，不从竞品价或历史提示补造", async () => {
  const source = await candidate();
  source.expectedPriceRub = 9999;
  const card = buildRealAConfirmationCard(source);
  assert.equal(card.targetSalePriceRub, null);
  const form = { ...validSubmission(card), targetSalePriceRub: "2000" };
  const input = buildAConfirmationInput(card, form, "confirm", card.sourceDataRevision);
  assert.equal(input.targetSalePriceRub, 2000);
  const validated = validateRealAConfirmationSubmission(card, input);
  assert.equal(validated.valid, true);
  assert.equal(validated.normalized.targetSalePriceRub, 2000);
  for (const invalid of [0, -1, true, "2000", Infinity]) {
    assert.equal(validateRealAConfirmationSubmission(card, { ...input, targetSalePriceRub: invalid }).valid, false);
  }
  const absent = validateRealAConfirmationSubmission(card, validSubmission(card));
  assert.equal(absent.normalized.targetSalePriceRub, null);
});

test("真实A确认卡展示Terra辅助草稿但明确不覆盖真实字段", async () => {
  const source = await candidate();
  const latest = source.salesSnapshotsV11.at(-1);
  source.salesSnapshotsV11[source.salesSnapshotsV11.length - 1] = attachTerraAuxiliaryDraft(latest, {
    provider: "terra",
    modelVersion: "gpt-5.6-terra",
    generatedAt: "2026-08-22T05:00:00.000Z",
    status: "draft",
    authoritative: false,
    mayOverrideObservedFields: false,
    publicTextEvidenceRefs: [latest.evidenceRef],
    authorizedImageRefs: [],
    output: { summary: "辅助判断", comparabilitySignals: [], attributeHints: [] }
  });
  const card = buildRealAConfirmationCard(source);
  assert.equal(card.salesReview.terraAssist.output.summary, "辅助判断");
  assert.equal(card.salesReview.terraAssist.authoritative, false);
  assert.equal(card.salesReview.currentPrice, latest.currentPrice);
});

test("真实A确认卡要求精确SKU、成本拆分、包装和一次主人确认", async () => {
  const card = buildRealAConfirmationCard(await candidate());
  const missing = validateRealAConfirmationSubmission(card, {
    decision: "confirm",
    salesReview: { snapshotId: card.salesReview.snapshotId, comparability: "unknown", validityStatus: "unknown" },
    supplierConfirmation: {
      productUrl: "https://qr.1688.com/s/7OnLCakq",
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: false
    }
  });
  assert.equal(missing.valid, false);
  const fields = missing.errors.map((item) => item.field);
  for (const required of [
    "salesReview.comparability",
    "salesReview.validityStatus",
    "productUrl",
    "supplierSkuId",
    "variantKey",
    "unitProductPrice",
    "unitDomesticFreight",
    "otherPurchaseCosts",
    "ownerSupplyConfirmed"
  ]) assert.equal(fields.includes(required), true, required);
});

test("真实A确认卡通过时规范化一次提交但仍不创建B或派发", async () => {
  const card = buildRealAConfirmationCard(await candidate());
  const result = validateRealAConfirmationSubmission(card, validSubmission(card));
  assert.equal(result.valid, true);
  assert.equal(result.decision, "confirm");
  assert.equal(result.sourceCandidateId, card.sourceCandidateId);
  assert.equal(result.sourceDataRevision, card.sourceDataRevision);
  assert.equal(result.normalized.supplierConfirmation.actualPurchaseCost, 17.3);
  assert.equal(result.normalized.supplierConfirmation.unitDomesticFreight, 2);
  assert.equal("skuPackage" in result, false);
  assert.equal("dispatch" in result, false);
});

test("真实A确认卡只显示脱敏的短链失败分类", async () => {
  const source = await candidate();
  source.sourceCapture = {
    captureId: "SCJ-sanitized",
    mode: "a_supplier_capture",
    status: "failed",
    failureCode: "site_verification_required",
    failureDiagnostics: {
      finalHostClass: "verification_1688",
      finalPathType: "verification",
      redirectClassification: "verification_required",
      navigationStage: "page_complete",
      observedOfferId: null
    },
    reason: "1688页面要求完成人机或安全验证：人机验证页"
  };
  const card = buildRealAConfirmationCard(source);
  assert.equal(card.supplierCapture.failureDestinationLabel, "人机验证页");
  assert.equal(card.supplierCapture.failureDiagnostics.redirectClassification, "verification_required");
  assert.equal("finalUrl" in card.supplierCapture.failureDiagnostics, false);
});

test("真实A确认卡不接受不相等的采购成本，也允许在同一张卡淘汰", async () => {
  const card = buildRealAConfirmationCard(await candidate());
  const submission = validSubmission(card);
  submission.supplierConfirmation.actualPurchaseCost = 18;
  const mismatch = validateRealAConfirmationSubmission(card, submission);
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.errors.find((item) => item.field === "actualPurchaseCost").reason, /商品价＋国内运费＋其他采购费用/);

  const rejected = validateRealAConfirmationSubmission(card, { ...validSubmission(card), decision: "reject" });
  assert.equal(rejected.valid, true);
  assert.equal(rejected.normalized, null);
});

test("真实A确认卡UI只有一组销售、供应、成本、包装和最终确认动作", async () => {
  const source = await readFile(path.join(appDir, "src", "components", "RealAConfirmationCard.jsx"), "utf8");
  assert.match(source, /A阶段完整确认卡/);
  assert.match(source, /Terra辅助整理/);
  assert.match(source, /不覆盖页面价格、标题、类目或卖家身份/);
  assert.match(source, /一次确认并进入B/);
  assert.doesNotMatch(source, /disabled=\{disabled \|\| !onSubmit \|\| !systemReady\}/);
  assert.match(source, /确认后由系统准备B证据/);
  assert.match(source, /商品可比性/);
  assert.match(source, /1688供应链接/);
  assert.match(source, /采集是否获准、是否已领取，以服务端作业和插件回执为准/);
  assert.match(source, /storeBindingStatus !== "bound"/);
  assert.match(source, /等待插件后台领取/);
  assert.match(source, /本轮不会调用接口、保存选择、确认供应方案或进入B\/C1/);
  assert.match(source, /具体供应SKU/);
  assert.match(source, /国内运费/);
  assert.match(source, /其他采购费用/);
  assert.match(source, /实际采购成本/);
  assert.match(source, /实际打包重量/);
  assert.match(source, /属于同一个采购方案/);
  assert.doesNotMatch(source, /未知运费按0|未知.*自动.*0/);
  assert.match(source, /未知可暂留空，但确认完整供货方案前必须补齐；确认免运费时才填0/);
  assert.match(source, /系统准备方式/);
  assert.match(source, /任何失败立即停止，不自动重试，也不提交半套证据/);
  assert.match(source, /登录页／人机验证页／移动页／中间跳转页／详情页加载超时／标签不可读取／地址未就绪／其他非白名单页面／不同商品/);
  assert.match(source, /不会保存完整跳转地址、查询参数或页面内容/);
});


function browserCaptureFixture() {
  const source = createMusicBoxCandidate();
  delete source.lifecycleV11;
  const evidence = sanitize1688Evidence({ offerId: '876240928352', sourceUrl: 'https://detail.1688.com/offer/876240928352.html',
    observedAt: '2026-09-09T04:00:00.000Z', title: 'Synthetic dual SKU',
    priceRanges: [{ minimumQuantity: 100, priceCny: 1, source: 'synthetic:bulk-tier' }],
    skus: [{ sourceSkuId: 'sewing-black', attributes: { 款式: '黑色缝纫机' }, priceCny: 11.8,
      priceSource: 'skuModel.skuInfoMap.price', stock: 120, stockSource: 'skuModel.skuInfoMap.canBookCount' },
    { sourceSkuId: 'sewing-ivory', attributes: { 款式: '象牙白缝纫机' }, priceCny: null, priceSource: null, stock: null, stockSource: null }]
  }, '876240928352');
  source.sourceCapture = { ...evidence, mode: 'a_supplier_capture', captureId: 'capture:synthetic-browser',
    status: 'captured_waiting_owner_selection', skuChoices: evidence.skus, selectedSkuIds: [], ownerSupplyConfirmed: false };
  const card = buildRealAConfirmationCard(source);
  return { source, evidence, card };
}

function browserConfirmation(card, skuId = 'sewing-black') {
  const form = selectAConfirmationSku(validSubmission(card), card, skuId);
  Object.assign(form.supplierConfirmation, { minimumOrderQuantity: 1, quantityOneEvidenceSourceNote: 'Synthetic owner checked this exact SKU for one-piece price and MOQ.',
    unitDomesticFreight: 2, otherPurchaseCosts: 0, actualPurchaseCost: skuId === 'sewing-black' ? 13.8 : 17,
    weightKg: 0.4, dimensionsCm: { length: 12, width: 12, height: 7 }, matchType: 'exact_match', ownerSupplyConfirmed: true });
  if (skuId === 'sewing-ivory') form.supplierConfirmation.unitProductPrice = 15;
  return form;
}

test('real browser sanitizer DTO projects selectable variants without inventing MOQ or unknown prices', () => {
  const { source, evidence, card } = browserCaptureFixture();
  assert.equal(card.supplierCapture.sourceMode, 'chrome_extension_structured_page_v1');
  assert.equal(card.supplierCapture.quantityOneEvidenceRequired, true);
  assert.deepEqual(card.supplierCapture.selectedSkuIds, []);
  assert.deepEqual(card.supplierCapture.skuChoices.map(sku => sku.priceCny), [11.8, null]);
  for (const sku of card.supplierCapture.skuChoices) {
    assert.equal(typeof sku.variantKey, 'string'); assert.ok(sku.variantKey.length > 0);
    assert.equal(sku.minimumOrderQuantity, null);
  }
  assert.equal(evidence.skus[0].variantKey, undefined);
  assert.equal(source.sourceCapture.skuChoices[0].minimumOrderQuantity, undefined);
  const before = structuredClone(source);
  for (const skuId of ['sewing-black', 'sewing-ivory']) {
    const input = buildAConfirmationInput(card, browserConfirmation(card, skuId), 'confirm', card.sourceDataRevision);
    const result = validateRealAConfirmationSubmission(card, input);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.normalized.supplierConfirmation.minimumOrderQuantity, 1);
    assert.match(result.normalized.supplierConfirmation.quantityOneEvidenceSourceNote, /exact SKU/);
    assert.equal(result.normalized.supplierConfirmation.unitProductPrice, skuId === 'sewing-black' ? 11.8 : 15);
  }
  assert.deepEqual(source, before);
});

test('browser single-link confirmation rejects identity price MOQ and owner-evidence tampering at server validation', () => {
  const { card } = browserCaptureFixture();
  const good = buildAConfirmationInput(card, browserConfirmation(card), 'confirm', card.sourceDataRevision);
  for (const [field, value] of [
    ['captureId', 'capture:other'], ['productUrl', 'https://detail.1688.com/offer/999999999.html'],
    ['supplierSkuId', 'sku:not-captured'], ['variantKey', 'another-variant'], ['unitProductPrice', 1],
    ['minimumOrderQuantity', null], ['minimumOrderQuantity', 2], ['matchType', 'near_match'],
    ['quantityOneEvidenceSourceNote', ''], ['quantityOneEvidenceSourceNote', 'bad\u0000note'],
    ['ownerSupplyConfirmed', false]
  ]) {
    const input = structuredClone(good); input.supplierConfirmation[field] = value;
    assert.equal(validateRealAConfirmationSubmission(card, input).valid, false, field);
  }
  const unknown = buildAConfirmationInput(card, browserConfirmation(card, 'sewing-ivory'), 'confirm', card.sourceDataRevision);
  unknown.supplierConfirmation.unitProductPrice = null;
  assert.equal(validateRealAConfirmationSubmission(card, unknown).valid, false);
});


test('same A confirmation freezes owner quantity-one evidence separately from the unchanged browser receipt', () => {
  const { source } = browserCaptureFixture();
  source.sourceCapture.observedAt = syntheticConfirmedAt;
  const contextual = addEvidenceContext(source), card = buildRealAConfirmationCard(contextual);
  const originalCapture = structuredClone(contextual.sourceCapture);
  const input = buildAConfirmationInput(card, browserConfirmation(card, 'sewing-ivory'), 'confirm', card.sourceDataRevision);
  const run = runRealAConfirmationToBAndC1({ candidate: contextual, otherCosts: currentOtherCosts(contextual), submission: input,
    evidencePacks: syntheticEvidencePacks(), confirmedAt: syntheticConfirmedAt });
  const supplierSku = run.opportunityPackage.supplierOptions[0].supplierSkus[0];
  assert.deepEqual(supplierSku.attributes.quantityOneEvidence, {
    source: 'owner_quantity_one_confirmation', candidateId: source.id, sourceRevision: source.dataRevision,
    captureId: originalCapture.captureId, productUrl: originalCapture.sourceUrl, supplierSkuId: 'sewing-ivory',
    variantKey: input.supplierConfirmation.variantKey, minimumOrderQuantity: 1, unitProductPrice: 15,
    currency: 'CNY', matchType: 'exact_match', sourceNote: input.supplierConfirmation.quantityOneEvidenceSourceNote,
    evidenceRef: `owner-a-confirmation:${source.id}:${source.dataRevision}`, confirmedAt: syntheticConfirmedAt
  });
  assert.deepEqual(run.skuPackage.selectedSupplySnapshot.supplierSku.attributes.quantityOneEvidence, supplierSku.attributes.quantityOneEvidence);
  assert.deepEqual(contextual.sourceCapture, originalCapture);
  assert.equal(originalCapture.skuChoices[1].priceCny, null);
  assert.deepEqual(run.externalAccesses, []);
  assert.equal(run.taskDispatches, 0);
});

test('known browser MOQ greater than one cannot be overwritten by owner notes', () => {
  const { card } = browserCaptureFixture();
  const input = buildAConfirmationInput(card, browserConfirmation(card), 'confirm', card.sourceDataRevision);
  const known = structuredClone(card);
  known.supplierCapture.skuChoices.find(sku => sku.sourceSkuId === 'sewing-black').minimumOrderQuantity = 2;
  assert.throws(() => buildAConfirmationInput(known, browserConfirmation(known), 'confirm', known.sourceDataRevision), /起订量/);
  assert.equal(validateRealAConfirmationSubmission(known, input).valid, false);
});
