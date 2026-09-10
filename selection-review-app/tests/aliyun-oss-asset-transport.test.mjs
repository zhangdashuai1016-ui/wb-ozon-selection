import assert from "node:assert/strict";
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
      assetRef: "local-asset:c2-local:00000000-0000-4000-8000-000000000001",
      fileName: "main.png",
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

function localAsset(body, order = 1) {
  const assetId = `c2-local:00000000-0000-4000-8000-${String(order).padStart(12, "0")}`;
  return { assetId, assetRef: `local-asset:${assetId}`, fileName: `${order}.png`, mediaType: "image",
    sha256: hash(body), assetVersion: `sha256:${hash(body)}`, byteSize: body.length,
    stableUrlEvidenceRef: "not_applicable", order, role: order === 1 ? "main_image" : "detail_image",
    lifecycleArea: "finalUploads", ownerConfirmed: true, productionEligible: true };
}

function request(finalUploads, options = {}) {
  return { candidateId: "candidate-test", skuPackageId: "sku-test", dataRevision: 3, finalUploads, ...options };
}

test("direct transport cannot reach credentials or put without an explicit service write gate", async () => {
  let reads = 0; let clients = 0; let writes = 0;
  const body = Buffer.from("synthetic-image");
  await assert.rejects(() => uploadAliyunOssFinalAssets(request([localAsset(body)], {
    resolveLocalAsset: async () => { reads += 1; return { body, contentType: "image/png" }; },
    createClient: async () => { clients += 1; return { put: async () => { writes += 1; } }; }
  })), /OSS_PUBLIC_WRITE_GATE_REQUIRED/);
  assert.equal(reads, 0); assert.equal(clients, 0); assert.equal(writes, 0);
});

test("a gate invalidated during local reads or between images prevents the next public put", async () => {
  const body = Buffer.from("synthetic-image"); const assets = [localAsset(body), localAsset(body, 2)];
  for (const failureDuring of ["local_read", "between_images"]) {
    let allowed = true; let writes = 0; let gates = 0;
    await assert.rejects(() => uploadAliyunOssFinalAssets(request(assets, {
      resolveLocalAsset: async () => { await Promise.resolve(); if (failureDuring === "local_read") allowed = false; return { body, contentType: "image/png" }; },
      client: { put: async () => { writes += 1; } },
      beforePublicWrite: async ({ order }) => { gates += 1; assert.equal(order, writes + 1); if (!allowed) throw new Error("SYNTHETIC_AUTHORIZATION_EXPIRED"); },
      fetchImpl: async () => { allowed = false; return new Response(body, { headers: { "Content-Type": "image/png" } }); }
    })), /SYNTHETIC_AUTHORIZATION_EXPIRED/);
    assert.equal(writes, failureDuring === "local_read" ? 0 : 1); assert.equal(gates, writes + 1);
  }
});

test("opaque素材先逐件验证，上传后以独立公开内容回读锁定真实字节", async () => {
  const firstBody = Buffer.from("first-image");
  const secondBody = Buffer.from("second-image");
  const assets = [localAsset(firstBody, 1), localAsset(secondBody, 2)];
  const stored = new Map(assets.map((asset, index) => [asset.assetId, [firstBody, secondBody][index]]));
  const publicFiles = new Map();
  const events = [];
  const result = await uploadAliyunOssFinalAssets(request(assets, {
    beforePublicWrite: async ({ assetId, order }) => { assert.equal(assetId, assets[order - 1].assetId); events.push(`gate:${order}`); },
    resolveLocalAsset: async asset => { events.push(`read:${asset.order}`); return { body: stored.get(asset.assetId), contentType: "image/png" }; },
    createClient: async () => {
      events.push("client");
      return { put: async (key, body, options) => {
        events.push("put");
        assert.equal(options.headers["x-oss-object-acl"], "public-read");
        assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
        publicFiles.set(`${ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl}/${key}`, Buffer.from(body));
      } };
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "manual");
      events.push("readback");
      return new Response(publicFiles.get(url), { headers: { "Content-Type": "image/png" } });
    },
    now: () => "2026-09-07T00:00:00.000Z"
  }));
  assert.deepEqual(events, ["read:1", "read:2", "client", "gate:1", "put", "readback", "gate:2", "put", "readback"]);
  assert.equal(result.status, "verified");
  assert.equal(result.resolvedAssets.length, 2);
  assert.equal(result.resolvedAssets[0].role, "main_image");
  assert.equal(result.resolvedAssets[1].sha256, assets[1].sha256);
  assert.match(result.evidenceRef, /^aliyun-oss-asset:/u);
});

test("第二份素材内容变化时，不读凭据、不上传第一份", async () => {
  const bodies = [Buffer.from("first"), Buffer.from("second")];
  const assets = bodies.map((body, index) => localAsset(body, index + 1));
  let clients = 0;
  await assert.rejects(uploadAliyunOssFinalAssets(request(assets, {
    beforePublicWrite: async () => { throw new Error("must not reach authorization gate with changed bytes"); },
    createClient: async () => { clients++; throw new Error("must not reach credential boundary"); },
    resolveLocalAsset: async asset => ({ body: asset.order === 1 ? bodies[0] : Buffer.from("broken"), contentType: "image/png" })
  })), /OSS_ASSET_SHA256_MISMATCH/);
  assert.equal(clients, 0);
  await assert.rejects(uploadAliyunOssFinalAssets(request(assets)), /OSS_LOCAL_ASSET_RESOLVER_REQUIRED/);
});

test("公开HTTP成功但内容变化时不返回verified，不上传下一份", async () => {
  const bytes = Buffer.from("valid-image");
  let writes = 0;
  await assert.rejects(uploadAliyunOssFinalAssets(request([localAsset(bytes), localAsset(bytes, 2)], {
    beforePublicWrite: async ({ order, sha256 }) => { assert.ok([1, 2].includes(order)); assert.equal(sha256, hash(bytes)); },
    resolveLocalAsset: async () => ({ body: bytes, contentType: "image/png" }),
    client: { put: async () => { writes++; } },
    fetchImpl: async () => new Response(Buffer.from("other-image"), { headers: { "Content-Type": "image/png" } })
  })), /OSS_PUBLIC_READBACK_MISMATCH/);
  assert.equal(writes, 1);
});
