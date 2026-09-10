import test from "node:test";
import assert from "node:assert/strict";
import { dESoftwareRuntimeDisplay, eReadbackRuntimeDisplay } from "../src/dESoftwareRuntimeView.js";
import { mapLifecycleStatus } from "../src/lifecycleStatusView.js";

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

test("历史验证来源冲突在E和生命周期都显示待核对，不改变业务结果", () => {
  const readback = { status: "source_conflict", currentVerified: false, recordedStatus: "verified",
    applicationDisposition: "applied", sourceConflict: "E_READBACK_APPLIED_SOURCE_CONFLICT", result: { gaps: [] } };
  const display = eReadbackRuntimeDisplay(readback);
  assert.equal(display.verified, false);
  assert.match(display.statusLabel, /来源冲突/);
  assert.ok(display.gaps.length > 0);
  assert.equal(dESoftwareRuntimeDisplay({ available: true, status: "e_source_conflict" }).tone, "waiting");
  const status = mapLifecycleStatus({ id: "synthetic", eReadbackRuntimeView: readback, lifecycleV11: { skuPackage: {
    schemaVersion: "product-lifecycle-v1.1", skuPackageId: "sku:synthetic", businessPhase: "E", businessResult: "passed",
    technicalStatus: "completed", ownerAction: "none", eVerificationRecord: { outcome: "listed_verified" }
  } } });
  assert.equal(status.technicalStatus, "system_error");
  assert.equal(status.businessResult, "passed");
  assert.equal(status.failureLayer, "e_readback_source_conflict");
  assert.match(status.explanation, /待核对/);
  assert.doesNotMatch(status.explanation, /已基于ProductionRecord完成/);
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

test("E显示独立读取实际缺口，旧运行记录和未应用结果不能显示完成", () => {
  assert.equal(eReadbackRuntimeDisplay(null), null);
  const failed = eReadbackRuntimeDisplay({ status: "not_verified", applicationDisposition: "recorded",
    result: { gaps: ["media_order_or_set_mismatch", "warehouse_identity_or_quantity_unverified", "listedStatus"] } });
  assert.equal(failed.verified, false);
  assert.match(failed.gaps.join("；"), /图片集合或顺序/);
  assert.match(failed.gaps.join("；"), /指定仓库/);
  assert.match(failed.gaps.join("；"), /审核或销售状态/);
  assert.equal(eReadbackRuntimeDisplay({ status: "in_flight", live: false }).statusLabel, "平台读取结果待核对");
  assert.equal(eReadbackRuntimeDisplay({ status: "in_flight", live: true }).statusLabel, "正在独立读取平台结果");
  assert.equal(eReadbackRuntimeDisplay({ status: "verified", applicationDisposition: "source_conflict_not_applied" }).verified, false);
  assert.equal(eReadbackRuntimeDisplay({ status: "verified", applicationDisposition: "applied" }).verified, true);
});
