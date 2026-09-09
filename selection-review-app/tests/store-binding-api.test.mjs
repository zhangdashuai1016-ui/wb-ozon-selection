import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1 || [4317, 4318, 4173].includes(port)) throw new Error("TEST_REQUIRES_ISOLATED_PORT");
const base = `http://127.0.0.1:${port}`;
const binding = { targetStore: "dandanshu", platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-001", mappingVersion: "synthetic-v1" } };

test("配置映射经新增、保存和持久文件回读；错绑请求在任何采集或B读取前拒绝", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "store-binding-api-"));
  const dataFile = path.join(directory, "state.json");
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {}, candidates: [], dispatches: [], evidencePacks: [] }));
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([binding]), SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("API_START_TIMEOUT")), 10000);
    let output = "";
    const onData = chunk => { output += chunk; if (output.includes(`http://127.0.0.1:${port}`)) done(); };
    const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
  });
  async function request(method, route, input) {
    const response = await fetch(`${base}${route}`, { method, headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  }
  const created = await request("POST", "/api/candidates", { targetStore: "wb", productUrl: "https://example.invalid/synthetic-product", productName: "Synthetic product" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let candidate = created.body.candidate;
  assert.equal(candidate.storeRef, null);
  const route = `/api/candidates/${encodeURIComponent(candidate.id)}`;
  const unboundBytes = await readFile(dataFile, "utf8");
  const unboundEvidence = await request("POST", `${route}/lifecycle/b-evidence/prepare`, { dataRevision: candidate.dataRevision });
  assert.equal(unboundEvidence.status, 409, JSON.stringify(unboundEvidence.body));
  assert.equal(unboundEvidence.body.code, "candidate_store_binding_unavailable");
  assert.equal(await readFile(dataFile, "utf8"), unboundBytes);
  const saved = await request("PATCH", route, { dataRevision: candidate.dataRevision, targetStore: "dandanshu" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  candidate = saved.body.candidate;
  assert.deepEqual(candidate.storeRef, binding.storeRef);
  const invalidRevision = await request("POST", `${route}/lifecycle/b-evidence/prepare`, { dataRevision: String(candidate.dataRevision) });
  assert.equal(invalidRevision.status, 409);
  const bytes = await readFile(dataFile, "utf8");
  const forged = await request("PATCH", route, { dataRevision: candidate.dataRevision, storeRef: { ...binding.storeRef, platformStoreId: "another" } });
  assert.equal(forged.status, 400);
  const stale = await request("PATCH", route, { dataRevision: candidate.dataRevision - 1, targetStore: "wb" });
  assert.equal(stale.status, 409);
  const confirmation = { decision: "confirm", dataRevision: candidate.dataRevision, sourceDataRevision: candidate.dataRevision,
    sourceCandidateId: candidate.id, targetPlatform: "ozon", storeRef: { ...binding.storeRef, mappingVersion: "changed" },
    supplierConfirmation: { productUrl: "https://detail.1688.com/offer/123456789.html" } };
  const wrong = await request("POST", `${route}/lifecycle/a-confirm`, confirmation);
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  for (const decision of [undefined, "other"]) {
    const invalid = await request("POST", `${route}/lifecycle/a-confirm`, { ...confirmation, storeRef: binding.storeRef, decision });
    assert.equal(invalid.status, 400);
  }
  assert.equal(await readFile(dataFile, "utf8"), bytes);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(state.candidates[0].storeRef, binding.storeRef);
  const persisted = JSON.parse(bytes);
  assert.equal(persisted.dispatches.length, 0);
  assert.equal(persisted.meta.automationStarted, false);
  assert.equal(persisted.candidates[0].sourceCapture, undefined);
  assert.equal(persisted.candidates[0].lifecycleV11, undefined);
  assert.equal(stderr.join(""), "");
});
