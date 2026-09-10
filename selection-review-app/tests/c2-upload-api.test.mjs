import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { validateProductionAuthorizationPreparation } from "../lib/production-authorization-preparation.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT || 28000 + process.pid % 10000);
const base = `http://127.0.0.1:${port}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");
const headers = { Origin: base, "Sec-Fetch-Site": "same-origin" };

async function startServer(t, dataFile, uploadDirectory) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_C2_UPLOAD_DIR: uploadDirectory, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", chunk => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${stderr.join("")}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, stderr }; }
    catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Test server did not become healthy");
}

test("C2 upload and saved order survive restart, then local confirmation produces no platform writes", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "c2-upload-api-"));
  const dataFile = path.join(directory, "state.json");
  const formal = createFormalC1C2Fixture({ candidateId: "synthetic-c2-upload", supplierSkuId: "SYNTHETIC-C2",
    variantKey: "规格:合成验收款", candidateRevision: 12, at: "2026-09-07T08:00:00.000Z" });
  const candidate = { ...formal.candidate,
    productName: "Synthetic upload confirmation", source: "user", workflowStatus: "listing_preparation", comments: [], history: [],
    processing: { state: "idle" }, lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } };
  const original = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate], dispatches: [], evidencePacks: [] };
  await writeFile(dataFile, JSON.stringify(original));
  const first = await startServer(t, dataFile, path.join(directory, "uploads"));
  const route = `/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2`;
  async function upload(draftRevision, fileName, bytes) {
    const response = await fetch(`${base}${route}/final-assets/upload?dataRevision=12&draftRevision=${draftRevision}&fileName=${fileName}`, {
      method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: bytes
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.dataRevision, 12);
    assert.equal(body.platformWrites, 0);
    assert.equal(body.businessPhaseChanged, false);
    assert.ok(body.asset.assetRef.startsWith("local-asset:c2-local:"));
    return body;
  }
  const uploaded = await upload(0, "main.png", PNG);
  assert.equal(uploaded.draft.revision, 2);
  await stopApiProcess(first.child);
  const restartBefore = await readFile(dataFile, "utf8");
  const second = await startServer(t, dataFile, path.join(directory, "uploads"));
  assert.equal(await readFile(dataFile, "utf8"), restartBefore);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.candidates[0].lifecycleV11.c2UploadDraft.uploads[0].assetId, uploaded.asset.assetId);
  const preview = await fetch(`${base}${route}/local-assets/${encodeURIComponent(uploaded.asset.assetId)}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  const detail = await upload(2, "detail.png", DETAIL_PNG);
  const selection = [
    { assetId: uploaded.asset.assetId, slotId: "main", order: 1 },
    { assetId: detail.asset.assetId, slotId: "detail", order: 2 }
  ];
  const save = await fetch(`${base}${route}/upload-draft`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 4, selection }) });
  const saved = await save.json();
  assert.equal(save.status, 200, JSON.stringify(saved));
  assert.deepEqual(saved.draft.selection, selection);
  const stale = await fetch(`${base}${route}/upload-draft`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 4, selection: [] }) });
  assert.equal(stale.status, 409);
  const confirm = await fetch(`${base}${route}/final-assets`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 5, confirmed: true, finalUploadAssets: selection,
      approvedAssetIds: selection.map(asset => asset.assetId), approvedMainImageAssetId: uploaded.asset.assetId, approvedVideoDisposition: "excludes_video" }) });
  const result = await confirm.json();
  assert.equal(confirm.status, 200, JSON.stringify(result));
  const after = JSON.parse(await readFile(dataFile, "utf8"));
  const final = after.candidates[0].lifecycleV11.skuPackage;
  assert.equal(final.c2FinalAssets.status, "completed");
  assert.equal(final.productionAuthorization, null);
  assert.equal(final.productionRecord, null);
  assert.equal(final.dataRevision, final.c2FinalAssets.productionAuthorizationPreparation.resultDataRevision);
  assert.equal(final.productionConfirmationCard.cardRevision, 1);
  assert.doesNotThrow(() => validateProductionAuthorizationPreparation({ preparation: final.c2FinalAssets.productionAuthorizationPreparation, candidateId: candidate.id, skuPackage: final }));
  assert.deepEqual(final.c2FinalAssets.assets.finalUploads.map(asset => asset.assetId), selection.map(asset => asset.assetId));
  assert.equal(after.dispatches.length, 0);
  assert.equal(after.meta.automationStarted, false);
  assert.equal(after.candidates[0].executionRuntime.status, "waiting_owner");
  assert.equal(after.candidates[0].executionRuntime.businessPhase, "C2");
  assert.equal(after.candidates[0].executionRuntime.stepId, "C2_OWNER_BUSINESS_CONFIRMATION");
  assert.equal(after.candidates[0].executionRuntime.inputRevision, after.candidates[0].dataRevision);
  assert.equal(after.candidates[0].executionRuntime.inferenceJobId, null);
  assert.equal(after.candidates[0].executionRuntime.codexWakeupCount, 0);
  const confirmedState = await fetch(`${base}/api/state`);
  assert.equal(confirmedState.status, 200, await confirmedState.clone().text());
  const projected = await confirmedState.json();
  assert.equal(projected.candidates[0].executionRuntimeView.status, "waiting_owner");
  assert.deepEqual(projected.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  await stopApiProcess(second.child);
  const beforeConfirmedRestart = await readFile(dataFile, "utf8");
  const third = await startServer(t, dataFile, path.join(directory, "uploads"));
  const restartedState = await fetch(`${base}/api/state`);
  assert.equal(restartedState.status, 200, await restartedState.clone().text());
  const restarted = await restartedState.json();
  assert.deepEqual(restarted.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  assert.deepEqual(restarted.candidates[0].executionRuntimeView, projected.candidates[0].executionRuntimeView);
  assert.equal(await readFile(dataFile, "utf8"), beforeConfirmedRestart);
  assert.equal(first.stderr.join(""), "");
  assert.equal(second.stderr.join(""), "");
  assert.equal(third.stderr.join(""), "");
});
