import { readDProductionJobWaiting, readDPlatformStoppedJobTerminal, readDInitialImportStoppedJobTerminal } from './d-platform-observation-contract.mjs';
import { isDeepStrictEqual } from "node:util";
import { assertDProductionJobReference, assertEReadbackJobReference } from "./d-e-software-job-handoff.mjs";
import { assertDEJobAdmissionDecision, createDEJobAdmissionDecision, DESoftwareJobAdmissionError } from "./d-e-software-job-admission.mjs";
import { assertDProductionRecordSource, assertDProductionReceiptChain, DEJobScopeError } from "./d-e-software-job-scope.mjs";
import { DProductionJobCursorError } from "./d-production-job-cursor.mjs";
import { assertEReadbackAttempt } from "./e-readback-attempt.mjs";
import { validateSystemCreatedVerificationRecord } from "./e-stage-readback.mjs";
import { normalizeDEServiceBindings, isRuntimeConfigurationTimestamp } from "./runtime-configuration.mjs";
import { isCanonicalFrozenRef, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { workerSatisfiesCapabilities } from "./runtime-identity.mjs";
import { assertDProductionPreparation, DProductionPreparationError } from "./d-production-preparation-contract.mjs";

const TYPES = { D: "d_production_execution", E: "e_independent_readback" };
const knownCode = error => {
  if (error instanceof DESoftwareJobAdmissionError || error instanceof DEJobScopeError || error instanceof DProductionJobCursorError || error instanceof DProductionPreparationError) return error.code;
  if (error?.constructor === Error) {
    const code = error.message.split(":", 1)[0];
    if (/^(?:[DE]_JOB_HANDOFF_[A-Z_]+|E_READBACK_[A-Z_]+|DE_SERVICE_CONFIGURATION_INVALID|SOFTWARE_JOB_PREPARATION_SOURCE_CONFLICT|D_PLATFORM_OBSERVATION_[A-Z_]+)$/.test(code)) return code;
  }
  throw error;
};
const blocker = (code, message) => ({ code, message });
const conflict = (view, code) => ({ ...view, sourceBlockReason: code, canContinueSaved: false, currentVerified: false,
  blockers: [...view.blockers, blocker(code, "保存的任务与当前商品来源不一致，请核对原记录。") ] });

function stageBase(stage, job) {
  return { stage, jobId: isCanonicalFrozenRef(job?.jobId) ? job.jobId : null, jobRevision: job?.revision ?? null,
    status: job?.status ?? "source_conflict", externalRequestState: job?.externalRequestState ?? null,
    receiptStatus: "none", businessStatus: null, currentVerified: false, lateMaterial: false,
    canContinueSaved: false, sourceBlockReason: null, configurationBlockReason: null, blockers: [] };
}

function savedMaterial(stage, job, candidate, view, observedAt) {
  const sku = candidate.lifecycleV11.skuPackage;
  if (stage === "D") {
    const state = sku.dSoftwareExecution;
    if (state?.status === "succeeded") {
      const authorization = state.productionPlan?.sourceAuthorization;
      if (!authorization || fingerprintCanonicalRecord(authorization) !== job.scopeBinding.authorizationFingerprint ||
          !isDeepStrictEqual(state.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId })) {
        throw new Error("D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT");
      }
      const record = assertDProductionRecordSource({ record: state.attempt?.productionRecord, authorization, observedAt });
      assertDProductionReceiptChain({ state, authorization, record, candidateId: candidate.id });
      view.receiptStatus = "production_record_saved";
      view.businessStatus = "production_recorded";
    } else if (state?.checkpoints?.length || job.preparationEvidence || sku.dAssetTransport) {
      view.receiptStatus = "progress_saved";
    }
    if (state?.schemaVersion === 'd-software-execution-state-v2' && state.platformContinuation) {
      const continuation=state.platformContinuation;
      if(state.status === 'waiting_platform') readDProductionJobWaiting({candidate,job,observedAt});
      else if(continuation.inventoryWriteState === 'not_sent' && ['failed','unknown_outcome'].includes(state.status)) {
        if (job.resultEnvelope?.payload?.schemaVersion === 'd-initial-import-stop-job-result-v1') readDInitialImportStoppedJobTerminal({candidate,job,observedAt});
        else readDPlatformStoppedJobTerminal({candidate,job,observedAt});
      }
      view.businessStatus=continuation.status;
      view.platformObservation={status:continuation.status,queriesUsed:continuation.queryCount,
        queryLimit:continuation.policy?.maxQueries ?? null,inventoryWriteState:continuation.inventoryWriteState,
        nextJobId:continuation.activeObservationJobId};
      const messages={waiting_import:'平台已接收导入，等待有限只读查询确认。',waiting_price:'导入已确认，尚需核验库存写入前提。',
        waiting_inventory:'价格发送状态已核验，尚需核验准确仓库的预留库存。',prerequisites_observed:'只读前提已取得，等待原生产任务核验后续执行。',
        platform_failed:'平台明确报告导入失败；不会重新导入。',platform_skipped:'平台明确报告导入被跳过；不会自动写库存。',
        query_budget_exhausted:'本轮查询次数或期限已用尽，已停止。',unknown_outcome:'本轮观察结果无法确认，已停止且不会重放导入。',
        blocked:'缺少已核实的后续执行前提，库存尚未发送。',inventory_not_sent_interrupted:'库存发送前服务中断，原导入回执已保留。'};
      if (continuation.status === 'waiting_import' && continuation.policy === null) messages.waiting_import='平台已接收导入；查询策略未配置，尚未安排查询。';
      if (job.resultEnvelope?.payload?.schemaVersion === 'd-initial-import-stop-job-result-v1') messages.blocked=
        state.blockReason === 'lease_expired' ? '导入任务已接收，但执行租约已过期；已停止后续查询，库存尚未发送。' :
          '导入任务已接收，但商品、执行配置或查询期限已不满足后续条件；已停止查询，库存尚未发送。';
      if(Object.hasOwn(messages,continuation.status)) view.blockers.push(blocker(`D_PLATFORM_${continuation.status.toUpperCase()}`,messages[continuation.status]));
    }
    if (job.preparationEvidence) {
      const preparation = assertDProductionPreparation(job.preparationEvidence, { job });
      if (preparation.status === "not_ready") {
        const messages = {
          account_evidence_missing: "尚未保存这家店铺的账户核验证据。",
          evidence_source_unverified: "账户资料的官方来源尚未核验。",
          account_evidence_not_current: "账户核验证据尚未生效或已过期。"
        };
        const fields = { permission: "账号权限", imagePermission: "图片权限", priceCurrency: "后台价格币种",
          apiConnection: "API连接", sellerBackendConnection: "卖家后台连接", writeScope: "授权字段的可写范围" };
        for (const gap of preparation.result.capabilities.gaps) {
          if (gap.code === "account_inspection_not_ready" && !Object.hasOwn(fields, gap.field)) throw new Error("D_JOB_HANDOFF_PREFLIGHT_FIELD_INVALID");
          const message = Object.hasOwn(messages, gap.code) ? messages[gap.code] : (gap.code === "account_inspection_not_ready"
            ? `${fields[gap.field]}尚未核验通过。`
            : gap.code.startsWith("OZON_DE_PREFLIGHT_EVIDENCE_") ? "保存的账户证据校验失败，需要修复。" : gap.message);
          if (!view.blockers.some(item => item.message === message)) view.blockers.push(blocker(gap.code, message));
        }
      } else if (preparation.status === "unknown_outcome" && preparation.requestMode === "persisted_evidence_only") {
        view.blockers.push(blocker("local_preflight_unavailable", "本地证据检查未完成，商品尚未写入店铺。"));
      }
    }
  } else {
    const attempts = sku.readbackHistory.filter(attempt => attempt?.softwareJobRef?.jobId === job.jobId);
    if (attempts.length > 1) throw new Error("E_READBACK_ATTEMPT_DUPLICATE");
    if (attempts.length === 0 && (job.status === "completed" || ["in_flight", "succeeded", "unknown_outcome"].includes(job.externalRequestState))) {
      throw new Error("E_READBACK_ATTEMPT_SCOPE_CONFLICT");
    }
    if (attempts.length === 1) {
      const attempt = assertEReadbackAttempt(attempts[0]);
      if (attempt.result) {
        view.receiptStatus = "readback_saved";
        view.businessStatus = attempt.result.status;
        if (attempt.candidateId !== job.candidateId || attempt.skuPackageId !== job.skuPackageId ||
            attempt.requestedByUserId !== job.workerId || attempt.sourceProductionRecordId !== job.scopeBinding.sourceProductionRecordId ||
            !isDeepStrictEqual(attempt.softwareJobRef, { jobId: job.jobId, revision: job.revision, workerId: job.workerId, leaseId: job.leaseId }) ||
            attempt.sourceFingerprint !== fingerprintCanonicalRecord({ productionRecord: sku.dSoftwareExecution?.attempt?.productionRecord,
              identity: job.scopeBinding.identity, variantKey: job.scopeBinding.variantKey })) throw new Error("E_READBACK_SOURCE_SCOPE_CONFLICT");
        view.currentVerified = job.status === "completed" && job.externalRequestState === "succeeded" &&
          attempt.status === "verified" && attempt.applicationDisposition === "applied" &&
          isDeepStrictEqual(sku.eVerificationRecord, attempt.result.eVerificationRecord) &&
          validateSystemCreatedVerificationRecord(attempt.result.eVerificationRecord, sku.productionRecord).valid;
      }
    }
  }
  view.lateMaterial = job.status === "unknown_outcome" && view.receiptStatus !== "none";
  return view;
}

function currentSource(stage, job, candidate, document) {
  if (stage === "D") assertDProductionJobReference({ document, candidate, job });
  else assertEReadbackJobReference({ document, candidate, job });
  assertDEJobAdmissionDecision(job, job.admissionDecision);
  const sku = candidate.lifecycleV11.skuPackage, scope = job.scopeBinding;
  if (!isDeepStrictEqual(scope.identity, sku.g1Identity) || scope.variantKey !== sku.variantKey ||
      candidate.targetStore !== scope.identity.storeRef.stableStoreId || !isDeepStrictEqual(candidate.storeRef, scope.identity.storeRef) ||
      sku.supplierSkuId !== scope.identity.supplierSkuId || sku.targetPlatform !== scope.identity.platform ||
      sku.targetStore !== scope.identity.storeRef.stableStoreId) throw new Error("E_READBACK_SOURCE_SCOPE_CONFLICT");
}

function continuationConfiguration({ stage, job, candidate, runtime, serviceBindings, productionBindings, dependencyView, observedAt }) {
  const blockers = [];
  const services = serviceBindings.filter(binding => binding.productionBindingId === job.scopeBinding.productionBinding.bindingId);
  const productions = productionBindings.filter(binding => binding.bindingId === job.scopeBinding.productionBinding.bindingId);
  if (services.length !== 1) blockers.push(blocker("DE_SERVICE_REQUIRED", "尚未配置本店的生产与回读服务。"));
  if (productions.length !== 1) blockers.push(blocker("DE_PRODUCTION_BINDING_REQUIRED", "尚未配置本店对应的仓库与连接。"));
  for (const [key, message] of [["transport", "尚未接入平台连接。"], ["capabilities", "尚未接入平台能力检查。"],
    ...(stage === "D" ? [["preflight", "尚未接入生产前检查。"]] : [])]) {
    if (dependencyView[key] !== true) blockers.push(blocker(`DE_${key.toUpperCase()}_REQUIRED`, message));
  }
  const sku = candidate.lifecycleV11.skuPackage;
  if (stage === "D" && sku.productionAuthorization.lockedScope.finalUploads.some(asset => asset.assetRef.startsWith("local-asset:")) &&
      dependencyView.assetTransport !== true) blockers.push(blocker("DE_ASSET_TRANSPORT_REQUIRED", "尚未接入最终素材传输。"));
  if (services.length !== 1 || productions.length !== 1) return blockers;
  try { normalizeDEServiceBindings(services, productions); }
  catch (error) { blockers.push(blocker(knownCode(error), "保存任务所需的服务配置不完整或版本不一致。")); return blockers; }
  const service = services[0], production = productions[0];
  const workers = (runtime.workers ?? []).filter(worker => worker.workerId === service.workerId);
  const worker = workers[0];
  if (workers.length !== 1 || worker.status !== "online" || worker.version !== service.workerVersion ||
      !workerSatisfiesCapabilities(worker, job.requiredCapabilities)) {
    blockers.push(blocker("DE_WORKER_REQUIRED", "当前没有符合本任务要求的执行端，请检查服务接线。"));
    return blockers;
  }
  const executionBinding = { schemaVersion: "d-e-execution-binding-v1", serviceId: service.serviceId,
    serviceConfigurationVersion: service.configurationVersion,
    productionBinding: { bindingId: production.bindingId, configurationVersion: production.configurationVersion, warehouseId: production.warehouseId },
    platform: production.platform, storeRef: production.storeRef, warehouseRef: production.warehouseRef, credentialAlias: production.credentialAlias,
    workerId: service.workerId, workerVersion: service.workerVersion, configurationEvidence: production.verification };
  try { createDEJobAdmissionDecision({ candidate, job, observedAt, phase: "claim", executionBinding, worker }); }
  catch (error) {
    const code = knownCode(error);
    blockers.push(blocker(code, code.includes("EVIDENCE_EXPIRED") ? "本店连接与仓库的核验记录已过期，请先更新配置。"
      : "当前商品、执行端或店铺连接与原任务不一致，暂不能继续。"));
  }
  return blockers;
}

/** Read-only display projection. Presence of configured providers is not a platform health check or permission to send. */
export function buildDESavedJobRuntimeView({ candidate, runtime, serviceBindings = [], productionBindings = [], dependencyView = {}, observedAt }) {
  if (!isRuntimeConfigurationTimestamp(observedAt)) throw new TypeError("DE_RUNTIME_VIEW_TIME_INVALID");
  if (!runtime || (runtime.softwareJobs !== undefined && !Array.isArray(runtime.softwareJobs)) || !Array.isArray(serviceBindings) || !Array.isArray(productionBindings) ||
      (runtime.workers !== undefined && !Array.isArray(runtime.workers)) || !dependencyView || typeof dependencyView !== "object" ||
      ["transport", "preflight", "capabilities", "assetTransport"].some(key => Object.hasOwn(dependencyView, key) && typeof dependencyView[key] !== "boolean")) {
    throw new TypeError("DE_RUNTIME_VIEW_INPUT_INVALID");
  }
  const lifecycle = candidate.lifecycleV11, sku = lifecycle?.skuPackage;
  if (!sku) return null;
  const refs = { D: sku.dHandoff?.softwareJobRef, E: lifecycle.eIndependentReadbackJobRefV1 };
  const jobs = (runtime.softwareJobs ?? []).filter(job => job.candidateId === candidate.id || job.jobId === refs.D?.jobId || job.jobId === refs.E?.jobId);
  if (sku.dHandoff?.schemaVersion !== "c2-d-handoff-v2" && !refs.D && !refs.E &&
      !jobs.some(job => Object.values(TYPES).includes(job.jobType))) return null;
  const document = { candidates: [candidate], runtime: { softwareJobs: jobs } };
  const stages = {};
  for (const stage of ["D", "E"]) {
    const relevant = jobs.filter(job => job.jobType === TYPES[stage] && job.candidateId === candidate.id);
    const expectsE = sku.dSoftwareExecution?.status === "succeeded" && sku.dSoftwareExecution.continuationBlocked === false &&
      stages.d?.status === "completed";
    if (stage === "E" && !refs.E && relevant.length === 0 && !expectsE) { stages.e = null; continue; }
    const job = relevant.find(job => job.jobId === refs[stage]?.jobId) ?? relevant[0];
    let view = stageBase(stage, job);
    if (!job || relevant.length !== 1 || !refs[stage]) { stages[stage.toLowerCase()] = conflict(view, "DE_SAVED_JOB_REFERENCE_CONFLICT"); continue; }
    try {
      view = savedMaterial(stage, job, candidate, view, observedAt);
      currentSource(stage, job, candidate, document);
    } catch (error) { stages[stage.toLowerCase()] = conflict(view, knownCode(error)); continue; }
    const queued = job.status === "queued" && job.attempt === 0 && job.externalRequestState === "not_sent" &&
      job.workerId === null && job.leaseId === null && job.externalRequestRef === null;
    if (job.status === "queued" && !queued) view = conflict(view, "DE_SAVED_JOB_NOT_PRISTINE");
    if (queued) {
      const existingWork = stage === "D" ? sku.dSoftwareExecution || sku.dAssetTransport || Object.hasOwn(job, "preparationEvidence") :
        sku.readbackHistory.some(attempt => attempt?.sourceProductionRecordId === job.scopeBinding.sourceProductionRecordId);
      if (existingWork || candidate.dataRevision !== job.revision) view = conflict(view, existingWork ? "DE_SAVED_INTENT_EXISTS" : "DE_CANDIDATE_REVISION_CONFLICT");
      else {
        try { createDEJobAdmissionDecision({ candidate, job, observedAt, phase: "enqueue_current" }); }
        catch (error) { stages[stage.toLowerCase()] = conflict(view, knownCode(error)); continue; }
        view.blockers = continuationConfiguration({ stage, job, candidate, runtime, serviceBindings, productionBindings, dependencyView, observedAt });
        view.configurationBlockReason = view.blockers[0]?.code ?? null;
        view.canContinueSaved = view.blockers.length === 0;
      }
    }
    stages[stage.toLowerCase()] = view;
  }
  const sourceConflict = [stages.d, stages.e].some(stage => stage?.sourceBlockReason);
  if (sourceConflict && stages.e) stages.e.currentVerified = false;
  const active = stages.e ?? stages.d;
  const currentVerified = !sourceConflict && stages.e?.currentVerified === true;
  const canContinueSaved = !sourceConflict && active.canContinueSaved;
  return { schemaVersion: "d-e-saved-job-runtime-view-v1", ...stages,
    status: sourceConflict ? "source_conflict" : currentVerified ? "verified" : active.status,
    currentVerified, canContinueSaved, continueJobId: canContinueSaved ? active.jobId : null,
    expectedRevision: candidate.dataRevision, automaticRetryAllowed: false, platformHealth: "not_checked" };
}
