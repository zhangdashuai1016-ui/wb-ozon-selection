import { readFile } from 'node:fs/promises';

export class WbCommissionReferenceError extends Error {
  constructor(code, cause) {
    super(`WB_COMMISSION_REFERENCE_${code}`, cause === undefined ? undefined : { cause });
    this.name = 'WbCommissionReferenceError';
    this.code = code;
  }
}
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const check = (condition, code) => { if (!condition) throw new WbCommissionReferenceError(code); };
const gap = (code, field, blocking = true) => ({ code, field, blocking });

async function readJson(filePath, code) {
  const bytes = await readFile(filePath);
  check(bytes.length <= 32 * 1024 * 1024, 'FILE_TOO_LARGE');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WbCommissionReferenceError(code, error);
  }
}

function assertSource(source) {
  check(closed(source, ['schemaVersion', 'catalogId', 'catalogVersion', 'platform', 'sellerRegion', 'sourceUrl',
    'acquiredAt', 'sourceReceiptRef', 'sourceField', 'rowCount', 'categoryIdentityField', 'effectiveFrom', 'effectiveTo',
    'salesSchemes', 'priceConditions', 'applicabilityStatus', 'purpose', 'refreshFrequency', 'productionEvidenceCommitted']) &&
    source.schemaVersion === 'commission-reference-source-v1' && source.platform === 'wb' && source.sellerRegion === 'CN' &&
    source.sourceField === 'kgvpChina' && source.categoryIdentityField === 'subjectID' &&
    source.sourceUrl === 'https://common-api.wildberries.ru/api/v1/tariffs/commission' &&
    ['catalogId', 'catalogVersion', 'sourceReceiptRef'].every(key => text(source[key])) && instant(source.acquiredAt) &&
    positiveId(source.rowCount) && source.rowCount <= 100000 &&
    ['effectiveFrom', 'effectiveTo'].every(key => source[key] === null || instant(source[key])) &&
    (source.effectiveFrom === null || source.effectiveTo === null || Date.parse(source.effectiveFrom) < Date.parse(source.effectiveTo)), 'SOURCE_INVALID');
  // Only the saved source contract is supported. Later official applicability must
  // receive its own verified semantics, rather than interpreting arbitrary fields.
  check(source.salesSchemes === null && source.priceConditions === null &&
    source.applicabilityStatus === 'official_mode_and_price_conditions_not_yet_verified' &&
    source.purpose === 'saved_official_reference_not_formal_profit_evidence' &&
    source.refreshFrequency === null && source.productionEvidenceCommitted === false, 'SOURCE_APPLICABILITY_UNSUPPORTED');
}

function indexRows(rows, source) {
  check(Array.isArray(rows) && rows.length === source.rowCount, 'ROW_COUNT_INVALID');
  const indexed = new Map();
  for (const row of rows) {
    check(closed(row, ['parentID', 'parentName', 'subjectID', 'subjectName', 'kgvpChina']) &&
      positiveId(row.parentID) && positiveId(row.subjectID) && text(row.parentName) && text(row.subjectName) &&
      Number.isFinite(row.kgvpChina) && row.kgvpChina >= 0 && row.kgvpChina <= 100, 'ROW_INVALID');
    check(!indexed.has(row.subjectID), 'DUPLICATE_SUBJECT_ID');
    indexed.set(row.subjectID, row);
  }
  return indexed;
}

/**
 * Local lookup only. The caller supplies the current catalog state from its
 * repository on every call; this function owns no status store or hidden cache.
 * A returned rate is reference material, never a ready B evidence pack.
 */
export async function readWbCommissionReference({ catalogPath, sourcePath, scope, versionState, asOf } = {}) {
  check(text(catalogPath) && text(sourcePath) && catalogPath !== sourcePath && instant(asOf) &&
    closed(scope, ['platform', 'sellerRegion', 'subjectId', 'salesScheme']) &&
    text(scope.platform) && text(scope.sellerRegion) && positiveId(scope.subjectId) &&
    (scope.salesScheme === null || text(scope.salesScheme)) &&
    closed(versionState, ['catalogId', 'catalogVersion', 'status']) && text(versionState.catalogId) &&
    text(versionState.catalogVersion) && ['active', 'invalidated'].includes(versionState.status), 'INPUT_INVALID');
  const [rows, source] = await Promise.all([readJson(catalogPath, 'CATALOG_JSON_INVALID'), readJson(sourcePath, 'SOURCE_JSON_INVALID')]);
  assertSource(source);
  const indexed = indexRows(rows, source);
  const base = { formalApplicability: false, commissionRate: null, commissionPercent: null, matchedRow: null,
    source: structuredClone(source), scope: structuredClone(scope), versionState: structuredClone(versionState), checkedAt: asOf };
  const blocked = (status, code, field) => ({ ...base, status, gaps: [gap(code, field)] });
  if (source.catalogId !== versionState.catalogId || source.catalogVersion !== versionState.catalogVersion)
    return blocked('version_mismatch', 'CATALOG_VERSION_MISMATCH', 'versionState');
  if (versionState.status === 'invalidated') return blocked('invalidated', 'CATALOG_VERSION_INVALIDATED', 'versionState.status');
  if (scope.platform !== source.platform || scope.sellerRegion !== source.sellerRegion)
    return blocked('scope_mismatch', 'CATALOG_SCOPE_MISMATCH', 'scope');
  if (Date.parse(source.acquiredAt) > Date.parse(asOf)) return blocked('not_yet_available', 'CATALOG_ACQUIRED_AFTER_LOOKUP', 'source.acquiredAt');
  if (source.effectiveFrom !== null && Date.parse(asOf) < Date.parse(source.effectiveFrom))
    return blocked('not_effective', 'CATALOG_NOT_YET_EFFECTIVE', 'source.effectiveFrom');
  if (source.effectiveTo !== null && Date.parse(asOf) >= Date.parse(source.effectiveTo))
    return blocked('not_effective', 'CATALOG_EFFECTIVE_PERIOD_ENDED', 'source.effectiveTo');
  const row = indexed.get(scope.subjectId);
  if (!row) return blocked('not_found', 'SUBJECT_ID_NOT_FOUND', 'scope.subjectId');
  const gaps = [gap('SALES_SCHEME_APPLICABILITY_UNKNOWN', 'source.salesSchemes'),
    gap('PRICE_CONDITIONS_UNKNOWN', 'source.priceConditions')];
  if (scope.salesScheme === null) gaps.push(gap('SALES_SCHEME_MISSING', 'scope.salesScheme'));
  if (source.effectiveFrom === null || source.effectiveTo === null)
    gaps.push(gap('EFFECTIVE_PERIOD_UNKNOWN', 'source.effectiveFrom/effectiveTo', false));
  if (row.kgvpChina === 100) gaps.push(gap('COMMISSION_RATE_UNSUPPORTED_BY_B', 'matchedRow.kgvpChina'));
  return { ...base, status: 'matched_with_gaps', commissionPercent: row.kgvpChina,
    commissionRate: row.kgvpChina / 100, matchedRow: structuredClone(row), gaps };
}
