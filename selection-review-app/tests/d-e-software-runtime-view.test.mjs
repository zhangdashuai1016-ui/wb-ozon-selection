import test from "node:test";
import assert from "node:assert/strict";
import { dESoftwareRuntimeDisplay } from "../src/dESoftwareRuntimeView.js";

test("D/E准备度用人话显示真实缺口", () => {
  const display = dESoftwareRuntimeDisplay({
    available: true,
    status: "not_ready",
    gaps: [{ code: "asset_transport_not_ready", field: "assetTransport", message: "最终素材没有稳定HTTPS地址" }]
  });
  assert.equal(display.statusLabel, "D/E能力尚未就绪");
  assert.equal(display.gaps[0].message, "最终素材没有稳定HTTPS地址");
  assert.equal(display.tone, "waiting");
  assert.equal(display.assetTransport.status, "not_started");
  assert.equal(display.assetTransport.resolvedCount, 0);
});

test("D/E卡独立显示已验证OSS素材，不把它冒充完整D能力", () => {
  const display = dESoftwareRuntimeDisplay({
    available: true,
    status: "not_ready",
    assetTransportStatus: "verified",
    assetTransportEvidenceRef: "aliyun-oss-asset:evidence",
    assetTransportResolvedCount: 5,
    gaps: [{ code: "platform_preflight_missing", field: "platformWritePreflight", message: "尚未完成Seller API只读前检" }]
  });
  assert.deepEqual(display.assetTransport, {
    status: "verified",
    evidenceRef: "aliyun-oss-asset:evidence",
    resolvedCount: 5
  });
  assert.equal(display.statusLabel, "D/E能力尚未就绪");
  assert.equal(display.gaps.length, 1);
});

test("没有新版生命周期时不显示D/E卡", () => {
  assert.equal(dESoftwareRuntimeDisplay({ available: false }), null);
});
