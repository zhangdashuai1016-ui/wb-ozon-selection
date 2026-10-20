import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

let page;
async function home() {
  if (!page) {
    const entry = fileURLToPath(new URL("./selection-home-ui-entry.jsx", import.meta.url));
    const component = fileURLToPath(new URL("../src/components/SelectionHome.jsx", import.meta.url));
    const eliminate = fileURLToPath(new URL("../src/components/EliminateControl.jsx", import.meta.url));
    const output = await build({ configFile: false, logLevel: "warn", plugins: [react(), {
      name: "selection-home-ui-test", resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
        import Home from ${JSON.stringify(component)};import Eliminate from ${JSON.stringify(eliminate)};
        export const render=props=>renderToStaticMarkup(<Home {...props}/>);
        function expand(value,result=[]){
          if(Array.isArray(value)){for(const child of value)expand(child,result);return result;}
          if(!React.isValidElement(value))return result;
          result.push(value);
          if(typeof value.type==='function'&&value.type!==Eliminate)expand(value.type(value.props),result);
          else expand(value.props.children,result);
          return result;
        }
        export const elements=props=>expand(<Home {...props}/>);
        export const isEliminate=element=>element.type===Eliminate;` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false,
      rollupOptions: { input: entry, output: { format: "es" } } } });
    const chunk = output.output.find(value => value.type === "chunk" && value.isEntry);
    assert.ok(chunk);
    page = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  }
  return page;
}

const forbidden = () => { throw new Error("HOME_MUST_NOT_START_WORK"); };
const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: "miska", dataRevision: 4,
  workflowStatus: "listing_preparation", displayStatus: "listing_preparation", needsFromUser: [],
  executionRuntime: { businessPhase: "C1", status: "running" },
  imageUrl: "https://ir.ozone.ru/s3/synthetic/home.jpg", updatedAt: "2026-09-11T06:00:00.000Z", ...extra });
const props = (candidates = [], extra = {}) => ({ candidates, store: "miska", storeLine: "Ozon · Miska", ownerReady: true,
  onOpenCandidate: forbidden, onEliminateCandidate: forbidden, onOpenIntake: forbidden,
  onOpenSeerfar: forbidden, onOpenInbox: forbidden, onOpenBoard: forbidden, ...extra });
const buttonText = element => typeof element.props.children === "string" ? element.props.children : null;

test("未登录时首页不展示商品、计数或业务操作", async () => {
  const html = (await home()).render(props([candidate("private")], { ownerReady: false }));
  assert.match(html, /请先登录后查看选品台/u);
  assert.doesNotMatch(html, /合成商品|我选的商品|找一轮新品|添加商品|eliminate-button/u);
});

test("首页按原稿呈现商品行、待处理和右栏，严格隔离本店与已淘汰记录", async () => {
  const input = props([candidate("mine"), candidate("other", { targetStore: "dandanshu" }),
    candidate("gone", { workflowStatus: "eliminated" })]);
  const before = structuredClone(input.candidates);
  const html = (await home()).render(input);
  for (const text of ["我选的商品（1）", "待你处理（0）", "本店汇总与下一轮", "进行中", "下一轮方向", "Ozon · Miska"]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<li class="selection-home-row" data-testid="selection-home-product"/u);
  assert.doesNotMatch(html, /合成商品 other|合成商品 gone|textarea|开始找同款|预计扣|确认，开始/u);
  assert.deepEqual(input.candidates, before);
});

test("待处理直接使用现有原因与下一步，不把未确认结果变成利润通过", async () => {
  const html = (await home()).render(props([candidate("waiting", { productName: "合成待补最终素材",
    needsFromUser: ["请确认最终素材"], executionRuntime: { businessPhase: "C2", status: "waiting_owner" } })]));
  assert.match(html, /待你处理（1）/u);
  assert.match(html, /请确认最终素材/u);
  assert.match(html, /准备中 · 等你决定/u);
  assert.match(html, /需要你处理（1）/u);
  assert.doesNotMatch(html, /利润通过|单件利润 ¥|默认利润|可直接上架/u);
});

test("三色同阶段只占一行，统计仍是三个SKU，淘汰逐个绑定原id与revision", async () => {
  const choices = ["卡其", "黑色", "CP"].map((colour, index) => ({ sourceSkuId: String(index + 1), attributes: { 颜色: colour } }));
  const candidates = [candidate("vest", { productName: "合成三色背心", dataRevision: 8,
    sourceCapture: { selectedSkuIds: ["1"], skuChoices: choices } }),
    candidate("black", { dataRevision: 9, siblingSourceV1: { parentCandidateId: "vest", supplierSkuId: "2" }, sourceCapture: { skuChoices: choices } }),
    candidate("cp", { dataRevision: 10, siblingSourceV1: { parentCandidateId: "vest", supplierSkuId: "3" }, sourceCapture: { skuChoices: choices } })];
  const input = props(candidates);
  const renderer = await home();
  const html = renderer.render(input);
  assert.match(html, /我选的商品（1）/u);
  assert.equal((html.match(/data-testid="selection-home-product"/gu) ?? []).length, 1);
  assert.match(html, /<span>准备中<\/span><b>3<\/b>/u);
  assert.match(html, /aria-label="合成三色背心 的颜色"/u);
  const controls = renderer.elements(input).filter(renderer.isEliminate);
  assert.deepEqual(controls.map(({ props: item }) => ({ id: item.id, dataRevision: item.dataRevision, label: item.label })), [
    { id: "vest", dataRevision: 8, label: "淘汰「卡其」" },
    { id: "black", dataRevision: 9, label: "淘汰「黑色」" },
    { id: "cp", dataRevision: 10, label: "淘汰「CP」" }
  ]);
  for (const control of controls) assert.equal(control.props.onEliminate, input.onEliminateCandidate);
});

test("同款跨阶段保留原选择器的两行和elsewhere说明，不按family丢掉一行", async () => {
  const input = props([candidate("vest", { productName: "合成跨阶段背心" }),
    candidate("black", { siblingSourceV1: { parentCandidateId: "vest", supplierSkuId: "2" },
      executionRuntime: { businessPhase: "D", status: "queued" } })]);
  const html = (await home()).render(input);
  assert.match(html, /我选的商品（2）/u);
  assert.equal((html.match(/data-testid="selection-home-product"/gu) ?? []).length, 2);
  assert.match(html, /同一件货另有颜色在：待上架 1 个/u);
  assert.match(html, /同一件货另有颜色在：准备中 1 个/u);
});

test("缺少当前revision时淘汰禁用，不能改用其他颜色或新读到的版本", async () => {
  const renderer = await home();
  const input = props([candidate("missing", { dataRevision: null })]);
  const controls = renderer.elements(input).filter(renderer.isEliminate);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].props.id, "missing");
  assert.equal(controls[0].props.dataRevision, null);
  assert.equal(controls[0].props.disabled, true);
  assert.match(renderer.render(input), /eliminate-button" disabled=""/u);
});

test("点查看、颜色和下一轮只交给现有导航，不调用淘汰或启动作业", async () => {
  const calls = [];
  const input = props([candidate("mine"), candidate("black", {
    siblingSourceV1: { parentCandidateId: "mine", supplierSkuId: "black-sku" },
    sourceCapture: { skuChoices: [{ sourceSkuId: "black-sku", attributes: { 颜色: "黑色" } }] }
  })], { onOpenCandidate: id => calls.push(["open", id]),
    onOpenIntake: () => calls.push(["intake"]), onOpenSeerfar: () => calls.push(["seerfar"]),
    onOpenInbox: () => calls.push(["inbox"]), onOpenBoard: () => calls.push(["board"]) });
  const elements = (await home()).elements(input);
  for (const label of ["查看商品", "黑色", "＋ 添加商品", "找一轮新品", "打开需要你处理", "打开进行中"]) {
    const button = elements.find(element => element.type === "button" && buttonText(element) === label);
    assert.ok(button, label);
    await button.props.onClick();
  }
  assert.deepEqual(calls, [["open", "mine"], ["open", "black"], ["intake"], ["seerfar"], ["inbox"], ["board"]]);
});

test("队列或查询读取失败明确可见，已保存商品仍可查看", async () => {
  const html = (await home()).render(props([candidate("saved")], {
    intakeError: "合成队列版本冲突", discoveryError: "合成查询拒绝访问" }));
  assert.match(html, /role="alert"[^>]*>找货队列读取失败：合成队列版本冲突/u);
  assert.match(html, /role="alert"[^>]*>查询记录读取失败：合成查询拒绝访问/u);
  assert.match(html, /合成商品 saved/u);
  assert.doesNotMatch(html, /队列是空的|查询没有结果/u);
});

test("App独立首页和录入，档案回到录入，首页无请求或自动执行依赖", async () => {
  const component = await readFile(new URL("../src/components/SelectionHome.jsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(component, /boardColumns\(candidates, store, \{ discoveryView, intakeQueue \}\)/u);
  assert.match(component, /inboxRows\(attention\)/u);
  assert.doesNotMatch(component, /\b(?:useEffect|api|requestSupplierCaptureStart|startQueuedSupplierCapture|createIntakeJobBridge)\b/u);
  assert.match(app, /view === "desk" \? \(\s*<SelectionHome /u);
  assert.match(app, /view === "intake" \? \(\s*<IntakePage /u);
  assert.match(app, /intakeShownOnPage=\{view === "intake"\}/u);
  assert.match(app, /setView\("intake"\)\}>看或改店铺档案/u);
  const homeWiring = app.slice(app.indexOf("<SelectionHome "), app.indexOf(') : view === "intake"'));
  assert.doesNotMatch(homeWiring, /api\.|startSeerfarRound|mutateProductDiscovery/u);
  assert.match(homeWiring, /onOpenSeerfar=\{\(\) => setView\("seerfar"\)\}/u);
});
