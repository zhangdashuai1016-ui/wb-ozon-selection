import { createHash } from "node:crypto";

import { prepareC1FactKeywordPipeline } from "./c1-fact-keyword-pipeline.mjs";

export const C1_FACT_KEYWORD_RUNTIME_INPUT_VERSION = "c1-fact-keyword-runtime-input-v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function assertNoSensitiveFields(value, path = "input") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i.test(key)) {
      throw new Error(`C1_FACT_KEYWORD_RUNTIME_SECRET_FORBIDDEN: ${path}.${key}`);
    }
    assertNoSensitiveFields(child, `${path}.${key}`);
  }
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function validateInput(input) {
  if (!isObject(input) || input.schemaVersion !== C1_FACT_KEYWORD_RUNTIME_INPUT_VERSION ||
      !Number.isInteger(input.dataRevision) || input.dataRevision < 0 ||
      !isObject(input.keywordSourceEvidence) || !isObject(input.frozenSeoRules) ||
      !nonEmpty(input.keywordExpiresAt) || Number.isNaN(Date.parse(input.keywordExpiresAt)) ||
      !isObject(input.providerEvidence)) {
    throw new Error("C1_FACT_KEYWORD_RUNTIME_INPUT_INVALID: 缺少当前revision、冻结关键词来源、SEO规则、有效期或提供器证据");
  }
  const providerEvidence = input.providerEvidence;
  for (const field of ["frozenComplexityDecision", "reusableKeywordSnapshot"]) {
    if (!Object.hasOwn(input, field)) throw new Error(`C1_FACT_KEYWORD_RUNTIME_INPUT_INVALID: 缺少${field}`);
  }
  for (const field of ["seerfarApiReceipt", "browserReceipt", "standardSkuHealthReceipts", "keywordMetricEvidence"]) {
    if (!Object.hasOwn(providerEvidence, field)) throw new Error(`C1_FACT_KEYWORD_RUNTIME_PROVIDER_EVIDENCE_INVALID: 缺少${field}`);
  }
  if (!(providerEvidence.seerfarApiReceipt === null || isObject(providerEvidence.seerfarApiReceipt)) ||
      !(providerEvidence.browserReceipt === null || isObject(providerEvidence.browserReceipt)) ||
      !Array.isArray(providerEvidence.standardSkuHealthReceipts) ||
      !(providerEvidence.keywordMetricEvidence === null || isObject(providerEvidence.keywordMetricEvidence))) {
    throw new Error("C1_FACT_KEYWORD_RUNTIME_PROVIDER_EVIDENCE_INVALID: 冻结提供器证据结构无效");
  }
  assertNoSensitiveFields(input);
}

function frozenProviders(providerEvidence) {
  const counts = { seerfarApi: 0, browser: 0, standardSkuHealth: 0, keywordMetrics: 0 };
  const usedHealth = new Set();
  const once = (name, value, missingCode) => async () => {
    counts[name] += 1;
    if (counts[name] > 1) throw new Error(`C1_FACT_KEYWORD_RUNTIME_PROVIDER_REUSED:${name}`);
    if (!isObject(value)) throw new Error(`${missingCode}: 缺少已冻结回执，服务端不得现场兜底`);
    return structuredClone(value);
  };
  return {
    counts,
    providers: {
      seerfarApi: once("seerfarApi", providerEvidence.seerfarApiReceipt, "C1_FROZEN_SEERFAR_RECEIPT_MISSING"),
      browser: once("browser", providerEvidence.browserReceipt, "C1_FROZEN_BROWSER_RECEIPT_MISSING"),
      keywordMetrics: once("keywordMetrics", providerEvidence.keywordMetricEvidence, "C1_FROZEN_KEYWORD_METRICS_MISSING"),
      standardSkuHealth: async ({ standardSku }) => {
        counts.standardSkuHealth += 1;
        const receipt = providerEvidence.standardSkuHealthReceipts.find((item) => item?.standardSkuId === standardSku?.id);
        if (!receipt || usedHealth.has(standardSku.id)) {
          throw new Error("C1_FROZEN_STANDARD_SKU_RECEIPT_MISSING: 标准SKU健康回执缺失或被重复使用");
        }
        usedHealth.add(standardSku.id);
        return structuredClone(receipt);
      }
    }
  };
}

export async function prepareC1FactKeywordRuntime(
  { candidateId, skuPackage, input, preparedAt, existingEvidence = null },
  { preparePipeline = prepareC1FactKeywordPipeline } = {}
) {
  validateInput(input);
  if (!nonEmpty(candidateId) || skuPackage?.candidateId !== candidateId) {
    throw new Error("C1_FACT_KEYWORD_RUNTIME_CANDIDATE_DRIFT: 候选与SKU包不一致");
  }
  const { providers, counts } = frozenProviders(input.providerEvidence);
  const result = await preparePipeline({
    candidateId,
    candidateRevision: input.dataRevision,
    skuPackage,
    keywordSourceEvidence: structuredClone(input.keywordSourceEvidence),
    frozenSeoRules: structuredClone(input.frozenSeoRules),
    frozenComplexityDecision: input.frozenComplexityDecision === null ? null : structuredClone(input.frozenComplexityDecision),
    reusableKeywordSnapshot: input.reusableKeywordSnapshot === null ? null : structuredClone(input.reusableKeywordSnapshot),
    preparedAt,
    keywordExpiresAt: input.keywordExpiresAt,
    existingEvidence
  }, providers);
  const receipt = {
    schemaVersion: "c1-fact-keyword-runtime-receipt-v1",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    sourceCandidateRevision: input.dataRevision,
    inputFingerprint: digest(input),
    status: result.status,
    providerReceiptReads: structuredClone(counts),
    externalCallsByRuntime: 0,
    codexDispatches: 0,
    platformWrites: 0,
    automaticRetries: 0,
    completedAt: preparedAt
  };
  receipt.receiptFingerprint = digest(receipt);
  return freeze({ result, receipt });
}
