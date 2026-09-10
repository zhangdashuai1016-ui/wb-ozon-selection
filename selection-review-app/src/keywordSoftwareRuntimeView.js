const JOB_LABELS = Object.freeze({
  queued: "关键词软件作业已排队",
  claimed: "关键词软件作业已领取",
  waiting_platform: "Seerfar软件分析中",
  completed: "关键词证据已完成",
  failed: "关键词证据技术失败",
  unknown_outcome: "运行结果未知，已停止",
  not_found: "关键词作业引用缺失"
});

export function keywordSoftwareRuntimeDisplay({ candidate, runtimeStatus }) {
  const skuPackage = candidate?.lifecycleV11?.skuPackage;
  const job = candidate?.c1PaidKeywordSoftwareJob ?? null;
  const planning = candidate?.c1KeywordSoftwarePlanningView ?? null;
  if (skuPackage?.businessPhase !== "C1" && !job) return null;

  const configured = runtimeStatus?.configured === true;
  const enabled = runtimeStatus?.softwareJobQueueEnabled === true;
  const providerLabel = configured
    ? "检测到本机Seerfar凭据登记；不表示本SKU已授权、已绑定或已扣点"
    : runtimeStatus?.configured === false ? "未检测到本机Seerfar凭据登记" : "尚未检查Seerfar凭据；普通打开页面不会读取凭据";
  if (!job) {
    const gapText = Array.isArray(planning?.gaps) && planning.gaps.length > 0
      ? planning.gaps.map((item) => item.message).filter(Boolean).join("；")
      : null;
    return {
      status: enabled && planning?.status === "not_ready" ? "not_ready" : enabled ? "waiting_software" : "disabled",
      title: enabled && planning?.status === "not_ready" ? "服务端计划尚未就绪" : enabled ? "等待服务端准备关键词作业" : "真实关键词软件执行尚未开启",
      detail: enabled
        ? gapText || "系统只按当前SKU冻结数据入队一次通用软件作业；页面不能自行拼接请求、选择其他SKU或调用Seerfar。"
        : "当前未开放通用软件作业入队；页面不会自动调用Seerfar。",
      providerLabel,
      jobId: null,
      failureClass: null
    };
  }

  const failureClass = job.failureClass || null;
  const handoffFailure = candidate?.executionRuntime?.technicalFailure;
  if (job.status === "completed" && handoffFailure?.status === "stopped" &&
      handoffFailure.softwareJobId === job.jobId && handoffFailure.failureLayer === "c1_keyword_handoff") {
    return {
      status: "handoff_blocked", recordedStatus: "completed", title: "关键词证据已保存，C1草稿执行配置尚未就绪",
      detail: "已保存明确配置缺口并停止交接；配置修复后可在文案准备中点击“继续准备文案”，复用原关键词结果，不会重复查询或再次付费。",
      providerLabel, jobId: job.jobId, failureClass: handoffFailure.errorCode
    };
  }
  const handoffException = candidate?.executionRuntime?.exceptionCase;
  if (job.status === "completed" && handoffException?.status === "open" &&
      handoffException.softwareJobId === job.jobId && handoffException.failureLayer === "c1_keyword_handoff") {
    return {
      status: "handoff_failed", recordedStatus: "completed", title: "关键词证据已保存，后续C1交接因异常停止",
      detail: "关键词查询已完成；交接异常已保存，维护处理前不会自动重试，也不会重复付费。",
      providerLabel, jobId: job.jobId, failureClass: "c1_keyword_handoff"
    };
  }
  if (job.admissionFailure) {
    return {
      status: "blocked", recordedStatus: job.status, title: "关键词作业执行条件已失效",
      detail: "当前授权、资料版本或执行资格未通过检查，已停止发送请求；请查看作业缺口，不能重复付费重试。",
      providerLabel, jobId: job.jobId || null, failureClass: job.admissionFailure.code || "admission_rejected"
    };
  }
  if (job.status === "queued" && runtimeStatus?.serviceStatus === "failed") {
    return {
      status: "blocked", recordedStatus: job.status, title: "关键词执行服务因异常停止",
      detail: "排队记录已保存，服务需要维护；本作业未因页面打开而再次发送。",
      providerLabel, jobId: job.jobId || null, failureClass: "runtime_failed"
    };
  }
  if (["claimed", "waiting_platform"].includes(job.status) && job.currentExecutionConfirmed !== true) {
    return {
      status: "historical_unconfirmed",
      recordedStatus: job.status,
      title: "历史关键词作业 · 当前运行未确认",
      detail: job.status === "waiting_platform"
        ? "上次记录正在等待平台结果；本次服务没有确认该执行，须先核对已有请求和回执，禁止自动重试或再次付费。"
        : "保留上次领取记录；本次服务没有确认该执行，打开页面不会重新领取、恢复作业或调用Seerfar。",
      providerLabel,
      jobId: job.jobId || null,
      failureClass
    };
  }
  const consumerUnavailable = job.status === "queued" && runtimeStatus?.consumerConnected === false;
  const localFailureAfterSuccess = job.status === "failed" && job.externalRequestState === "succeeded";
  return {
    status: job.status,
    title: consumerUnavailable ? "关键词排队记录已保存，执行器尚未接入"
      : job.status === "queued" ? "关键词排队记录已保存，尚未开始执行"
      : localFailureAfterSuccess ? "关键词请求已成功，本地证据处理失败"
        : JOB_LABELS[job.status] || job.status,
    detail: consumerUnavailable
      ? "当前仅支持保存作业；真实执行器尚未接入，不会因排队而调用Seerfar或扣点。"
      : job.status === "queued"
        ? "这里只显示已保存的排队记录；它不证明本次服务已领取任务，打开页面不会自动恢复历史作业。"
      : localFailureAfterSuccess
        ? `失败层：${failureClass || "未验证"}。外部请求已成功，须先核对保存结果，禁止再次付费或自动重试。`
        : job.status === "completed"
      ? "当前SKU的单次作业已收口；后续只读取保存的证据，不重复调用。"
      : ["queued", "claimed", "waiting_platform"].includes(job.status)
        ? "已锁定当前SKU和修订号；worker只有在取得租约、授权和凭据绑定后才能发起一次Open API请求。"
        : `失败层：${failureClass || "未验证"}。B利润结论不变，系统不会自动重试。`,
    providerLabel,
    jobId: job.jobId || null,
    failureClass
  };
}
