import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { isCompleteStoreRef, sameStoreRef } from './store-binding.mjs';
import { evidenceScopeMatches } from './lifecycle-evidence-scope.mjs';
import { isLifecycleEvidenceTraceValid, validateLifecycleEvidenceData } from './lifecycle-b-input-bundle.mjs';
import { inspectLifecycleEvidenceValidity } from './lifecycle-evidence-validity.mjs';
import { refreshC1FrozenPlatformSchema, C1FrozenSchemaRefreshError } from './c1-frozen-schema-refresh.mjs';
import { hasUnsettledC1ColorDictionaryRead } from './c1-final-plan-revision-preparation.mjs';

const MAX_HISTORY = 16;
const PROVIDER_RESPONSE_ERRORS = new Set(['B_EVIDENCE_PROVIDER_EMPTY_RESULT', 'B_EVIDENCE_PROVIDER_NOT_CURRENT',
  'B_EVIDENCE_PROVIDER_SCOPE_MISMATCH', 'B_EVIDENCE_PROVIDER_TRACE_MISSING', 'B_EVIDENCE_PROVIDER_SECRET_REJECTED',
  'B_EVIDENCE_PROVIDER_VALIDITY_INVALID', 'B_EVIDENCE_PROVIDER_DATA_INVALID']);
const nonEmpty = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const fail = code => { throw new C1SchemaRefreshError(code); };

export class C1SchemaRefreshError extends Error {
  constructor(code, { requestSent = false, cause = null } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'C1SchemaRefreshError';
    this.code = code;
    this.requestSent = requestSent;
  }
}

function owner(actor) {
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
    fail('C1_SCHEMA_REFRESH_OWNER_REQUIRED');
  }
}

function validateInput(input, continuing = false) {
  const keys = continuing ? 'authorizationId,candidateId,expectedRevision,skuPackageId'
    : 'candidateId,expectedRevision,skuPackageId';
  if (!input || Object.keys(input).sort().join(',') !== keys || !nonEmpty(input.candidateId) ||
      !nonEmpty(input.skuPackageId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      continuing && !nonEmpty(input.authorizationId)) fail('C1_SCHEMA_REFRESH_INPUT_INVALID');
}

function scope(candidate, skuPackageId) {
  if (hasUnsettledC1ColorDictionaryRead(candidate.lifecycleV11)) fail('C1_SCHEMA_REFRESH_DICTIONARY_READ_UNSETTLED');
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const schema = plan?.inputSnapshots?.platformSchemaRules;
  if (candidate.targetPlatform !== 'ozon' || sku?.targetPlatform !== 'ozon' ||
      sku.targetStore !== candidate.targetStore || sku.skuPackageId !== skuPackageId ||
      !nonEmpty(sku.supplierSkuId) || !Number.isSafeInteger(sku.dataRevision) || sku.dataRevision < 0 ||
      sku.businessPhase !== 'C1' || sku.productionAuthorization || sku.productionRecord ||
      sku.externalListingRecord || plan?.status !== 'inputs_ready' || !nonEmpty(plan.c1PlanId) ||
      !isCompleteStoreRef(candidate.storeRef, candidate.targetStore) ||
      sku.g1Identity?.candidateId !== candidate.id || sku.g1Identity.skuPackageId !== skuPackageId ||
      sku.g1Identity.supplierSkuId !== sku.supplierSkuId || sku.g1Identity.platform !== 'ozon' ||
      !sameStoreRef(sku.g1Identity?.storeRef, candidate.storeRef) || schema?.platform !== 'ozon' ||
      schema.store !== candidate.targetStore || !sameStoreRef(schema.storeRef, candidate.storeRef) ||
      !nonEmpty(schema.ruleVersion) || !nonEmpty(schema.schemaRevision) || !nonEmpty(schema.evidenceId) ||
      !Number.isSafeInteger(Number(schema.descriptionCategoryId)) || Number(schema.descriptionCategoryId) <= 0 ||
      !Number.isSafeInteger(Number(schema.typeId)) || Number(schema.typeId) <= 0 ||
      plan.inputRefs?.platformSchemaEvidenceId !== schema.evidenceId ||
      plan.frozenInputRefs?.schemaSnapshotRef !== schema.evidenceId || plan.schemaSnapshotRef !== schema.evidenceId ||
      candidate.siblingSourceV1 && candidate.siblingSourceV1.supplierSkuId !== sku.supplierSkuId) {
    fail('C1_SCHEMA_REFRESH_SCOPE_INVALID');
  }
  return { sku, plan, schema, category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}` };
}

function current(candidate, authorizationId, skuPackageId) {
  const record = candidate.lifecycleV11?.c1SchemaRefreshV1;
  if (record?.schemaVersion !== 'c1-schema-refresh-v1' || record.authorizationId !== authorizationId ||
      record.candidateId !== candidate.id || record.skuPackageId !== skuPackageId) {
    fail('C1_SCHEMA_REFRESH_AUTHORIZATION_MISSING');
  }
  const { sku, plan, schema, category } = scope(candidate, skuPackageId);
  if (record.supplierSkuId !== sku.supplierSkuId || record.sourceSkuRevision !== sku.dataRevision ||
      record.c1PlanId !== plan.c1PlanId || record.schemaEvidenceId !== schema.evidenceId ||
      record.schemaRevision !== schema.schemaRevision || record.schemaRuleVersion !== schema.ruleVersion ||
      record.category !== category || record.store !== schema.store || !sameStoreRef(record.storeRef, schema.storeRef) ||
      record.maximumProviderCalls !== 1 || record.maxExternalRequests !== 2 || record.maxUses !== 1 ||
      record.readOnly !== true || record.platformWritesAllowed !== false ||
      !Number.isSafeInteger(record.sourceCandidateRevision) || record.sourceCandidateRevision < 0 ||
      !Number.isFinite(Date.parse(record.authorizedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) ||
      Date.parse(record.expiresAt) <= Date.parse(record.authorizedAt) ||
      !Array.isArray(record.readOperations) || record.readOperations.join(',') !== 'category_schema_ru,category_schema_zh') {
    fail('C1_SCHEMA_REFRESH_SCOPE_CHANGED');
  }
  return record;
}

function requestFor(record) {
  return {
    requestVersion: 'c1-frozen-schema-refresh-v1', candidateId: record.candidateId,
    candidateRevision: record.sourceCandidateRevision, kind: 'schema',
    scope: { platform: 'ozon', store: record.store, storeRef: structuredClone(record.storeRef),
      category: record.category, ruleVersion: record.schemaRuleVersion },
    relatedSchemaScope: null, commissionReferenceScope: null,
    maximumAttempts: 1, maxExternalRequests: record.maxExternalRequests,
    readOnly: true, platformWritesAllowed: false, requestedAt: record.requestedAt
  };
}

function validateRead(pack, record, skuPackage, observedAt) {
  if (pack?.kind !== 'schema' || !nonEmpty(pack.id) || !isLifecycleEvidenceTraceValid(pack) ||
      !validateLifecycleEvidenceData('schema', pack.evidenceData).valid ||
      !evidenceScopeMatches('schema', pack.scope, requestFor(record).scope) ||
      Date.parse(pack.checkedAt) < Date.parse(record.requestedAt) ||
      inspectLifecycleEvidenceValidity(pack, { asOf: observedAt }).usable !== true) {
    fail('C1_SCHEMA_REFRESH_EVIDENCE_INVALID');
  }
  refreshC1FrozenPlatformSchema({ skuPackage, freshPack: pack, refreshedAt: observedAt });
  return structuredClone(pack);
}

/** One explicit owner action, with a durable send boundary and no restart replay. */
export function createC1SchemaRefreshUseCase({ repository, runtimeMode, serverClock, schemaProvider }) {
  if (!repository || typeof serverClock !== 'function' || typeof schemaProvider !== 'function') {
    throw new TypeError('C1_SCHEMA_REFRESH_DEPENDENCY_INVALID');
  }
  return Object.freeze({
    async adoptSaved({ actor, input }) {
      owner(actor);
      if (!input || Object.keys(input).sort().join(',') !== 'candidateId,evidencePackId,expectedRevision,skuPackageId' ||
          !nonEmpty(input.evidencePackId)) fail('C1_SCHEMA_REFRESH_INPUT_INVALID');
      validateInput({ candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision });
      const key = `c1-schema-adopt:${input.candidateId}:${input.expectedRevision}:${input.evidencePackId}`;
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
        action: 'adopt_saved_c1_schema', candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: key,
        inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }),
        auditEventId: `${key}:audit`, serverClock,
        mutate: ({ candidate, evidencePacks, observedAt }) => {
          const { sku, schema, category } = scope(candidate, input.skuPackageId);
          const previous = candidate.lifecycleV11.c1SchemaRefreshV1;
          if (previous && !['succeeded', 'failed'].includes(previous.status)) fail('C1_SCHEMA_REFRESH_UNSETTLED_READ');
          const matches = Array.isArray(evidencePacks) ? evidencePacks.filter(pack => pack.id === input.evidencePackId) : [];
          const pack = matches[0];
          if (matches.length !== 1 || pack.kind !== 'schema' || !isLifecycleEvidenceTraceValid(pack) ||
              !validateLifecycleEvidenceData('schema', pack.evidenceData).valid ||
              !evidenceScopeMatches('schema', pack.scope, { platform: schema.platform, store: schema.store,
                storeRef: schema.storeRef, category, ruleVersion: schema.ruleVersion }) ||
              inspectLifecycleEvidenceValidity(pack, { asOf: observedAt }).usable !== true) {
            fail('C1_SCHEMA_REFRESH_SAVED_EVIDENCE_INVALID');
          }
          let refreshed;
          try {
            refreshed = refreshC1FrozenPlatformSchema({ skuPackage: sku, freshPack: pack, refreshedAt: observedAt });
          } catch (error) {
            if (!(error instanceof C1FrozenSchemaRefreshError)) throw error;
            fail('C1_SCHEMA_REFRESH_SAVED_EVIDENCE_INVALID');
          }
          candidate.lifecycleV11.skuPackage = refreshed.skuPackage;
          return { candidate, result: { status: 'succeeded', change: refreshed.change, evidencePackId: pack.id,
            providerCalls: 0, externalRequests: 0, platformWrites: 0, paidCalls: 0 } };
        } });
    },
    async authorize({ actor, input }) {
      owner(actor);
      validateInput(input);
      const key = `c1-schema-refresh:${input.candidateId}:${input.expectedRevision}`;
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
        action: 'authorize_c1_schema_refresh', candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: key,
        inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }),
        auditEventId: `${key}:audit`, serverClock,
        mutate: ({ candidate, observedAt }) => {
          const { sku, plan, schema, category } = scope(candidate, input.skuPackageId);
          const previous = candidate.lifecycleV11.c1SchemaRefreshV1;
          if (previous) {
            const unusedExpired = previous.status === 'authorized' && previous.useCount === 0 &&
              Date.parse(previous.expiresAt) <= Date.parse(observedAt);
            const settled = ['succeeded', 'failed'].includes(previous.status) && previous.useCount === 1 &&
              nonEmpty(previous.settledAt);
            if (!unusedExpired && !settled) fail('C1_SCHEMA_REFRESH_ALREADY_AUTHORIZED');
            const history = candidate.lifecycleV11.c1SchemaRefreshHistoryV1 ?? [];
            if (!Array.isArray(history) || history.length >= MAX_HISTORY) fail('C1_SCHEMA_REFRESH_HISTORY_CAPACITY_REACHED');
            candidate.lifecycleV11.c1SchemaRefreshHistoryV1 = [
              ...history, { ...structuredClone(previous), supersededAt: observedAt }
            ];
          }
          const record = {
            schemaVersion: 'c1-schema-refresh-v1', authorizationId: key, status: 'authorized',
            candidateId: candidate.id, skuPackageId: sku.skuPackageId, supplierSkuId: sku.supplierSkuId,
            sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: sku.dataRevision,
            c1PlanId: plan.c1PlanId, schemaEvidenceId: schema.evidenceId, schemaRevision: schema.schemaRevision,
            schemaRuleVersion: schema.ruleVersion, store: schema.store, storeRef: structuredClone(schema.storeRef), category,
            authorizedByUserId: actor.userId, authorizedAt: observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 10 * 60_000).toISOString(),
            maximumProviderCalls: 1, maxExternalRequests: 2, readOperations: ['category_schema_ru', 'category_schema_zh'],
            readOnly: true, platformWritesAllowed: false, maxUses: 1, useCount: 0,
            externalRequestRef: null, requestedAt: null, settledAt: null, evidencePackId: null, failureCode: null
          };
          candidate.lifecycleV11.c1SchemaRefreshV1 = record;
          return { candidate, result: { authorizationId: key, status: record.status,
            providerCalls: 0, externalRequests: 0, maxExternalRequests: 2, platformWrites: 0, paidCalls: 0 } };
        } });
    },
    async continueSaved({ actor, input }) {
      owner(actor);
      validateInput(input, true);
      const claimKey = `${input.authorizationId}:claim`;
      const externalRequestRef = `${input.authorizationId}:request`;
      const claim = await executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
        action: 'claim_c1_schema_refresh', candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: claimKey,
        inputFingerprint: fingerprintCanonicalRecord({ input, ownerUserId: actor.userId }),
        auditEventId: `${claimKey}:audit`, authorizationRef: input.authorizationId,
        externalRequestState: 'unknown_outcome', externalRequestRef, serverClock,
        mutate: ({ candidate, observedAt }) => {
          const record = current(candidate, input.authorizationId, input.skuPackageId);
          if (record.status !== 'authorized' || record.useCount !== 0 ||
              candidate.dataRevision !== record.sourceCandidateRevision + 1 || actor.userId !== record.authorizedByUserId ||
              Date.parse(observedAt) >= Date.parse(record.expiresAt)) fail('C1_SCHEMA_REFRESH_AUTHORIZATION_NOT_CURRENT');
          record.status = 'request_sent'; record.useCount = 1;
          record.externalRequestRef = externalRequestRef; record.requestedAt = observedAt;
          return { candidate, result: { authorizationId: record.authorizationId, status: record.status,
            providerCalls: 0, externalRequests: 0, maxExternalRequests: 2, platformWrites: 0, paidCalls: 0 } };
        } });
      if (claim.status !== 'committed') return claim;
      const record = current(claim.candidate, input.authorizationId, input.skuPackageId);
      let readOutcome;
      try {
        const read = await schemaProvider(requestFor(record));
        readOutcome = { status: 'returned', read };
      } catch (error) {
        // Only the provider's explicit response-validation codes prove a returned
        // response. Generic read failures cannot prove how far RU/ZH requests got.
        readOutcome = PROVIDER_RESPONSE_ERRORS.has(error?.code)
          ? { status: 'failed', pack: null, failureCode: 'C1_SCHEMA_REFRESH_PROVIDER_RESPONSE_INVALID' }
          : { status: 'unknown_outcome', pack: null, failureCode: 'C1_SCHEMA_REFRESH_UNKNOWN_OUTCOME' };
      }
      if (readOutcome.status === 'returned') {
        try {
          readOutcome = { status: 'succeeded', pack: validateRead(readOutcome.read, record,
            claim.candidate.lifecycleV11.skuPackage, new Date(serverClock()).toISOString()), failureCode: null };
        } catch (error) {
          if (!(error instanceof C1SchemaRefreshError) && !(error instanceof C1FrozenSchemaRefreshError)) {
            throw new C1SchemaRefreshError('C1_SCHEMA_REFRESH_SETTLEMENT_UNCONFIRMED', { requestSent: true, cause: error });
          }
          readOutcome = { status: 'failed', pack: null, failureCode: 'C1_SCHEMA_REFRESH_EVIDENCE_INVALID' };
        }
      }
      const { status, pack, failureCode } = readOutcome;
      const settleKey = `${input.authorizationId}:settle`;
      try {
        return await executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
          action: 'settle_c1_schema_refresh', candidateId: input.candidateId, skuPackageId: input.skuPackageId,
          expectedRevision: claim.candidate.dataRevision, idempotencyKey: settleKey,
          inputFingerprint: fingerprintCanonicalRecord({ status, pack, failureCode }), auditEventId: `${settleKey}:audit`,
          authorizationRef: input.authorizationId, externalRequestState: status, externalRequestRef, serverClock,
          mutate: ({ candidate, observedAt }) => {
            const saved = current(candidate, input.authorizationId, input.skuPackageId);
            if (saved.status !== 'request_sent' || saved.useCount !== 1 ||
                candidate.dataRevision !== saved.sourceCandidateRevision + 2 || saved.externalRequestRef !== externalRequestRef) {
              fail('C1_SCHEMA_REFRESH_SETTLEMENT_CONFLICT');
            }
            let change = null;
            if (pack) {
              const refreshed = refreshC1FrozenPlatformSchema({ skuPackage: candidate.lifecycleV11.skuPackage,
                freshPack: pack, refreshedAt: observedAt });
              candidate.lifecycleV11.skuPackage = refreshed.skuPackage;
              change = refreshed.change;
            }
            saved.status = status; saved.settledAt = observedAt;
            saved.evidencePackId = pack?.id ?? null;
            saved.failureCode = failureCode;
            return { candidate, ...(pack ? { evidencePacksToCommit: [pack] } : {}), result: {
              authorizationId: saved.authorizationId, status, change, failureCode, evidencePackId: saved.evidencePackId,
              providerCalls: 1, externalRequests: null, maxExternalRequests: 2, platformWrites: 0, paidCalls: 0
            } };
          } });
      } catch (error) {
        throw new C1SchemaRefreshError('C1_SCHEMA_REFRESH_SETTLEMENT_UNCONFIRMED', { requestSent: true, cause: error });
      }
    }
  });
}
