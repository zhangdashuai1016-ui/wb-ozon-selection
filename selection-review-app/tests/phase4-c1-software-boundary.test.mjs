import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("第4阶段服务端在B通过后自动续接C1软件路径且默认关闭手工C1输入入口", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/api.js", import.meta.url), "utf8");
  assert.match(server, /createC1DraftRuntimeServices/);
  assert.match(server, /c1DraftRuntimeServices\.continueSavedCurrent/);
  assert.match(server, /serviceBindings: runtimeConfiguration\.c1DraftServiceBindings/);
  assert.doesNotMatch(server, /loadCurrentExecution|c1DraftSoftwareRuntime\.continueCurrent/);
  assert.doesNotMatch(server, /runC1SoftwareOrchestration|resolveC1K3RuntimeEvidence/);
  const c1Continuation = server.slice(server.indexOf("async function continueC1SoftwareWhenEvidenceReady"), server.indexOf("async function prepareAndContinueC1FactKeywordEvidence"));
  assert.doesNotMatch(c1Continuation, /inferenceReceiptsV1|createC2SoftwareContainer|result\.status === "completed"/);
  assert.match(c1Continuation, /C1DraftRuntimeUnavailableError[\s\S]*c1DraftRuntimeView: buildC1DraftRuntimeView/);
  assert.match(c1Continuation, /c1DraftRuntimeServices\.prepareCurrent/);
  assert.doesNotMatch(c1Continuation, /authorizeAndEnqueue/);
  assert.match(server, /continueC1SoftwareWhenEvidenceReady\(candidate\.id, candidate\.dataRevision\)/);
  assert.match(server, /result\.profitModel\?\.result === "passed"/);
  assert.match(server, /SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT === "true"/);
  assert.match(server, /旧手工提交Schema、竞品文字和关键词的C1入口已停用/);
  assert.doesNotMatch(api, /completeLifecycleC1/);
});

test("C1软件证据只由服务端冻结计划生成并原子保存，旧手工证据入口已退役", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const useCase = await readFile(new URL("../lib/c1-keyword-software-use-case.mjs", import.meta.url), "utf8");
  assert.match(useCase, /prepareC1KeywordSoftwareExecution\(\{/);
  assert.match(useCase, /next\.lifecycleV11\.c1KeywordSoftwareJobPlanV1 = structuredClone\(preparation\.plan\)/);
  assert.match(useCase, /next\.lifecycleV11\.c1PaidKeywordEvidenceJobRefV1 = structuredClone\(preparation\.softwareJobRef\)/);
  assert.match(server, /current\.lifecycleV11 = patch\.lifecycleV11/);
  assert.match(server, /continueC1SoftwareWhenEvidenceReady\(candidateId, staged\.nextRevision\)/);
  assert.match(server, /旧C1软件证据手工冻结入口已停用/);
  assert.doesNotMatch(server, /prepareC1KeywordSoftwareExecution\(\{|current\.lifecycleV11\.keywordEvidenceSoftwareJobV1 = structuredClone\(intent\)/);
  assert.doesNotMatch(server, /preparedInputs:\s*input\.preparedInputs/);
});

test("第4阶段活动模块没有火车、固定SKU、固定件数或固定价格默认值", async () => {
  const sources = await Promise.all([
    "../lib/c1-ai-draft-contract.mjs",
    "../lib/c1-ai-gateway.mjs",
    "../lib/c1-k3-keyword-adapter.mjs",
    "../lib/c1-k3-runtime-bridge.mjs",
    "../lib/c1-software-evidence-stage.mjs",
    "../lib/c1-software-input-preparation.mjs",
    "../lib/c1-software-orchestrator.mjs"
  ].map((relative) => readFile(new URL(relative, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78"]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});
