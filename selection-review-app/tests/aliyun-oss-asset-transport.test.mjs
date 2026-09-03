import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ALIYUN_OSS_KEYCHAIN_SERVICE,
  ALIYUN_OSS_PUBLIC_CONFIG,
  buildAliyunOssFinalAssetObjectKey,
  createAliyunOssClient,
  inspectAliyunOssAssetTransportConfiguration,
  uploadAliyunOssFinalAssets
} from "../lib/aliyun-oss-asset-transport.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("三店OSS公开配置使用独立前缀，配置检查不返回密钥", async () => {
  assert.equal(ALIYUN_OSS_PUBLIC_CONFIG.bucket, "ozon-img-staging-cn-20260630-a7k3");
  assert.equal(ALIYUN_OSS_PUBLIC_CONFIG.objectPrefix, "wb-ozon-selection/final-assets/");
  assert.equal(ALIYUN_OSS_KEYCHAIN_SERVICE, "com.shuaizhang.wb-ozon-selection.aliyun-oss");
  const status = await inspectAliyunOssAssetTransportConfiguration({ readSecret: async () => "configured-secret" });
  assert.equal(status.status, "configured_unverified");
  assert.equal(status.realUploadVerified, false);
  assert.equal(JSON.stringify(status).includes("configured-secret"), false);
  assert.equal("accessKeyId" in status, false);
  assert.equal("accessKeySecret" in status, false);
});

test("OSS客户端从钥匙串读取两项秘密但不改变公开配置", async () => {
  const accounts = [];
  class FakeClient {
    constructor(config) { this.config = config; }
  }
  const client = await createAliyunOssClient({
    readSecret: async (account) => { accounts.push(account); return `secret-for-${account}`; },
    Client: FakeClient
  });
  assert.deepEqual(accounts, ["access-key-id", "access-key-secret"]);
  assert.equal(client.config.bucket, ALIYUN_OSS_PUBLIC_CONFIG.bucket);
  assert.equal(client.config.endpoint, ALIYUN_OSS_PUBLIC_CONFIG.endpoint);
  assert.equal(client.config.authorizationV4, true);
});

test("对象键锁定项目、候选、SKU、revision、顺序和SHA", () => {
  const key = buildAliyunOssFinalAssetObjectKey({
    candidateId: "CX-TEST-001",
    skuPackageId: "sku:lifecycle:001",
    dataRevision: 9,
    asset: {
      assetId: "final-main",
      assetRef: "/owner/main.png",
      sha256: "a".repeat(64),
      order: 1,
      lifecycleArea: "finalUploads",
      ownerConfirmed: true,
      productionEligible: true
    }
  });
  assert.equal(key, "wb-ozon-selection/final-assets/CX-TEST-001/sku-lifecycle-001/revision-9/01-final-main-aaaaaaaaaaaaaaaa.png");
  assert.throws(() => buildAliyunOssFinalAssetObjectKey({ candidateId: "x", skuPackageId: "y", dataRevision: 1, asset: {} }), /OSS_ASSET_NOT_AUTHORIZED/);
});

test("上传只处理主人确认素材，校验SHA并以公开HEAD 200形成能力证据", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oss-assets-"));
  const firstBody = Buffer.from("first-image");
  const secondBody = Buffer.from("second-image");
  const firstPath = path.join(directory, "main.png");
  const secondPath = path.join(directory, "detail.jpg");
  await writeFile(firstPath, firstBody);
  await writeFile(secondPath, secondBody);
  const calls = [];
  const client = {
    async put(key, body, options) { calls.push({ key, body: Buffer.from(body), options }); },
    async multipartUpload() { throw new Error("small files must not use multipart"); }
  };
  const result = await uploadAliyunOssFinalAssets({
    candidateId: "CX-TEST-002",
    skuPackageId: "sku-package-002",
    dataRevision: 3,
    finalUploads: [
      { assetId: "main", assetRef: firstPath, sha256: hash(firstBody), order: 1, role: "main", lifecycleArea: "finalUploads", ownerConfirmed: true, productionEligible: true },
      { assetId: "detail", assetRef: secondPath, sha256: hash(secondBody), order: 2, role: "detail", lifecycleArea: "finalUploads", ownerConfirmed: true, productionEligible: true }
    ],
    client,
    fetchImpl: async () => ({ status: 200 }),
    now: () => "2026-08-22T12:00:00.000Z"
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["x-oss-object-acl"], "public-read");
  assert.equal(calls[0].options.headers["x-oss-forbid-overwrite"], "true");
  assert.equal(result.status, "verified");
  assert.equal(result.mode, "preapproved_stable_https");
  assert.equal(result.resolvedAssets.length, 2);
  assert.equal(result.resolvedAssets[0].platformAcceptedUrl.startsWith(ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl), true);
  assert.match(result.evidenceRef, /^aliyun-oss-asset:/u);
});

test("SHA或顺序不一致立即停止，不产生OSS写入", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oss-assets-fail-"));
  const localPath = path.join(directory, "main.png");
  await writeFile(localPath, Buffer.from("actual"));
  let writes = 0;
  const client = { async put() { writes += 1; } };
  await assert.rejects(() => uploadAliyunOssFinalAssets({
    candidateId: "CX-TEST-003",
    skuPackageId: "sku-package-003",
    dataRevision: 4,
    finalUploads: [{ assetId: "main", assetRef: localPath, sha256: hash(Buffer.from("different")), order: 1, lifecycleArea: "finalUploads", ownerConfirmed: true, productionEligible: true }],
    client,
    fetchImpl: async () => ({ status: 200 })
  }), /OSS_ASSET_SHA256_MISMATCH/);
  assert.equal(writes, 0);
});
