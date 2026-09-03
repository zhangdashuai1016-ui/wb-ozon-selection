import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("C1成功后由服务端原子创建C2软件容器，不停在旧C1状态", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /createC2SoftwareContainer\(\{/);
  assert.match(server, /assetRegions: \{ collected: \[\], aiDrafts: \[\], finalUploads: \[\] \}/);
  assert.match(server, /current\.lifecycleV11\.status = "c2_waiting_final_uploads"/);
  assert.match(server, /aiCompleted\.businessPhase = "C2"/);
  assert.match(server, /stepId: "C2_OWNER_FINAL_ASSETS"/);
  assert.doesNotMatch(server, /current\.lifecycleV11\.status = "c1_ai_draft_ready"/);
});

test("主人一次确认最终素材时锁定manifest并生成确认卡，但不创建生产授权", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /prepareC2FinalUploadManifest\(\{/);
  assert.match(server, /confirmC2SoftwareFinalUploads\(\{/);
  assert.match(server, /approvedManifestSha256: manifest\.manifestSha256/);
  assert.match(server, /createFinalProductPlanConfirmationCard\(\{/);
  assert.match(server, /未创建生产授权，零平台写入/);
});

test("活动C2软件模块没有火车、固定SKU、件数、价格或图片路径默认值", async () => {
  const sources = await Promise.all([
    "../lib/c2-asset-lifecycle.mjs",
    "../lib/c2-software-orchestrator.mjs"
  ].map((relative) => readFile(new URL(relative, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78", "小猴子做图产出物"]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});
