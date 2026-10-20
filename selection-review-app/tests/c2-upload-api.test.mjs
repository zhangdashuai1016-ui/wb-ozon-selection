import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";
import { createFormalC1C2Fixture, createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { validateProductionAuthorizationPreparation } from "../lib/production-authorization-preparation.mjs";
import { reserveC2Upload, MAX_UPLOAD_RECORDS } from "../lib/c2-upload-draft.mjs";
import { api } from "../src/api.js";
import { threeColorFixture, at } from "./fixtures/sibling-batch-final-family-fixture.mjs";
import { previewSiblingBatchC1Preparation, commitSiblingBatchC1Preparation } from "../lib/sibling-batch-c1-preparation.mjs";
import { writeSyntheticSiblingPreparationCatalog } from "./fixtures/sibling-preparation-catalog-fixture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { api: port, gateway: dependencyPort } = allocatedTestPorts();
const base = `http://127.0.0.1:${port}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=", "base64");
const DETAIL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRsgUADjcBfvDPgM9AAAAAElFTkSuQmCC", "base64");
const headers = { Origin: base, "Sec-Fetch-Site": "same-origin" };

async function startServer(t, dataFile, uploadDirectory, ownerIdentityFile = null, catalogDirectory = null) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir, env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_C2_UPLOAD_DIR: uploadDirectory, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
      ...(catalogDirectory ? { SELECTION_REVIEW_BATCH_CATALOG_DIRECTORY: catalogDirectory } : {}),
      ...(ownerIdentityFile ? { SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
        SELECTION_REVIEW_OWNER_IDENTITY_FILE: ownerIdentityFile, SELECTION_REVIEW_PUBLIC_ORIGIN: base } : {}),
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

async function dependencyTripwire(t) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected_test_dependency_request" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(dependencyPort, "127.0.0.1", resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(requests, 0, "C2 local preparation must not contact any configured external dependency");
  });
  return () => requests;
}

// Browser relative URLs and cookies are adapted to a real isolated HTTP server. Responses are never mocked.
function browserApiTransport(t, cookie) {
  const realFetch = globalThis.fetch.bind(globalThis), requests = [];
  let externalAttempts = 0;
  t.mock.method(globalThis, "fetch", (input, options = {}) => {
    const url = new URL(input, base);
    if (url.origin !== base) { externalAttempts += 1; throw new Error("Unexpected external browser request."); }
    requests.push({ method: options.method ?? "GET", pathname: url.pathname });
    const browserRelative = typeof input === "string" && input.startsWith("/");
    return realFetch(url, { ...options, headers: browserRelative
      ? { ...headers, ...(cookie() ? { Cookie: cookie() } : {}), ...options.headers } : options.headers });
  });
  t.after(() => assert.equal(externalAttempts, 0));
  return requests;
}

function publicDraft(candidateId, dataRevision, draft) {
  return { candidateId, dataRevision, draft: draft ? { revision: draft.revision,
    uploads: draft.uploads.map(asset => ({ assetId: asset.assetId, status: asset.status,
      ...(asset.status === "ready" ? { sha256: asset.sha256 } : {}) })),
    selection: draft.selection.map(({ assetId, order }) => ({ assetId, order })) } : null,
    businessPhaseChanged: false, platformWrites: 0 };
}

async function assertReadOnlyDraft(dataFile, candidateId, expected) {
  const before = await readFile(dataFile, "utf8");
  const result = await api.getC2UploadDraft(candidateId);
  assert.deepEqual(result, expected);
  assert.equal(await readFile(dataFile, "utf8"), before, "GET must not initialize or rewrite business state");
  return result;
}

test("C2 upload and saved order survive restart, then local confirmation produces no platform writes", async t => {
  await dependencyTripwire(t);
  const directory = await mkdtemp(path.join(tmpdir(), "c2-upload-api-"));
  await mkdir(path.join(directory, "business"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  const dataFile = path.join(directory, "business", "state.json");
  const ownerIdentityFile = path.join(directory, "private", "owner.json");
  let cookie;
  async function authenticate(action) {
    const response = await fetch(`${base}/api/owner-access/${action}`, { method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "synthetic C2 upload owner password" }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    cookie = response.headers.get("set-cookie").split(";")[0];
  }
  const formal = createFormalC1C2Fixture({ candidateId: "synthetic-c2-upload", supplierSkuId: "SYNTHETIC-C2",
    variantKey: "规格:合成验收款", candidateRevision: 12, at: "2026-09-07T08:00:00.000Z" });
  const candidate = { ...formal.candidate,
    productName: "Synthetic upload confirmation", source: "user", workflowStatus: "listing_preparation", comments: [], history: [],
    processing: { state: "idle" }, lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } };
  const original = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate], dispatches: [], evidencePacks: [] };
  await writeFile(dataFile, JSON.stringify(original));
  const first = await startServer(t, dataFile, path.join(directory, "uploads"), ownerIdentityFile);
  const unauthenticated = await fetch(`${base}/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2/upload-draft`);
  assert.equal(unauthenticated.status, 401);
  await authenticate("setup");
  browserApiTransport(t, () => cookie);
  await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, 12, null));
  const route = `/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2`;
  async function upload(draftRevision, fileName, bytes) {
    const response = await fetch(`${base}${route}/final-assets/upload?dataRevision=12&draftRevision=${draftRevision}&fileName=${fileName}`, {
      method: "POST", headers: { ...headers, "Content-Type": "image/png", Cookie: cookie }, body: bytes
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
  await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, 12, uploaded.draft));
  await stopApiProcess(first.child);
  const restartBefore = await readFile(dataFile, "utf8");
  const second = await startServer(t, dataFile, path.join(directory, "uploads"), ownerIdentityFile);
  const unauthorizedPreview = await fetch(`${base}${route}/local-assets/${encodeURIComponent(uploaded.asset.assetId)}`);
  assert.equal(unauthorizedPreview.status, 401);
  assert.equal((await unauthorizedPreview.json()).code, "OWNER_LOGIN_REQUIRED");
  await authenticate("login");
  assert.equal(await readFile(dataFile, "utf8"), restartBefore);
  await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, 12, uploaded.draft));
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.candidates[0].lifecycleV11.c2UploadDraft.uploads[0].assetId, uploaded.asset.assetId);
  const preview = await fetch(`${base}${route}/local-assets/${encodeURIComponent(uploaded.asset.assetId)}`, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  const detail = await upload(2, "detail.png", DETAIL_PNG);
  const selection = [
    { assetId: detail.asset.assetId, order: 1 },
    { assetId: uploaded.asset.assetId, order: 2 }
  ];
  const saved = await api.saveC2UploadDraft(candidate.id, { dataRevision: 12, draftRevision: 4, selection });
  assert.deepEqual(saved.draft.selection, selection);
  await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, 12, saved.draft));
  await stopApiProcess(second.child);
  const savedOrderBeforeRestart = await readFile(dataFile, "utf8");
  const orderRestart = await startServer(t, dataFile, path.join(directory, "uploads"), ownerIdentityFile);
  await authenticate("login");
  assert.equal(await readFile(dataFile, "utf8"), savedOrderBeforeRestart);
  await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, 12, saved.draft));
  const stale = await fetch(`${base}${route}/upload-draft`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 4, selection: [] }) });
  assert.equal(stale.status, 409);
  const confirm = await fetch(`${base}${route}/final-assets`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ dataRevision: 12, draftRevision: 5, confirmed: true, finalUploadAssets: selection,
      approvedAssetIds: selection.map(asset => asset.assetId), approvedMainImageAssetId: detail.asset.assetId, approvedVideoDisposition: "excludes_video" }) });
  const result = await confirm.json();
  assert.equal(confirm.status, 200, JSON.stringify(result));
  const after = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
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
  const afterConfirmation = await readFile(dataFile, "utf8");
  await assert.rejects(() => api.getC2UploadDraft(candidate.id), error => error.status === 409 && error.body.code === "c2_upload_stage_invalid");
  assert.equal(await readFile(dataFile, "utf8"), afterConfirmation);
  const confirmedState = await fetch(`${base}/api/state`);
  assert.equal(confirmedState.status, 200, await confirmedState.clone().text());
  const projected = await confirmedState.json();
  assert.equal(projected.candidates[0].executionRuntimeView.status, "waiting_owner");
  assert.deepEqual(projected.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  await stopApiProcess(orderRestart.child);
  const beforeConfirmedRestart = await readFile(dataFile, "utf8");
  const third = await startServer(t, dataFile, path.join(directory, "uploads"), ownerIdentityFile);
  await authenticate("login");
  const finalPreview = await fetch(`${base}${route}/local-assets/${encodeURIComponent(uploaded.asset.assetId)}`, { headers: { Cookie: cookie } });
  assert.equal(finalPreview.status, 200);
  assert.deepEqual(Buffer.from(await finalPreview.arrayBuffer()), PNG);
  const restartedState = await fetch(`${base}/api/state`);
  assert.equal(restartedState.status, 200, await restartedState.clone().text());
  const restarted = await restartedState.json();
  assert.deepEqual(restarted.candidates[0].lifecycleV11.skuPackage.productionConfirmationCard, final.productionConfirmationCard);
  assert.deepEqual(restarted.candidates[0].executionRuntimeView, projected.candidates[0].executionRuntimeView);
  assert.equal(await readFile(dataFile, "utf8"), beforeConfirmedRestart);
  assert.equal(first.stderr.join(""), "");
  assert.equal(second.stderr.join(""), "");
  assert.equal(orderRestart.stderr.join(""), "");
  assert.equal(third.stderr.join(""), "");
});

test("sibling gallery link keeps independent registrations and rejects another color main image", async t => {
  await dependencyTripwire(t);
  const directory = await mkdtemp(path.join(tmpdir(), "c2-sibling-link-api-"));
  await mkdir(path.join(directory, 'business'));
  await mkdir(path.join(directory, 'private'), { mode: 0o700 });
  const dataFile = path.join(directory, 'business', "state.json");
  function child(id, supplierSkuId, color) {
    const formal = createFormalC1C2Fixture({ candidateId: id, supplierSkuId, variantKey: `颜色:${color}` });
    return { ...formal.candidate, dataRevision: 12, source: "user", workflowStatus: "listing_preparation",
      comments: [], history: [], processing: { state: "idle" },
      sourceCapture: { skuChoices: [{ sourceSkuId: supplierSkuId, attributes: { 颜色: color } }] },
      siblingSourceV1: { parentCandidateId: "candidate:synthetic-family", supplierSkuId },
      lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } };
  }
  const source = child("candidate:synthetic-black", "synthetic-black", "黑色");
  const target = child("candidate:synthetic-green", "synthetic-green", "绿色");
  const parent = { id: 'candidate:synthetic-family', dataRevision: 7,
    sourceCapture: { selectedSkuIds: ['synthetic-first', 'synthetic-black', 'synthetic-green'] },
    lifecycleV11: { skuPackage: { supplierSkuId: 'synthetic-first', technicalStatus: 'unknown_outcome' } } };
  await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {},
    candidates: [parent, source, target], dispatches: [], evidencePacks: [] }));
  await startServer(t, dataFile, path.join(directory, "uploads"), path.join(directory, 'private', 'owner.json'));
  const setup = await fetch(`${base}/api/owner-access/setup`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic gallery link password' }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  async function upload(id, revision, fileName, bytes) {
    const response = await fetch(`${base}/api/candidates/${id}/lifecycle/c2/final-assets/upload?dataRevision=12&draftRevision=${revision}&fileName=${fileName}`,
      { method: "POST", headers: { ...headers, "Content-Type": "image/png", Cookie: cookie }, body: bytes });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body;
  }
  const blackMain = await upload(source.id, 0, "black.png", PNG);
  const greenMain = await upload(target.id, 0, "green.png", DETAIL_PNG);
  async function link(sourceAssetId, draftRevision) {
    const response = await fetch(`${base}/api/candidates/${target.id}/lifecycle/c2/final-assets/link`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ dataRevision: 12, draftRevision, role: "gallery_image",
        sourceCandidateId: source.id, sourceDataRevision: 12, sourceAssetId }) });
    return { response, body: await response.json() };
  }
  const rejected = await link(blackMain.asset.assetId, greenMain.draft.revision);
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.code, "c2_link_main_color_mismatch");
  const detail = await upload(source.id, blackMain.draft.revision, "shared.png", DETAIL_PNG);
  const linked = await link(detail.asset.assetId, greenMain.draft.revision);
  assert.equal(linked.response.status, 201, JSON.stringify(linked.body));
  assert.notEqual(linked.body.asset.assetId, detail.asset.assetId);
  assert.equal(linked.body.asset.sha256, detail.asset.sha256);
  assert.equal(linked.body.draft.selection[0].assetId, greenMain.asset.assetId);
  assert.equal(linked.body.draft.selection[1].assetId, linked.body.asset.assetId);
  const saved = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
  assert.equal(saved.candidates[2].lifecycleV11.c2UploadDraft.uploads[1].assetRef, linked.body.asset.assetRef);
  assert.equal(saved.candidates[1].lifecycleV11.c2UploadDraft.uploads.length, 2);
  const beforeFinal = await readFile(dataFile, 'utf8');
  const c2Decision = await fetch(`${base}/api/candidates/${parent.id}/sibling-batch-c2-confirm`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ parentCandidateId: parent.id, parentRevision: parent.dataRevision, confirmed: true,
      members: [
        { candidateId: source.id, candidateRevision: 12, draftRevision: detail.draft.revision,
          approvedAssetIds: detail.draft.selection.map(item => item.assetId) },
        { candidateId: target.id, candidateRevision: 12, draftRevision: linked.body.draft.revision,
          approvedAssetIds: linked.body.draft.selection.map(item => item.assetId) }
      ] }) });
  assert.equal(c2Decision.status, 409, await c2Decision.clone().text());
  assert.match(JSON.stringify(await c2Decision.json()), /C1_|C2_|SIBLING_/);
  assert.equal(await readFile(dataFile, 'utf8'), beforeFinal);
});

test("C2 draft GET enforces authenticated identity, current source, strict rows and a read-only minimal DTO", async t => {
  await dependencyTripwire(t);
  const directory = await mkdtemp(path.join(tmpdir(), "c2-draft-read-api-"));
  await mkdir(path.join(directory, "business"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  const dataFile = path.join(directory, "business", "state.json");
  const ownerIdentityFile = path.join(directory, "private", "owner.json");
  const cases = [];
  function add(label, mutate = () => {}, expectedCode = null) {
    const formal = createFormalC1C2Fixture({ candidateId: `candidate:synthetic-c2-read-${label}`,
      supplierSkuId: `SYNTHETIC-READ-${label}`, candidateRevision: 12 });
    const candidate = structuredClone({ ...formal.candidate, source: "user", workflowStatus: "listing_preparation",
      comments: [], history: [], processing: { state: "idle" },
      lifecycleV11: { ...formal.candidate.lifecycleV11, status: "awaiting_final_assets" } });
    candidate.lifecycleV11.c2UploadDraft = reserveC2Upload(candidate, { dataRevision: 12, draftRevision: 0,
      uploadId: "00000000-0000-4000-8000-000000000001", fileName: "synthetic.png", mediaType: "image",
      contentType: "image/png", startedAt: at });
    mutate(candidate, candidate.lifecycleV11.c2UploadDraft);
    const entry = { label, candidate, expectedCode };
    cases.push(entry);
    return entry;
  }
  const current = add("current", candidate => { delete candidate.lifecycleV11.c2UploadDraft; });
  add("null", candidate => { candidate.lifecycleV11.c2UploadDraft = null; });
  add("uploading");
  add("failed", (_candidate, draft) => Object.assign(draft.uploads[0], { status: "failed", failureCode: "upload_incomplete", settledAt: at }));
  const privateMetadata = add("ready-private", (_candidate, draft) => {
    Object.assign(draft, { privateFile: "synthetic-private-draft-marker" });
    Object.assign(draft.uploads[0], { status: "ready", sha256: "a".repeat(64), privateFile: "synthetic-private-upload-marker" });
    draft.selection = [{ assetId: draft.uploads[0].assetId, order: 1, privateFile: "synthetic-private-selection-marker" }];
  });
  for (const [label, value] of [["false", false], ["zero", 0], ["empty", ""], ["array", []]]) {
    add(label, candidate => { candidate.lifecycleV11.c2UploadDraft = value; }, "c2_upload_draft_invalid");
  }
  for (const [field, value] of [["candidateId", "candidate:foreign"], ["skuPackageId", "sku:foreign"],
    ["sourceCandidateRevision", 11], ["sourceSkuRevision", 0], ["sourceC1Fingerprint", "f".repeat(64)],
    ["schemaEvidenceRef", "schema:foreign"]]) {
    add(`old-${field}`, (_candidate, draft) => { draft[field] = value; }, "c2_upload_source_changed");
  }
  add("stage", candidate => { candidate.lifecycleV11.skuPackage.businessPhase = "C1"; }, "c2_upload_stage_invalid");
  add("authorized", candidate => { candidate.lifecycleV11.skuPackage.productionAuthorization = { authorizationId: "synthetic:existing" }; }, "c2_upload_stage_invalid");
  add("produced", candidate => { candidate.lifecycleV11.skuPackage.productionRecord = { productionId: "synthetic:existing" }; }, "c2_upload_stage_invalid");
  const invalidDrafts = [
    ["revision", draft => { draft.revision = -1; }],
    ["uploads-object", draft => { draft.uploads = {}; }],
    ["selection-object", draft => { draft.selection = {}; }],
    ["duplicate-id", draft => { draft.uploads.push(structuredClone(draft.uploads[0])); }],
    ["status", draft => { draft.uploads[0].status = "unknown"; }],
    ["ready-no-sha", draft => { draft.uploads[0].status = "ready"; }],
    ["selected-not-ready", draft => { draft.selection = [{ assetId: draft.uploads[0].assetId, order: 1 }]; }],
    ["selected-foreign", draft => { draft.selection = [{ assetId: "c2-local:00000000-0000-4000-8000-000000000002", order: 1 }]; }],
    ["selected-duplicate", draft => { Object.assign(draft.uploads[0], { status: "ready", sha256: "a".repeat(64) });
      draft.selection = [1, 2].map(order => ({ assetId: draft.uploads[0].assetId, order })); }],
    ["selected-order", draft => { Object.assign(draft.uploads[0], { status: "ready", sha256: "a".repeat(64) });
      draft.selection = [{ assetId: draft.uploads[0].assetId, order: 2 }]; }],
    ["too-many", draft => { draft.uploads = Array.from({ length: MAX_UPLOAD_RECORDS + 1 }, (_, index) => ({
      ...draft.uploads[0], assetId: `c2-local:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })); }]
  ];
  for (const [label, mutate] of invalidDrafts) add(label, (_candidate, draft) => mutate(draft), "c2_upload_draft_invalid");
  const document = { meta: { version: 2, automationStarted: false }, rules: {}, candidates: cases.map(item => item.candidate), dispatches: [], evidencePacks: [] };
  await writeFile(dataFile, JSON.stringify(document));
  const noIdentity = await startServer(t, dataFile, path.join(directory, "uploads"));
  const route = `/api/candidates/${encodeURIComponent(current.candidate.id)}/lifecycle/c2/upload-draft`;
  const developmentBefore = await readFile(dataFile, "utf8");
  const development = await fetch(base + route, { headers: { "X-Role": "owner", "X-Actor-Type": "human", "X-Actor-Source": "authenticated_identity_provider" } });
  assert.equal(development.status, 403);
  assert.equal((await development.json()).code, "c2_upload_draft_identity_required");
  assert.equal(await readFile(dataFile, "utf8"), developmentBefore);
  await stopApiProcess(noIdentity.child);
  const authenticatedServer = await startServer(t, dataFile, path.join(directory, "uploads"), ownerIdentityFile);
  const anonymousBefore = await readFile(dataFile, "utf8");
  const anonymous = await fetch(base + route);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, "OWNER_LOGIN_REQUIRED");
  assert.equal(await readFile(dataFile, "utf8"), anonymousBefore);
  const setup = await fetch(`${base}/api/owner-access/setup`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic C2 read-only owner password" }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const requests = browserApiTransport(t, () => cookie);
  const crossOriginBefore = await readFile(dataFile, "utf8");
  const crossOrigin = await fetch(base + route, { headers: { Cookie: cookie, Origin: "https://foreign.example.test" } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(await readFile(dataFile, "utf8"), crossOriginBefore);
  for (const { label, candidate, expectedCode } of cases) {
    const before = await readFile(dataFile, "utf8");
    if (expectedCode) await assert.rejects(() => api.getC2UploadDraft(candidate.id), error => {
      assert.equal(error.status, 409, label);
      assert.equal(error.body.code, expectedCode, label);
      return true;
    });
    else await assertReadOnlyDraft(dataFile, candidate.id, publicDraft(candidate.id, candidate.dataRevision, candidate.lifecycleV11.c2UploadDraft));
    assert.equal(await readFile(dataFile, "utf8"), before, label);
  }
  const missingBefore = await readFile(dataFile, "utf8");
  await assert.rejects(() => api.getC2UploadDraft("candidate:synthetic-missing"), error => error.status === 404);
  // A double-encoded colon must remain a literal percent sequence after the server's one pathname decode.
  const doubleEncoded = await fetch(`${base}/api/candidates/${encodeURIComponent(encodeURIComponent(current.candidate.id))}/lifecycle/c2/upload-draft`, { headers: { Cookie: cookie } });
  assert.equal(doubleEncoded.status, 404);
  assert.equal(await readFile(dataFile, "utf8"), missingBefore);
  const projected = await api.getC2UploadDraft(privateMetadata.candidate.id);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic-private-|fileName|sourceC1Fingerprint|sourceSkuRevision|schemaEvidenceRef/u);
  assert.ok(requests.some(item => item.pathname.includes("candidate%3Asynthetic-c2-read-current")));
  assert.equal(noIdentity.stderr.join(""), "");
  assert.equal(authenticatedServer.stderr.join(""), "");
  t.diagnostic(`C2_DRAFT_HTTP_MATRIX ${JSON.stringify({ cases: cases.length,
    currentReadable: cases.filter(item => !item.expectedCode).length,
    rejectedUnchanged: cases.filter(item => item.expectedCode).length })}`);
});

async function threeColorHttpDocument() {
  const fixture = await threeColorFixture();
  await fixture.repository.transact(document => {
    const parent = document.candidates[0];
    for (const candidate of document.candidates.slice(1)) {
      const original = candidate.lifecycleV11.skuPackage;
      const schema = original.c1ProductPlan.inputSnapshots.platformSchemaRules;
      const formal = createFormalC1DraftFixture({ at, candidateId: candidate.id, supplierSkuId: original.supplierSkuId,
        variantKey: original.variantKey,
        skuAttributes: { 颜色: candidate.sourceCapture.skuChoices[0].attributes.颜色, model_name: "synthetic-model",
          quantityOneEvidence: { captureId: parent.sourceCapture.captureId } },
        platformAttributes: schema.attributes, platformRequiredFields: schema.requiredFields });
      assert.equal(formal.created.skuPackage.dataRevision, original.dataRevision);
      assert.equal(formal.created.c1ProductPlan.c1PlanId, original.c1ProductPlan.c1PlanId);
      assert.deepEqual(formal.created.skuPackage.g1Identity, original.g1Identity);
      candidate.lifecycleV11.opportunityPackage = structuredClone(formal.state.opportunityPackage);
      candidate.lifecycleV11.skuPackage = structuredClone(formal.created.skuPackage);
      parent.sourceCapture.offerId = formal.state.skuPackage.selectedSupplySnapshot.supplierOption.offerId;
    }
    for (const candidate of document.candidates) candidate.sourceCapture.offerId = parent.sourceCapture.offerId;
    return { changed: true, document, result: null };
  });
  const input = { ...fixture.input, previewFingerprint: previewSiblingBatchC1Preparation({
    document: await fixture.repository.readSnapshot(), actor: fixture.actor, input: fixture.input, serverClock: () => at }).previewFingerprint };
  await commitSiblingBatchC1Preparation({ repository: fixture.repository, runtimeMode: "local_development", actor: fixture.actor,
    input, serverClock: () => at });
  return fixture.repository.readSnapshot();
}

test("frontend C2 API reads real catalog files, uploads and saves all three colors before atomic final cards", async t => {
  const externalRequests = await dependencyTripwire(t);
  const directory = await mkdtemp(path.join(tmpdir(), "c2-three-color-http-"));
  await mkdir(path.join(directory, "business"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  const catalogDirectory = path.join(directory, "catalog");
  await mkdir(catalogDirectory);
  const document = await threeColorHttpDocument();
  const catalog = await writeSyntheticSiblingPreparationCatalog({ document, tempDir: catalogDirectory });
  const parent = document.candidates[0], children = document.candidates.slice(1);
  const dataFile = path.join(directory, "business", "state.json");
  await writeFile(dataFile, JSON.stringify(document));
  const server = await startServer(t, dataFile, path.join(directory, "uploads"), path.join(directory, "private", "owner.json"), catalogDirectory);
  const setup = await fetch(`${base}/api/owner-access/setup`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic three color C2 HTTP password" }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const requests = browserApiTransport(t, () => cookie);
  const selectedByChild = new Map();
  // This is the component's actual API sequence; each response comes from server.mjs and its real local asset store.
  for (const [index, child] of children.entries()) {
    let draft = (await assertReadOnlyDraft(dataFile, child.id, publicDraft(child.id, child.dataRevision, null))).draft;
    const order = [catalog.assets.find(asset => asset.onlySourceSkuId === child.lifecycleV11.skuPackage.supplierSkuId).assetId, "17", "19"];
    const selected = [];
    for (const catalogId of order) {
      const source = catalog.assets.find(asset => asset.assetId === catalogId);
      const beforeRead = await readFile(dataFile, "utf8");
      const blob = await api.getSiblingCatalogFile(parent.id, catalogId);
      assert.equal(blob.type, source.contentType);
      assert.equal(blob.size, source.byteSize);
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), await readFile(path.join(catalogDirectory, source.storageKey)));
      assert.equal(await readFile(dataFile, "utf8"), beforeRead);
      const uploaded = await api.uploadLifecycleFinalAsset(child.id, { dataRevision: child.dataRevision,
        draftRevision: draft?.revision ?? 0, file: new File([blob], source.fileName, { type: source.contentType }) });
      assert.equal(uploaded.platformWrites, 0);
      assert.equal(uploaded.businessPhaseChanged, false);
      assert.equal(uploaded.asset.sha256, source.sha256);
      draft = uploaded.draft;
      selected.push({ assetId: uploaded.asset.assetId, order: selected.length + 1 });
    }
    // Keep each color's hero first while actually changing the saved gallery order.
    const selection = [selected[0], selected[2], selected[1]].map((asset, position) => ({ assetId: asset.assetId, order: position + 1 }));
    const saved = await api.saveC2UploadDraft(child.id, { dataRevision: child.dataRevision, draftRevision: draft.revision, selection });
    assert.deepEqual(saved.draft.selection, selection);
    await assertReadOnlyDraft(dataFile, child.id, publicDraft(child.id, child.dataRevision, saved.draft));
    selectedByChild.set(child.id, { selection, draftRevision: saved.draft.revision, sourceOrder: [order[0], order[2], order[1]], index });
  }
  const beforeFinal = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
  assert.deepEqual(beforeFinal.candidates[0], parent);
  assert.deepEqual(beforeFinal.runtime.softwareJobs, document.runtime.softwareJobs);
  const readsBefore = await readFile(dataFile, "utf8");
  const savedDrafts = await Promise.all(children.map(child => api.getC2UploadDraft(child.id)));
  assert.equal(await readFile(dataFile, "utf8"), readsBefore);
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision, confirmed: true,
    members: children.map((child, index) => ({ candidateId: child.id, candidateRevision: child.dataRevision,
      draftRevision: savedDrafts[index].draft.revision, approvedAssetIds: savedDrafts[index].draft.selection.map(asset => asset.assetId) })) };
  const staleInput = structuredClone(input);
  staleInput.members[1].draftRevision -= 1;
  const beforeRejectedBatch = await readFile(dataFile, "utf8");
  await assert.rejects(() => api.confirmSiblingBatchC2(parent.id, staleInput), error =>
    error.status === 409 && error.body.code === "c2_upload_draft_conflict");
  assert.equal(await readFile(dataFile, "utf8"), beforeRejectedBatch, "one stale member must not partially confirm another color");
  const result = await api.confirmSiblingBatchC2(parent.id, input);
  assert.equal(result.status, "awaiting_owner_business_confirmation");
  assert.equal(result.platformWrites, 0);
  assert.equal(result.externalRequests, 0);
  assert.equal(result.members.length, 3);
  const after = await createJsonBusinessStateRepository({ filePath: dataFile }).readSnapshot();
  assert.deepEqual(after.candidates[0], parent);
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.technicalStatus, "unknown_outcome");
  assert.deepEqual(after.evidencePacks, document.evidencePacks);
  assert.deepEqual(after.runtime.softwareJobs, document.runtime.softwareJobs);
  const assetIds = [];
  for (const child of after.candidates.slice(1)) {
    const sku = child.lifecycleV11.skuPackage, selected = selectedByChild.get(child.id);
    assert.equal(sku.c2FinalAssets.status, "completed");
    assert.equal(sku.productionAuthorization, null);
    assert.equal(sku.productionRecord, null);
    assert.equal(sku.productionConfirmationCard.cardRevision, 1);
    assert.equal(sku.productionConfirmationCard.productInformation.sku.value.skuPackageId, sku.skuPackageId);
    assert.equal(sku.productionConfirmationCard.productInformation.sku.value.supplierSkuId, child.siblingSourceV1.supplierSkuId);
    assert.deepEqual(sku.c2FinalAssets.assets.finalUploads.map(asset => ({ assetId: asset.assetId, order: asset.order })), selected.selection);
    assert.deepEqual(sku.c2FinalAssets.assets.finalUploads.map(asset => asset.sha256), selected.sourceOrder.map(id => catalog.assets.find(asset => asset.assetId === id).sha256));
    assert.deepEqual(sku.profitModels, document.candidates.find(value => value.id === child.id).lifecycleV11.skuPackage.profitModels);
    assetIds.push(...selected.selection.map(asset => asset.assetId));
  }
  assert.equal(new Set(assetIds).size, 9);
  assert.equal(requests.filter(request => request.method === "GET" && request.pathname.includes("/preparation-assets/")).length, 9);
  assert.equal(requests.filter(request => request.method === "POST" && request.pathname.endsWith("/final-assets/upload")).length, 9);
  assert.equal(requests.filter(request => request.method === "POST" && request.pathname.endsWith("/upload-draft")).length, 3);
  assert.equal(requests.filter(request => request.method === "POST" && request.pathname.endsWith("/sibling-batch-c2-confirm")).length, 2);
  assert.equal(externalRequests(), 0);
  assert.equal(server.stderr.join(""), "");
  t.diagnostic('C2_THREE_COLOR_HTTP completed: catalogReads=9 uploads=9 orderedDrafts=3 staleBatchRejected=1 finalCards=3 externalRequests=0 platformWrites=0');
});
