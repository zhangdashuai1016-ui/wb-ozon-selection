import assert from "node:assert/strict";
import test from "node:test";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { preparedFixture, historicalPlanFixture } from "./helpers/d-software-fixture.mjs";
import { verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { assertCurrentC1SkuRightsReview } from "../lib/c1-sku-rights-review.mjs";
import { buildC1ReviewPresentation } from "../lib/c1-review-presentation.mjs";
import { assertValidProductionAuthorization } from "../lib/production-authorization.mjs";
import { beginDSoftwareExecution, executeDSoftwareAttempt } from "../lib/d-e-software-closure.mjs";

test("品牌文本、Schema clear 与旧商业 clear 不提供逐SKU许可，Schema夹带review也不会被读取", () => {
  const missing = createFormalC1DraftFixture({ rightsReviewOptions: null, skuAttributes: { brand: "Нет бренда" } });
  const candidate = { ...missing.candidate, complianceStatus: "clear", authorizationStatus: "clear",
    c1ReviewPresentation: { rights: { status: "verified", code: null }, compliance: { status: "clear", assessment: "clear", code: null } } };
  const before = JSON.stringify(candidate);
  const plan = candidate.lifecycleV11.skuPackage.c1ProductPlan;
  assert.equal(plan.platformCompliance.assessment.value.status, "clear");
  assert.equal(plan.inputSnapshots.skuRightsReview, null);
  assert.equal(buildC1ReviewPresentation({ candidate, observedAt: missing.at }).rights.status, "unknown");
  assert.throws(() => assertCurrentC1SkuRightsReview({ plan, sourceIdentity: candidate.lifecycleV11.skuPackage.g1Identity,
    observedAt: missing.at }), /C1_SKU_RIGHTS_REVIEW_REQUIRED/);
  assert.equal(JSON.stringify(candidate), before);

  const licensed = createFormalC1DraftFixture();
  const inputs = structuredClone(licensed.created.skuPackage);
  inputs.c1ProductPlan.inputSnapshots.platformSchemaRules.skuRightsReview = structuredClone(licensed.checked.c1ProductPlan.inputSnapshots.skuRightsReview);
  const checked = verifyC1ProductFacts({ skuPackage: inputs, verifiedAt: licensed.at });
  assert.equal(checked.c1ProductPlan.inputSnapshots.skuRightsReview, null);
  assert.equal(checked.c1ProductPlan.platformCompliance.skuRightsReview.rights.verificationStatus, "unknown");
});

test("JSON回读的合法旧授权只读；当前版本request和伪造verified展示不能解锁D直接执行", async () => {
  const { plan, authorization } = historicalPlanFixture();
  const saved = JSON.parse(JSON.stringify({ plan, authorization }));
  assert.doesNotThrow(() => assertValidProductionAuthorization(saved.authorization));
  assert.equal(saved.authorization.schemaVersion, "production-authorization-v1.1");
  const { prepared, executionContext } = await preparedFixture();
  const attempt = beginDSoftwareExecution({ preparedExecution: prepared, startedAt: "2026-08-22T07:20:00.000Z" });
  assert.equal(attempt.request.sourceAuthorizationVersion, "production-authorization-v1.2");
  let externalCalls = 0;
  const executeSellerApi = async () => { externalCalls += 1; throw new Error("unexpected external write"); };
  const readbackSellerApi = async () => { externalCalls += 1; throw new Error("unexpected external read"); };
  const before = JSON.stringify(saved);
  await assert.rejects(() => executeDSoftwareAttempt({ executionAttempt: attempt,
    executionContext: { ...executionContext, productionPlan: saved.plan }, executeSellerApi, readbackSellerApi,
    completedAt: "2026-08-22T07:25:00.000Z" }), /PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  await assert.rejects(() => executeDSoftwareAttempt({ executionAttempt: attempt,
    c1ReviewPresentation: { rights: { status: "verified", code: null } }, executeSellerApi, readbackSellerApi,
    completedAt: "2026-08-22T07:25:00.000Z" }), /D_EXECUTION_CONTEXT_REQUIRED/);
  assert.equal(externalCalls, 0);
  assert.equal(JSON.stringify(saved), before);
});
