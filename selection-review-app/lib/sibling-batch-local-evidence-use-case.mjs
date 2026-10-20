import { isDeepStrictEqual } from 'node:util';
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from './business-state-repository.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { prepareSiblingBatchEvidenceInputs, runSiblingBatchEvidencePreparation } from './sibling-batch-evidence-preparation.mjs';
import { createLocalOzonCommissionEvidenceProvider } from './lifecycle-b-real-evidence-readers.mjs';
import { commitLifecycleBEvidencePacks } from './lifecycle-b-evidence-runtime.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const RECEIPT_LIMIT = 1000;
const FAILURE_TYPES = Object.freeze({
  'provider:commission': { code: 'LOCAL_COMMISSION_READ_FAILED', message: '本地官方佣金表读取或匹配失败；整批未提交。' },
  'provider_result:commission': { code: 'LOCAL_COMMISSION_EVIDENCE_INVALID', message: '本地佣金结果未通过证据校验；整批未提交。' },
  'provider:schema': { code: 'LOCAL_EVIDENCE_DEPENDENCY_UNAVAILABLE', message: '本轮所需 Schema 证据不可用；未发起外部请求。' },
  'provider:logistics_tariff': { code: 'LOCAL_EVIDENCE_DEPENDENCY_UNAVAILABLE', message: '本轮所需物流证据不可用；未发起外部请求。' },
  'provider:exchange_rate': { code: 'LOCAL_EVIDENCE_DEPENDENCY_UNAVAILABLE', message: '本轮所需汇率证据不可用；未发起外部请求。' },
  evidence_context: { code: 'LOCAL_EVIDENCE_CONTEXT_INVALID', message: '本轮证据适用范围未通过校验；整批未提交。' },
  reuse_validity_drift: { code: 'LOCAL_EVIDENCE_VALIDITY_CHANGED', message: '复用证据在本轮结束前失效；整批未提交。' },
  final_readiness: { code: 'LOCAL_EVIDENCE_NOT_READY', message: '本轮证据未全部就绪；整批未提交。' }
});

function preparationScope(prepared) {
  return { parentCandidateId: prepared.parentCandidateId, parentRevision: prepared.parentRevision,
    draftRevision: prepared.draftRevision,
    members: prepared.members.map(member => ({ candidateId: member.candidateId,
      candidateRevision: member.candidateRevision, sourceSkuId: member.sourceSkuId,
      priceRub: member.submission?.targetSalePriceRub ?? null })) };
}

function receiptsFrom(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('SIBLING_BATCH_EVIDENCE_DOCUMENT_REQUIRED');
  const receipts = document.runtime?.siblingLocalEvidencePreparations ?? [];
  if (!Array.isArray(receipts) || receipts.length > RECEIPT_LIMIT) fail('SIBLING_BATCH_EVIDENCE_RECEIPTS_INVALID');
  return receipts;
}

function receiptStatus(receipt) {
  if (receipt?.schemaVersion === 'sibling-local-evidence-preparation-v1' && receipt.status === undefined) return 'completed';
  if (receipt?.schemaVersion === 'sibling-local-evidence-preparation-v2' && ['completed', 'failed'].includes(receipt.status)) {
    return receipt.status;
  }
  fail('SIBLING_BATCH_EVIDENCE_RECEIPT_INVALID');
}

function safeFailure(failure, members) {
  if (!failure || !Object.hasOwn(FAILURE_TYPES, failure.layer) ||
      !members.some(member => member.candidateId === failure.candidateId)) fail('SIBLING_BATCH_EVIDENCE_FAILURE_INVALID');
  const category = FAILURE_TYPES[failure.layer];
  return { candidateId: failure.candidateId, layer: failure.layer, code: category.code, message: category.message };
}

function attemptView(receipt) {
  const status = receiptStatus(receipt);
  const attemptedAt = receipt.attemptedAt ?? receipt.preparedAt;
  if (!validTime(attemptedAt) || !Array.isArray(receipt.members) || !Array.isArray(receipt.evidencePackIds) ||
      !receipt.evidencePackIds.every(id => typeof id === 'string' && id.length > 0)) fail('SIBLING_BATCH_EVIDENCE_RECEIPT_INVALID');
  const failure = status === 'failed' ? safeFailure(receipt.failure, receipt.members) : null;
  if (failure && receipt.failure.code !== failure.code) fail('SIBLING_BATCH_EVIDENCE_RECEIPT_INVALID');
  return { status, attemptedAt, failure, evidencePackIds: [...receipt.evidencePackIds] };
}

function latestAttempt(prepared, document) {
  const scope = preparationScope(prepared), receipts = receiptsFrom(document);
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    receiptStatus(receipt);
    if (receipt.parentCandidateId === scope.parentCandidateId && receipt.parentRevision === scope.parentRevision &&
        receipt.draftRevision === scope.draftRevision && isDeepStrictEqual(receipt.members, scope.members)) return attemptView(receipt);
  }
  return null;
}

export function siblingBatchEvidencePreparationView(prepared, document) {
  const externalGaps = prepared.members.flatMap(member => (member.plan?.actions ?? [])
    .filter(action => action.action === 'prepare_once' && action.kind !== 'commission')
    .map(action => ({ candidateId: member.candidateId, kind: action.kind, message: action.reason })));
  const lastAttempt = latestAttempt(prepared, document), ready = prepared.status === 'ready_from_reuse';
  return { parentCandidateId: prepared.parentCandidateId, parentRevision: prepared.parentRevision,
    draftRevision: prepared.draftRevision, status: prepared.status,
    ready, lastAttempt, failure: !ready && lastAttempt?.status === 'failed' ? lastAttempt.failure : null,
    localPreparationAvailable: prepared.status === 'preparation_required' && externalGaps.length === 0,
    members: prepared.members.map(member => ({ candidateId: member.candidateId,
      candidateRevision: member.candidateRevision, sourceSkuId: member.sourceSkuId, status: member.status,
      missing: member.missing, actions: member.plan?.actions ?? [] })),
    externalGaps, businessStateEffect: 'unchanged', externalRequests: 0, platformWrites: 0 };
}

function schemaDependencies(prepared) {
  const ids = new Set(prepared.members.map(member => member.plan?.actions.find(action => action.kind === 'schema')?.evidencePackId));
  return [...ids].map(id => {
    const matches = prepared.evidencePacks.filter(pack => pack.id === id);
    if (!id || matches.length !== 1) fail('SIBLING_BATCH_EVIDENCE_SCHEMA_DEPENDENCY_INVALID');
    return matches[0];
  });
}

function frozenInputs(prepared) {
  return prepared.members.map(member => ({ candidate: member.candidate,
    submission: member.submission, otherCosts: member.otherCosts }));
}

function appendReceipt(document, { prepared, schemas, reference, actor, at, status, evidencePackIds, failure = null }) {
  const receipts = receiptsFrom(document);
  if (receipts.length >= RECEIPT_LIMIT) fail('SIBLING_BATCH_EVIDENCE_RECEIPT_CAPACITY');
  if (!validTime(at)) fail('SIBLING_BATCH_EVIDENCE_RECEIPT_TIME_INVALID');
  const receipt = { schemaVersion: 'sibling-local-evidence-preparation-v2', status,
    ...preparationScope(prepared), attemptedAt: at, attemptedBy: actor.userId,
    ...(status === 'completed' ? { preparedAt: at, preparedBy: actor.userId } : {}),
    schemaDependencies: schemas.map(pack => ({ evidencePackId: pack.id,
      schemaRevision: pack.evidenceData.schemaRevision, checkedAt: pack.checkedAt })),
    commissionCatalogVersion: structuredClone(reference.versionState), evidencePackIds, failure,
    externalRequests: 0, platformWrites: 0, productionAuthorizationGranted: false };
  document.runtime ??= {};
  document.runtime.siblingLocalEvidencePreparations = [...receipts, receipt];
  return receipt;
}

/** Pure local I/O outside the transaction; commit rechecks the saved draft and all dependencies. */
export async function prepareSiblingBatchLocalEvidence({ repository, runtimeMode, actor, input, catalog,
  guooFilePath, ozonCommissionReference, serverClock,
  readOzonCommissionReferenceImpl }) {
  if (!['local_development', 'central_test', 'central_production'].includes(runtimeMode)) {
    fail('SIBLING_BATCH_EVIDENCE_RUNTIME_MODE_INVALID');
  }
  assertBusinessStateRepositoryBoundary(repository);
  if (['central_test', 'central_production'].includes(runtimeMode)) assertCentralPersistenceBoundary(repository);
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider' || typeof serverClock !== 'function') {
    fail('SIBLING_BATCH_EVIDENCE_OWNER_REQUIRED');
  }
  const prepare = document => prepareSiblingBatchEvidenceInputs({ document, catalog, input,
    plannedAt: serverClock(), guooFilePath });
  const initial = await repository.readSnapshot(), prepared = prepare(initial);
  const view = siblingBatchEvidencePreparationView(prepared, initial);
  if (view.ready) return { ...view, result: 'already_prepared' };
  if (!view.localPreparationAvailable) return { ...view, result: 'blocked',
    message: '本批尚有输入或外部证据缺口；本地费表准备未执行。' };
  if (receiptsFrom(initial).length >= RECEIPT_LIMIT) fail('SIBLING_BATCH_EVIDENCE_RECEIPT_CAPACITY');
  const schemas = schemaDependencies(prepared);
  const reference = structuredClone(ozonCommissionReference);
  const commission = createLocalOzonCommissionEvidenceProvider({ ozonCommissionReference: reference,
    schemaPacks: schemas, now: () => new Date(serverClock()),
    ...(readOzonCommissionReferenceImpl ? { readOzonCommissionReferenceImpl } : {}) });
  const run = await runSiblingBatchEvidencePreparation({ prepared, providers: { commission },
    clock: () => new Date(serverClock()) });
  if (run.status !== 'completed') {
    const failure = safeFailure(run.failure, prepared.members);
    return repository.transact(document => {
      // A failed local read records only its original input scope, even if a newer draft now exists.
      const receipt = appendReceipt(document, { prepared, schemas, reference, actor, at: serverClock(),
        status: 'failed', evidencePackIds: [], failure });
      return { changed: true, document, result: { ...view, result: 'failed', failure,
        lastAttempt: attemptView(receipt), receipt,
        message: '本地证据准备失败；整批未提交，商品阶段保持不变。' } };
    });
  }
  return repository.transact(document => {
    const current = prepare(document);
    if (!isDeepStrictEqual(frozenInputs(current), frozenInputs(prepared)) ||
        !isDeepStrictEqual(schemaDependencies(current), schemas) ||
        !isDeepStrictEqual(ozonCommissionReference, reference)) fail('SIBLING_BATCH_EVIDENCE_INPUT_CHANGED');
    const currentView = siblingBatchEvidencePreparationView(current, document);
    if (currentView.ready) return { changed: false, document, result: { ...currentView, result: 'already_prepared' } };
    if (!currentView.localPreparationAvailable) fail('SIBLING_BATCH_EVIDENCE_DEPENDENCY_CHANGED');
    const at = serverClock();
    const committed = commitLifecycleBEvidencePacks(document, run.evidencePacksToCommit,
      { createdAt: at, createdBy: actor.userId, currentCommissionCatalogs: document.currentCommissionCatalogs ?? [] });
    const final = prepare(document);
    const finalView = siblingBatchEvidencePreparationView(final, document);
    if (!finalView.ready) fail('SIBLING_BATCH_EVIDENCE_FINAL_READINESS_FAILED');
    const receipt = appendReceipt(document, { prepared, schemas, reference, actor, at, status: 'completed',
      evidencePackIds: committed.map(pack => pack.id) });
    return { changed: true, document, result: { ...finalView, lastAttempt: attemptView(receipt), result: 'prepared', receipt } };
  });
}
