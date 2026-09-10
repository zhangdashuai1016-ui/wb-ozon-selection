import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createFormalC1C2Fixture, createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";
import { candidateRightsCompliancePresentation } from "../src/candidateViews.js";
import { buildC1ReviewPresentation } from "../lib/c1-review-presentation.mjs";
import { projectC1SkuRightsReviewFacts, createC1SkuRightsReviewRecord, validateC1SkuRightsReviewRecord } from "../lib/c1-sku-rights-review.mjs";
import { verifyC1ProductFacts } from "../lib/c1-product-plan.mjs";
import { SYNTHETIC_UNBRANDED, SYNTHETIC_NO_THIRD_PARTY_RIGHTS } from "./fixtures/c1-sku-rights-review-fixture.mjs";

function withPresentation(candidate, observedAt) {
  return { ...candidate, c1ReviewPresentation: buildC1ReviewPresentation({ candidate, observedAt }) };
}

test("已冻结C1必须继续匹配独立保存声明，合法的另一条声明也不能冒充当前核验", () => {
  const formal = createFormalC1DraftFixture();
  function declaration(fixture, revision) {
    return createC1SkuRightsReviewRecord({ plan: fixture.created.c1ProductPlan, sourceIdentity: fixture.created.skuPackage.g1Identity,
      sourceCandidateRevision: revision, declaredByUserId: "synthetic-owner", declaredAt: fixture.at,
      ownerDeclaration: { brand: { status: "branded", name: "SYNTHETIC_TEST_BRAND" }, rights: { status: "verified", basis: "licensed" },
        reviewedAt: fixture.at, expiresAt: "2099-01-01T00:00:00.000Z" } });
  }
  const record = declaration(formal, formal.candidate.dataRevision);
  const checked = verifyC1ProductFacts({ skuPackage: formal.created.skuPackage, skuRightsReview: record.review, verifiedAt: formal.at });
  const candidate = structuredClone(formal.candidate);
  candidate.lifecycleV11.skuPackage = { ...structuredClone(checked.skuPackage), c1RightsReviewRecord: record };
  assert.deepEqual(withPresentation(candidate, formal.at).c1ReviewPresentation.rights, { status: "verified", code: null });
  const other = createFormalC1DraftFixture({ candidateId: "SYNTHETIC-RIGHTS-OTHER" });
  for (const replacement of [declaration(formal, formal.candidate.dataRevision + 1), declaration(other, other.candidate.dataRevision)]) {
    assert.equal(validateC1SkuRightsReviewRecord(replacement).valid, true);
    const changed = structuredClone(candidate);
    changed.lifecycleV11.skuPackage.c1RightsReviewRecord = replacement;
    const before = structuredClone(changed);
    const view = withPresentation(changed, formal.at);
    assert.equal(view.c1ReviewPresentation.rights.status, "invalid");
    assert.doesNotMatch(candidateRightsCompliancePresentation(view).details.join(""), /品牌\/IP 权利核验通过/);
    assert.deepEqual(changed, before);
  }
});

test("服务端用正式C1事实和独立权利证据投影，页面本身不从品牌或旧clear推定权利", () => {
  const { candidate, at } = createFormalC1C2Fixture({ skuAttributes: { brand: "Нет бренда" },
    rightsReviewOptions: { brand: SYNTHETIC_UNBRANDED, rights: SYNTHETIC_NO_THIRD_PARTY_RIGHTS } });
  const before = structuredClone(candidate);
  const projected = withPresentation(candidate, at);
  assert.deepEqual(projected.c1ReviewPresentation.rights, { status: "verified", code: null });
  assert.deepEqual(projected.c1ReviewPresentation.compliance, { status: "clear", assessment: "clear", code: null });
  const view = candidateRightsCompliancePresentation(projected);
  assert.match(view.details.join(""), /当前 C1 已记录合规核验通过/);
  assert.match(view.details.join(""), /当前 C1 已记录品牌\/IP 权利核验通过/);
  assert.doesNotMatch(view.details.join(""), /证据尚未取得|已发现风险/);
  const clientOnly = candidateRightsCompliancePresentation({ ...candidate, complianceStatus: "clear", authorizationStatus: "clear",
    c1SkuRightsReview: { status: "verified", code: null } });
  assert.match(clientOnly.details.join(""), /品牌\/IP 权利证据尚未取得/);
  assert.doesNotMatch(clientOnly.details.join(""), /核验通过/);
  assert.deepEqual(candidate, before);
});

test("服务端拒绝不同SKU、完整店铺、规格和伪造来源；页面保留已有明确风险", () => {
  const { candidate, at } = createFormalC1C2Fixture();
  for (const mutate of [
    c => { c.id = "another-candidate"; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.identity.supplierSkuId = "another-sku"; },
    c => { c.lifecycleV11.skuPackage.variantKey = "规格:另一款"; },
    c => { c.storeRef.mappingVersion = "another-mapping"; },
    c => { c.lifecycleV11.skuPackage.g1Identity.supplierSkuId = "another-sku"; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.snapshotId = "source:another"; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.revisionRefs.resultRevision = c.lifecycleV11.skuPackage.dataRevision + 1; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.schemaSnapshotRef = "schema:another"; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.platformCompliance.assessment.sourceRefs = []; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.platformCompliance.assessment.verificationStatus = "unknown"; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.platformCompliance.status = "restricted"; }
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    const view = candidateRightsCompliancePresentation(withPresentation(changed, at));
    assert.doesNotMatch(view.details.join(""), /已记录合规核验通过/);
    assert.match(view.details.join(""), /仍需核验/);
  }
  const risk = structuredClone(candidate);
  risk.lifecycleV11.skuPackage.c1ProductPlan.platformCompliance.assessment.value.status = "restricted";
  risk.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.platformCompliance.status = "restricted";
  const riskView = candidateRightsCompliancePresentation(withPresentation(risk, at));
  assert.equal(riskView.title, "合规结论需复核");
  assert.match(riskView.details.join(""), /restricted.*具体风险/);
  const conflicting = candidateRightsCompliancePresentation(withPresentation({ ...candidate,
    complianceStatus: "risk_recorded", authorizationStatus: "rights_restricted" }, at));
  assert.equal(conflicting.title, "权利或合规记录需复核");
  assert.match(conflicting.details.join(""), /risk_recorded/);
  assert.match(conflicting.details.join(""), /rights_restricted/);
});

test("缺失、已过期、明确阻塞与待授权各有准确呈现，旧版不会升级或原位修改", () => {
  const { candidate, at } = createFormalC1C2Fixture();
  const expiredAt = candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt;
  assert.match(candidateRightsCompliancePresentation(withPresentation(candidate, expiredAt)).details.join(""), /权利证据已过期/);
  for (const [status, pattern] of [["blocked", /已记录阻塞/], ["requires_authorization", /仍待取得适用于当前商品的授权/]]) {
    const changed = structuredClone(candidate);
    const plan = changed.lifecycleV11.skuPackage.c1ProductPlan;
    const review = plan.inputSnapshots.skuRightsReview;
    review.rights.status = status; review.rights.basis = null;
    plan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(review, `${plan.c1PlanId}#/inputSnapshots/skuRightsReview`);
    const result = withPresentation(changed, at);
    assert.equal(result.c1ReviewPresentation.rights.status, status);
    assert.match(candidateRightsCompliancePresentation(result).details.join(""), pattern);
  }
  const missing = structuredClone(candidate);
  const missingPlan = missing.lifecycleV11.skuPackage.c1ProductPlan;
  missingPlan.inputSnapshots.skuRightsReview = null;
  missingPlan.platformCompliance.skuRightsReview = projectC1SkuRightsReviewFacts(null, `${missingPlan.c1PlanId}#/inputSnapshots/skuRightsReview`);
  assert.match(candidateRightsCompliancePresentation(withPresentation(missing, at)).details.join(""), /品牌\/IP 权利证据尚未取得/);
  const legacy = structuredClone(candidate);
  legacy.lifecycleV11.skuPackage.c1ProductPlan.factVerificationVersion = "c1-fact-verification-v1.1";
  delete legacy.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.skuRightsReview;
  delete legacy.lifecycleV11.skuPackage.c1ProductPlan.platformCompliance.skuRightsReview;
  const bytes = JSON.stringify(legacy);
  const historical = withPresentation(legacy, at);
  assert.equal(historical.c1ReviewPresentation.compliance.status, "historical");
  assert.equal(historical.c1ReviewPresentation.rights.status, "unknown");
  assert.doesNotMatch(candidateRightsCompliancePresentation(historical).details.join(""), /当前 C1 已记录.*核验通过/);
  assert.match(candidateRightsCompliancePresentation(historical).details.join(""), /历史 C1 合规记录/);
  assert.equal(JSON.stringify(legacy), bytes);
  const incomplete = structuredClone(candidate);
  delete incomplete.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots;
  assert.doesNotThrow(() => buildC1ReviewPresentation({ candidate: incomplete, observedAt: at }));
  assert.equal(buildC1ReviewPresentation({ candidate: incomplete, observedAt: at }).compliance.status, "unknown");
});

test("实际商品组件把缺失显示为待核验，保留正式合规与权利缺口，未知状态作为文字安全呈现", async () => {
  const entry = fileURLToPath(new URL("./candidate-risk-render.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/CandidateDetail.jsx", import.meta.url));
  const result = await build({ configFile: false, logLevel: "warn", plugins: [react(), { name: "candidate-risk-render",
    resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import CandidateDetail from ${JSON.stringify(component)};
      export const render=candidate=>renderToStaticMarkup(<CandidateDetail candidate={candidate}/>);` : null }], ssr: { noExternal: true },
    build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const chunk = result.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  const legacy = { id: "synthetic:legacy", productName: "合成商品", targetStore: "dandanshu", source: "user" };
  assert.match(render(legacy), /缺失资料不表示已发现风险/);
  assert.doesNotMatch(render(legacy), /IP\/品牌或合规风险 · 需总控确认/);
  assert.doesNotMatch(render({ ...legacy, complianceStatus: "clear", authorizationStatus: "clear" }), /aria-label="权利与合规状态"/);
  const { candidate, at } = createFormalC1C2Fixture();
  const html = render(withPresentation(candidate, at));
  assert.match(html, /当前 C1 已记录合规核验通过/);
  assert.match(html, /当前 C1 已记录品牌\/IP 权利核验通过/);
  assert.doesNotMatch(html, /证据尚未取得/);
  assert.match(render(candidate), /品牌\/IP 权利证据尚未取得/);
  assert.doesNotMatch(html, /IP\/品牌或合规风险 · 需总控确认/);
  const unsafe = render({ ...legacy, authorizationStatus: "<script>blocked</script>" });
  assert.match(unsafe, /&lt;script&gt;blocked&lt;\/script&gt;/);
  assert.doesNotMatch(unsafe, /<script>blocked<\/script>/);
});
