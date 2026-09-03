import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("C2界面只在新版等待态提供本地素材排序与一次主人确认", async () => {
  const inspector = await readFile(path.join(appDir, "src", "components", "UserInspector.jsx"), "utf8");
  assert.match(inspector, /c2Assets\.softwareState/);
  assert.match(inspector, /type="file" multiple/);
  assert.match(inspector, /\.jpg,\.jpeg,\.png,\.webp,\.mp4/);
  assert.match(inspector, /上移/);
  assert.match(inspector, /下移/);
  assert.match(inspector, /我确认以上文件属于当前SKU，并确认首图和顺序/);
  assert.match(inspector, /确认最终素材并生成方案卡/);
  assert.match(inspector, /不创建生产授权、不派发任务、不访问或写入店铺/);
  assert.match(inspector, /index === 0 \? "main_image"/);
  assert.match(inspector, /assets\[0\]\?\.mediaType === "image"/);
});

test("C2素材上传和最终确认使用分离接口，选择文件不会直接确认", async () => {
  const api = await readFile(path.join(appDir, "src", "api.js"), "utf8");
  const app = await readFile(path.join(appDir, "src", "App.jsx"), "utf8");
  assert.match(api, /lifecycle\/c2\/final-assets\/upload\?dataRevision=/);
  assert.match(api, /confirmLifecycleFinalAssets/);
  assert.match(app, /uploadLifecycleFinalAsset/);
  assert.match(app, /confirmLifecycleFinalAssets/);
  assert.match(app, /尚未生产授权，也没有店铺写入/);
});
