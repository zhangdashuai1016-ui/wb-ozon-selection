import { syntheticContentRules } from "./helpers/c2-software-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { newDraft, receiveDraft, createSubmitLock, createLatestRead, createSelectionGuard, shouldContinuePolling, optionalNumber, safeWebUrl, safeImageUrl, candidatePlatform, errorMessage } from "../src/formState.js";
import { orderCandidates, firstInQueue } from "../src/candidateViews.js";
import { api } from "../src/api.js";
import { buildAConfirmationInput, selectAConfirmationSku } from "../src/aConfirmationInput.js";
import { buildC2FinalAssetInput } from "../src/c2FinalAssetInput.js";
import { productionAuthorizationInputFromCard } from "../src/productionAuthorizationInput.js";
import { extensionConnectionStatus, EXPECTED_EXTENSION_VERSION } from "../src/extensionStatus.js";
import { finiteDisplayNumber, formatMoney, formatPercent } from "../src/finiteDisplay.js";
import { buildCandidateCommentInput, shouldClearSubmittedComment, validateCandidateCommentReceipt } from "../src/commentInput.js";
import { normalizeCandidateUserCreateInput } from "../lib/candidate-user-fields.mjs";
import { createSavedConditionalBFixture } from "./fixtures/real-a-b-flow-fixture.mjs";
import { buildBExactCommissionRuntimeView } from "../lib/b-exact-commission-runtime-view.mjs";

function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }

async function componentRenderer() {
  const entry = fileURLToPath(new URL("./review-component-render-entry.jsx", import.meta.url));
  const detail = fileURLToPath(new URL("../src/components/CandidateDetail.jsx", import.meta.url));
  const inspector = fileURLToPath(new URL("../src/components/UserInspector.jsx", import.meta.url));
  const addCandidate = fileURLToPath(new URL("../src/components/AddCandidateModal.jsx", import.meta.url));
  const realA = fileURLToPath(new URL("../src/components/RealAConfirmationCard.jsx", import.meta.url));
  const rail = fileURLToPath(new URL("../src/components/CandidateRail.jsx", import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: "warn",
    plugins: [react(), {
      name: "review-component-render-entry",
      resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import CandidateDetail from ${JSON.stringify(detail)};
        import UserInspector, { C2FinalAssetsPanel } from ${JSON.stringify(inspector)};
        import RealA from ${JSON.stringify(realA)};
        export const renderRealA = card => renderToStaticMarkup(<RealA card={card} onSubmit={() => { throw new Error("UNEXPECTED_RENDER_MUTATION"); }} />);
        import CandidateRail from ${JSON.stringify(rail)};
        export { candidateCreateInput } from ${JSON.stringify(addCandidate)};
        export const renderDetail = candidate => renderToStaticMarkup(<CandidateDetail candidate={candidate} />);
        export const renderInspector = (candidate, identity, withRecalculation = false) => renderToStaticMarkup(<UserInspector candidate={candidate} productionIdentity={identity} onRecalculateBWithExactCommission={withRecalculation ? () => { throw new Error('UNEXPECTED_RENDER_MUTATION'); } : undefined} />);
        export const renderRail = candidate => renderToStaticMarkup(<CandidateRail candidates={[candidate]} queue="listed" sourceFilter="all" />);
        export const renderC2 = candidate => renderToStaticMarkup(<C2FinalAssetsPanel candidate={candidate} />);` : null
    }],
    ssr: { noExternal: true },
    build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } }
  });
  const output = result.output.find(item => item.type === "chunk" && item.isEntry);
  return import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
}

test("历史E来源冲突在详情、列表和历史上架面板均不宣称当前验证通过", async () => {
  const { renderDetail, renderInspector, renderRail } = await componentRenderer();
  const candidate = { id: "synthetic:e-source-conflict", dataRevision: 4, productName: "合成历史商品", targetStore: "dandanshu",
    source: "user", workflowStatus: "listed", comments: [], activity: [],
    listingRecord: { platform: "ozon", store: "dandanshu", eVerificationOutcome: "listed_verified", createdByCurrentRun: true },
    eReadbackRuntimeView: { status: "source_conflict", currentVerified: false, applicationDisposition: "applied", result: { gaps: [] } },
    dESoftwareRuntimeView: { available: true, status: "e_source_conflict", gaps: [], canExecutePlatformWrite: false, platformWrites: 0 } };
  const before = structuredClone(candidate);
  for (const render of [renderDetail, renderInspector, renderRail]) {
    const html = render(candidate);
    assert.match(html, /来源待核对/);
    assert.doesNotMatch(html, /系统创建并验证|平台结果已独立验证|已完成E阶段验证/);
  }
  assert.deepEqual(candidate, before);
});

test("估算佣金停在条件测算时页面不要求重复填写供货数据", async () => {
  const { renderInspector } = await componentRenderer();
  const candidate = { id: "synthetic:conditional-b", dataRevision: 2, productName: "条件测算商品", targetStore: "dandanshu",
    workflowStatus: "needs_user_data", comments: [], activity: [], neededFieldKeys: ["purchasePriceRmb"], needsFromUser: ["旧资料提示"],
    lifecycleV11: { status: "b_conditional_awaiting_exact_commission", skuPackage: {
      activeProfitModelVersion: "profit-v1", profitModels: [{ profitModelVersion: "profit-v1", calculationType: "conditional",
        result: "manual_review", commissionRate: 0.2, unitProfitRmb: 25, profitMargin: 0.2 }]
    } } };
  const before = JSON.stringify(candidate);
  const html = renderInspector(candidate);
  assert.match(html, /条件测算已保存，等待精确佣金/);
  assert.match(html, /条件单件利润/);
  assert.match(html, /未通过正式B，也未进入C1/);
  assert.doesNotMatch(html, /只需你完成这一项|旧资料提示|保存资料/);
  assert.equal(JSON.stringify(candidate), before);
});

test("精确证据齐备时同一商品卡提供本地复算按钮并遵守主人身份", async () => {
  const f = await createSavedConditionalBFixture();
  const { renderInspector } = await componentRenderer();
  const candidate = { ...f.candidate, comments: [], activity: [], neededFieldKeys: [], needsFromUser: [],
    bExactCommissionRuntimeView: buildBExactCommissionRuntimeView({ candidate: f.candidate, evidencePacks: f.evidencePacks, rules: f.document.rules, observedAt: f.at }) };
  const before = structuredClone(candidate);
  const ready = renderInspector(candidate, { authenticated: true, roles: ["owner"] }, true);
  assert.match(ready, /精确费用已齐，可以复算正式利润/);
  assert.match(ready, /使用精确费用复算/);
  assert.doesNotMatch(ready, /<button[^>]*disabled[^>]*>使用精确费用复算/);
  const unauthenticated = renderInspector(candidate, { authenticated: false, roles: [] }, true);
  assert.match(unauthenticated, /<button[^>]*disabled[^>]*>使用精确费用复算/);
  assert.doesNotMatch(ready, /保存资料|尚待接通|一次付费/);
  assert.deepEqual(candidate, before);
});

test("商品实际显示保留未知采购价，中文缺口与素材标签不改业务值", async () => {
  const { renderDetail, renderInspector, renderC2 } = await componentRenderer();
  const candidate = { id: "candidate:display", dataRevision: 1, productName: "历史商品", targetStore: "wb", source: "user",
    workflowStatus: "listing_preparation", complianceStatus: "clear", authorizationStatus: "clear", comments: [], activity: [],
    listingHandoff: { state: "blocked", blockReason: "paid_job_admission_required" }, listingPreparation: { status: "blocked" } };
  for (const value of [undefined, null, "", "12.5", NaN, Infinity]) {
    const html = renderDetail({ ...candidate, purchasePriceRmb: value });
    assert.match(html, /采购到手总价（含国内运费）<\/dt><dd>未取得<\/dd>/);
    assert.doesNotMatch(html, /¥undefined|¥NaN|¥Infinity/);
  }
  for (const [value, expected] of [[0, "¥0.00"], [12.5, "¥12.50"]]) {
    assert.ok(renderDetail({ ...candidate, purchasePriceRmb: value }).includes(`<dd>${expected}</dd>`));
  }
  const admission = renderInspector(candidate);
  assert.match(admission, /尚未取得当前商品的单次付费授权与服务连接/);
  assert.doesNotMatch(admission, /paid_job_admission_required/);
  const failure = renderInspector({ ...candidate, listingHandoff: { state: "blocked", blockReason: "当前商品Schema核验失败" } });
  assert.match(failure, /当前商品Schema核验失败/);
  assert.doesNotMatch(failure, /尚未取得当前商品的单次付费授权与服务连接/);
  const capture = renderInspector({ ...candidate, sourceCapture: { reason: "当前来源证据读取失败" } });
  assert.match(capture, /当前来源证据读取失败/);
  assert.doesNotMatch(capture, /尚未取得当前商品的单次付费授权与服务连接/);
  const c2 = c2Fixture();
  c2.candidate.lifecycleV11.c2UploadDraft = {
    candidateId: c2.candidate.id, sourceCandidateRevision: c2.candidate.dataRevision, revision: 3,
    uploads: c2.assets.map(asset => ({ ...asset, status: "ready" })),
    selection: c2.assets.map((asset, index) => ({ assetId: asset.assetId, slotId: asset.slotId, order: index + 1 }))
  };
  const c2Before = structuredClone(c2.candidate);
  const c2Html = renderC2(c2.candidate);
  assert.match(c2Html, /value="hero"[^>]*>主图 · 1–1<\/option>/);
  assert.match(c2Html, /value="side"[^>]*>详情图 · 1–2<\/option>/);
  assert.doesNotMatch(c2Html, /main_image|detail_image/);
  for (const label of ["上移", "下移", "移出清单"]) assert.ok(c2Html.includes(`>${label}</button>`));
  assert.match(c2Html, /<label class="c2-owner-confirmation"><input type="checkbox"[^>]*\/><span>我确认/);
  assert.deepEqual(c2.candidate, c2Before);
  c2.candidate.lifecycleV11.skuPackage.c2FinalAssets.mediaRequirements.imageSlots[1].role = "尺寸示意图";
  assert.match(renderC2(c2.candidate), /尺寸示意图/);
});

test("新增商品实际表单提交符合服务契约，尺寸不重复且未知运费不变零", async () => {
  const { candidateCreateInput } = await componentRenderer();
  const form = { targetStore: "miska", productUrl: "https://detail.1688.com/offer/990000000007.html",
    productName: "合成保存回读", sourceUrl: "", competitorUrl: "", imageUrl: "", materialsAndAge: "", notes: "合成资料",
    purchasePriceRmb: "28.50", moq: "", netWeightKg: "", packedWeightKg: "0.42", expectedPriceRub: "",
    acceptedTestRisk: false, powered: "unknown", length: "24", width: "18", height: "7" };
  const before = structuredClone(form);
  const input = candidateCreateInput(form);
  const saved = normalizeCandidateUserCreateInput(input);
  assert.equal(saved.targetStore, "miska");
  assert.equal(saved.purchasePriceRmb, 28.5);
  assert.equal(saved.domesticShippingRmb, null);
  assert.equal(saved.packedWeightKg, 0.42);
  assert.deepEqual(saved.dimensionsCm, { length: 24, width: 18, height: 7 });
  for (const field of ["length", "width", "height", "complianceStatus", "authorizationStatus"]) assert.equal(Object.hasOwn(input, field), false);
  assert.equal(saved.complianceStatus, "needs_confirmation");
  assert.equal(saved.authorizationStatus, "needs_confirmation");
  assert.deepEqual(form, before);
  const empty = normalizeCandidateUserCreateInput(candidateCreateInput({ ...form, purchasePriceRmb: "", packedWeightKg: "", length: "", width: "", height: "" }));
  assert.equal(empty.purchasePriceRmb, null);
  assert.deepEqual(empty.dimensionsCm, { length: null, width: null, height: null });
  for (const value of ["NaN", "12元", "-1"]) assert.throws(() => candidateCreateInput({ ...form, length: value }), /数字/);
  assert.throws(() => normalizeCandidateUserCreateInput(candidateCreateInput({ ...form, powered: "invalid" })), /powered/);
  assert.throws(() => normalizeCandidateUserCreateInput({ ...input, length: 24 }), /字段不允许/);
});

test("D1 clean刷新、dirty保留旧revision、换候选重置", () => {
  const record = {id:"A",dataRevision:1};
  const initial = {weight:"1"};
  const clean = newDraft(record,initial);
  assert.equal(receiveDraft(clean,record,{weight:"other"}),clean);
  assert.equal(receiveDraft(clean,{...record,dataRevision:2},{weight:"2"}).revision,2);
  const dirty={...clean,dirty:true,value:{weight:"12.5"}};
  assert.equal(receiveDraft(dirty,{...record,dataRevision:2},{weight:"2"}),dirty);
  assert.equal(dirty.revision,1);
  assert.deepEqual(receiveDraft(dirty,{id:"B",dataRevision:9},{weight:"9"}),newDraft({id:"B",dataRevision:9},{weight:"9"}));
});

test("D1/D6提交锁在等待和失败期间不受revision刷新影响", async () => {
  const run=createSubmitLock(), gate=deferred(); let calls=0;
  const first=run(async()=>{calls++; await gate.promise; throw new Error("422 field failure");});
  assert.equal(await run(()=>{calls++;}),undefined);
  assert.equal(calls,1); gate.resolve();
  await assert.rejects(first,/422/);
  assert.equal(await run(()=>++calls),2);
});

test("D5只发布最新读取，取消不冒充失败，真实错误上抛", async () => {
  const reader=createLatestRead(), old=deferred(), fresh=deferred(), published=[]; let oldSignal;
  const p1=reader.run(signal=>{oldSignal=signal;return old.promise;},v=>published.push(v));
  const p2=reader.run(()=>fresh.promise,v=>published.push(v));
  assert.equal(oldSignal.aborted,true);
  fresh.resolve("new");assert.equal(await p2,"new");old.resolve("old");assert.equal(await p1,null);
  assert.deepEqual(published,["new"]);
  const late=deferred(), pending=reader.run(()=>late.promise,v=>published.push(v));reader.cancel();late.resolve("cancelled");await pending;
  assert.deepEqual(published,["new"]);
  await assert.rejects(reader.run(()=>Promise.reject(new Error("offline")),()=>{}),/offline/);
  assert.equal(shouldContinuePolling({active:true,failed:false}),true);
  assert.equal(shouldContinuePolling({active:true,failed:true}),false);
  assert.equal(shouldContinuePolling({active:false,failed:false}),false);
});

test("D5保存晚响应不能导航回已离开的候选", () => {
  const guard=createSelectionGuard(), token=guard.capture();
  assert.equal(guard.isCurrent(token),true);guard.changed();assert.equal(guard.isCurrent(token),false);
  assert.equal(guard.isCurrent(guard.capture()),true);
});

test("permission reads survive polling and polling cleanup shares only their result", async () => {
  const reader = createLatestRead(), gate = deferred(), published = [];
  const owner = new AbortController(), poll = new AbortController();
  let requests = 0, permissionSignal;
  const permission = reader.run(signal => { requests++; permissionSignal = signal; return gate.promise; },
    value => published.push(value), { protect: true, signal: owner.signal });
  const polling = reader.run(() => { requests++; throw new Error("poll started a second request"); },
    () => { throw new Error("poll republished permission data"); }, { signal: poll.signal });
  assert.strictEqual(polling, permission);
  poll.abort();
  assert.equal(permissionSignal.aborted, false);
  gate.resolve({ permission: "current" });
  assert.deepEqual(await permission, { permission: "current" });
  assert.equal(requests, 1); assert.deepEqual(published, [{ permission: "current" }]);
  assert.equal(await reader.run(async () => "next poll", value => published.push(value)), "next poll");
});

test("new permission refresh replaces older work; an old cleanup cannot abort the new request", async () => {
  const reader = createLatestRead(), old = deferred(), fresh = deferred(), published = [];
  const oldOwner = new AbortController(), newOwner = new AbortController();
  let oldSignal, newSignal;
  const first = reader.run(signal => { oldSignal = signal; return old.promise; }, value => published.push(value),
    { protect: true, signal: oldOwner.signal });
  const second = reader.run(signal => { newSignal = signal; return fresh.promise; }, value => published.push(value),
    { protect: true, signal: newOwner.signal });
  assert.equal(oldSignal.aborted, true);
  oldOwner.abort(); assert.equal(newSignal.aborted, false);
  old.resolve("stale owner"); assert.equal(await first, null);
  assert.deepEqual(published, []);
  fresh.resolve("current owner"); assert.equal(await second, "current owner");
  assert.deepEqual(published, ["current owner"]);
  const late = deferred();
  const pending = reader.run(() => late.promise, value => published.push(value), { protect: true });
  reader.cancel(); late.resolve("unmounted owner"); assert.equal(await pending, null);
  assert.deepEqual(published, ["current owner"]);
});

test("protected permission failure reaches every waiter; only a locally cancelled read is cancellation", async () => {
  const reader = createLatestRead(), gate = deferred();
  const failure = new Error("permission endpoint offline");
  const first = reader.run(() => gate.promise, () => { throw new Error("failed request published"); }, { protect: true });
  const poll = reader.run(() => { throw new Error("second request"); }, () => {});
  const firstFailure = assert.rejects(first, error => error === failure);
  const pollFailure = assert.rejects(poll, error => error === failure);
  gate.reject(failure); await Promise.all([firstFailure, pollFailure]);
  const externalAbort = new DOMException("upstream aborted independently", "AbortError");
  await assert.rejects(reader.run(async () => { throw externalAbort; }, () => {}, { protect: true }), error => error === externalAbort);
  const owner = new AbortController(), delayed = deferred();
  const last = reader.run(() => delayed.promise, () => { throw new Error("cancelled request published"); }, { protect: true, signal: owner.signal });
  owner.abort(); delayed.reject(externalAbort); assert.equal(await last, null);
});

test("D3排序不依赖输入方向且满足传递性，firstInQueue遵守当前队列", () => {
  const candidates=[
    {id:"D",workflowStatus:"awaiting_data",source:"user",updatedAt:"2026-09-03"},
    {id:"C",workflowStatus:"codex_processing",source:"codex",updatedAt:"2026-09-02"},
    {id:"B",workflowStatus:"codex_processing",source:"user",updatedAt:"invalid"},
    {id:"A",workflowStatus:"codex_processing",source:"user",updatedAt:"invalid"}
  ];
  const expected=["A","B","C","D"];
  const permutations=list=>list.length?list.flatMap((item,i)=>permutations(list.filter((_,j)=>i!==j)).map(rest=>[item,...rest])):[[]];
  for(const permutation of permutations(candidates)) assert.deepEqual(orderCandidates(permutation).map(c=>c.id),expected);
  for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) {
    const a=candidates.find(c=>c.id===expected[i]),b=candidates.find(c=>c.id===expected[j]);
    assert.deepEqual(orderCandidates([b,a]),[a,b]);
  }
  assert.equal(firstInQueue(candidates,"codex_processing","user","A").id,"B");
  assert.equal(firstInQueue(candidates,"awaiting_data","codex"),undefined);
});

test("D7数值、URL和平台店铺无静默兜底", () => {
  for(const value of ["12,5","12元",NaN,Infinity,-1,"-2"," "]) assert.throws(()=>optionalNumber(value),/数字/);
  assert.equal(optionalNumber("0"),0);assert.equal(optionalNumber("12.5"),12.5);assert.equal(optionalNumber(""),null);
  for(const value of ["javascript:alert(1)","data:image/png;base64,xx","file:///tmp/x","https://u:p@example.com/a","//evil.test/a"]) assert.equal(safeWebUrl(value),"");
  assert.equal(safeImageUrl("/product-images/candidate/photo.png"),"/product-images/candidate/photo.png");
  for(const value of ["/product-images/../secret","/product-images/%2e%2e/secret","/product-images/a\\b","/product-images//a","/product-images/\t../other"]) assert.equal(safeImageUrl(value),"");
  assert.equal(candidatePlatform({targetStore:"wb"}),"wb");
  assert.throws(()=>candidatePlatform({targetStore:"other"}),/不一致/);
  assert.throws(()=>candidatePlatform({targetStore:"wb",lifecycleV11:{skuPackage:{g1Identity:{platform:"ozon"}}}}),/不一致/);
});

test("C5 显示数值只接受真实有限number：null不变0，合法正负和0可见", () => {
  for (const value of [null, undefined, "", "0", "12.5", false, {}, NaN, Infinity, -Infinity]) {
    assert.equal(finiteDisplayNumber(value), null);
    assert.equal(formatMoney(value), "未取得");
    assert.equal(formatPercent(value), "未取得");
  }
  assert.equal(finiteDisplayNumber(0), 0);
  assert.equal(formatMoney(0), "¥0.00");
  assert.equal(formatPercent(0), "0.0%");
  assert.equal(formatMoney(12.5), "¥12.50");
  assert.equal(formatPercent(0.125, 2), "12.50%");
  assert.equal(formatMoney(-2), "¥-2.00");
  assert.equal(formatPercent(-0.125, 2), "-12.50%");
});

test("A9 留言只提交当前修订和允许字段，不在浏览器声称actor或请求派发", () => {
  const candidate = { id: "candidate:comment", dataRevision: 9 };
  const before = structuredClone(candidate);
  assert.deepEqual(buildCandidateCommentInput(candidate, "  留言  "), {
    candidateId: "candidate:comment", dataRevision: 9, message: "留言", category: "general"
  });
  assert.deepEqual(buildCandidateCommentInput(candidate, "淘汰原因", "elimination_feedback", "comment:parent"), {
    candidateId: "candidate:comment", dataRevision: 9, message: "淘汰原因", category: "elimination_feedback", replyTo: "comment:parent"
  });
  assert.deepEqual(candidate, before);
  for (const [value, category, replyTo] of [["", "general", null], ["ok", "other", null], ["ok", "general", ""]]) {
    assert.throws(() => buildCandidateCommentInput(candidate, value, category, replyTo));
  }
  for (const invalid of [{ id: "candidate:comment", dataRevision: "9" }, { id: "", dataRevision: 9 }]) {
    assert.throws(() => buildCandidateCommentInput(invalid, "ok"), /身份或修订/);
  }
  const payload = buildCandidateCommentInput(candidate, "ok");
  for (const forbidden of ["actor", "requestReview", "confirmedAt", "ownerConfirmation"]) assert.equal(Object.hasOwn(payload, forbidden), false);
  const receipt = { comment: { id: "comment:1", message: "ok", category: "general", actor: "server-owned" }, candidate: { id: candidate.id, dataRevision: 10 } };
  assert.equal(validateCandidateCommentReceipt(payload, receipt), receipt);
  for (const mutate of [
    value => { delete value.comment; }, value => { value.candidate.id = "other"; },
    value => { value.candidate.dataRevision = 9; }, value => { value.comment.message = "other"; }, value => { value.comment.category = "elimination_feedback"; }
  ]) {
    const invalid = structuredClone(receipt); mutate(invalid);
    assert.throws(() => validateCandidateCommentReceipt(payload, invalid), /回执不完整/);
  }
  assert.equal(shouldClearSubmittedComment("ok", "ok"), true);
  assert.equal(shouldClearSubmittedComment("edited while pending", "ok"), false);
});

test("D6 API保留signal、revision与422详情，非法JSON或null错误体不伪成功", async t => {
  const calls=[];let response={ok:true,status:200,json:async()=>({candidates:[]})};
  t.mock.method(globalThis,"fetch",async(...args)=>{calls.push(args);return response;});
  const controller=new AbortController();await api.getState(controller.signal);assert.equal(calls[0][1].signal,controller.signal);
  await api.confirmRealAStage("id/a",{dataRevision:7,decision:"confirm"});
  assert.match(calls[1][0],/id%2Fa/);assert.equal(JSON.parse(calls[1][1].body).dataRevision,7);
  await api.addComment("id/a", { dataRevision: 7, message: "note", category: "general" });
  assert.match(calls[2][0], /id%2Fa\/comments$/);
  assert.deepEqual(JSON.parse(calls[2][1].body), { dataRevision: 7, message: "note", category: "general" });
  response={ok:false,status:422,json:async()=>({message:"required",errors:["weight"],evidencePreparation:{status:"missing"}})};
  await assert.rejects(api.getState(),error=>error.status===422 && /weight/.test(errorMessage(error)) && /missing/.test(errorMessage(error)));
  response={ok:false,status:409,json:async()=>null};await assert.rejects(api.getState(),error=>error.status===409);
  response={ok:true,status:200,json:async()=>{throw new SyntaxError("bad json");}};
  await assert.rejects(api.getState(),/无效JSON/);
  await assert.rejects(api.uploadLifecycleFinalAsset("A",{dataRevision:7,file:{name:"a.jpg",type:"image/jpeg"}}),/无效JSON/);
});

function aFixture() {
  const card={sourceCandidateId:"A",sourceDataRevision:3,targetPlatform:"ozon",targetStore:"store:one",storeRef:{stableStoreId:"store:one",platformStoreId:"seller:one",mappingVersion:"v1"},supplierCapture:{sourceMode:"provider_api_read_only",sourceUrl:"https://detail.1688.com/offer/1.html",captureId:"capture:A",status:"captured_waiting_owner_selection",skuChoices:[{sourceSkuId:"sku:A",variantKey:"white",priceCny:12,minimumOrderQuantity:1}]}};
  const form=selectAConfirmationSku({salesReview:{snapshotId:"sales:A",comparability:"exact_match",validityStatus:"current",confidence:"confirmed"},supplierConfirmation:{productUrl:"https://detail.1688.com/offer/1.html",unitDomesticFreight:"0",otherPurchaseCosts:"0",actualPurchaseCost:"12",weightKg:"0.5",dimensionsCm:{length:"1",width:"2",height:"3"}}},card,"sku:A");
  Object.assign(form.supplierConfirmation,{unitDomesticFreight:"0",otherPurchaseCosts:"0",actualPurchaseCost:"12",weightKg:"0.5",dimensionsCm:{length:"1",width:"2",height:"3"}});
  form.supplierConfirmation.ownerSupplyConfirmed=true;form.supplierConfirmation.matchType="exact_match";
  return {card,form};
}

test("D2/D6 A只回传明确选择和输入，不伪造证据与确认身份", () => {
  const {card,form}=aFixture();form.supplierConfirmation.fieldEvidence={fake:true};form.supplierConfirmation.actorId="fake";
  const input=buildAConfirmationInput(card,form,"confirm",3);
  assert.equal(input.supplierConfirmation.unitDomesticFreight,0);assert.equal(input.dataRevision,3);assert.deepEqual(input.storeRef,card.storeRef);
  for(const key of ["fieldEvidence","actorId","confirmedAt","ownerSupplyConfirmation","complianceStatus","authorizationStatus"]) assert.equal(Object.hasOwn(input.supplierConfirmation,key),false);
  for(const [mutate, reason] of [
    [v=>v.form.supplierConfirmation.variantKey="other",/与当前采集不一致/],
    [v=>v.form.supplierConfirmation.unitProductPrice="1",/与当前采集不一致/],
    [v=>v.form.supplierConfirmation.minimumOrderQuantity="2",/与当前采集不一致/],
    [v=>v.form.supplierConfirmation.ownerSupplyConfirmed=false,/明确确认精确同款/],
    [v=>v.form.supplierConfirmation.matchType="near_match",/明确确认精确同款/],
    [v=>v.card.supplierCapture.skuChoices.push(structuredClone(v.card.supplierCapture.skuChoices[0])),/与当前采集不一致/]
  ]) {const value=aFixture();mutate(value);assert.throws(()=>buildAConfirmationInput(value.card,value.form,"confirm",3),reason);}
  assert.throws(()=>buildAConfirmationInput(card,form,"confirm",4),/修订/);
});

function c2Fixture() {
  const candidate={id:"A",dataRevision:8,lifecycleV11:{skuPackage:{c2FinalAssets:{mediaRequirements:{imageSlots:[{slotId:"hero",role:"main_image",mediaType:"image",minCount:1,maxCount:1},{slotId:"side",role:"detail_image",mediaType:"image",minCount:1,maxCount:2}],videoSlots:[],schemaVideoRequirement:{status:"not_required"}}}}}};
  const assets=["hero","side"].map((slotId,i)=>({assetId:`asset:${i}`,slotId,mediaType:"image",fileName:`${i}.jpg`,assetRef:`/staged/${i}.jpg`,assetVersion:"v1",sha256:String(i).repeat(64),byteSize:2,width:2,height:3,sourceEvidenceRef:`upload:${i}`,sourceType:"owner_provided_final_upload",stagedAt:"2026-09-03T01:00:00Z"}));
  candidate.lifecycleV11.skuPackage.c2FinalAssets.mediaRequirements.contentRules = syntheticContentRules([{slotId:"hero",mediaType:"image"},{slotId:"side",mediaType:"image"}]);
  return {candidate,assets,sourceRevision:8,draftRevision:3,ownerChecked:true};
}

test("D4 C2从Schema明确映射槽位，排序不能自动改角色，素材确认零授权", () => {
  const fixture=c2Fixture(), before=structuredClone(fixture);
  const input=buildC2FinalAssetInput(fixture);
  assert.deepEqual(fixture,before);assert.deepEqual(input.approvedAssetIds,["asset:0","asset:1"]);
  assert.equal(input.approvedMainImageAssetId,"asset:0");assert.equal(input.approvedVideoDisposition,"excludes_video");
  assert.deepEqual(input.finalUploadAssets, [{ assetId: "asset:0", slotId: "hero", order: 1 }, { assetId: "asset:1", slotId: "side", order: 2 }]);
  assert.equal(input.draftRevision, 3);
  assert.equal(Object.hasOwn(input.finalUploadAssets[0], "assetRef"), false, "文件位置和证据必须由服务端已保存登记取得");
  assert.equal(Object.hasOwn(input,"productionAuthorization"),false);assert.equal(Object.hasOwn(input,"ownerConfirmation"),false);
  for(const [change, reason] of [[v=>v.assets.reverse(),/首图/],[v=>delete v.assets[0].slotId,/槽位/],[v=>v.ownerChecked=false,/明确确认/],[v=>v.sourceRevision=7,/修订/],[v=>v.assets.push(v.assets[0]),/重复/]]) {
    const v=c2Fixture();change(v);assert.throws(()=>buildC2FinalAssetInput(v),reason);
  }
});

test("D4 条件视频、未选槽位及数量边界不能绕过", () => {
  for (const ownerRequired of [false, true]) {
    const fixture = c2Fixture();
    const c2 = fixture.candidate.lifecycleV11.skuPackage.c2FinalAssets;
    if (ownerRequired) c2.ownerVideoRequirement = { required: true };
    else c2.mediaRequirements.schemaVideoRequirement.status = "required";
    assert.throws(() => buildC2FinalAssetInput(fixture), /缺少视频/);
    c2.mediaRequirements.videoSlots.push({ slotId: "demo", role: "video", mediaType: "video", minCount: 0, maxCount: 1 });
    fixture.assets.push({ ...fixture.assets[0], assetId: "video:1", slotId: "demo", mediaType: "video", fileName: "demo.mp4" });
    c2.mediaRequirements.contentRules.slotRules.push(...syntheticContentRules([{slotId:"demo",mediaType:"video"}]).slotRules);
    const input = buildC2FinalAssetInput(fixture);
    assert.equal(input.approvedVideoDisposition, "includes_video");
    assert.equal(input.finalUploadAssets[2].order, 3);
    assert.equal(Object.hasOwn(input, "productionAuthorization"), false);
  }
  for (const change of [
    slots => slots.push({ slotId: "missing", role: "detail_image", mediaType: "image" }),
    slots => slots.push({ ...slots[0] }),
    slots => { slots[1].minCount = -1; },
    slots => { slots[1].maxCount = 0; }
  ]) {
    const fixture = c2Fixture(); change(fixture.candidate.lifecycleV11.skuPackage.c2FinalAssets.mediaRequirements.imageSlots);
    assert.throws(() => buildC2FinalAssetInput(fixture), /完整数量边界/);
  }
  const missing = c2Fixture(); missing.assets.pop();
  assert.throws(() => buildC2FinalAssetInput(missing), /槽位 side 需要/);
  const excess = c2Fixture(); excess.assets.push(...[2, 3].map(i => ({ ...excess.assets[1], assetId: `extra:${i}` })));
  assert.throws(() => buildC2FinalAssetInput(excess), /槽位 side 需要/);
});

test("生产确认只读取服务端当前准备资料，旧决定和不完整默认值不能解锁", () => {
  const card = { cardId: "card:test", cardRevision: 1, status: "awaiting_owner_business_confirmation", ownerDecision: null };
  const source = { dataRevision: 8, skuRevision: 5, cardId: card.cardId, cardRevision: 1,
    sourcePreparationFingerprint: "a".repeat(64), sourceFinalCardInputFingerprint: "b".repeat(64) };
  const candidate = { id: "candidate:test", dataRevision: 8, lifecycleV11: { skuPackage: { dataRevision: 5,
    c2FinalAssets: { productionAuthorizationPreparation: { preparationFingerprint: source.sourcePreparationFingerprint, finalCardInputFingerprint: source.sourceFinalCardInputFingerprint } } } },
    productionOwnerPreparation: { contractVersion: "production-authorization-v1.2", ready: true, gaps: [], source,
      store: { displayName: "蛋蛋鼠店铺" }, executionBindings: [{ bindingId: "binding:test", configurationVersion: "config:1", warehouseName: "已核验仓库" }],
      scope: { stock: 100, buyerTargetPrice: { amount: 500, currency: "RUB" }, platformWritePrice: { amount: 40, currency: "CNY" },
        priceConversion: { rubPerCny: 12.5, evidenceRef: "exchange:test", checkedAt: "2026-09-03T00:00:00Z" },
        publishScope: "create_draft_only", allowedWriteFields: ["title"], exclusions: ["publish"] } } };
  const before = structuredClone({ candidate, card });
  const result = productionAuthorizationInputFromCard(candidate, card);
  assert.equal(result.ready, true);
  assert.deepEqual(result.input, { contractVersion: "production-authorization-v1.2", ...source });
  for (const key of ["ownerConfirmation", "platformWritePrice", "credentialAlias", "warehouseRef", "productionAuthorization", "confirmExactScope"]) assert.equal(Object.hasOwn(result.input, key), false);
  assert.deepEqual({ candidate, card }, before);
  for (const change of [v => { v.card.cardId = "other"; }, v => { v.candidate.dataRevision++; },
    v => { delete v.card.cardRevision; }, v => { v.card.status = "owner_business_approved"; v.card.ownerDecision = { ownerConfirmation: { schemaVersion: "production-owner-confirmation-v1" } }; },
    v => { v.candidate.productionOwnerPreparation.source.sourcePreparationFingerprint = "e".repeat(64); },
    v => { v.candidate.productionOwnerPreparation.scope.platformWritePrice.currency = "RUB"; },
    v => { v.candidate.productionOwnerPreparation.scope.stock = -1; },
    v => { v.candidate.productionOwnerPreparation.executionBindings = []; }, v => { delete v.candidate.productionOwnerPreparation; }]) {
    const value = structuredClone(before); change(value);
    const rejected = productionAuthorizationInputFromCard(value.candidate, value.card);
    assert.equal(rejected.ready, false); assert.equal(rejected.input, null); assert.ok(rejected.reason);
  }
  candidate.productionOwnerPreparation.ready = false;
  candidate.productionOwnerPreparation.gaps = [{ code: "configuration_missing", message: "当前店铺尚未配置已核验仓库" }];
  assert.equal(productionAuthorizationInputFromCard(candidate, card).reason, "当前店铺尚未配置已核验仓库");
});

test("缺少当前准备DTO或只有旧主人确认时不能用B建议或truthy属性解锁", () => {
  const candidate = c2Fixture().candidate;
  for (const card of [null, { ownerDecision: null }, { productionAuthorizationInput: {} }, { ownerDecision: { ownerConfirmation: {} } }]) {
    const result = productionAuthorizationInputFromCard(candidate, card); assert.equal(result.ready, false); assert.equal(result.input, null);
  }
});

test("扩展heartbeat或页面桥接不能冒充后台认证可用", () => {
  for(const options of [{liveVersion:EXPECTED_EXTENSION_VERSION,backgroundReady:true},{serverHeartbeat:{version:EXPECTED_EXTENSION_VERSION,fresh:true,backgroundReady:true}}]) {
    const result=extensionConnectionStatus(options);assert.equal(result.code,"authentication_unverified");assert.match(result.label,/不可用/);
  }
});


test('switching browser SKU clears owner evidence and never borrows another SKU price', () => {
  const { card, form } = aFixture();
  card.supplierCapture.sourceMode = 'chrome_extension_structured_page_v1';
  card.supplierCapture.quantityOneEvidenceRequired = true;
  card.supplierCapture.skuChoices.push({ sourceSkuId: 'sku:unknown-price', variantKey: 'ivory', priceCny: null, minimumOrderQuantity: null });
  form.supplierConfirmation.quantityOneEvidenceSourceNote = 'old SKU owner evidence';
  const before = structuredClone(form);
  const selected = selectAConfirmationSku(form, card, 'sku:unknown-price');
  assert.deepEqual(form, before);
  assert.equal(selected.supplierConfirmation.unitProductPrice, '');
  assert.equal(selected.supplierConfirmation.minimumOrderQuantity, '');
  assert.equal(selected.supplierConfirmation.variantKey, 'ivory');
  assert.equal(selected.supplierConfirmation.matchType, 'unknown');
  assert.equal(selected.supplierConfirmation.ownerSupplyConfirmed, false);
  for (const field of ['quantityOneEvidenceSourceNote', 'unitDomesticFreight', 'otherPurchaseCosts', 'actualPurchaseCost', 'weightKg']) {
    assert.equal(selected.supplierConfirmation[field], '', field);
  }
  assert.deepEqual(selected.supplierConfirmation.dimensionsCm, { length: '', width: '', height: '' });
  assert.throws(() => buildAConfirmationInput(card, selected, 'confirm', 3));
  selected.supplierConfirmation.unitProductPrice = 'invalid old text';
  selected.supplierConfirmation.minimumOrderQuantity = 'invalid';
  selected.supplierConfirmation.quantityOneEvidenceSourceNote = 'invalid\u0000note';
  const rejected = buildAConfirmationInput(card, selected, 'reject', 3);
  assert.equal(rejected.decision, 'reject');
  assert.equal(rejected.supplierConfirmation.unitProductPrice, null);
  assert.equal(rejected.supplierConfirmation.minimumOrderQuantity, null);
});


test("A卡区分技术证据与完整成本，旧卡及成本缺口不放行正式B且不阻淘汰或前置采集", async () => {
  const { renderRealA } = await componentRenderer();
  const { candidate, addEvidenceContext } = await import('./fixtures/real-a-b-flow-fixture.mjs');
  const { buildRealAConfirmationCard } = await import('../lib/real-a-confirmation-card.mjs');
  const card = structuredClone(buildRealAConfirmationCard(addEvidenceContext(await candidate())));
  card.systemEvidenceReadiness = { ready: true, fields: [], missing: [] };
  card.supplierCapture = { status: 'captured_waiting_owner_selection', skuChoices: [] };
  const button = (html, kind) => html.match(new RegExp(`<button class="button ${kind}"[^>]*>`))[0];
  for (const readiness of [undefined, { ready: false, missing: ['标签费用尚未明确', '税费适用性尚未明确'], code: 'B_COST_POLICY_INCOMPLETE' }]) {
    const value = structuredClone(card);
    if (readiness) value.costPolicyReadiness = readiness;
    const before = structuredClone(value), html = renderRealA(value);
    assert.match(html, /技术证据已齐/);
    assert.match(html, /正式成本尚未就绪/);
    assert.doesNotMatch(html, /可直接进入B/);
    assert.match(button(html, 'primary'), /disabled/);
    assert.doesNotMatch(button(html, 'secondary'), /disabled/);
    assert.match(html, readiness ? /标签费用尚未明确.*税费适用性尚未明确/ : /当前成本策略尚未验证/);
    assert.deepEqual(value, before);
    value.supplierCapture = { status: 'not_requested', skuChoices: [] };
    assert.doesNotMatch(button(renderRealA(value), 'primary'), /disabled/);
  }
  card.costPolicyReadiness = { ready: true, missing: [], code: null };
  assert.match(renderRealA(card), /完整成本策略已就绪/);
  assert.doesNotMatch(button(renderRealA(card), 'primary'), /disabled/);
});
