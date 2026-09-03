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

test("server活动编排显式传K3字段并禁止直接读取旧savedKeywordEvidence", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /resolveC1K3RuntimeEvidence\(evidence\)/);
  assert.match(server, /k3KeywordEvidenceSnapshot: c1Evidence\.k3KeywordEvidenceSnapshot/);
  assert.match(server, /k3CurrentBinding: c1Evidence\.k3CurrentBinding/);
  assert.match(server, /legacySavedKeywordEvidenceReadOnly: c1Evidence\.legacySavedKeywordEvidenceReadOnly/);
  assert.doesNotMatch(server, /savedKeywordEvidence: evidence\.savedKeywordEvidence/);
});
