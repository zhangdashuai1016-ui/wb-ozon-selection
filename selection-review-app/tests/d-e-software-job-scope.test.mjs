import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEJobScopeError, createDProductionJobScope, assertDProductionJobScope,
  createEReadbackJobScope, assertEReadbackJobScope, normalizeDESoftwareJobScope } from "../lib/d-e-software-job-scope.mjs";
import * as oldRecordContract from "../lib/draft-production-execution.mjs";
import * as recordContract from "../lib/production-record-contract.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";
import { deSoftwareJobScopeFixture, DE_SCOPE_OBSERVED_AT as observedAt } from "./fixtures/d-e-software-job-scope-fixture.mjs";

const fixture = await deSoftwareJobScopeFixture();
const clone = value => structuredClone(value);
const code = expected => error => error instanceof DEJobScopeError && error.code === expected;
const expiredAt = new Date(Date.parse(fixture.initialCandidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt) + 1).toISOString();
const shapeScopes = [createDProductionJobScope({ candidate: fixture.initialCandidate, observedAt }),
  createEReadbackJobScope({ candidate: fixture.completedCandidate, observedAt })];
const shapeContext = scope => ({ candidateId: scope.candidateId, skuPackageId: scope.skuPackageId, revision: scope.resultRevision, jobType: scope.sideEffectScope });

test("D/E envelope shape reuses G1, preserves long real PA/plan IDs and returns an immutable detached value", () => {
  for (const original of shapeScopes) {
    const input = clone(original), before = clone(input);
    const result = normalizeDESoftwareJobScope(input, shapeContext(input));
    assert.deepEqual(result, input); assert.deepEqual(input, before); assert.notEqual(result, input);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.identity.storeRef)); assert.ok(Object.isFrozen(result.productionBinding));
    assert.ok(result.authorizationRef.length > 256);
    if (result.sideEffectScope === "d_production_execution") {
      assert.equal(result.resultRevision, result.sourceRevision + 1); assert.equal(result.resultSkuRevision, result.sourceSkuRevision + 1);
    } else { assert.equal(result.resultRevision, result.sourceRevision); assert.equal(result.resultSkuRevision, result.sourceSkuRevision); assert.ok(result.sourceProductionPlanId.length > 256); }
    input.identity.storeRef.mappingVersion = "changed"; assert.notEqual(result.identity.storeRef.mappingVersion, "changed");
  }
});

test("D/E envelope shape is closed at root, G1/store and production binding", () => {
  for (const original of shapeScopes) {
    for (const field of Object.keys(original)) {
      const invalid = clone(original); delete invalid[field];
      assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)), code("DE_JOB_SCOPE_SHAPE_INVALID"));
    }
    for (const change of [s => { s.extra = true; }, s => { s.schemaVersion = "software-job-scope-v2"; },
      s => { s.identity.extra = true; }, s => { delete s.identity.storeRef.mappingVersion; },
      s => { s.identity.storeRef.extra = true; }, s => { s.productionBinding.verified = true; },
      s => { s.productionBinding.warehouseId = "9007199254740992"; }, s => { s.productionBinding.warehouseId = "070001"; }]) {
      const invalid = clone(original); change(invalid); assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)));
    }
  }
  for (const invalid of [null, [], {}, false]) assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(shapeScopes[0])), DEJobScopeError);
  assert.throws(() => normalizeDESoftwareJobScope(shapeScopes[0]), code("DE_JOB_SCOPE_TYPE_INVALID"));
});

test("D/E shape rejects independent source/result/SKU/PA revision and job identity drift", () => {
  for (const original of shapeScopes) {
    for (const field of ["sourceRevision", "resultRevision", "sourceSkuRevision", "resultSkuRevision"]) for (const value of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = clone(original); invalid[field] = value;
      assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)), code("DE_JOB_SCOPE_REVISION_CONFLICT"));
    }
    for (const change of [s => { s.sourceRevision += 1; }, s => { s.sourceSkuRevision += 1; },
      s => { s.candidateId = "candidate:other"; }, s => { s.identity.skuPackageId = "sku:other"; },
      s => { s.identity.platform = "wb"; }, s => { s.identity.credentialAlias = s.credentialAlias; }]) {
      const invalid = clone(original); change(invalid); assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)));
    }
    for (const change of [{ revision: original.resultRevision + 1 }, { candidateId: "candidate:other" },
      { skuPackageId: "sku:other" }, { jobType: "c1_ai_draft" }]) assert.throws(() => normalizeDESoftwareJobScope(original, { ...shapeContext(original), ...change }));
  }
  const invalid = clone(shapeScopes[1]); invalid.authorizationResultRevision += 1;
  assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(invalid)), code("DE_JOB_SCOPE_REVISION_CONFLICT"));
});

test("D/E references are bounded, secret-free and retain opaque PA IDs and Unicode variants", () => {
  for (const original of shapeScopes) for (const change of [s => { s.authorizationRef = "x".repeat(1025); },
    s => { s.authorizationRef = "Bearer synthetic-private-value"; }, s => { s.authorizationRef += "?token=synthetic-private-value"; },
    s => { s.variantKey = "x".repeat(257); }, s => { s.variantKey = "规格\n红色"; },
    s => { s.credentialAlias = "https://example.com/key"; }, s => { s.warehouseRef = "unknown"; },
    s => { s.merchantSku = "sku%0asecret"; }, s => { s.candidateId = " candidate"; },
    s => { s.identity.storeRef.mappingVersion = "token=synthetic-private-value"; }]) {
    const invalid = clone(original); change(invalid); assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)));
  }
  const invalid = clone(shapeScopes[1]); invalid.sourceProductionRecordId = "x".repeat(1025);
  assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(invalid)), code("DE_JOB_SCOPE_REFERENCE_INVALID"));
});

test("D/E fingerprints, E plan identity, product ID and receipt refs cannot drift independently", () => {
  for (const original of shapeScopes) for (const field of ["authorizationFingerprint", "inputFingerprint",
    ...(original.sideEffectScope === "e_independent_readback" ? ["sourceProductionPlanFingerprint", "sourceProductionRecordFingerprint"] : [])]) {
    const invalid = clone(original); invalid[field] = "g".repeat(64);
    assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)), code("DE_JOB_SCOPE_FINGERPRINT_INVALID"));
  }
  for (const original of shapeScopes) {
    const invalid = clone(original); invalid.inputFingerprint = "0".repeat(64);
    assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(original)), code("DE_JOB_SCOPE_FINGERPRINT_INVALID"));
  }
  for (const change of [s => { s.sourceProductionPlanId += "other"; }, s => { s.authorizationRef += "other"; },
    s => { s.platformProductId = "0"; }, s => { s.platformProductId = "9007199254740992"; },
    s => { s.requestReceiptRef = "http://example.com/receipt"; }, s => { s.inventoryReceiptRef = "x".repeat(257); },
    s => { s.sourceExecutionKey = "token=synthetic-private-value"; }, s => { s.requestReceiptRef = "unknown"; },
    s => { s.sourceProductionRecordId = "not_applicable"; }]) {
    const invalid = clone(shapeScopes[1]); change(invalid); assert.throws(() => normalizeDESoftwareJobScope(invalid, shapeContext(invalid)));
  }
});

test("pure record extraction preserves every original public validator and version", () => {
  for (const field of ["PRODUCTION_RECORD_VERSION", "validateProductionReadbackExpectation", "validateProductionRecord", "assertValidProductionRecord"]) {
    assert.equal(recordContract[field], oldRecordContract[field]);
  }
  assert.equal(recordContract.validateProductionRecord(fixture.completedCandidate.lifecycleV11.skuPackage.productionRecord).valid, true);
});

test("D source derives one frozen scope from saved PA without modifying the candidate or asserting technical readiness", () => {
  const candidate = clone(fixture.initialCandidate);
  const before = clone(candidate);
  const scope = createDProductionJobScope({ candidate, observedAt });
  const pa = candidate.lifecycleV11.skuPackage.productionAuthorization;
  assert.equal(scope.sideEffectScope, "d_production_execution");
  assert.equal(scope.sourceRevision, pa.sourceCandidateRevision);
  assert.equal(scope.resultRevision, pa.resultCandidateRevision);
  assert.equal(scope.sourceSkuRevision, pa.authorizedDataRevision);
  assert.equal(scope.resultSkuRevision, pa.resultDataRevision);
  assert.deepEqual(scope.identity, pa.sourceIdentity);
  assert.deepEqual(scope.productionBinding, pa.executionBinding);
  assert.equal(scope.authorizationRef, pa.authorizationId);
  assert.equal(scope.inputFingerprint, fingerprintCanonicalRecord(pa));
  assert.deepEqual(assertDProductionJobScope({ scope, candidate, observedAt }), scope);
  assert.equal(Object.isFrozen(scope.identity.storeRef), true);
  assert.equal(Object.hasOwn(scope, "credentialStatus"), false);
  assert.equal(Object.hasOwn(scope, "authorizationRecord"), false);
  assert.deepEqual(candidate, before);
});

test("D rejects candidate, SKU, full G1 store, variant, PA binding and all revision drift", () => {
  for (const change of [
    c => { c.id = "candidate:another"; }, c => { c.targetStore = "another"; },
    c => { c.storeRef.platformStoreId = "seller-other"; }, c => { c.dataRevision += 1; },
    c => { c.dataRevision -= 1; }, c => { c.lifecycleV11.skuPackage.dataRevision += 1; },
    c => { c.lifecycleV11.skuPackage.skuPackageId = "sku:another"; },
    c => { c.lifecycleV11.skuPackage.g1Identity.storeRef.mappingVersion = "mapping-other"; },
    c => { c.lifecycleV11.skuPackage.variantKey = "another"; },
    c => { c.lifecycleV11.skuPackage.productionAuthorization.executionBinding.warehouseId = "80001"; },
    c => { c.lifecycleV11.skuPackage.productionAuthorization.sourceCandidateRevision += 1; },
    c => { c.lifecycleV11.skuPackage.productionAuthorization.resultDataRevision += 1; }
  ]) {
    const candidate = clone(fixture.initialCandidate); change(candidate);
    assert.throws(() => createDProductionJobScope({ candidate, observedAt }), DEJobScopeError);
  }
});

test("D requires a current rights gate and refuses sources already advanced to D or E", () => {
  assert.throws(() => createDProductionJobScope({ candidate: fixture.initialCandidate, observedAt: expiredAt }),
    error => error.code === "C1_SKU_RIGHTS_REVIEW_EXPIRED");
  assert.throws(() => createDProductionJobScope({ candidate: fixture.completedCandidate, observedAt }), code("DE_JOB_SCOPE_D_ALREADY_ADVANCED"));
  for (const change of [
    c => { c.lifecycleV11.skuPackage.dAssetTransport = { status: "in_flight" }; },
    c => { c.lifecycleV11.skuPackage.dSoftwareExecution = false; },
    c => { c.lifecycleV11.skuPackage.externalListingRecord = {}; },
    c => { c.lifecycleV11.skuPackage.eVerificationRecord = {}; }
  ]) {
    const candidate = clone(fixture.initialCandidate); change(candidate);
    assert.throws(() => createDProductionJobScope({ candidate, observedAt }), DEJobScopeError);
  }
});

test("scope validators reject extra fields, changed identities and fake technical permission", () => {
  for (const [create, verify, candidate] of [[createDProductionJobScope, assertDProductionJobScope, fixture.initialCandidate],
    [createEReadbackJobScope, assertEReadbackJobScope, fixture.completedCandidate]]) {
    const scope = create({ candidate, observedAt });
    for (const change of [s => { s.resultRevision += 1; }, s => { s.credentialVerified = true; },
      s => { s.productionBinding.configurationVersion = "other"; }, s => { s.inputFingerprint = "0".repeat(64); },
      s => { delete s.authorizationRef; }]) {
      const altered = clone(scope); change(altered);
      assert.throws(() => verify({ scope: altered, candidate, observedAt }), DEJobScopeError);
    }
  }
});

test("E scope derives from persisted D receipts without reusing immediate readback as E evidence", () => {
  const candidate = clone(fixture.completedCandidate);
  const before = clone(candidate);
  const scope = createEReadbackJobScope({ candidate, observedAt });
  const sku = candidate.lifecycleV11.skuPackage;
  const record = sku.productionRecord;
  assert.equal(scope.sideEffectScope, "e_independent_readback");
  assert.equal(scope.sourceRevision, candidate.dataRevision);
  assert.equal(scope.resultRevision, candidate.dataRevision);
  assert.equal(scope.sourceSkuRevision, sku.dataRevision);
  assert.equal(scope.resultSkuRevision, sku.dataRevision);
  assert.equal(scope.sourceProductionRecordId, record.productionRecordId);
  assert.equal(scope.sourceProductionRecordFingerprint, fingerprintCanonicalRecord(record));
  assert.equal(scope.requestReceiptRef, record.requestReceiptRef);
  assert.equal(scope.inventoryReceiptRef, record.inventoryReceiptRef);
  assert.deepEqual(assertEReadbackJobScope({ scope, candidate, observedAt }), scope);
  assert.deepEqual(sku.readbackHistory, []);
  assert.equal(sku.eVerificationRecord, null);
  assert.equal(Object.hasOwn(scope, "observation"), false);
  assert.deepEqual(candidate, before);
  const awaitingReadback = clone(candidate);
  awaitingReadback.lifecycleV11.skuPackage.businessPhase = "E";
  assert.deepEqual(createEReadbackJobScope({ candidate: awaitingReadback, observedAt }), scope);
});

test("E rejects unattested record DTOs, wrong write receipts, unknown D and current source drift", () => {
  for (const change of [
    s => { delete s.dSoftwareExecution; }, s => { s.dSoftwareExecution.status = "unknown_outcome"; },
    s => { s.dSoftwareExecution.continuationBlocked = true; },
    s => { s.dSoftwareExecution.checkpoints[2] = null; },
    s => { s.productionRecord.sourceAuthorizationFingerprint = "0".repeat(64); },
    s => { s.productionRecord.sourceProductionPlanFingerprint = "0".repeat(64); },
    s => { s.productionRecord.storeRef.platformStoreId = "another"; },
    s => { s.productionRecord.requestReceiptRef = "receipt:nonexistent"; },
    s => { s.productionRecord.inventoryReceiptRef = "receipt:nonexistent"; },
    s => { s.dSoftwareExecution.checkpoints[2].requestReceiptRef = "receipt:nonexistent"; },
    s => { s.dSoftwareExecution.checkpoints[4].inventoryReceiptRef = "receipt:nonexistent"; },
    s => { s.dSoftwareExecution.checkpoints[4].warehouseId = "80001"; },
    s => { s.dSoftwareExecution.checkpoints[5].observation.platformEvidenceRef = "evidence:unrelated"; },
    s => { s.dSoftwareExecution.attempt.productionRecord.platformProductId = "999999"; },
    s => { s.productionRecord.readbackExpectation.media[0].sha256 = "0".repeat(64); },
    s => { s.productionRecord.createdAt = "2027-01-01T00:00:00.000Z"; }
  ]) {
    const candidate = clone(fixture.completedCandidate); change(candidate.lifecycleV11.skuPackage);
    assert.throws(() => createEReadbackJobScope({ candidate, observedAt }), DEJobScopeError);
  }
  const candidate = clone(fixture.completedCandidate); candidate.dataRevision += 1;
  assert.throws(() => createEReadbackJobScope({ candidate, observedAt }), code("DE_JOB_SCOPE_D_RECEIPT_SOURCE_CONFLICT"));
});

test("missing sources and invalid source times fail explicitly without returning an empty scope", () => {
  for (const create of [createDProductionJobScope, createEReadbackJobScope]) {
    for (const candidate of [null, {}, { dataRevision: 1, lifecycleV11: null }]) {
      assert.throws(() => create({ candidate, observedAt }), code("DE_JOB_SCOPE_CANDIDATE_INVALID"));
    }
  }
  assert.throws(() => createDProductionJobScope({ candidate: fixture.initialCandidate, observedAt: "invalid" }), code("DE_JOB_SCOPE_TIME_INVALID"));
  assert.throws(() => createDProductionJobScope({ candidate: fixture.initialCandidate, observedAt: "2020-01-01T00:00:00.000Z" }),
    code("DE_JOB_SCOPE_REVISION_OR_TIME_CONFLICT"));
});

test("historical expiry does not rewrite completed production or invent a new authorization", () => {
  const candidate = clone(fixture.completedCandidate);
  const before = clone(candidate);
  assert.equal(createEReadbackJobScope({ candidate, observedAt: expiredAt }).authorizationRef,
    candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId);
  assert.deepEqual(candidate, before);
});

test("pure D/E scope dependency graph contains no transaction, generic jobs or execution I/O modules", () => {
  const visited = new Set();
  function inspect(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.doesNotMatch(path.basename(file), /^(?:business-mutation-transaction|software-job-(?:contract|admission|repository)|production-authorization|draft-production-execution|d-e-software-integration|aliyun-oss-runtime-(?:configuration|provider))\.mjs$/);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*)["']node:(?:fs|net|http|https|child_process)(?:\/[^"']*)?["']/);
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) inspect(path.resolve(path.dirname(file), match[1]));
  }
  inspect(fileURLToPath(new URL("../lib/d-e-software-job-scope.mjs", import.meta.url)));
  inspect(fileURLToPath(new URL("../lib/production-execution-failure.mjs", import.meta.url)));
  assert.ok(visited.size > 3);
});
