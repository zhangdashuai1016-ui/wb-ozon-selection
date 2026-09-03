import { assertBusinessStateRepositoryBoundary } from "./business-state-repository.mjs";
import { assertSafeRuntimeRecord, workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { assertWorkerRegistryBoundary } from "./worker-registry.mjs";
import {
  SOFTWARE_JOB_TYPES,
  claimSoftwareJobLease,
  enqueueSoftwareJobInDocument,
  findSoftwareJobInDocument,
  markSoftwareJobExternalRequestStarted,
  recordSoftwareJobProgress,
  reconcileExpiredSoftwareJobLease,
  reconcileSoftwareJobAfterRestart,
  sameSoftwareJobIdentity,
  softwareJobsInDocument,
  softwareJobRequiresDomainSettlement,
  settleSoftwareJobInDocument
} from "./software-job-contract.mjs";
import {
  assertSoftwareJobAdmittedForClaim,
  bindSoftwareJobAdmissionForEnqueue,
  assertSoftwareJobAdmittedForExternalRequest
} from "./software-job-admission.mjs";

function clone(value) {
  return structuredClone(value);
}

function currentCandidate(document, job) {
  if (!Array.isArray(document.candidates)) throw new Error("SOFTWARE_JOB_STORE_DOCUMENT_INVALID");
  const candidate = document.candidates.find((entry) => entry.id === job.candidateId);
  if (!candidate) throw new Error("SOFTWARE_JOB_CANDIDATE_NOT_FOUND");
  if (Number(candidate.dataRevision) !== job.revision) throw new Error("SOFTWARE_JOB_REVISION_CONFLICT");
  const candidateSkuIds = [
    candidate.lifecycleV11?.skuPackage?.skuPackageId,
    candidate.skuPackage?.skuPackageId,
    ...(Array.isArray(candidate.skuLifecyclePackages) ? candidate.skuLifecyclePackages.map((entry) => entry?.skuPackageId) : [])
  ].filter(Boolean);
  if (candidateSkuIds.length > 0 && !candidateSkuIds.includes(job.skuPackageId)) {
    throw new Error("SOFTWARE_JOB_SKU_CONFLICT");
  }
  return candidate;
}

function isWorkerSpecificAdmissionRejection(error) {
  return /(?:SOFTWARE_JOB_ADMISSION_(?:WORKER_NOT_BOUND|WORKER_CAPABILITY_REQUIRED)|WORKER_REGISTRY_WORKER_NOT_CURRENT)/.test(String(error?.message || error));
}

function isPerJobAdmissionRejection(error) {
  return /(?:^|[^A-Z0-9_])(?:SOFTWARE_JOB_ADMISSION_[A-Z0-9_]+|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_REVISION_CONFLICT|SOFTWARE_JOB_CANDIDATE_NOT_FOUND|SOFTWARE_JOB_SKU_CONFLICT)(?:$|[^A-Z0-9_])/.test(String(error?.message || error));
}

function rejectionCode(error) {
  const match = String(error?.message || error).match(/(?:SOFTWARE_JOB_ADMISSION_[A-Z0-9_]+|WORKER_REGISTRY_WORKER_NOT_CURRENT|SOFTWARE_JOB_REVISION_CONFLICT|SOFTWARE_JOB_CANDIDATE_NOT_FOUND|SOFTWARE_JOB_SKU_CONFLICT)/);
  return match ? match[0] : "SOFTWARE_JOB_ASSIGNMENT_REJECTED";
}

function assignmentRejection(job, error) {
  const rejection = {
    schemaVersion: "software-job-assignment-rejection-v1",
    jobId: String(job?.jobId || ""),
    jobType: String(job?.jobType || ""),
    candidateId: String(job?.candidateId || ""),
    skuPackageId: String(job?.skuPackageId || ""),
    revision: Number.isInteger(job?.revision) ? job.revision : null,
    reasonCode: rejectionCode(error)
  };
  assertSafeRuntimeRecord(rejection, "softwareJob.assignmentRejection");
  return Object.freeze(rejection);
}

export { enqueueSoftwareJobInDocument, findSoftwareJobInDocument, sameSoftwareJobIdentity, settleSoftwareJobInDocument };

export function createRepositoryBackedSoftwareJobStore({ businessStateRepository, serverClock = () => new Date().toISOString(), workerRegistry = null } = {}) {
  const repositoryBoundary = assertBusinessStateRepositoryBoundary(businessStateRepository);
  if (typeof serverClock !== "function") throw new Error("SOFTWARE_JOB_STORE_CLOCK_REQUIRED");
  if (workerRegistry !== null) assertWorkerRegistryBoundary(workerRegistry);

  function observedServerTime() {
    const raw = String(serverClock() ?? "").trim();
    const timestamp = Date.parse(raw);
    if (!raw || Number.isNaN(timestamp)) throw new Error("SOFTWARE_JOB_STORE_CLOCK_INVALID");
    return new Date(timestamp).toISOString();
  }

  function requireWorkerRegistry(job) {
    if (!softwareJobRequiresDomainSettlement(job)) return null;
    assertWorkerRegistryBoundary(workerRegistry);
    if (typeof workerRegistry.get !== "function" || typeof workerRegistry.snapshot !== "function") {
      throw new Error("WORKER_REGISTRY_BOUNDARY_REQUIRED");
    }
    return workerRegistry;
  }

  function registryWorkerForJob(job, workerId, { requireClaimSnapshot = false } = {}) {
    const registry = requireWorkerRegistry(job);
    if (!registry) return null;
    const snapshot = registry.snapshot();
    const snapshotWorker = snapshot.find((entry) => entry.workerId === workerId);
    const current = registry.get(workerId);
    if (!snapshotWorker || !current || snapshotWorker.heartbeatCurrent !== true ||
        current.status !== "online" ||
        snapshotWorker.status !== current.status ||
        snapshotWorker.version !== current.version ||
        JSON.stringify(snapshotWorker.capabilities) !== JSON.stringify(current.capabilities) ||
        !workerSatisfiesCapabilities(current, job.requiredCapabilities)) {
      throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    }
    if (requireClaimSnapshot &&
        (job.workerVersion !== current.version ||
         JSON.stringify(job.workerCapabilitiesSnapshot || []) !== JSON.stringify(current.capabilities))) {
      throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    }
    return current;
  }

  function registryWorkerForDescriptor(job, worker) {
    if (!softwareJobRequiresDomainSettlement(job)) return worker;
    if (!worker?.workerId) throw new Error("WORKER_REGISTRY_WORKER_NOT_CURRENT");
    return registryWorkerForJob(job, worker.workerId);
  }

  async function readJobs() {
    const document = await businessStateRepository.readSnapshot();
    return clone(document.runtime?.softwareJobs || []);
  }

  const store = {
    boundaryType: "software_job_store",
    persistenceClass: "business_state_repository",
    multiUserReady: repositoryBoundary.multiUserReady,
    async enqueue(job) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        currentCandidate(document, job);
        const existing = softwareJobsInDocument(document).find((entry) => entry.idempotencyKey === job.idempotencyKey);
        if (existing) {
          const outcome = enqueueSoftwareJobInDocument(document, job);
          return { changed: outcome.changed, result: outcome.job };
        }
        const admittedJob = job.scopeBinding
          ? bindSoftwareJobAdmissionForEnqueue({
            document,
            job,
            observedAt,
            phase: "enqueue_current"
          })
          : job;
        const outcome = enqueueSoftwareJobInDocument(document, admittedJob);
        return { changed: outcome.changed, ...(outcome.changed ? { document } : {}), result: outcome.job };
      });
    },
    async get(jobId) {
      return (await readJobs()).find((entry) => entry.jobId === jobId) || null;
    },
    async findByIdempotencyKey(idempotencyKey) {
      return (await readJobs()).find((entry) => entry.idempotencyKey === idempotencyKey) || null;
    },
    async listAssignable({ worker, limit = 1, includeRejections = false, jobType = null }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("SOFTWARE_JOB_STORE_LIMIT_INVALID");
      if (jobType !== null && !SOFTWARE_JOB_TYPES.includes(jobType)) throw new Error("SOFTWARE_JOB_STORE_JOB_TYPE_INVALID");
      const observedAt = observedServerTime();
      const document = await businessStateRepository.readSnapshot();
      const revisions = new Map((document.candidates || []).map((candidate) => [candidate.id, Number(candidate.dataRevision)]));
      const assignable = [];
      const rejected = [];
      for (const job of clone(document.runtime?.softwareJobs || [])) {
        if (jobType !== null && job.jobType !== jobType) continue;
        if (job.status !== "queued" || job.attempt !== 0) continue;
        if (revisions.get(job.candidateId) !== job.revision) {
          rejected.push(assignmentRejection(job, new Error("SOFTWARE_JOB_REVISION_CONFLICT")));
          continue;
        }
        if (!softwareJobRequiresDomainSettlement(job) && !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) continue;
        try {
          const trustedWorker = registryWorkerForDescriptor(job, worker);
          if (!workerSatisfiesCapabilities(trustedWorker, job.requiredCapabilities)) continue;
          assertSoftwareJobAdmittedForClaim({ document, job, worker: trustedWorker, observedAt });
          if (assignable.length < limit) assignable.push(job);
        } catch (error) {
          if (isWorkerSpecificAdmissionRejection(error)) {
            if (includeRejections) rejected.push(assignmentRejection(job, error));
            continue;
          }
          if (isPerJobAdmissionRejection(error)) {
            rejected.push(assignmentRejection(job, error));
            continue;
          }
          throw error;
        }
      }
      if (includeRejections) {
        return Object.freeze({ assignable: clone(assignable), rejected: clone(rejected) });
      }
      return clone(assignable);
    },
    async listAssignableWithDiagnostics({ worker, limit = 1, jobType = null } = {}) {
      return store.listAssignable({ worker, limit, includeRejections: true, jobType });
    },
    async claim({ jobId, worker, leaseId, leaseDurationMs }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        currentCandidate(document, jobs[index]);
        const trustedWorker = registryWorkerForDescriptor(jobs[index], worker);
        assertSoftwareJobAdmittedForClaim({ document, job: jobs[index], worker: trustedWorker, observedAt });
        const claimed = claimSoftwareJobLease({
          job: jobs[index], worker: trustedWorker, leaseId, serverTime: observedAt, leaseDurationMs
        });
        jobs[index] = clone(claimed);
        return { changed: true, document, result: claimed };
      });
    },
    async recordProgress({ jobId, workerId, leaseId, progressRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        currentCandidate(document, jobs[index]);
        registryWorkerForJob(jobs[index], workerId, { requireClaimSnapshot: true });
        assertSoftwareJobAdmittedForExternalRequest({
          document,
          job: jobs[index],
          workerId,
          observedAt
        });
        const next = recordSoftwareJobProgress({
          job: jobs[index], workerId, leaseId, progressRef, serverTime: observedAt
        });
        jobs[index] = clone(next);
        return { changed: true, document, result: next };
      });
    },
    async markExternalRequestStarted({ jobId, workerId, leaseId, externalRequestRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        const index = jobs.findIndex((entry) => entry.jobId === jobId);
        if (index < 0) throw new Error("SOFTWARE_JOB_NOT_FOUND");
        currentCandidate(document, jobs[index]);
        registryWorkerForJob(jobs[index], workerId, { requireClaimSnapshot: true });
        assertSoftwareJobAdmittedForExternalRequest({
          document,
          job: jobs[index],
          workerId,
          observedAt
        });
        const next = markSoftwareJobExternalRequestStarted({
          job: jobs[index], workerId, leaseId, externalRequestRef, serverTime: observedAt
        });
        jobs[index] = clone(next);
        return { changed: true, document, result: next };
      });
    },
    async settle({ jobId, workerId, leaseId, status, externalRequestState, resultRef, resultEnvelope, failureClass, externalRequestRef }) {
      return businessStateRepository.transact(async (document) => {
        const observedAt = observedServerTime();
        const before = findSoftwareJobInDocument(document, jobId);
        const candidate = before ? (document.candidates || []).find((entry) => entry.id === before.candidateId) : null;
        const applicationDisposition = status === "completed" && candidate && Number(candidate.dataRevision) !== before.revision
          ? "revision_conflict_not_applied"
          : "result_recorded_no_candidate_mutation";
        const next = settleSoftwareJobInDocument(document, {
          jobId, workerId, leaseId, status, externalRequestState, resultRef, resultEnvelope,
          applicationDisposition, failureClass, externalRequestRef
        }, observedAt);
        return { changed: true, document, result: next };
      });
    },
    async listWaitingPlatform({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("SOFTWARE_JOB_STORE_LIMIT_INVALID");
      const document = await businessStateRepository.readSnapshot();
      return clone((document.runtime?.softwareJobs || [])
        .filter((job) => job.status === "waiting_platform" && job.externalRequestState === "in_flight")
        .slice(0, limit));
    },
    async reconcileAfterRestart() {
      return businessStateRepository.transact(async (document) => {
        const reconciledAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        let changed = false;
        const reconciled = [];
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index];
          if (!["claimed", "waiting_platform"].includes(job.status)) continue;
          const next = reconcileSoftwareJobAfterRestart({ job, serverTime: reconciledAt });
          jobs[index] = next;
          reconciled.push(next.jobId);
          changed = true;
        }
        return { changed, ...(changed ? { document } : {}), result: Object.freeze({ reconciled }) };
      });
    },
    async reconcileExpiredLeases() {
      return businessStateRepository.transact(async (document) => {
        const reconciledAt = observedServerTime();
        const jobs = softwareJobsInDocument(document);
        let changed = false;
        const reconciled = [];
        for (let index = 0; index < jobs.length; index += 1) {
          const job = jobs[index];
          if (!["claimed", "waiting_platform"].includes(job.status)) continue;
          let next;
          try {
            next = reconcileExpiredSoftwareJobLease({ job, serverTime: reconciledAt });
          } catch (error) {
            if (String(error?.message || error) === "SOFTWARE_JOB_LEASE_NOT_EXPIRED") continue;
            throw error;
          }
          jobs[index] = next;
          reconciled.push(next.jobId);
          changed = true;
        }
        return { changed, ...(changed ? { document } : {}), result: Object.freeze({ reconciled }) };
      });
    }
  };
  return Object.freeze(store);
}
