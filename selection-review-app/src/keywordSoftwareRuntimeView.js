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
    : "未检测到本机Seerfar凭据登记";
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
  const consumerUnavailable = job.status === "queued" && runtimeStatus?.consumerConnected === false;
  const localFailureAfterSuccess = job.status === "failed" && job.externalRequestState === "succeeded";
  return {
    status: job.status,
    title: consumerUnavailable ? "关键词作业已排队，执行器尚未接入"
      : localFailureAfterSuccess ? "关键词请求已成功，本地证据处理失败"
        : JOB_LABELS[job.status] || job.status,
    detail: consumerUnavailable
      ? "当前仅支持保存作业；真实执行器尚未接入，不会因排队而调用Seerfar或扣点。"
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
