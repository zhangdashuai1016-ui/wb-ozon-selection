export function runtimeArchitectureView(status) {
  if (!status || status.schemaVersion !== "runtime-architecture-status-v1") {
    return {
      code: "unavailable",
      label: "运行架构状态未取得",
      detail: "无法确认业务状态保存边界",
      multiUserReady: false
    };
  }
  const centralMode = ["central_test", "central_production"].includes(status.deploymentMode);
  const centralBoundariesReady = status.status === "central_runtime_ready" &&
    status.multiUserReady === true && centralMode && status.concurrencyScope === "database_transaction" &&
    status.identityProvider && status.identityProvider !== "development_default" &&
    status.softwareJobStore && status.workerRegistry;
  if (centralBoundariesReady) {
    return {
      code: "central_ready",
      label: "中央运行可用",
      detail: `中央数据与任务边界已就绪；当前用户 ${status.currentUser?.userId || "未取得"}`,
      multiUserReady: true
    };
  }
  return {
    code: "local_development",
    label: "本地开发模式",
    detail: "业务状态由4317 Repository统一保存；当前JSON仅支持单进程，不具备多人并发",
    multiUserReady: false
  };
}
