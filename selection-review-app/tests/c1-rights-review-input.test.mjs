import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { buildC1RightsReviewInput } from "../src/c1RightsReviewInput.js";

function fixture() {
  const candidate = { id: "synthetic-rights-ui", dataRevision: 7, lifecycleV11: { skuPackage: {
    skuPackageId: "sku:synthetic-rights-ui", supplierSkuId: "synthetic-supplier-sku", variantKey: "规格:合成测试",
    businessPhase: "C1", c1ProductPlan: { c1PlanId: "plan:synthetic-rights-ui", status: "inputs_ready", inputSnapshots: {} }
  } } };
  const form = { c1PlanId: "plan:synthetic-rights-ui", skuPackageId: "sku:synthetic-rights-ui", brandStatus: "branded",
    brandName: "SYNTHETIC_TEST_BRAND", rightsChoice: "licensed", reviewedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z", confirmed: true, replaceFrozenPlan: false };
  return { candidate, form, sourceRevision: candidate.dataRevision };
}

test("明确的准确SKU声明保留选择和有效期，客户端不制造身份、证据或许可记录", () => {
  const f = fixture(), before = structuredClone(f);
  const input = buildC1RightsReviewInput(f);
  assert.deepEqual(input.rights, { status: "verified", basis: "licensed" });
  assert.deepEqual(input.brand, { status: "branded", name: "SYNTHETIC_TEST_BRAND" });
  assert.equal(input.expectedRevision, 7);
  assert.equal(input.replacesC1PlanId, null);
  assert.equal(input.reviewedAt, f.form.reviewedAt);
  assert.equal(input.expiresAt, f.form.expiresAt);
  assert.equal(input.idempotencyKey, buildC1RightsReviewInput(f).idempotencyKey);
  for (const field of ["sourceIdentity", "reviewId", "recordId", "actor", "evidenceRefs", "productionAuthorization"]) assert.equal(Object.hasOwn(input, field), false);
  assert.deepEqual(f, before);
  for (const status of ["unknown", "blocked", "requires_authorization"]) {
    assert.deepEqual(buildC1RightsReviewInput({ ...f, form: { ...f.form, rightsChoice: status } }).rights, { status, basis: null });
  }
});

test("缺确认、错误品牌依据、非法日期和当前修订变化均不能提交", () => {
  const f = fixture();
  for (const patch of [{ confirmed: false }, { brandName: " " }, { rightsChoice: "no_third_party_rights_identified" },
    { rightsChoice: "__proto__" }, { reviewedAt: "2026-02-30T00:00:00.000Z" }, { expiresAt: "" },
    { expiresAt: f.form.reviewedAt }, { skuPackageId: "sku:other" }, { c1PlanId: "plan:other" }]) {
    assert.throws(() => buildC1RightsReviewInput({ ...f, form: { ...f.form, ...patch } }));
  }
  assert.throws(() => buildC1RightsReviewInput({ ...f, sourceRevision: 6 }), /资料已变化/);
  f.candidate.lifecycleV11.skuPackage.businessPhase = "C2";
  assert.throws(() => buildC1RightsReviewInput(f), /资料已变化/);
});

test("冻结过null权利证据也必须明确替代；未知声明不会自动成为许可", () => {
  const f = fixture();
  f.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview = null;
  assert.throws(() => buildC1RightsReviewInput(f), /替代版本/);
  const input = buildC1RightsReviewInput({ ...f, form: { ...f.form, replaceFrozenPlan: true, brandStatus: "unknown", rightsChoice: "unknown" } });
  assert.equal(input.replacesC1PlanId, f.form.c1PlanId);
  assert.deepEqual(input.brand, { status: "unknown", name: null });
  assert.deepEqual(input.rights, { status: "unknown", basis: null });
});

test("旧版已核验但没有权利字段的C1仍需明确替代，不能陷入反复提交旧计划", () => {
  for (const status of ["facts_checked", "seo_draft_ready"]) {
    const f = fixture();
    f.candidate.lifecycleV11.skuPackage.c1ProductPlan.status = status;
    assert.throws(() => buildC1RightsReviewInput(f), /替代版本/);
    assert.equal(buildC1RightsReviewInput({ ...f, form: { ...f.form, replaceFrozenPlan: true } }).replacesC1PlanId, f.form.c1PlanId);
  }
});

test("实际表单默认未知、未确认、不能提交，损坏计划明确显示资料错误", async () => {
  const entry = fileURLToPath(new URL("./c1-rights-form-test-entry.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/C1RightsReviewPanel.jsx", import.meta.url));
  const built = await build({ configFile: false, logLevel: "warn", plugins: [react(), {
    name: "c1-rights-form-test", resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from "react"; import {renderToStaticMarkup} from "react-dom/server";
      import Panel from ${JSON.stringify(component)};
      export const render = candidate => renderToStaticMarkup(<Panel candidate={candidate} identity={{canSaveC1RightsReview:true}} onSave={()=>{throw new Error("render performed write")}}/>);` : null
  }], ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const output = built.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
  const f = fixture(), html = render(f.candidate);
  assert.equal((html.match(/value="unknown" selected=""/g) || []).length, 2);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /disabled="">保存本件商品声明/);
  assert.match(html, /我已获得所需许可/);
  assert.doesNotMatch(html, /type="file"/);
  f.candidate.lifecycleV11.skuPackage.c1ProductPlan.status = "facts_checked";
  const historicalHtml = render(f.candidate);
  assert.match(historicalHtml, /当前C1计划已冻结/);
  assert.match(historicalHtml, /disabled="">保存声明并生成替代计划/);
  assert.doesNotMatch(historicalHtml, /checked=""/);
  f.candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots = null;
  assert.match(render(f.candidate), /资料不完整或已损坏/);
});
