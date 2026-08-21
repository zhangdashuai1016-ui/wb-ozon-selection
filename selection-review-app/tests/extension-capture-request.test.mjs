import test from "node:test";
import assert from "node:assert/strict";
import {
  captureRequestErrorMessage,
  validateSupplierCaptureRequest
} from "../extension/1688-capture/capture-request.js";

function validPayload(overrides = {}) {
  return {
    captureId: "SCJ-test",
    token: "one-time-token",
    candidateId: "CANDIDATE-1",
    dataRevision: 3,
    mode: "a_supplier_capture",
    sourceUrl: "https://qr.1688.com/s/Abc_123",
    expectedOfferId: "",
    allowShortLinkResolution: true,
    requiredExtensionVersion: "1.2.7",
    attempt: 1,
    ...overrides
  };
}

test("页面桥接请求按来源、字段、模式、revision和版本返回精确错误码", () => {
  assert.deepEqual(validateSupplierCaptureRequest({
    payload: validPayload(),
    senderUrl: "https://example.com/",
    manifestVersion: "1.2.7"
  }), { ok: false, code: "request_origin_invalid" });
  assert.equal(validateSupplierCaptureRequest({ payload: null, manifestVersion: "1.2.7" }).code, "request_payload_missing");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ token: "" }), manifestVersion: "1.2.7" }).code, "request_payload_missing");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ mode: "listing_preparation" }), manifestVersion: "1.2.7" }).code, "capture_mode_invalid");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload({ dataRevision: "3" }), manifestVersion: "1.2.7" }).code, "revision_invalid");
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload(), manifestVersion: "1.2.6" }).code, "extension_version_mismatch");
  assert.match(captureRequestErrorMessage("extension_version_mismatch"), /插件版本/);
});

test("短链和精确detail链接只接受锁定模式与offer", () => {
  assert.equal(validateSupplierCaptureRequest({ payload: validPayload(), manifestVersion: "1.2.7" }).ok, true);
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({ allowShortLinkResolution: false }),
    manifestVersion: "1.2.7"
  }).code, "short_link_resolution_not_allowed");
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({ sourceUrl: "https://example.com/s/Abc_123" }),
    manifestVersion: "1.2.7"
  }).code, "source_url_invalid");
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({
      sourceUrl: "https://detail.1688.com/offer/876240928352.html",
      expectedOfferId: "876240928352",
      allowShortLinkResolution: false
    }),
    manifestVersion: "1.2.7"
  }).ok, true);
  assert.equal(validateSupplierCaptureRequest({
    payload: validPayload({
      sourceUrl: "https://detail.1688.com/offer/876240928352.html",
      expectedOfferId: "999",
      allowShortLinkResolution: false
    }),
    manifestVersion: "1.2.7"
  }).code, "expected_offer_invalid");
});
