import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRealAConfirmationCard,
  validateRealAConfirmationSubmission
} from "../lib/real-a-confirmation-card.mjs";
import { attachTerraAuxiliaryDraft } from "../lib/sales-snapshot.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function candidate() {
  const document = JSON.parse(await readFile(path.join(appDir, "data", "candidates.json"), "utf8"));
  return structuredClone(document.candidates.find((item) => item.id === "CX-20260802-014"));
}

function validSubmission(card) {
  return {
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

  const rejected = validateRealAConfirmationSubmission(card, { decision: "reject" });
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
  assert.match(source, /服务端会自动建立单候选作业/);
  assert.match(source, /等待插件后台领取/);
  assert.match(source, /本轮不会调用接口、保存选择、确认供应方案或进入B\/C1/);
  assert.match(source, /具体供应SKU/);
  assert.match(source, /国内运费/);
  assert.match(source, /其他采购费用/);
  assert.match(source, /实际采购成本/);
  assert.match(source, /实际打包重量/);
  assert.match(source, /属于同一个采购方案/);
  assert.doesNotMatch(source, /未知运费按0|未知.*自动.*0/);
  assert.match(source, /未知保持空白/);
  assert.match(source, /系统准备方式/);
  assert.match(source, /任何失败立即停止，不自动重试，也不提交半套证据/);
  assert.match(source, /登录页／人机验证页／移动页／中间跳转页／详情页加载超时／标签不可读取／地址未就绪／其他非白名单页面／不同商品/);
  assert.match(source, /不会保存完整跳转地址、查询参数或页面内容/);
});
