import { isDeepStrictEqual } from 'node:util';
import { A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES, ASupplierImageSearchError,
  assertASupplierImageSearchScope, assertASupplierImageSearchSource, assertASupplierImageSearchReceipt,
  assertASupplierImageSearchResult } from './a-supplier-image-search-contract.mjs';
import { ASupplierImageSearchExecutionBlockedError } from './software-job-repository.mjs';

const terminal = job => ['completed', 'failed', 'unknown_outcome'].includes(job.status);
const check = (condition, code) => { if (!condition) throw new ASupplierImageSearchError(code); };
function heldJob(document, jobId, workerId, leaseId) {
  const job = document.runtime.softwareJobs.find(item => item.jobId === jobId);
  check(job?.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE && job.workerId === workerId && job.leaseId === leaseId, 'JOB_SOURCE_CONFLICT');
  assertASupplierImageSearchScope(job.scopeBinding, job);
  return job;
}
function retainLateResult(receipt, job, result, recordedAt) {
  check(job.status === 'unknown_outcome' && receipt.status === 'unknown_outcome', 'LATE_RESULT_INVALID');
  assertASupplierImageSearchResult(result, receipt.scope);
  if (receipt.lateResult !== undefined) {
    check(isDeepStrictEqual(receipt.lateResult.result, result), 'LATE_RESULT_INVALID');
    return false;
  }
  receipt.lateResult = { recordedAt, result };
  assertASupplierImageSearchReceipt(receipt, job);
  return true;
}

/** The controlled worker must explicitly deliver a late result after timeout. This only records evidence; it never replays or promotes a job. */
export async function recordASupplierImageSearchLateResult({ repository, jobId, workerId, leaseId, result, serverClock }) {
  if (typeof repository?.transact !== 'function' || typeof serverClock !== 'function') throw new TypeError('A_SUPPLIER_IMAGE_SEARCH_LATE_RESULT_DEPENDENCY_INVALID');
  return repository.transact(document => {
    const job = heldJob(document, jobId, workerId, leaseId);
    const receipt = assertASupplierImageSearchReceipt(document.runtime.aSupplierImageSearchReceipts[jobId], job);
    const changed = retainLateResult(receipt, job, result, serverClock());
    if (changed) document.runtime.aSupplierImageSearchReceipts[jobId] = receipt;
    return { changed, ...(changed ? { document } : {}), result: { status: job.status, jobId, lateMaterialSaved: true } };
  });
}

/** Adapter protocol: await beforeSubmit immediately before one submission; honor abort. Late delivery uses the explicit record function above. */
export async function runASupplierImageSearchSoftwareJob({ repository, softwareJobStore, worker, jobId, leaseId,
  leaseDurationMs, serverClock, pageAdapter = null, signal = null, timeoutMs = 120000 }) {
  if (pageAdapter === null) return { status: 'not_configured', jobId, code: 'PAGE_CONTRACT_UNCONFIGURED', externalRequests: 0 };
  if (typeof pageAdapter.execute !== 'function' || typeof repository?.transact !== 'function' || typeof serverClock !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('A_SUPPLIER_IMAGE_SEARCH_RUNNER_DEPENDENCY_INVALID');
  const queued = await softwareJobStore.get(jobId);
  check(queued?.jobType === A_SUPPLIER_IMAGE_SEARCH_JOB_TYPE, 'JOB_SOURCE_CONFLICT');
  const scope = assertASupplierImageSearchScope(queued.scopeBinding, queued);
  if (terminal(queued) || queued.status !== 'queued') return { status: 'idempotent_replay', jobId, executionStatus: queued.status, externalRequests: 0 };
  check(!signal?.aborted, 'CANCELLED');
  await softwareJobStore.claim({ jobId, worker, leaseId, leaseDurationMs });
  const controller = new AbortController();
  const abort = () => controller.abort(new ASupplierImageSearchError('CANCELLED'));
  const assertActive = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    check(!signal?.aborted, 'CANCELLED');
  };
  const held = document => heldJob(document, jobId, worker.workerId, leaseId);
  let source, submitted = false, checkedResult = null, timer;
  if (signal) signal.addEventListener('abort', abort, { once: true });
  function newReceipt(job, at, failed = null) {
    return assertASupplierImageSearchReceipt({ schemaVersion: 'a-supplier-image-search-receipt-v1',
      receiptId: `a-supplier-image-search-receipt:${jobId}`, jobId, scope, workerId: worker.workerId, leaseId,
      startedAt: at, completedAt: failed === null ? null : at, status: failed === null ? 'in_flight' : 'failed', failureClass: failed,
      steps: failed === null ? [{ method: 'image_search', intentAt: at, sentAt: null, completedAt: null,
        externalRequestState: 'not_sent', requestTransmission: 'not_attempted', result: null, errorCode: null }] : [] }, job);
  }
  async function beforeSubmit() {
    assertActive();
    await repository.transact(document => {
      assertActive();
      const job = held(document), receipt = document.runtime.aSupplierImageSearchReceipts[jobId];
      check(!terminal(job) && receipt.steps[0].sentAt === null, 'ALREADY_ATTEMPTED');
      const currentSource = assertASupplierImageSearchSource({ document,
        candidate: document.candidates.find(item => item.id === scope.candidateId), scope });
      check(isDeepStrictEqual(currentSource, source), 'SOURCE_INVALID');
      const at = serverClock();
      const checked = softwareJobStore.assertASupplierImageSearchExecutionInDocument({ document, jobId,
        workerId: worker.workerId, leaseId, observedAt: at, markRequestSent: true });
      Object.assign(receipt.steps[0], { sentAt: at, externalRequestState: 'in_flight', requestTransmission: 'unknown' });
      assertASupplierImageSearchReceipt(receipt, checked.job);
      return { changed: true, document, result: null };
    });
    // If abort occurred during persistence, the recorded intent stays unknown, but the worker must not submit.
    assertActive();
    submitted = true;
  }
  async function finish(result, failureClass, lateResult = null) {
    return repository.transact(document => {
      const job = held(document), receipts = document.runtime.aSupplierImageSearchReceipts, at = serverClock();
      let receipt = receipts[jobId] === undefined ? newReceipt(job, at, failureClass) : assertASupplierImageSearchReceipt(receipts[jobId], job);
      if (terminal(job)) {
        const late = result ?? lateResult;
        const changed = late !== null && job.status === 'unknown_outcome' ? retainLateResult(receipt, job, late, at) : false;
        if (changed) receipts[jobId] = receipt;
        return { changed, ...(changed ? { document } : {}), result: { status: job.status, jobId, lateMaterialSaved: changed } };
      }
      if (result !== null) {
        assertActive();
        softwareJobStore.assertASupplierImageSearchExecutionInDocument({ document, jobId, workerId: worker.workerId, leaseId, observedAt: at });
        const currentSource = assertASupplierImageSearchSource({ document,
          candidate: document.candidates.find(item => item.id === scope.candidateId), scope });
        check(isDeepStrictEqual(currentSource, source), 'SOURCE_INVALID');
      }
      const step = receipt.steps[0];
      receipt.completedAt = at;
      if (step) step.completedAt = at;
      if (result !== null) {
        receipt.status = 'completed';
        Object.assign(step, { result, externalRequestState: 'succeeded', requestTransmission: 'response_received' });
      } else {
        receipt.failureClass = failureClass;
        const wasSent = step?.sentAt !== null && step?.sentAt !== undefined;
        if (step) Object.assign(step, { errorCode: failureClass, externalRequestState: wasSent ? 'unknown_outcome' : 'not_sent' });
        receipt.status = wasSent ? 'unknown_outcome' : 'failed';
        if (lateResult !== null && wasSent) receipt.lateResult = { recordedAt: at, result: lateResult };
      }
      receipts[jobId] = assertASupplierImageSearchReceipt(receipt, job);
      const settled = softwareJobStore.settleASupplierImageSearchInDocument({ document, jobId,
        workerId: worker.workerId, leaseId, observedAt: at });
      return { changed: true, document, result: { status: settled.job.status, jobId, receipt,
        externalRequests: submitted ? 1 : 0, platformWrites: 0 } };
    });
  }
  try {
    assertActive();
    timer = setTimeout(() => controller.abort(new ASupplierImageSearchError('TIMEOUT')), timeoutMs);
    source = await repository.transact(document => {
      assertActive();
      const job = held(document), at = serverClock();
      softwareJobStore.assertASupplierImageSearchExecutionInDocument({ document, jobId, workerId: worker.workerId, leaseId, observedAt: at });
      const resolved = assertASupplierImageSearchSource({ document,
        candidate: document.candidates.find(item => item.id === scope.candidateId), scope });
      check(!Object.hasOwn(document.runtime.aSupplierImageSearchReceipts, jobId), 'ALREADY_ATTEMPTED');
      document.runtime.aSupplierImageSearchReceipts[jobId] = newReceipt(job, at);
      return { changed: true, document, result: resolved };
    });
    assertActive();
    const cancelled = new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const execution = (async () => pageAdapter.execute({ source: { imageRef: source.imageRef, imageUrl: source.imageUrl,
      sourceEvidenceRef: source.sourceEvidenceRef }, scope: structuredClone(scope), signal: controller.signal, beforeSubmit }))();
    const result = await Promise.race([execution, cancelled]);
    check(submitted, 'RESPONSE_INVALID');
    checkedResult = assertASupplierImageSearchResult(result, scope);
    return await finish(checkedResult, null);
  } catch (error) {
    const known = error instanceof ASupplierImageSearchError || error instanceof ASupplierImageSearchExecutionBlockedError;
    const failureClass = known && A_SUPPLIER_IMAGE_SEARCH_FAILURE_CLASSES.includes(error.failureClass ?? error.code)
      ? error.failureClass ?? error.code : 'UNEXPECTED_SYSTEM_ERROR';
    const result = await finish(null, failureClass, checkedResult);
    if (!known || failureClass === 'UNEXPECTED_SYSTEM_ERROR') throw error;
    return result;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}
