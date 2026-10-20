import { isDeepStrictEqual } from 'node:util';
import { readOwnerProductFacts, OWNER_PRODUCT_FACT_LABELS, OwnerProductFactsError } from './owner-product-facts.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { assertNoProductionSecrets, assertNoRawPersistenceKeys, isCanonicalFrozenRef } from './production-contract-primitives.mjs';

export const C1_SIBLING_SHARED_FACTS_VERSION = 'c1-sibling-shared-facts-v1';
export class C1SiblingSharedFactsError extends Error {
  constructor(code) { super(code); this.name = 'C1SiblingSharedFactsError'; this.code = code; }
}
const fail = code => { throw new C1SiblingSharedFactsError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const scalar = value => text(value) || typeof value === 'number' && Number.isFinite(value);
const NON_SHARED_FIELDS = new Set(['颜色', '尺码', '规格', '品牌', '有可授权的自有品牌', 'quantityOneEvidence', 'purchaseCostComponents']);
const fields = (plan, group) => plan.productAttributes?.[group] ?? [];

function usedFields(parent) {
  const plan = parent.lifecycleV11.skuPackage.c1ProductPlan;
  const paths = [plan.seoTitleDraft, plan.descriptionDraft, ...plan.bulletPointsDraft,
    ...plan.searchKeywordsDraft.keywords].flatMap(piece => piece.factRefs);
  paths.push(...(plan.seoEvidenceLayer.russianAttributes ?? []).map(item => item.factPath),
    ...(parent.lifecycleV11.skuPackage.ozonAttributeMappingsV1?.mappings ?? [])
      .filter(item => !['10096', '10097'].includes(String(item.attributeId))).map(item => item.sourceFactPath));
  const result = { supplierAttributes: new Set(), ownerDeclaredFacts: new Set() };
  for (const path of paths) {
    const match = /^productAttributes\.(supplierAttributes|ownerDeclaredFacts)\.(\d+)\.fact$/.exec(path);
    if (!match) continue;
    const entry = fields(plan, match[1])[Number(match[2])];
    if (!entry || fields(plan, match[1]).filter(item => item.fieldKey === entry.fieldKey).length !== 1) {
      fail('C1_SIBLING_SHARED_SOURCE_FIELD_INVALID');
    }
    if (match[1] !== 'supplierAttributes' || !NON_SHARED_FIELDS.has(entry.fieldKey)) result[match[1]].add(entry.fieldKey);
  }
  return Object.fromEntries(Object.entries(result).map(([group, keys]) => [group, [...keys].sort()]));
}

function sourceBinding(parent) {
  const sku = parent.lifecycleV11.skuPackage;
  return { identity: structuredClone(sku.g1Identity), candidateRevision: parent.dataRevision,
    skuRevision: sku.dataRevision, variantKey: sku.variantKey, supplySnapshotId: sku.selectedSupplySnapshot.snapshotId };
}

function readBoundOwnerDeclaration(source, declaration) {
  if (declaration === null) return null;
  const identity = source.identity;
  const candidate = { id: identity.candidateId, dataRevision: source.candidateRevision,
    targetPlatform: identity.platform, targetStore: identity.storeRef.stableStoreId, storeRef: identity.storeRef,
    lifecycleV11: { ownerProductFactsV1: declaration, skuPackage: { dataRevision: source.skuRevision,
      skuPackageId: identity.skuPackageId, supplierSkuId: identity.supplierSkuId,
      targetPlatform: identity.platform, g1Identity: identity, variantKey: source.variantKey,
      selectedSupplySnapshot: { snapshotId: source.supplySnapshotId,
        supplierSku: { supplierSkuId: identity.supplierSkuId, variantKey: source.variantKey },
        ownerSupplyConfirmation: { status: 'confirmed', supplierSkuId: identity.supplierSkuId, variantKey: source.variantKey } } } } };
  try { return readOwnerProductFacts(candidate); }
  catch (error) {
    if (!(error instanceof OwnerProductFactsError)) throw error;
    fail('C1_SIBLING_SHARED_OWNER_SOURCE_MISMATCH');
  }
}

/** Pure input preparation. Only the batch owner-confirmation transaction persists this record. */
export function createC1SiblingSharedFactRevision({ parent, candidate, confirmedByUserId, preparedAt }) {
  const keys = usedFields(parent), sku = candidate.lifecycleV11.skuPackage, plan = sku.c1ProductPlan;
  const frozen = plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes;
  const needed = keys.supplierAttributes.filter(key => !Object.hasOwn(frozen, key));
  if (!needed.length && !keys.ownerDeclaredFacts.length) return null;
  const parentSku = parent.lifecycleV11.skuPackage, capture = parent.sourceCapture;
  if (candidate.siblingSourceV1?.parentCandidateId !== parent.id ||
      candidate.siblingSourceV1.supplierSkuId !== sku.supplierSkuId ||
      candidate.sourceCapture?.captureId !== capture?.captureId || candidate.sourceCapture?.offerId !== capture?.offerId ||
      !capture?.selectedSkuIds?.includes(sku.supplierSkuId) || !sameStoreRef(parent.storeRef, candidate.storeRef) ||
      parentSku.g1Identity.candidateId !== parent.id || parentSku.g1Identity.supplierSkuId !== parentSku.supplierSkuId ||
      !sameStoreRef(parentSku.g1Identity.storeRef, parent.storeRef) ||
      parentSku.selectedSupplySnapshot.supplierOption.offerId !== capture.offerId ||
      parentSku.selectedSupplySnapshot.ownerSupplyConfirmation.status !== 'confirmed' ||
      parentSku.selectedSupplySnapshot.ownerSupplyConfirmation.supplierSkuId !== parentSku.supplierSkuId ||
      parentSku.selectedSupplySnapshot.supplierSku.attributes.quantityOneEvidence?.captureId !== capture.captureId ||
      parent.targetPlatform !== candidate.targetPlatform || !text(confirmedByUserId) || !timestamp(preparedAt) ||
      plan.sourceFactsRevision !== undefined) fail('C1_SIBLING_SHARED_SCOPE_MISMATCH');
  const supplierFacts = needed.map(fieldKey => {
    const matches = fields(parentSku.c1ProductPlan, 'supplierAttributes').filter(item => item.fieldKey === fieldKey);
    const value = capture.supplierAttributes?.[fieldKey];
    if (matches.length !== 1 || matches[0].fact.verificationStatus !== 'confirmed' || !scalar(value) ||
        !isDeepStrictEqual(value, matches[0].fact.value) ||
        !isDeepStrictEqual(value, parentSku.selectedSupplySnapshot.supplierSku.attributes[fieldKey]) ||
        !isDeepStrictEqual(value, candidate.sourceCapture.supplierAttributes?.[fieldKey])) {
      fail('C1_SIBLING_SHARED_CAPTURE_FACT_MISMATCH');
    }
    return { fieldKey, value, sourceRefs: [...matches[0].fact.sourceRefs,
      `${capture.captureId}#/supplierAttributes`] };
  });
  const declaration = keys.ownerDeclaredFacts.length ? readOwnerProductFacts(parent) : null;
  for (const key of keys.ownerDeclaredFacts) {
    const matches = fields(parentSku.c1ProductPlan, 'ownerDeclaredFacts').filter(item => item.fieldKey === key);
    if (declaration === null || declaration.facts[key] === null || matches.length !== 1 ||
        matches[0].fact.verificationStatus !== 'confirmed' ||
        !isDeepStrictEqual(matches[0].fact.value, declaration.facts[key]) ||
        !matches[0].fact.sourceRefs.includes(`${declaration.declarationId}#/facts/${key}`)) {
      fail('C1_SIBLING_SHARED_OWNER_SOURCE_MISMATCH');
    }
  }
  const record = { schemaVersion: C1_SIBLING_SHARED_FACTS_VERSION,
    revisionId: `sibling-c1-shared-facts:${candidate.id}:${candidate.dataRevision}`,
    targetC1PlanId: plan.c1PlanId, sourceIdentity: structuredClone(sku.g1Identity),
    targetCandidateRevision: candidate.dataRevision, targetSkuRevision: sku.dataRevision,
    targetSupplySnapshotId: sku.selectedSupplySnapshot.snapshotId, preparedAt,
    family: { parentCandidateId: parent.id, captureId: capture.captureId, offerId: capture.offerId },
    source: sourceBinding(parent), sourceOwnerDeclaration: declaration, supplierFacts,
    ownerConfirmation: { status: 'confirmed', confirmedByUserId, confirmedAt: preparedAt,
      sourceCandidateRevision: candidate.dataRevision, resultCandidateRevision: candidate.dataRevision + 1,
      adoptedSupplierFieldKeys: needed, adoptedOwnerFieldKeys: keys.ownerDeclaredFacts, productionAuthorized: false } };
  resolveC1SiblingSharedFactRevision({ plan: { ...plan, sourceFactsRevision: record }, sourceIdentity: sku.g1Identity });
  return record;
}

/** Rebuild facts from the saved source and the exact child-scoped batch decision; never relabel a parent's declaration. */
export function resolveC1SiblingSharedFactRevision({ plan, sourceIdentity }) {
  const record = plan.sourceFactsRevision, supply = plan.inputSnapshots.confirmedSupplierSkuSnapshot;
  if (!exact(record, ['schemaVersion', 'revisionId', 'targetC1PlanId', 'sourceIdentity', 'targetCandidateRevision',
    'targetSkuRevision', 'targetSupplySnapshotId', 'preparedAt', 'family', 'source', 'sourceOwnerDeclaration',
    'supplierFacts', 'ownerConfirmation']) || record.schemaVersion !== C1_SIBLING_SHARED_FACTS_VERSION ||
      !exact(record.family, ['parentCandidateId', 'captureId', 'offerId']) ||
      !exact(record.source, ['identity', 'candidateRevision', 'skuRevision', 'variantKey', 'supplySnapshotId']) ||
      !isCanonicalFrozenRef(record.revisionId) || record.revisionId !== `sibling-c1-shared-facts:${sourceIdentity?.candidateId}:${record.targetCandidateRevision}` ||
      record.targetC1PlanId !== plan.c1PlanId || !isDeepStrictEqual(record.sourceIdentity, sourceIdentity) ||
      sourceIdentity?.candidateId !== plan.frozenInputRefs.candidateId || sourceIdentity?.skuPackageId !== plan.identity.skuPackageId ||
      sourceIdentity?.supplierSkuId !== plan.identity.supplierSkuId || sourceIdentity?.platform !== plan.identity.targetPlatform ||
      !sameStoreRef(sourceIdentity?.storeRef, plan.inputSnapshots.platformSchemaRules.storeRef) ||
      record.source.identity?.schemaVersion !== 'g1-identity-v1' ||
      record.family.parentCandidateId !== record.source.identity.candidateId ||
      record.source.identity.candidateId === sourceIdentity.candidateId || record.source.identity.supplierSkuId === sourceIdentity.supplierSkuId ||
      record.source.identity.platform !== sourceIdentity.platform || !sameStoreRef(record.source.identity.storeRef, sourceIdentity.storeRef) ||
      !revision(record.targetCandidateRevision) || !revision(record.source.candidateRevision) ||
      !Number.isSafeInteger(record.targetSkuRevision) || record.targetSkuRevision < 1 ||
      record.targetSkuRevision !== plan.revisionRefs.resultRevision ||
      !Number.isSafeInteger(record.source.skuRevision) || record.source.skuRevision < 1 ||
      !text(record.source.variantKey) || !isCanonicalFrozenRef(record.source.supplySnapshotId) ||
      record.targetSupplySnapshotId !== supply.snapshotId || supply.ownerSupplyConfirmation.status !== 'confirmed' ||
      [supply.supplierSku, supply.ownerSupplyConfirmation].some(item => item.supplierSkuId !== sourceIdentity.supplierSkuId || item.variantKey !== plan.identity.variantKey) ||
      supply.supplierOptionIdentity.offerId !== record.family.offerId ||
      supply.supplierSku.attributes.quantityOneEvidence?.captureId !== record.family.captureId ||
      !timestamp(record.preparedAt)) fail('C1_SIBLING_SHARED_SCOPE_MISMATCH');
  const confirmation = record.ownerConfirmation;
  if (!exact(confirmation, ['status', 'confirmedByUserId', 'confirmedAt', 'sourceCandidateRevision', 'resultCandidateRevision',
    'adoptedSupplierFieldKeys', 'adoptedOwnerFieldKeys', 'productionAuthorized']) || confirmation.status !== 'confirmed' ||
      !text(confirmation.confirmedByUserId) || confirmation.confirmedAt !== record.preparedAt ||
      confirmation.sourceCandidateRevision !== record.targetCandidateRevision ||
      confirmation.resultCandidateRevision !== record.targetCandidateRevision + 1 || confirmation.productionAuthorized !== false ||
      !Array.isArray(confirmation.adoptedSupplierFieldKeys) || !Array.isArray(confirmation.adoptedOwnerFieldKeys) ||
      confirmation.adoptedSupplierFieldKeys.length + confirmation.adoptedOwnerFieldKeys.length === 0 ||
      !confirmation.adoptedSupplierFieldKeys.every(key => text(key) && !NON_SHARED_FIELDS.has(key)) ||
      !confirmation.adoptedOwnerFieldKeys.every(key => Object.hasOwn(OWNER_PRODUCT_FACT_LABELS, key)) ||
      [confirmation.adoptedSupplierFieldKeys, confirmation.adoptedOwnerFieldKeys].some(keys => new Set(keys).size !== keys.length)) {
    fail('C1_SIBLING_SHARED_OWNER_CONFIRMATION_INVALID');
  }
  if (!Array.isArray(record.supplierFacts) || record.supplierFacts.length > 100 ||
      record.supplierFacts.some(item => !exact(item, ['fieldKey', 'value', 'sourceRefs']) || !scalar(item.value) ||
        !Array.isArray(item.sourceRefs) || !item.sourceRefs.every(isCanonicalFrozenRef) ||
        !item.sourceRefs.includes(`${record.family.captureId}#/supplierAttributes`)) ||
      !isDeepStrictEqual(record.supplierFacts.map(item => item.fieldKey), confirmation.adoptedSupplierFieldKeys)) {
    fail('C1_SIBLING_SHARED_CAPTURE_FACT_MISMATCH');
  }
  assertNoRawPersistenceKeys(record, 'sourceFactsRevision');
  assertNoProductionSecrets(record, 'sourceFactsRevision');
  const declaration = readBoundOwnerDeclaration(record.source, record.sourceOwnerDeclaration);
  if ((declaration !== null) !== (confirmation.adoptedOwnerFieldKeys.length > 0) ||
      declaration !== null && (Date.parse(declaration.confirmedAt) > Date.parse(record.preparedAt) ||
        confirmation.adoptedOwnerFieldKeys.some(key => declaration.facts[key] === null))) fail('C1_SIBLING_SHARED_OWNER_SOURCE_MISMATCH');
  const supplierSku = structuredClone(supply.supplierSku), attributeSources = {};
  for (const [index, item] of record.supplierFacts.entries()) {
    if (Object.hasOwn(supplierSku.attributes, item.fieldKey) && !isDeepStrictEqual(supplierSku.attributes[item.fieldKey], item.value)) {
      fail('C1_SIBLING_SHARED_TARGET_FACT_CONFLICT');
    }
    supplierSku.attributes[item.fieldKey] = item.value;
    attributeSources[item.fieldKey] = `${record.revisionId}#/supplierFacts/${index}`;
  }
  const ownerFacts = confirmation.adoptedOwnerFieldKeys.map(fieldKey => ({ fieldKey, label: OWNER_PRODUCT_FACT_LABELS[fieldKey],
    fact: { value: structuredClone(declaration.facts[fieldKey]), verificationStatus: 'confirmed',
      sourceRefs: [`${declaration.declarationId}#/facts/${fieldKey}`, `${record.revisionId}#/ownerConfirmation`], reason: null } }));
  return { supplierSku, attributeSources, powerSourceRef: null,
    ...(ownerFacts.length ? { ownerFacts } : {}) };
}
