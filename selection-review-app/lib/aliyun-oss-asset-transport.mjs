import OSS from "ali-oss";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const ALIYUN_OSS_ASSET_TRANSPORT_VERSION = "aliyun-oss-final-assets-v1";
export const ALIYUN_OSS_KEYCHAIN_SERVICE = "com.shuaizhang.wb-ozon-selection.aliyun-oss";
export const ALIYUN_OSS_PUBLIC_CONFIG = Object.freeze({
  label: "三店选品上架 OSS 素材中转",
  region: "oss-cn-beijing",
  endpoint: "https://oss-accelerate.aliyuncs.com",
  bucket: "ozon-img-staging-cn-20260630-a7k3",
  publicBaseUrl: "https://ozon-img-staging-cn-20260630-a7k3.oss-accelerate.aliyuncs.com",
  objectPrefix: "wb-ozon-selection/final-assets/",
  accelerateEnabled: true,
  keychainService: ALIYUN_OSS_KEYCHAIN_SERVICE,
  keychainAccounts: Object.freeze({
    accessKeyId: "access-key-id",
    accessKeySecret: "access-key-secret"
  })
});

const execFileAsync = promisify(execFile);
const MAX_SIMPLE_UPLOAD_BYTES = 100 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeSegment(value, label) {
  const segment = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  if (!segment) throw new Error(`OSS_SCOPE_INVALID: ${label}不能为空`);
  return segment;
}

function extensionFromPath(path) {
  const match = String(path || "").match(/\.([a-zA-Z0-9]{1,8})$/u);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function contentTypeFromPath(path) {
  const extension = extensionFromPath(path);
  return ({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4"
  })[extension] || "application/octet-stream";
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function evidenceRef(value) {
  return `aliyun-oss-asset:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function readAliyunOssKeychainSecret(account, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl("/usr/bin/security", [
    "find-generic-password",
    "-w",
    "-s", ALIYUN_OSS_KEYCHAIN_SERVICE,
    "-a", account
  ], { encoding: "utf8", maxBuffer: 16 * 1024 });
  const value = String(stdout || "").trim();
  if (!value) throw new Error(`OSS_KEYCHAIN_MISSING: ${account}`);
  return value;
}

export async function inspectAliyunOssAssetTransportConfiguration({ readSecret = readAliyunOssKeychainSecret } = {}) {
  let accessKeyIdConfigured = false;
  let accessKeySecretConfigured = false;
  try {
    accessKeyIdConfigured = nonEmpty(await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeyId));
    accessKeySecretConfigured = nonEmpty(await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeySecret));
  } catch {
    // 配置状态只返回布尔值，不返回钥匙串内容或底层错误文本。
  }
  return Object.freeze({
    status: accessKeyIdConfigured && accessKeySecretConfigured ? "configured_unverified" : "not_configured",
    transportVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
    label: ALIYUN_OSS_PUBLIC_CONFIG.label,
    region: ALIYUN_OSS_PUBLIC_CONFIG.region,
    bucket: ALIYUN_OSS_PUBLIC_CONFIG.bucket,
    publicHost: new URL(ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl).hostname,
    objectPrefix: ALIYUN_OSS_PUBLIC_CONFIG.objectPrefix,
    accelerateEnabled: ALIYUN_OSS_PUBLIC_CONFIG.accelerateEnabled,
    keychainService: ALIYUN_OSS_KEYCHAIN_SERVICE,
    accessKeyIdConfigured,
    accessKeySecretConfigured,
    realUploadVerified: false
  });
}

export async function createAliyunOssClient({
  readSecret = readAliyunOssKeychainSecret,
  Client = OSS
} = {}) {
  const accessKeyId = await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeyId);
  const accessKeySecret = await readSecret(ALIYUN_OSS_PUBLIC_CONFIG.keychainAccounts.accessKeySecret);
  return new Client({
    region: ALIYUN_OSS_PUBLIC_CONFIG.region,
    endpoint: ALIYUN_OSS_PUBLIC_CONFIG.endpoint,
    bucket: ALIYUN_OSS_PUBLIC_CONFIG.bucket,
    accessKeyId,
    accessKeySecret,
    secure: true,
    authorizationV4: true
  });
}

export function buildAliyunOssFinalAssetObjectKey({ candidateId, skuPackageId, dataRevision, asset }) {
  if (!asset || asset.ownerConfirmed !== true || asset.productionEligible !== true || asset.lifecycleArea !== "finalUploads") {
    throw new Error("OSS_ASSET_NOT_AUTHORIZED: 只能上传主人确认的finalUploads");
  }
  if (!nonEmpty(asset.assetId) || !nonEmpty(asset.sha256) || !Number.isInteger(asset.order) || asset.order < 1) {
    throw new Error("OSS_ASSET_BINDING_INVALID: 素材ID、SHA256或顺序无效");
  }
  const extension = extensionFromPath(asset.assetRef);
  return [
    ALIYUN_OSS_PUBLIC_CONFIG.objectPrefix.replace(/\/$/u, ""),
    safeSegment(candidateId, "candidateId"),
    safeSegment(skuPackageId, "skuPackageId"),
    `revision-${safeSegment(dataRevision, "dataRevision")}`,
    `${String(asset.order).padStart(2, "0")}-${safeSegment(asset.assetId, "assetId")}-${asset.sha256.slice(0, 16)}${extension}`
  ].join("/");
}

export async function uploadAliyunOssFinalAssets({
  candidateId,
  skuPackageId,
  dataRevision,
  finalUploads,
  client,
  createClient = createAliyunOssClient,
  fetchImpl = fetch,
  now = () => new Date().toISOString()
}) {
  if (!Array.isArray(finalUploads) || finalUploads.length === 0) {
    throw new Error("OSS_FINAL_UPLOADS_MISSING: 没有主人确认的最终素材");
  }
  const orders = finalUploads.map((asset) => asset.order);
  if (orders.some((order, index) => order !== index + 1)) {
    throw new Error("OSS_ASSET_ORDER_INVALID: 最终素材顺序必须从1连续排列");
  }
  const ossClient = client || await createClient();
  const resolvedAssets = [];

  for (const asset of finalUploads) {
    const localPath = String(asset.assetRef || "");
    if (!localPath.startsWith("/")) throw new Error("OSS_LOCAL_PATH_REQUIRED: 首次传输只接受本机绝对路径");
    const fileStat = await stat(localPath);
    if (!fileStat.isFile()) throw new Error("OSS_ASSET_NOT_FILE: 素材路径不是文件");
    const body = await readFile(localPath);
    const observedSha256 = sha256(body);
    if (observedSha256 !== asset.sha256) throw new Error("OSS_ASSET_SHA256_MISMATCH: 素材内容与确认清单不一致");
    const objectKey = buildAliyunOssFinalAssetObjectKey({ candidateId, skuPackageId, dataRevision, asset });
    const headers = {
      "Content-Type": contentTypeFromPath(localPath),
      "x-oss-object-acl": "public-read",
      "x-oss-forbid-overwrite": "true"
    };
    if (body.length <= MAX_SIMPLE_UPLOAD_BYTES) {
      await ossClient.put(objectKey, body, { headers, timeout: 30_000 });
    } else {
      await ossClient.multipartUpload(objectKey, localPath, {
        headers,
        timeout: 60_000,
        parallel: 3,
        partSize: 10 * 1024 * 1024
      });
    }
    const platformAcceptedUrl = `${ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetchImpl(platformAcceptedUrl, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) throw new Error(`OSS_PUBLIC_READBACK_FAILED: HTTP ${response.status}`);
    const uploadedAt = now();
    resolvedAssets.push(Object.freeze({
      assetId: asset.assetId,
      sha256: asset.sha256,
      order: asset.order,
      role: asset.role || (asset.order === 1 ? "main" : "detail"),
      platformAcceptedUrl,
      stable: true,
      authorizationStatus: "approved",
      transportVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
      uploadedAt,
      evidenceRef: evidenceRef({ objectKey, sha256: asset.sha256, order: asset.order, uploadedAt })
    }));
  }

  return Object.freeze({
    status: "verified",
    mode: "preapproved_stable_https",
    protocolVersion: ALIYUN_OSS_ASSET_TRANSPORT_VERSION,
    approvedHosts: Object.freeze([new URL(ALIYUN_OSS_PUBLIC_CONFIG.publicBaseUrl).hostname]),
    resolvedAssets: Object.freeze(resolvedAssets),
    evidenceRef: evidenceRef({ candidateId, skuPackageId, dataRevision, assets: resolvedAssets.map(({ assetId, sha256, order, platformAcceptedUrl }) => ({ assetId, sha256, order, platformAcceptedUrl })) })
  });
}
