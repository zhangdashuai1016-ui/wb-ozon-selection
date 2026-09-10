import { optionalNumber } from "./formState.js";
import { isCompleteStoreRef } from "../lib/store-binding.mjs";

export function selectAConfirmationSku(form, card, sourceSkuId) {
  const matches = (card.supplierCapture?.skuChoices || []).filter(sku => sku.sourceSkuId === sourceSkuId);
  if (matches.length !== 1) throw new Error("必须选择当前采集中的唯一供应SKU。");
  const sku = matches[0];
  return { ...form, supplierConfirmation: {
    ...form.supplierConfirmation,
    captureId: card.supplierCapture.captureId,
    supplierSkuId: sku.sourceSkuId,
    variantKey: sku.variantKey ?? "",
    minimumOrderQuantity: sku.minimumOrderQuantity === "unknown" ? "" : sku.minimumOrderQuantity ?? "",
    unitProductPrice: sku.priceCny ?? "",
    quantityOneEvidenceSourceNote: "",
    unitDomesticFreight: "",
    otherPurchaseCosts: "",
    actualPurchaseCost: "",
    weightKg: "",
    dimensionsCm: { length: "", width: "", height: "" },
    matchType: "unknown",
    ownerSupplyConfirmed: false
  } };
}

// Browser intent only. The server owns fieldEvidence, actor, clock and confirmationRef.
export function buildAConfirmationInput(card, form, decision, sourceRevision) {
  if (!card.sourceCandidateId || card.sourceDataRevision !== sourceRevision ||
      (decision !== "reject" && (!card.targetPlatform || !isCompleteStoreRef(card.storeRef, card.targetStore)))) {
    throw new Error("A卡身份或修订不完整/已变化；请重新读取正式卡，不补造身份。");
  }
  const fields = form.supplierConfirmation;
  const supplierConfirmation = {};
  for (const field of ["captureId", "productUrl", "supplierSkuId", "variantKey", "matchType"]) {
    supplierConfirmation[field] = fields[field];
  }
  for (const field of ["minimumOrderQuantity", "unitProductPrice", "unitDomesticFreight", "otherPurchaseCosts", "actualPurchaseCost", "weightKg"]) {
    supplierConfirmation[field] = decision === "reject" ? null : optionalNumber(fields[field], field);
  }
  supplierConfirmation.dimensionsCm = Object.fromEntries(["length", "width", "height"].map(field => [field,
    decision === "reject" ? null : optionalNumber(fields.dimensionsCm[field], field)
  ]));
  supplierConfirmation.ownerSupplyConfirmed = fields.ownerSupplyConfirmed === true;
  const browserEvidence = card.supplierCapture?.quantityOneEvidenceRequired === true &&
    card.supplierCapture?.sourceMode === "chrome_extension_structured_page_v1";
  if (browserEvidence && decision !== "reject") {
    supplierConfirmation.quantityOneEvidenceSourceNote = typeof fields.quantityOneEvidenceSourceNote === "string"
      ? fields.quantityOneEvidenceSourceNote.trim() : "";
  }
  if (decision === "confirm" && card.supplierCapture?.status === "captured_waiting_owner_selection") {
    const matches = card.supplierCapture.skuChoices.filter(item => item.sourceSkuId === fields.supplierSkuId);
    const sku = matches[0];
    if (matches.length !== 1 || fields.captureId !== card.supplierCapture.captureId || fields.variantKey !== sku.variantKey ||
        fields.productUrl !== card.supplierCapture.sourceUrl) {
      throw new Error("供应SKU、规格或链接与当前采集不一致；未提交。");
    }
    const unknownPrice = sku.priceCny === null || sku.priceCny === undefined;
    const unknownMoq = sku.minimumOrderQuantity === null || sku.minimumOrderQuantity === undefined || sku.minimumOrderQuantity === "unknown";
    if (browserEvidence) {
      if (!(Number.isFinite(supplierConfirmation.unitProductPrice) && supplierConfirmation.unitProductPrice > 0) ||
          (!unknownPrice && supplierConfirmation.unitProductPrice !== sku.priceCny) ||
          supplierConfirmation.minimumOrderQuantity !== 1 || (!unknownMoq && sku.minimumOrderQuantity !== 1)) {
        throw new Error("必须确认当前SKU一件可买及其单件价格，不能覆盖已知价格或起订量；未提交。");
      }
      const note = supplierConfirmation.quantityOneEvidenceSourceNote;
      if (!note || note.length > 1000 || /[\u0000-\u001f\u007f]/u.test(note)) {
        throw new Error("请填写当前SKU一件可买、单件价格和规格的来源说明（1至1000字，无控制字符）。");
      }
    } else if (supplierConfirmation.unitProductPrice !== sku.priceCny || supplierConfirmation.minimumOrderQuantity !== sku.minimumOrderQuantity) {
      throw new Error("供应SKU、直接价格或MOQ与当前采集不一致；未提交。");
    }
    if (!supplierConfirmation.ownerSupplyConfirmed || fields.matchType !== "exact_match") {
      throw new Error("必须明确确认精确同款和完整供货方案；选择SKU不等于确认。");
    }
  }
  return {
    targetSalePriceRub: decision === "reject" ? null : optionalNumber(form.targetSalePriceRub, "targetSalePriceRub"),
    sourceCandidateId: card.sourceCandidateId, sourceDataRevision: sourceRevision, dataRevision: sourceRevision,
    targetPlatform: card.targetPlatform, storeRef: structuredClone(card.storeRef), decision,
    salesReview: { snapshotId: form.salesReview.snapshotId, comparability: form.salesReview.comparability,
      validityStatus: form.salesReview.validityStatus, confidence: form.salesReview.confidence },
    supplierConfirmation
  };
}
