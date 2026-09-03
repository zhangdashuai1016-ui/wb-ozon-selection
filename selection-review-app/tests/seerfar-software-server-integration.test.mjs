import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("4317接入固定钥匙串运行时但真实软件执行默认关闭", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const seerfarSoftwareExecutionEnabled = false/);
  assert.match(server, /const c1PaidKeywordGenericQueueEnabled = true/);
  assert.match(server, /softwareJobQueueEnabled: c1PaidKeywordGenericQueueEnabled/);
  assert.match(server, /consumerConnected: false/);
  assert.match(server, /executionBlocker: "awaiting_runtime_binding"/);
  assert.match(server, /directProviderExecutionEnabled: false/);
  assert.doesNotMatch(server, /createSeerfarRuntimeTransport\(\)|SEERFAR_SOFTWARE_EXECUTION_DISABLED/);
  assert.match(server, /keyword-evidence-software-run/);
  assert.match(server, /\/api\/integrations\/seerfar\/runtime-status/);
});

test("服务端使用纯用例入队generic SoftwareJob，服务重启只迁移旧局部in_flight为unknown_outcome", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const useCase = await readFile(new URL("../lib/c1-keyword-software-use-case.mjs", import.meta.url), "utf8");
  const state = await readFile(new URL("../lib/keyword-evidence-software-job-state.mjs", import.meta.url), "utf8");
  assert.match(server, /enqueueC1PaidKeywordEvidenceJob\(\{/);
  assert.match(useCase, /prepareC1KeywordSoftwareExecution\(\{/);
  assert.match(useCase, /executeBusinessMutation\(\{/);
  assert.match(useCase, /c1PaidKeywordEvidenceJobRefV1/);
  assert.doesNotMatch(useCase, /createKeywordEvidenceSoftwareJobIntent|runKeywordEvidenceSoftwareJob/);
  assert.doesNotMatch(server, /openApiTransport: createSeerfarRuntimeTransport\(\)|current\.lifecycleV11\.keywordEvidenceSoftwareJobV1 = structuredClone\(intent\)/);
  assert.match(server, /reconcileOrphanedKeywordEvidenceSoftwareJobsAfterRestart/);
  assert.match(server, /reconcileLegacyC1KeywordEvidenceSoftwareJobsInDocument/);
  assert.match(state, /service_restarted_during_provider_attempt/);
});

test("关键词软件作业只接受revision并停用三条旧注入入口", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const planner = await readFile(new URL("../lib/c1-keyword-software-job-planner.mjs", import.meta.url), "utf8");
  assert.match(planner, /客户端只允许提交dataRevision/);
  assert.match(server, /只接受application\/json/);
  assert.match(server, /拒绝非评审台页面来源/);
  assert.match(server, /旧C1事实关键词注入入口已停用/);
  assert.match(server, /旧关键词就绪事件注入入口已停用/);
  assert.match(server, /旧C1软件证据手工冻结入口已停用/);
  assert.match(server, /C1_KEYWORD_SOFTWARE_NOT_READY/);
  assert.match(server, /directProviderExecutionEnabled: false/);
  assert.doesNotMatch(server, /SELECTION_REVIEW_SEERFAR_SOFTWARE_ENABLED !== "false"/);
});
