import { readWbCommissionReference } from './wb-commission-reference-reader.mjs';
import { normalizeEvidenceScope, normalizeRelatedSchemaScope, evidenceScopeMatches, evidenceScopeKey } from "./lifecycle-evidence-scope.mjs";
import { readCurrentGuooTariff } from "./guoo-tariff-reader.mjs";
import { createLifecycleBEvidenceProviderRegistry } from "./lifecycle-b-evidence-providers.mjs";
import { readCurrentCbrExchangeRate } from "./official-fx-reader.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommissionEstimate(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || value.authorized !== true || value.confirmedBy !== "owner") {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 估算佣金必须由主人对当前SKU明确授权");
  }
  const rate = value.commissionRate;
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_INVALID: 估算佣金率必须在0到1之间");
  }
  return Object.freeze({
    authorized: true,
    confirmedBy: "owner",
    commissionRate: rate,
    authorizationRef: typeof value.authorizationRef === "string" ? value.authorizationRef.trim() : null,
    candidateId: value.candidateId,
    candidateRevision: value.candidateRevision,
    scope: value.scope === undefined ? null : structuredClone(value.scope),
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
  });
}

function assertEstimateScopeAndValidity(estimate, request, currentTime) {
  if (!Number.isFinite(currentTime) || !estimate || !estimate.authorizationRef || estimate.candidateId !== request.candidateId ||
      estimate.candidateRevision !== request.candidateRevision || !evidenceScopeMatches("commission", estimate.scope, request.scope)) {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 缺少当前候选、revision和精确范围的单次估算授权");
  }
  if (estimate.effectiveFrom !== undefined || estimate.effectiveTo !== undefined) {
    const from = Date.parse(estimate.effectiveFrom), to = Date.parse(estimate.effectiveTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || currentTime < from || currentTime >= to) {
      throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_EXPIRED: 估算授权不在明确有效时间窗内");
    }
  }
}

function assertExactCommissionUnavailable(result, request, currentTime) {
  if (!Number.isFinite(currentTime) || result.current !== false || result.reasonCode !== "exact_commission_unavailable" ||
      result.evidenceData?.commissionRate !== undefined ||
      typeof result.sourceType !== "string" || !result.sourceType.trim() || typeof result.sourceRef !== "string" || !result.sourceRef.trim() ||
      /token|cookie|password|secret|authorization/i.test(`${result.sourceType} ${result.sourceRef}`) ||
      !Number.isFinite(Date.parse(result.checkedAt)) || !Number.isFinite(Date.parse(request.requestedAt)) ||
      Date.parse(result.checkedAt) < Date.parse(request.requestedAt) || Date.parse(result.checkedAt) > currentTime) {
    throw new Error("B_EVIDENCE_COMMISSION_UNAVAILABLE_INVALID: 不可用必须是本轮同范围明确结果，不能保留佣金数值");
  }
}

function assertLocalOzonService(value) {
  const url = new URL(value);
  if (url.username || url.password || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("B_EVIDENCE_OZON_SERVICE_NOT_LOCAL: Ozon凭证服务只允许本机地址");
  }
  return url.origin;
}

async function postOzonEvidence({ request, kind, fetchImpl, ozonServiceUrl }) {
  const scope = normalizeEvidenceScope(kind, request.scope);
  const response = await fetchImpl(`${assertLocalOzonService(ozonServiceUrl)}/api/read-only/evidence/ozon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...scope, kind }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("OZON_LOCAL_EVIDENCE_INVALID_JSON");
  }
  if (!response.ok || payload?.ok !== true || !isObject(payload?.evidence)) {
    throw new Error(`OZON_LOCAL_EVIDENCE_FAILED: HTTP ${response.status}`);
  }
  if (Object.hasOwn(payload, "status") || (Object.hasOwn(payload.evidence, "status") &&
      !(kind === "commission" && payload.evidence.status === "data_unavailable"))) {
    throw new Error("OZON_LOCAL_EVIDENCE_STATUS_INVALID: 显式失败或未知状态不能作为成功证据");
  }
  if (!evidenceScopeMatches(kind, payload.evidence.scope, scope)) throw new Error("OZON_LOCAL_EVIDENCE_STORE_SCOPE_UNPROVEN");
  if (!(kind === "commission" && payload.evidence.status === "data_unavailable") && payload.evidence.current !== true) throw new Error("OZON_LOCAL_EVIDENCE_NOT_CURRENT");
  return payload.evidence;
}

export function createLifecycleBRealEvidenceReaders({
  fetchImpl = globalThis.fetch,
  ozonServiceUrl,
  guooFilePath,
  cbrSourceUrl,
  commissionEstimate,
  wbCommissionReference,
  now = () => new Date(),
  ...remainingOptions
} = {}) {
  if (Object.hasOwn(remainingOptions, "otherCosts")) {
    throw new Error("B_EVIDENCE_COST_POLICY_MISPLACED: 商品成本必须在当前SKU输入包中冻结，不能传入可复用佣金reader");
  }
  const authorizedEstimate = normalizeCommissionEstimate(commissionEstimate);
  if (!ozonServiceUrl) throw new Error("B_EVIDENCE_OZON_SERVICE_URL_REQUIRED: Ozon证据连接器地址必须由运行配置提供");
  const schemaCache = new Map();
  const readSchema = async (request) => {
    const scope = (request.kind === "commission" ? normalizeRelatedSchemaScope(request.scope, request.relatedSchemaScope) : normalizeEvidenceScope("schema", request.scope));
    const key = evidenceScopeKey("schema", scope);
    if (!schemaCache.has(key)) {
      if (schemaCache.size >= 32) throw new Error("B_EVIDENCE_SCHEMA_CACHE_LIMIT");
      schemaCache.set(key, postOzonEvidence({ request: { scope }, kind: "schema", fetchImpl, ozonServiceUrl }));
    }
    return schemaCache.get(key);
  };
  return {
    commission: async (request) => {
      const scope = normalizeEvidenceScope('commission', request.scope);
      if (scope.platform === 'wb') {
        const match = /^wb:subject:([1-9]\d*)$/.exec(scope.category);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw Object.assign(new Error('B_EVIDENCE_WB_SUBJECT_ID_REQUIRED: 缺少已核实的WB精确subjectID，不能按类目名称或Ozon编号猜测'), { code:'B_EVIDENCE_WB_SUBJECT_ID_REQUIRED' });
        if (!wbCommissionReference || typeof wbCommissionReference.readVersionState !== 'function') {
          throw Object.assign(new Error('B_EVIDENCE_WB_COMMISSION_REFERENCE_REQUIRED: 尚未配置本地官方费表及当前版本状态'), { code:'B_EVIDENCE_WB_COMMISSION_REFERENCE_REQUIRED' });
        }
        const reference = await readWbCommissionReference({catalogPath:wbCommissionReference.catalogPath,sourcePath:wbCommissionReference.sourcePath,
          scope:{platform:'wb',sellerRegion:wbCommissionReference.sellerRegion,subjectId:Number(match[1]),salesScheme:scope.salesScheme},
          versionState:await wbCommissionReference.readVersionState(),asOf:now().toISOString()});
        // The saved source proves the reference percentage, not WB sales-mode/price
        // applicability. Keep this diagnostic separate from the dated B pack contract.
        throw Object.assign(new Error(`B_EVIDENCE_WB_COMMISSION_NOT_FORMAL: 本地费表尚不能形成正式利润证据，缺口：${reference.gaps.filter(gap=>gap.blocking).map(gap=>gap.code).join('、')}`), {
          code:'B_EVIDENCE_WB_COMMISSION_NOT_FORMAL',reference
        });
      }
      if (scope.platform !== 'ozon') throw Object.assign(new Error('B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED'), { code:'B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED' });
      const result = await postOzonEvidence({ request, kind: "commission", fetchImpl, ozonServiceUrl });
      if (result.status === "data_unavailable") {
        assertExactCommissionUnavailable(result, request, now().getTime());
        assertEstimateScopeAndValidity(authorizedEstimate, request, now().getTime());
        const schema = await readSchema(request);
        const estimateTime = now();
        assertEstimateScopeAndValidity(authorizedEstimate, request, estimateTime.getTime());
        normalizeRelatedSchemaScope(request.scope, schema.scope);
        return {
          current: true,
          scope: structuredClone(request.scope),
          sourceType: "owner_authorized_commission_estimate",
          sourceRef: `${authorizedEstimate.authorizationRef}:${request.candidateId}:${request.candidateRevision}`,
          checkedAt: estimateTime.toISOString(),
          expiresAt: authorizedEstimate.effectiveTo === undefined ? schema.expiresAt :
            new Date(Math.min(Date.parse(schema.expiresAt), Date.parse(authorizedEstimate.effectiveTo))).toISOString(),
          evidenceData: {
            commissionRate: authorizedEstimate.commissionRate,
            commissionEvidenceMode: "estimated",
            commissionEstimateAuthorization: {
              schemaVersion: "commission-estimate-authorization-v1",
              candidateId: request.candidateId,
              candidateRevision: request.candidateRevision,
              authorizationRef: authorizedEstimate.authorizationRef,
              commissionRate: authorizedEstimate.commissionRate,
            },
            estimateAuthorized: true,
            exactCommissionRequiredAtC: true,
            descriptionCategoryId: schema.evidenceData.descriptionCategoryId,
            typeId: schema.evidenceData.typeId,
          },
        };
      }
      if (isObject(result.evidenceData) && Object.hasOwn(result.evidenceData, "otherCosts")) {
        throw new Error("B_EVIDENCE_COMMISSION_COSTS_UNEXPECTED: 佣金来源不得携带商品成本");
      }
      const exactTime = now().getTime();
      if (!Number.isFinite(exactTime) || result.evidenceData?.estimateAuthorized === true || result.evidenceData?.exactCommissionRequiredAtC === true ||
          (Object.hasOwn(result.evidenceData || {}, "commissionEvidenceMode") && result.evidenceData.commissionEvidenceMode !== "exact") ||
          !Number.isFinite(result.evidenceData?.commissionRate) || result.evidenceData.commissionRate < 0 || result.evidenceData.commissionRate >= 1 ||
          !Number.isFinite(Date.parse(result.checkedAt)) || Date.parse(result.checkedAt) > exactTime ||
          !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= exactTime) {
        throw new Error("B_EVIDENCE_COMMISSION_INVALID: 精确佣金数值、模式或时效无效");
      }
      return {
        ...result,
        evidenceData: {
          ...structuredClone(result.evidenceData),
          commissionEvidenceMode: "exact",
          estimateAuthorized: false,
          exactCommissionRequiredAtC: false,
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
