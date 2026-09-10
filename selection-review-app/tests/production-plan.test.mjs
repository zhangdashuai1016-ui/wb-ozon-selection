import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { historicalPlanFixture } from "./helpers/d-software-fixture.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { createProductionPlan, projectProductionPlanInputs, PRODUCTION_PLAN_VERSION, validateProductionPlan, validateProductionPlanAuthorizationBinding } from "../lib/production-plan.mjs";

test("D计划遵循公开合同保存完整正式授权，唯一投影保留商家和供应身份", () => {
  const fixture = authorizedProductionFixture();
  const plan = createProductionPlan(fixture);
  const inputs = projectProductionPlanInputs(plan);
  assert.equal(plan.schemaVersion, PRODUCTION_PLAN_VERSION);
  assert.deepEqual(plan.sourceAuthorization, fixture.productionAuthorization);
  assert.deepEqual(validateProductionPlan(plan), { valid: true, errors: [] });
  assert.equal(inputs.platform, "ozon");
  assert.deepEqual(inputs.storeRef, fixture.productionAuthorization.lockedScope.storeRef);
  assert.equal(inputs.sku.merchantSku, "MERCHANT-SHELF-001");
  assert.equal(inputs.sku.supplierSkuId, "SHELF-WHITE");
  assert.notEqual(inputs.sku.merchantSku, inputs.sku.supplierSkuId);
  assert.equal(inputs.title, "Полки для ванной");
  assert.equal(inputs.content.description, "Полки для ванной");
  assert.equal(inputs.content.bulletPoints.length, 1);
  assert.deepEqual(inputs.content.searchKeywords, ["Полки для ванной"]);
  assert.equal(inputs.packing.weight.value, 0.3);
  assert.equal(inputs.schemaWriteBindings.schemaRevision, "ozon-schema:17028665:92935:2026-08-12");
  assert.equal(inputs.platformCategory.typeId.value, "92935");
  assert.deepEqual(inputs.platformWritePrice, { amount: 151.78, currency: "CNY" });
  assert.deepEqual(inputs.buyerTargetPrice, { amount: 1831, currency: "RUB" });
  assert.equal(inputs.stock, 100);
  assert.equal(inputs.finalUploads.length, 2);
  assert.equal(inputs.warehouseRef, fixture.productionAuthorization.lockedScope.warehouseRef);
  assert.equal(inputs.credentialAlias, fixture.productionAuthorization.lockedScope.credentialAlias);
});

test("首次创建精确校验候选和SKU修订；不读取当前C1或其他原始商品信息", () => {
  const fixture = authorizedProductionFixture();
  const sku = structuredClone(fixture.skuPackage);
  sku.c1ProductPlan = null;
  sku.skuFacts = { material: "must-not-read" };
  const plan = createProductionPlan({ ...fixture, skuPackage: sku });
  assert.equal(projectProductionPlanInputs(plan).attributes.material.value, "plastic");
  for (const input of [
    { ...fixture, candidateId: "another" }, { ...fixture, candidateRevision: fixture.candidateRevision - 1 },
    { ...fixture, skuPackage: { ...fixture.skuPackage, dataRevision: fixture.skuPackage.dataRevision + 1 } },
    { productionAuthorization: fixture.productionAuthorization, createdAt: fixture.createdAt }
  ]) assert.throws(() => createProductionPlan(input), /校验失败|CONTEXT_REQUIRED/);
  assert.equal(plan.platformWrites, 0);
  assert.equal(plan.productResearchPerformed, false);
  assert.equal(plan.productCreated, false);
  assert.equal(plan.assetsUploaded, 0);
  assert.equal(plan.readbackPerformed, false);
});

test("冻结包装资料缺失时明确拒绝，不用当前资料补全", () => {
  const fixture = authorizedProductionFixture();
  const plan = structuredClone(createProductionPlan(fixture));
  delete plan.sourceAuthorization.lockedScope.finalCardInputSnapshot.c1Snapshot.productAttributes.weight;
  const original = structuredClone(plan);
  assert.throws(() => projectProductionPlanInputs(plan), /校验失败/);
  assert.throws(() => createProductionPlan({ ...fixture, productionAuthorization: plan.sourceAuthorization }), /校验失败/);
  assert.deepEqual(plan, original);
});

test("计划与授权均不可变；重新载入后不接受字段镜像或其他正式授权替换", () => {
  const fixture = authorizedProductionFixture();
  const before = structuredClone(fixture);
  const plan = createProductionPlan(fixture);
  assert.ok(Object.isFrozen(plan.sourceAuthorization.lockedScope));
  assert.throws(() => { plan.sourceAuthorization.lockedScope.stock = 5; }, TypeError);
  assert.deepEqual(fixture, before);
  assert.equal(validateProductionPlanAuthorizationBinding(plan, fixture.productionAuthorization).valid, true);
  const other = authorizedProductionFixture({ publishScope: "create_draft_only" });
  assert.equal(validateProductionPlanAuthorizationBinding(plan, other.productionAuthorization).status, "authorization_drift_detected");
  for (const change of [
    value => { value.title = "unapproved"; },
    value => { value.platformWritePrice = { amount: 1, currency: "CNY" }; },
    value => { value.sourceAuthorization.lockedScope.merchantSku = "unapproved"; }
  ]) {
    const loaded = JSON.parse(JSON.stringify(plan)); change(loaded);
    assert.equal(validateProductionPlan(loaded).valid, false);
    assert.throws(() => projectProductionPlanInputs(loaded), /校验失败/);
  }
});

test("无效或未确认授权不生成计划", () => {
  const fixture = authorizedProductionFixture();
  const invalid = structuredClone(fixture.productionAuthorization);
  invalid.status = "pending";
  assert.throws(() => createProductionPlan({ ...fixture, productionAuthorization: invalid }), /ProductionAuthorization校验失败/);
});

test("v1.1 plans remain strict readable history while new production plans require actual v1.2 owner authorization", async () => {
  const { fixture, plan } = historicalPlanFixture();
  const before = structuredClone(plan);
  assert.deepEqual(validateProductionPlan(plan), { valid: true, errors: [] });
  assert.equal(projectProductionPlanInputs(plan).sku.merchantSku, fixture.productionAuthorization.lockedScope.merchantSku);
  const validator = (await loadPublishedSchemaValidator()).getSchema("production-plan-v1.1");
  assert.equal(validator(plan), true, JSON.stringify(validator.errors));
  assert.throws(() => createProductionPlan(fixture), /PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED/);
  assert.deepEqual(plan, before);
  const current = createProductionPlan(authorizedProductionFixture());
  assert.equal(current.sourceAuthorization.schemaVersion, "production-authorization-v1.2");
  assert.equal(validator(current), true, JSON.stringify(validator.errors));
});

test("published ProductionPlan schema and runtime share the exact frozen no-write contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/production-plan-v1.1.schema.json", import.meta.url), "utf8"));
  const plan = createProductionPlan(authorizedProductionFixture());
  assert.deepEqual(Object.keys(plan).sort(), [...schema.required].sort());
  assert.deepEqual(Object.keys(plan).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.properties.sourceAuthorization.oneOf, [{ $ref: "production-authorization-v1.1" }, { $ref: "production-authorization-v1.2" }]);
  assert.equal(schema.additionalProperties, false);
  for (const [key, property] of Object.entries(schema.properties)) if (Object.hasOwn(property, "const")) assert.equal(plan[key], property.const, key);
});
