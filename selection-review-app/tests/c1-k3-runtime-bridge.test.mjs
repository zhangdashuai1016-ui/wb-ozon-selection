import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveC1K3RuntimeEvidence } from "../lib/c1-k3-runtime-bridge.mjs";

test("活动C1运行接缝只传K3快照和当前绑定，不把旧扁平证据当兜底", () => {
  const snapshot = { schemaVersion: "keyword-evidence-snapshot-v1", snapshotId: "keyword-evidence:NON-TRAIN:9" };
  const binding = { candidateId: "NON-TRAIN", skuPackageId: "sku:NON-TRAIN:WHITE", dataRevision: 9 };
  const result = resolveC1K3RuntimeEvidence({
    frozenSeoRules: { rulesVersion: "seo-v1" },
    k3KeywordEvidenceSnapshot: snapshot,
    k3CurrentBinding: binding,
    savedKeywordEvidence: { evidenceId: "legacy-should-not-flow" },
    legacySavedKeywordEvidenceReadOnly: true
  });
  assert.deepEqual(result.k3KeywordEvidenceSnapshot, snapshot);
  assert.deepEqual(result.k3CurrentBinding, binding);
  assert.equal(result.savedKeywordEvidence, null);
  assert.equal(result.legacySavedKeywordEvidenceReadOnly, false);
});

test("旧扁平证据只有显式历史只读标记且没有K3快照时才可读取", () => {
  const legacy = { evidenceId: "legacy:audit-only" };
  assert.equal(resolveC1K3RuntimeEvidence({ savedKeywordEvidence: legacy }).savedKeywordEvidence, null);
  const result = resolveC1K3RuntimeEvidence({
    savedKeywordEvidence: legacy,
    legacySavedKeywordEvidenceReadOnly: true
  });
  assert.deepEqual(result.savedKeywordEvidence, legacy);
  assert.equal(result.legacySavedKeywordEvidenceReadOnly, true);
});

test("运行接缝克隆输入，单SKU上下文不能被后续调用静默篡改", () => {
  const evidence = {
    k3KeywordEvidenceSnapshot: { snapshotId: "keyword-evidence:SKU-A:3" },
    k3CurrentBinding: { candidateId: "SKU-A", skuPackageId: "sku:SKU-A:BLUE", dataRevision: 3 }
  };
  const result = resolveC1K3RuntimeEvidence(evidence);
  evidence.k3CurrentBinding.candidateId = "SKU-B";
  assert.equal(result.k3CurrentBinding.candidateId, "SKU-A");
  assert.equal(result.k3KeywordEvidenceSnapshot.snapshotId, "keyword-evidence:SKU-A:3");
});

test("server活动编排经C1草稿运行服务显式传K3字段并禁止直接读取旧savedKeywordEvidence", async () => {
  // The live C1 seam moved out of server.mjs: server -> c1-draft-runtime-services -> c1-ai-draft-request-source -> input preparation.
  const read = relative => readFile(new URL(relative, import.meta.url), "utf8");
  const [server, services, requestSource, preparation] = await Promise.all([
    read("../server.mjs"), read("../lib/c1-draft-runtime-services.mjs"),
    read("../lib/c1-ai-draft-request-source.mjs"), read("../lib/c1-software-input-preparation.mjs")
  ]);
  // server 只经 C1 草稿运行服务进入活动 C1 编排，不直接碰旧证据、旧桥或输入准备
  assert.match(server, /import \{ createC1DraftRuntimeServices \} from "\.\/lib\/c1-draft-runtime-services\.mjs"/);
  assert.match(server, /c1DraftRuntimeServices\.prepareCurrent\(/);
  assert.match(server, /c1DraftRuntimeServices\.continueSavedCurrent\(/);
  assert.doesNotMatch(server, /savedKeywordEvidence|resolveC1K3RuntimeEvidence|prepareC1SoftwareInputs|runC1SoftwareOrchestration/);
  // 运行服务只经当前请求源取证据
  assert.match(services, /import \{ prepareCurrentC1AiDraftRequest \} from "\.\/c1-ai-draft-request-source\.mjs"/);
  assert.match(services, /prepareCurrentC1AiDraftRequest\(candidate, serverClock\(\)\)/);
  assert.doesNotMatch(services, /savedKeywordEvidence|legacySavedKeywordEvidenceReadOnly/);
  // 请求源只从冻结的 c1SoftwareEvidenceV1 显式传 K3 快照与当前绑定，并与 lifecycle 的 K3 记录指纹对账
  assert.match(requestSource, /const evidence = lifecycle\?\.c1SoftwareEvidenceV1;/);
  assert.match(requestSource, /!lifecycle\.k3KeywordEvidenceSnapshotV1 \|\| !lifecycle\.k3CurrentBindingV1/);
  assert.match(requestSource, /fingerprintCanonicalRecord\(evidence\.k3KeywordEvidenceSnapshot\) !== fingerprintCanonicalRecord\(lifecycle\.k3KeywordEvidenceSnapshotV1\)/);
  assert.match(requestSource, /fingerprintCanonicalRecord\(evidence\.k3CurrentBinding\) !== fingerprintCanonicalRecord\(lifecycle\.k3CurrentBindingV1\)/);
  assert.match(requestSource, /k3KeywordEvidenceSnapshot: evidence\.k3KeywordEvidenceSnapshot,/);
  assert.match(requestSource, /k3CurrentBinding: evidence\.k3CurrentBinding,/);
  assert.match(requestSource, /prepareC1SoftwareInputs\(\{ \.\.\.inputs, preparedAt: observedAt \}\)/);
  assert.doesNotMatch(requestSource, /savedKeywordEvidence|legacySavedKeywordEvidenceReadOnly|resolveC1K3RuntimeEvidence/);
  // 输入准备保留旧扁平证据守卫：活动路径默认不可读，只有显式历史只读才可读
  assert.match(preparation, /savedKeywordEvidence = null,/);
  assert.match(preparation, /legacySavedKeywordEvidenceReadOnly = false,/);
  assert.match(preparation, /k3Adaptation === null && savedKeywordEvidence !== null && legacySavedKeywordEvidenceReadOnly !== true/);
});
