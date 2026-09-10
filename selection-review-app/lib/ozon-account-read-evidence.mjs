import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary } from './business-state-repository.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertOzonAccountReadAuthorization, assertOzonAccountReadCredential, assertOzonAccountReadReceipt,
  readOzonAccountReadTerminal, OzonAccountReadError } from './ozon-account-read-contract.mjs';
import { assertOzonDEPreflightEvidence, assertOzonDEPreflightEvidenceScope, OzonDEPreflightEvidenceError } from './ozon-de-preflight-provider.mjs';
import { sameAccountReadRouting, currentOzonAccountReadJobs } from './ozon-account-read-preparation.mjs';
import { createSoftwareJobResultEnvelope } from './software-job-contract.mjs';
import { OZON_PRODUCT_IMPORT_ENDPOINT, OZON_PRODUCT_IMPORT_INFO_ENDPOINT, OZON_INVENTORY_WRITE_ENDPOINT,
  OZON_DE_READBACK_ENDPOINTS } from './ozon-seller-api-de-adapter.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(value, code) { if (!value) throw new OzonDEPreflightEvidenceError(code); }

// Frozen historical source contracts: newer adapters cannot expand old granted method evidence.
const HISTORICAL_ACCOUNT_SOURCE_METHODS=Object.freeze({
  'ozon-de-preflight-evidence-v1':Object.freeze(['/v3/product/import','/v1/product/import/info','/v2/products/stocks',
    '/v4/product/info/attributes','/v3/product/info/list','/v5/product/info/prices','/v4/product/info/stocks','/v3/product/list']),
  'ozon-de-preflight-evidence-v2':Object.freeze(['/v3/product/import','/v1/product/import/info','/v2/products/stocks',
    '/v4/product/info/attributes','/v3/product/info/list','/v5/product/info/prices','/v2/product/info/stocks-by-warehouse/fbs'])
});

function readAccountSource(document, jobId, scope, loadCurrentReadBinding) {
  assertOzonDEPreflightEvidenceScope(scope);
  const candidate = document.candidates.find(value => value.id === scope.candidateId);
  const sku = candidate?.lifecycleV11?.skuPackage, authorization = sku?.productionAuthorization;
  requireValue(authorization?.authorizationId === scope.authorizationId && sku.skuPackageId === scope.skuPackageId &&
    sku.supplierSkuId === scope.supplierSkuId && authorization.sourceCandidateRevision === scope.sourceCandidateRevision, 'ACCOUNT_SOURCE_SCOPE_MISMATCH');
  requireValue(Array.isArray(document.runtime.softwareJobs) && Array.isArray(document.runtime.softwareJobAuthorizationRecords) &&
    Array.isArray(document.runtime.softwareJobCredentialBindings), 'ACCOUNT_SOURCE_REPOSITORY_INVALID');
  const matches = document.runtime.softwareJobs.filter(value => value.jobId === jobId);
  requireValue(matches.length === 1 && matches[0].jobType === 'ozon_account_read', 'ACCOUNT_SOURCE_JOB_INVALID');
  const job = matches[0], receipt = document.runtime.ozonAccountReadReceipts?.[jobId];
  assertOzonAccountReadReceipt(receipt, job);
  const terminal = readOzonAccountReadTerminal(receipt, job), source = receipt.scope;
  requireValue(terminal.status === 'completed' && job.status === 'completed', 'ACCOUNT_SOURCE_NOT_COMPLETED');
  const expectedResult = createSoftwareJobResultEnvelope({ job, resultRef: receipt.receiptId, payloadKind: 'ozon_account_read',
    payload: { schemaVersion: 'ozon-account-read-job-result-v1', receiptRef: receipt.receiptId, scopeFingerprint: source.inputFingerprint },
    recordedAt: receipt.completedAt });
  requireValue(terminal.status === 'completed' && terminal.externalRequestState === 'succeeded' && job.status === 'completed' &&
    job.externalRequestState === 'succeeded' && job.resultRef === receipt.receiptId && isDeepStrictEqual(job.resultEnvelope, expectedResult) &&
    source.candidateId === scope.candidateId && source.skuPackageId === scope.skuPackageId &&
    source.supplierSkuId === scope.supplierSkuId && [scope.sourceCandidateRevision, candidate.dataRevision].includes(source.sourceRevision) &&
    ['storeRef', 'warehouseRef', 'warehouseId', 'credentialAlias', 'bindingId', 'configurationVersion'].every(field => isDeepStrictEqual(source[field], scope[field])), 'ACCOUNT_SOURCE_SCOPE_MISMATCH');
  const permissions = document.runtime.softwareJobAuthorizationRecords.filter(value => value.authorizationId === source.authorizationRef);
  requireValue(permissions.length === 1, 'ACCOUNT_SOURCE_AUTHORIZATION_INVALID');
  const permission = assertOzonAccountReadAuthorization(permissions[0]);
  requireValue(permission.useCount === 1 && permission.consumedByJobId === job.jobId && isDeepStrictEqual(permission.scopeBinding, source) &&
    permission.authorizedByUserId === job.ownerUserId && permission.authorizedByUserId === job.requestedByUserId &&
    Date.parse(permission.authorizedAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt) < Date.parse(permission.expiresAt), 'ACCOUNT_SOURCE_AUTHORIZATION_INVALID');
  const credentials = document.runtime.softwareJobCredentialBindings.filter(value => value.sideEffectScope === 'ozon_account_read' &&
    value.scopeBinding?.authorizationRef === source.authorizationRef);
  requireValue(credentials.length === 1, 'ACCOUNT_SOURCE_CREDENTIAL_INVALID');
  const credential = assertOzonAccountReadCredential(credentials[0]);
  requireValue(isDeepStrictEqual(credential.scopeBinding, source) && credential.allowedWorkerIds.includes(job.workerId) &&
    Date.parse(credential.boundAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.completedAt) < Date.parse(credential.expiresAt), 'ACCOUNT_SOURCE_CREDENTIAL_INVALID');
  const currentBinding = loadCurrentReadBinding({ document, candidateId: candidate.id, skuPackageId: sku.skuPackageId,
    bindingId: source.bindingId, configurationVersion: source.configurationVersion, checkedAt: receipt.completedAt });
  requireValue(currentBinding !== null && sameAccountReadRouting(source, currentBinding), 'ACCOUNT_SOURCE_CONFIGURATION_CHANGED');
  const currentJobs = currentOzonAccountReadJobs({ document, candidate, binding: currentBinding });
  requireValue(currentJobs[0]?.jobId === job.jobId, 'ACCOUNT_SOURCE_SUPERSEDED');
  return { receipt, authorization };
}

/** Only facts established by these three official methods are promoted. Other evidence remains explicitly absent. */
export function composeOzonAccountPreflightEvidence({ scope, receipt, authorization, schemaVersion = 'ozon-de-preflight-evidence-v3' }) {
  requireValue(['ozon-de-preflight-evidence-v1','ozon-de-preflight-evidence-v2','ozon-de-preflight-evidence-v3'].includes(schemaVersion), 'RECORD_INVALID');
  const historical = schemaVersion === 'ozon-de-preflight-evidence-v1';
  const roles = receipt.steps[0].result.facts;
  const availableMethods = new Set(roles.roles.flatMap(role => role.methods));
  const neededMethods = Object.hasOwn(HISTORICAL_ACCOUNT_SOURCE_METHODS,schemaVersion) ? HISTORICAL_ACCOUNT_SOURCE_METHODS[schemaVersion]
    : [...new Set([OZON_PRODUCT_IMPORT_ENDPOINT,OZON_PRODUCT_IMPORT_INFO_ENDPOINT,OZON_INVENTORY_WRITE_ENDPOINT,...Object.values(OZON_DE_READBACK_ENDPOINTS)])];
  const missingMethod = neededMethods.some(method => !availableMethods.has(method));
  const evidenceRef = receipt.receiptId;
  const expiresAt = Date.parse(roles.expiresAt) < Date.parse(receipt.scope.expiresAt) ? roles.expiresAt : receipt.scope.expiresAt;
  const record = {
    schemaVersion,
    evidenceId: `ozon-account-preflight:${fingerprintCanonicalRecord({ authorizationId: authorization.authorizationId, receiptId: receipt.receiptId,
      ...(historical ? {} : { schemaVersion }) })}`,
    scope: structuredClone(scope), collectedAt: receipt.steps.at(-1).result.observedAt, expiresAt,
    provenance: { sourceKind: 'controlled_platform_verification', readAuthorizationRef: receipt.scope.authorizationRef,
      softwareJobRef: receipt.jobId, officialContractRefs: Object.values(receipt.scope.officialContractRefs) },
    inspection: {
      observedStore: scope.storeRef.stableStoreId, observedStoreRef: null, storeIdentityStatus: 'unverified',
      storeIdentityEvidenceRef: `${evidenceRef}:store-identity-not-provided`,
      permissionStatus: missingMethod ? 'denied' : 'verified', permissionEvidenceRef: `${evidenceRef}:roles`,
      connections: {
        api: { status: 'connected', checkedVia: 'controlled_account_read', evidenceRef },
        sellerBackend: { status: 'unknown', checkedVia: 'not_checked', evidenceRef: `${evidenceRef}:backend-not-checked` }
      },
      platformWritableFields: [], imagePermissionStatus: 'unknown', imagePermissionEvidenceRef: `${evidenceRef}:image-protocol-missing`,
      priceFieldCurrency: 'unknown', priceCurrencyEvidenceRef: `${evidenceRef}:backend-price-currency-unverified`,
      risks: [
        ...(missingMethod ? [{ code: 'account_method_permissions_incomplete', message: '当前方法权限未完整覆盖生产与独立回读所需接口。' }] : []),
        { code: 'account_store_identity_not_provided', message: '账户接口未返回店铺编号，仍需当前店铺身份的独立官方证据。' },
        { code: 'account_backend_price_currency_unverified', message: '已读取公司币种，后台写入价格的币种仍需独立证据。' },
        ...(historical ? [{ code: 'account_seller_backend_not_checked', message: '卖家后台连接尚未经过获准的独立核验。' }] : []),
        { code: 'account_write_protocols_missing', message: '商品导入、图片、库存与独立回读协议仍需适用证据。' }
      ]
    },
    protocols: { productImport: null, inventoryWrite: null, independentReadback: null }
  };
  return assertOzonDEPreflightEvidence(record);
}

/** Local repository adapter. No account requests, imported verified claims, or new business permissions. */
export function createOzonAccountReadEvidenceSource({ repository, loadCurrentReadBinding }) {
  assertBusinessStateRepositoryBoundary(repository);
  if (typeof loadCurrentReadBinding !== 'function') throw new OzonAccountReadError('DEPENDENCY_INVALID');
  const reconstruct = (document, record, scope) => {
    const source = readAccountSource(document, record.provenance.softwareJobRef, scope, loadCurrentReadBinding);
    return composeOzonAccountPreflightEvidence({ scope, ...source, schemaVersion: record.schemaVersion });
  };
  function verifySnapshot(document, record, scope) {
    let rebuilt;
    try { rebuilt = reconstruct(document, record, scope); }
    catch (error) {
      if (error instanceof OzonAccountReadError) throw new OzonDEPreflightEvidenceError('ACCOUNT_SOURCE_INVALID');
      throw error;
    }
    requireValue(isDeepStrictEqual(record, rebuilt), 'ACCOUNT_SOURCE_CONTENT_MISMATCH');
    return rebuilt;
  }
  return Object.freeze({
    verifySnapshot,
    async verifySourceReceipt(record, scope) {
      const document = await repository.readSnapshot();
      const rebuilt = verifySnapshot(document, record, scope);
      return { status: 'verified', evidenceId: rebuilt.evidenceId, scope: structuredClone(scope), collectedAt: rebuilt.collectedAt,
        expiresAt: rebuilt.expiresAt, readAuthorizationRef: rebuilt.provenance.readAuthorizationRef,
        softwareJobRef: rebuilt.provenance.softwareJobRef, officialContractRefs: rebuilt.provenance.officialContractRefs };
    },
    async publish({ scope, jobId }) {
      return repository.transact(document => {
        const source = readAccountSource(document, jobId, scope, loadCurrentReadBinding);
        const record = composeOzonAccountPreflightEvidence({ scope, ...source });
        const runtime = document.runtime;
        if (!Object.hasOwn(runtime, 'ozonDEPreflightEvidence')) runtime.ozonDEPreflightEvidence = {};
        if (!Object.hasOwn(runtime, 'ozonDEPreflightEvidenceVersions')) runtime.ozonDEPreflightEvidenceVersions = {};
        requireValue(object(runtime.ozonDEPreflightEvidence) && object(runtime.ozonDEPreflightEvidenceVersions), 'REPOSITORY_INVALID');
        const old = runtime.ozonDEPreflightEvidence[scope.authorizationId];
        if (old && isDeepStrictEqual(old, record)) return { changed: false, result: { status: 'unchanged', evidenceId: record.evidenceId } };
        const history = runtime.ozonDEPreflightEvidenceVersions[scope.authorizationId];
        requireValue(history === undefined || Array.isArray(history), 'REPOSITORY_INVALID');
        const versions = history === undefined ? (old ? [assertOzonDEPreflightEvidence(old)] : []) : history;
        requireValue(!versions.some(value => value.evidenceId === record.evidenceId), 'EVIDENCE_VERSION_CONFLICT');
        runtime.ozonDEPreflightEvidenceVersions[scope.authorizationId] = [...versions, record];
        runtime.ozonDEPreflightEvidence[scope.authorizationId] = record;
        return { changed: true, document, result: { status: 'published', evidenceId: record.evidenceId } };
      });
    }
  });
}
