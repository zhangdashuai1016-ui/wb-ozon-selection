import { readCurrentGuooTariff } from "./guoo-tariff-reader.mjs";
import { createLifecycleBEvidenceProviderRegistry } from "./lifecycle-b-evidence-providers.mjs";
import { readCurrentCbrExchangeRate } from "./official-fx-reader.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function assertExplicitCostPolicy(value) {
  const fixed = ["packagingRmb", "labelRmb", "fixedOtherRmb"];
  const rates = ["advertisingRate", "returnReserveRate", "damageReserveRate", "withdrawalFeeRate", "targetMarginRate"];
  if (!isObject(value) || fixed.some((key) => !finiteNonNegative(value[key])) ||
      rates.some((key) => !finiteNonNegative(value[key]) || value[key] >= 1) ||
      !finiteNonNegative(value.minimumUnitProfitRmb) ||
      !Number.isFinite(value.priceIncrementCny) || value.priceIncrementCny <= 0 ||
      value.thresholdLogic !== "any" ||
      typeof value.pricingPolicyVersion !== "string" || !value.pricingPolicyVersion.trim()) {
    throw new Error("B_EVIDENCE_COST_POLICY_INCOMPLETE: 其他成本必须来自当前项目配置，禁止填默认值");
  }
  return structuredClone(value);
}

function normalizeCommissionEstimate(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || value.authorized !== true || value.confirmedBy !== "owner") {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 估算佣金必须由主人对当前SKU明确授权");
  }
  const rate = Number(value.commissionRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_INVALID: 估算佣金率必须在0到1之间");
  }
  return Object.freeze({
    authorized: true,
    confirmedBy: "owner",
    commissionRate: rate,
    authorizationRef: String(value.authorizationRef || "").trim() || "owner-current-sku-confirmation",
  });
}

function assertLocalOzonService(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("B_EVIDENCE_OZON_SERVICE_NOT_LOCAL: Ozon凭证服务只允许本机地址");
  }
  return url.origin;
}

async function postOzonEvidence({ request, kind, fetchImpl, ozonServiceUrl }) {
  const response = await fetchImpl(`${assertLocalOzonService(ozonServiceUrl)}/api/read-only/evidence/ozon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...request.scope }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { error: raw.slice(0, 300) };
  }
  if (!response.ok || payload?.ok !== true || !isObject(payload?.evidence)) {
    throw new Error(`OZON_LOCAL_EVIDENCE_FAILED: ${String(payload?.error || `HTTP ${response.status}`).slice(0, 500)}`);
  }
  return payload.evidence;
}

export function createLifecycleBRealEvidenceReaders({
  fetchImpl = globalThis.fetch,
  ozonServiceUrl,
  guooFilePath,
  cbrSourceUrl,
  otherCosts,
  commissionEstimate,
  now = () => new Date(),
} = {}) {
  const explicitOtherCosts = assertExplicitCostPolicy(otherCosts);
  const authorizedEstimate = normalizeCommissionEstimate(commissionEstimate);
  if (!ozonServiceUrl) throw new Error("B_EVIDENCE_OZON_SERVICE_URL_REQUIRED: Ozon证据连接器地址必须由运行配置提供");
  const schemaCache = new Map();
  const readSchema = async (request) => {
    const key = JSON.stringify({
      platform: request.scope.platform,
      store: request.scope.store,
      category: request.scope.category,
    });
    if (!schemaCache.has(key)) {
      schemaCache.set(key, postOzonEvidence({
        request: {
          scope: {
            platform: request.scope.platform,
            store: request.scope.store,
            category: request.scope.category,
            ruleVersion: "ozon-current",
          },
        },
        kind: "schema",
        fetchImpl,
        ozonServiceUrl,
      }));
    }
    return schemaCache.get(key);
  };
  return {
    commission: async (request) => {
      if (authorizedEstimate) {
        const schema = await readSchema(request);
        return {
          current: true,
          scope: structuredClone(request.scope),
          sourceType: "owner_authorized_commission_estimate",
          sourceRef: `${authorizedEstimate.authorizationRef}:${request.candidateId}:${request.candidateRevision}`,
          checkedAt: schema.checkedAt,
          expiresAt: schema.expiresAt,
          evidenceData: {
            commissionRate: authorizedEstimate.commissionRate,
            commissionEvidenceMode: "estimated",
            estimateAuthorized: true,
            exactCommissionRequiredAtC: true,
            descriptionCategoryId: schema.evidenceData.descriptionCategoryId,
            typeId: schema.evidenceData.typeId,
            otherCosts: structuredClone(explicitOtherCosts),
          },
        };
      }
      const result = await postOzonEvidence({ request, kind: "commission", fetchImpl, ozonServiceUrl });
      return {
        ...result,
        evidenceData: {
          ...structuredClone(result.evidenceData),
          commissionEvidenceMode: "exact",
          estimateAuthorized: false,
          exactCommissionRequiredAtC: false,
          otherCosts: structuredClone(explicitOtherCosts),
        },
      };
    },
    schema: (request) => readSchema(request),
    logistics_tariff: (request) => readCurrentGuooTariff({
      scope: request.scope,
      filePath: guooFilePath,
      now,
    }),
    exchange_rate: (request) => readCurrentCbrExchangeRate({
      scope: request.scope,
      fetchImpl,
      now,
      sourceUrl: cbrSourceUrl,
    }),
  };
}

export function createLifecycleBRealEvidenceProviderRegistry(options) {
  return createLifecycleBEvidenceProviderRegistry(createLifecycleBRealEvidenceReaders(options));
}
