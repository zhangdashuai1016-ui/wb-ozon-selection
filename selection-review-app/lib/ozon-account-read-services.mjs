import { createOzonAccountReadRuntime } from './ozon-account-read-runtime.mjs';
import { assertOzonAccountReadReceipt, OzonAccountReadError } from './ozon-account-read-contract.mjs';
import { createOzonAccountReadBindingResolver, buildOzonAccountReadPreparation, currentOzonAccountReadJobs,
  accountReadBindingForProduction } from './ozon-account-read-preparation.mjs';
import { assertOzonDEPreflightEvidenceScope, inspectOzonDEPreflightCapabilities, OzonDEPreflightEvidenceError } from './ozon-de-preflight-provider.mjs';
import { buildDESavedJobRuntimeView } from './d-e-runtime-view.mjs';
import { validateSoftwareJobAdmission } from './software-job-admission.mjs';
import { softwareJobsInDocument } from './software-job-contract.mjs';

function scopeFor(candidate, binding) {
  const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization, locked = authorization.lockedScope;
  return assertOzonDEPreflightEvidenceScope({ candidateId: candidate.id, skuPackageId: locked.skuPackageId,
    supplierSkuId: locked.supplierSkuId, authorizationId: authorization.authorizationId, sourceCandidateRevision: authorization.sourceCandidateRevision,
    storeRef: structuredClone(locked.storeRef), warehouseRef: locked.warehouseRef, warehouseId: binding.warehouseId,
    credentialAlias: locked.credentialAlias, bindingId: binding.bindingId, configurationVersion: binding.configurationVersion });
}

/** Existing job queue composition. No background scan, automatic authorization, retry, or extra production decision. */
export function createOzonAccountReadServices({ configuration, repository, workerRegistry, serverClock, requestJson,
  evidenceSource, preflightProvider, deRuntimeServices }) {
  const loadCurrentReadBinding = createOzonAccountReadBindingResolver(configuration), services = new Map();
  for (const binding of configuration.ozonAccountReadServiceBindings) {
    services.set(binding.productionBindingId, createOzonAccountReadRuntime({ repository, workerRegistry, serverClock,
      worker: { workerId: binding.workerId, version: binding.workerVersion, leaseDurationMs: binding.leaseDurationMs },
      loadCurrentReadBinding, requestJson }));
  }
  function savedReads(document, candidateId) {
    const hasRuntime = Object.hasOwn(document, 'runtime');
    const runtime = hasRuntime ? document.runtime : {};
    if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime) ||
        (Object.hasOwn(runtime, 'softwareJobs') && !Array.isArray(runtime.softwareJobs)) ||
        (Object.hasOwn(runtime, 'ozonAccountReadReceipts') && (runtime.ozonAccountReadReceipts === null ||
          typeof runtime.ozonAccountReadReceipts !== 'object' || Array.isArray(runtime.ozonAccountReadReceipts)))) {
      throw new OzonAccountReadError('REPOSITORY_INVALID');
    }
    // Historical v2 documents may predate runtime. Normalize only absent collections
    // in a read projection; the shared collection helper must not repair corrupt data.
    const jobs = softwareJobsInDocument({ runtime: { ...runtime } });
    const candidate = document.candidates.find(value => value.id === candidateId);
    if (!candidate?.lifecycleV11?.skuPackage || candidate.targetPlatform !== 'ozon') return [];
    const candidateJobs = jobs.filter(job => job.jobType === 'ozon_account_read' && job.candidateId === candidateId);
    const relevantBindings = configuration.productionBindings.filter(production => candidateJobs.some(job =>
      job.scopeBinding.bindingId === production.bindingId && job.scopeBinding.configurationVersion === production.configurationVersion));
    const currentIds = new Set(relevantBindings.flatMap(production => {
      const binding = loadCurrentReadBinding({ document, candidateId, skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
        bindingId: production.bindingId, configurationVersion: production.configurationVersion });
      return binding === null ? [] : currentOzonAccountReadJobs({ document, candidate, binding }).slice(0, 1).map(job => job.jobId);
    }));
    return candidateJobs.map(job => {
      const receipt = runtime.ozonAccountReadReceipts?.[job.jobId];
      if (runtime.ozonAccountReadReceipts && Object.hasOwn(runtime.ozonAccountReadReceipts, job.jobId)) {
        assertOzonAccountReadReceipt(receipt, job);
      }
      const isCurrent = currentIds.has(job.jobId), expired = Date.parse(serverClock()) >= Date.parse(job.scopeBinding.expiresAt);
      let admissionBlocker = null;
      if (isCurrent && !expired && job.status === 'queued' && job.revision === candidate.dataRevision) {
        try { validateSoftwareJobAdmission({ document, job, observedAt: serverClock(), phase: 'claim', workerId:
          configuration.ozonAccountReadServiceBindings.find(value => value.productionBindingId === job.scopeBinding.bindingId)?.workerId ?? null }); }
        catch (error) {
          if (error?.constructor !== Error || !/^SOFTWARE_JOB_ADMISSION_[A-Z_]+$/.test(error.message)) throw error;
          admissionBlocker = error.message;
        }
      }
      return { jobId: job.jobId, status: job.status, expectedRevision: job.revision, bindingId: job.scopeBinding.bindingId,
        isCurrent, expired, admissionBlocker,
        configurationVersion: job.scopeBinding.configurationVersion, createdAt: job.createdAt,
        requestsSent: receipt?.steps.some(step => step.requestTransmission === 'unknown') ? 'unknown'
          : receipt ? receipt.steps.filter(step => step.requestTransmission !== 'not_attempted').length : 0,
        observedMethods: receipt ? receipt.steps.filter(step => step.result?.status === 'observed').map(step => step.method) : [],
        companyCurrency: receipt?.steps.find(step => step.method === 'seller_info')?.result?.facts.companyCurrency ?? null,
        failureClass: receipt?.failureClass ?? null,
        gaps: receipt ? receipt.steps.flatMap(step => step.result?.gaps ?? []) : [],
        canContinue: isCurrent && !expired && admissionBlocker === null && job.revision === candidate.dataRevision &&
          job.status === 'queued' && job.attempt === 0 && services.has(job.scopeBinding.bindingId) };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async function continueProduction(input) {
    const document = await repository.readSnapshot(), candidate = document.candidates.find(value => value.id === input.candidateId);
    const job = document.runtime.softwareJobs?.find(value => value.jobId === input.jobId);
    if (!candidate || !job || candidate.dataRevision !== input.expectedRevision || job.candidateId !== candidate.id) throw new OzonAccountReadError('CANDIDATE_CHANGED');
    if (job.jobType !== 'd_production_execution' || job.status !== 'queued') return deRuntimeServices.continueSavedCurrent(input);
    const view = buildDESavedJobRuntimeView({ candidate, runtime: { ...document.runtime, workers: workerRegistry.snapshot() },
      serviceBindings: configuration.deServiceBindings, productionBindings: configuration.productionBindings,
      dependencyView: deRuntimeServices.dependencyView, observedAt: serverClock() });
    if (!view?.canContinueSaved) return deRuntimeServices.continueSavedCurrent(input);
    const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
    const binding = configuration.productionBindings.find(value => value.bindingId === authorization.executionBinding.bindingId);
    const scope = scopeFor(candidate, binding);
    const reads = currentOzonAccountReadJobs({ document, candidate, binding: accountReadBindingForProduction(configuration, binding) });
    if (reads.length === 0) return { status: 'awaiting_account_read', externalRequests: 0, platformWrites: 0 };
    if (reads[0].status !== 'completed') return { status: 'account_read_incomplete', externalRequests: 0, platformWrites: 0 };
    await evidenceSource.publish({ scope, jobId: reads[0].jobId });
    const capabilities = await preflightProvider.loadAdapterCapabilities({ candidate, job, productionBinding: binding });
    if (capabilities.gaps.some(gap => gap.code !== 'asset_transport_not_verified')) {
      return { status: 'account_evidence_gaps', externalRequests: 0, platformWrites: 0, gaps: capabilities.gaps };
    }
    return deRuntimeServices.continueSavedCurrent(input);
  }
  async function continueAfterRead(candidateId, outcome) {
    if (outcome.status !== 'completed') return null;
    const document = await repository.readSnapshot(), candidate = document.candidates.find(value => value.id === candidateId);
    const ref = candidate?.lifecycleV11?.skuPackage?.dHandoff?.softwareJobRef;
    const job = document.runtime.softwareJobs?.find(value => value.jobId === ref?.jobId);
    if (!candidate || !job || job.status !== 'queued') return null;
    return continueProduction({ candidateId, jobId: job.jobId, expectedRevision: candidate.dataRevision });
  }
  return Object.freeze({
    gateSavedView({ candidate, document, view }) {
      if (!view?.canContinueSaved || view.d?.status !== 'queued') return view;
      const authorization = candidate.lifecycleV11.skuPackage.productionAuthorization;
      const binding = configuration.productionBindings.find(value => value.bindingId === authorization.executionBinding.bindingId);
      const scope = scopeFor(candidate, binding), persisted = document.runtime.ozonDEPreflightEvidence?.[scope.authorizationId];
      let record = null, reason = 'account_evidence_missing';
      if (persisted) {
        try {
          record = evidenceSource.verifySnapshot(document, persisted, scope);
          if (Date.parse(serverClock()) < Date.parse(record.collectedAt) || Date.parse(serverClock()) >= Date.parse(record.expiresAt)) {
            record = null; reason = 'account_evidence_not_current';
          } else reason = null;
        } catch (error) {
          if (!(error instanceof OzonDEPreflightEvidenceError)) throw error;
          reason = error.code;
        }
      }
      const gaps = inspectOzonDEPreflightCapabilities({ candidate, authorization, scope, record, reason, now: serverClock() })
        .gaps.filter(gap => gap.code !== 'asset_transport_not_verified');
      if (gaps.length === 0) return view;
      const reads = savedReads(document, candidate.id).filter(value => value.isCurrent);
      const current = reads[0];
      const invalidSource = reason !== null && reason.startsWith('OZON_DE_PREFLIGHT_EVIDENCE_');
      const message = invalidSource ? '已保存的账户证据校验失败，请核对原始回执与当前范围。原生产任务保持等待。'
        : current?.status === 'completed' ? '账户资料已保存；店铺身份、后台价格币种、后台连接与写入协议仍需独立证据。'
        : current ? '账户核验尚未完成，原生产任务保持等待。' : '等待本次账户只读核验，请在账户核验卡确认准确范围。';
      return { ...view, canContinueSaved: false, continueJobId: null,
        d: { ...view.d, canContinueSaved: false, blockers: [...view.d.blockers, { code: invalidSource ? reason : 'OZON_ACCOUNT_EVIDENCE_REQUIRED', message }] } };
    },
    preparation({ candidate, document }) {
      return buildOzonAccountReadPreparation({ candidate, configuration, runtimeView: savedReads(document, candidate.id) });
    },
    continueProduction,
    async authorizeAndRun({ actor, input }) {
      const service = services.get(input.bindingId);
      if (!service) throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
      const authorized = await service.authorizeAndEnqueue({ actor, input });
      const execution = await service.continueSaved({ candidateId: input.candidateId, jobId: authorized.job.jobId, expectedRevision: input.expectedRevision });
      const production = await continueAfterRead(input.candidateId, execution);
      return { status: execution.status, requestsSent: execution.requestsSent, platformWrites: production === null ? 0 : production.platformWrites ?? 'unknown',
        jobId: execution.job.jobId, productionStatus: production?.status ?? null };
    },
    async continueSavedRead(input) {
      const document = await repository.readSnapshot(), job = document.runtime.softwareJobs?.find(value => value.jobId === input.jobId);
      if (!job || job.jobType !== 'ozon_account_read' || job.candidateId !== input.candidateId) throw new OzonAccountReadError('JOB_SOURCE_CONFLICT');
      const service = services.get(job.scopeBinding.bindingId);
      if (!service) throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
      const execution = await service.continueSaved(input), production = await continueAfterRead(input.candidateId, execution);
      return { status: execution.status, requestsSent: execution.requestsSent, platformWrites: production === null ? 0 : production.platformWrites ?? 'unknown',
        jobId: execution.job.jobId, productionStatus: production?.status ?? null };
    }
  });
}
