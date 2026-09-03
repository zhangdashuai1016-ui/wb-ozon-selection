import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTOR_TYPES,
  authorizeExceptionMaintenance,
  blockExecutionForTechnicalFailure,
  buildExecutionRuntimeView,
  codexDispatchGate,
  completeExecutionStep,
  createSoftwareExecutionRuntime,
  openExceptionCase,
  recordExceptionMaintenanceStarted,
  resolveExceptionCase,
  simulateNormalSoftwarePath,
  startSoftwareStep,
  startThirdPartyAiStep,
  validateExecutionRuntime,
  waitForOwner
} from "../lib/software-execution-state.mjs";

const at = "2026-08-22T01:00:00.000Z";

function runtime() {
  return createSoftwareExecutionRuntime({ candidateId: "SIM-1", dataRevision: 7, businessPhase: "A", at });
}

test("四类执行者被固定为软件、第三方AI、Codex异常和主人", () => {
  assert.deepEqual(EXECUTOR_TYPES, ["software", "third_party_ai", "codex_exception", "owner"]);
  const software = startSoftwareStep(runtime(), { stepId: "A_VALIDATE", inputRevision: 7, at });
  assert.equal(software.executorType, "software");
  const ai = startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "inf-1", at });
  assert.equal(ai.executorType, "third_party_ai");
  const owner = waitForOwner(runtime(), { stepId: "A_OWNER_CONFIRM", inputRevision: 7, at });
  assert.equal(owner.executorType, "owner");
  const exception = openExceptionCase(runtime(), {
    exceptionId: "exc-1",
    reasonCode: "evidence_conflict",
    failureLayer: "a_evidence",
    evidenceRefs: ["ev-1", "ev-2"],
    message: "两份证据冲突",
    at
  });
  assert.equal(exception.executorType, "software");
  assert.equal(exception.status, "blocked");
  assert.equal(exception.codexWakeupCount, 0);
});

test("正常软件SKU完成一步时Codex唤醒和派发均为0", () => {
  const result = simulateNormalSoftwarePath();
  assert.equal(result.runtime.status, "completed");
  assert.equal(result.codexWakeups, 0);
  assert.equal(result.dispatchesCreated, 0);
  assert.equal(result.platformAccesses, 0);
  assert.equal(result.platformWrites, 0);
});

test("第三方AI必须绑定作业与结果凭证，不能把无凭证输出标完成", () => {
  assert.throws(
    () => startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "", at }),
    /inferenceJobId/
  );
  const running = startThirdPartyAiStep(runtime(), { stepId: "A_AI_ASSIST", inputRevision: 7, inferenceJobId: "inf-1", at });
  assert.throws(() => completeExecutionStep(running, { outputRevision: 8, at }), /INFERENCE_RECEIPT_REQUIRED/);
  const completed = completeExecutionStep(running, { outputRevision: 8, inferenceReceiptId: "receipt-1", at });
  assert.equal(completed.inferenceReceiptId, "receipt-1");
  assert.equal(validateExecutionRuntime(completed).valid, true);
});

test("ExceptionCase创建、授权、真实领取和解决分别记录，创建本身不冒充Codex唤醒", () => {
  for (const reasonCode of ["evidence_conflict", "output_schema_mismatch", "system_failure"]) {
    const opened = openExceptionCase(runtime(), {
      exceptionId: `exc-${reasonCode}`,
      reasonCode,
      failureLayer: "test_layer",
      evidenceRefs: ["ev-1"],
      sourceRevision: 9,
      message: "模拟异常",
      at
    });
    assert.equal(opened.businessPhase, "A");
    assert.equal(opened.exceptionCase.businessStateChanged, false);
    assert.equal(opened.exceptionCase.schemaVersion, "exception-case-v2");
    assert.equal(opened.exceptionCase.sourceRevision, 9, "异常必须锁定失败现场修订，不沿用旧runtime修订");
    assert.equal(opened.exceptionCase.automaticRetryAllowed, false);
    assert.equal(opened.exceptionCase.dispatchState, "not_dispatched");
    assert.equal(opened.codexWakeupCount, 0);
    assert.equal(codexDispatchGate({ lifecycleV11: { opportunityPackage: {} }, executionRuntime: opened }).allowed, false);

    const authorized = authorizeExceptionMaintenance(opened, {
      exceptionId: opened.exceptionCase.exceptionId,
      maintenanceAuthorizationId: `maintenance-auth:${reasonCode}`,
      at
    });
    assert.equal(codexDispatchGate({ lifecycleV11: { opportunityPackage: {} }, executionRuntime: authorized }).allowed, true);
    assert.equal(authorized.codexWakeupCount, 0);

    const started = recordExceptionMaintenanceStarted(authorized, {
      exceptionId: authorized.exceptionCase.exceptionId,
      turnId: `turn:${reasonCode}`,
      at
    });
    assert.equal(started.executorType, "codex_exception");
    assert.equal(started.codexWakeupCount, 1);

    const resolved = resolveExceptionCase(started, {
      exceptionId: started.exceptionCase.exceptionId,
      resolutionCode: "code_fixed_and_verified",
      evidenceRefs: ["test:verification"],
      at
    });
    assert.equal(resolved.exceptionCase.status, "resolved");
    assert.equal(resolved.status, "blocked", "解决技术案件不能自动恢复业务执行");
  }
  assert.throws(() => openExceptionCase(runtime(), {
    exceptionId: "exc-bad", reasonCode: "permission_required", failureLayer: "x", evidenceRefs: [], at
  }), /EXCEPTION_REASON_NOT_ALLOWED/);
  assert.throws(() => openExceptionCase(runtime(), {
    exceptionId: "exc-secret",
    reasonCode: "system_failure",
    failureLayer: "x",
    evidenceRefs: ["request:token=do-not-store"],
    at
  }), /不得包含秘密/);
});

test("已知外部失败和结果未知由软件安全停止，不创建ExceptionCase或唤醒Codex", () => {
  for (const kind of ["external_dependency", "known_technical_failure", "unknown_outcome"]) {
    const blocked = blockExecutionForTechnicalFailure(runtime(), {
      failureId: `failure:${kind}`,
      kind,
      errorCode: "TEST_FAILURE",
      failureLayer: "test_layer",
      evidenceRefs: ["test:evidence"],
      softwareJobId: kind === "unknown_outcome" ? "job:unknown" : null,
      sourceRevision: 10,
      at
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.executorType, "software");
    assert.equal(blocked.exceptionCase, null);
    assert.equal(blocked.codexWakeupCount, 0);
    assert.equal(blocked.technicalFailure.automaticRetryAllowed, false);
    assert.equal(blocked.technicalFailure.businessStateChanged, false);
    assert.equal(blocked.technicalFailure.sourceRevision, 10);
    assert.throws(() => startSoftwareStep(blocked, { stepId: "RETRY", inputRevision: 7, at }), /EXECUTION_BLOCKED_BY_TECHNICAL_FAILURE/);
  }
});

test("新版正常商品禁止Codex派发，旧记录只读展示", () => {
  const normal = { lifecycleV11: { opportunityPackage: { businessPhase: "A" } }, executionRuntime: runtime(), dataRevision: 7 };
  assert.equal(codexDispatchGate(normal).allowed, false);
  const forgedException = {
    lifecycleV11: { opportunityPackage: { businessPhase: "A" } },
    executionRuntime: {
      status: "blocked",
      exceptionCase: {
        schemaVersion: "exception-case-v2",
        status: "open",
        dispatchState: "queued",
        maintenanceAuthorizationId: "maintenance:forged"
      }
    }
  };
  assert.equal(codexDispatchGate(forgedException).allowed, false, "不完整或伪造的ExceptionCase不能绕过派发门禁");
  const derived = buildExecutionRuntimeView({ lifecycleV11: { skuPackage: { businessPhase: "C1" } }, dataRevision: 4 });
  assert.equal(derived.executorType, "software");
  assert.equal(derived.legacyReadOnly, false);
  const legacy = buildExecutionRuntimeView({ workflowStatus: "codex_processing", processing: { currentStep: "M04" }, dataRevision: 2 });
  assert.equal(legacy.legacyReadOnly, true);
  assert.equal(legacy.executorType, null);
  const legacyGate = codexDispatchGate({ workflowStatus: "codex_processing", processing: { currentStep: "M04" } });
  assert.equal(legacyGate.allowed, false);
  assert.equal(legacyGate.mode, "legacy_read_only");
});
