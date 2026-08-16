import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_EXTENSION_VERSION,
  EXTENSION_CAPTURE_ACK_TIMEOUT_MS,
  extensionConnectionStatus
} from "../src/extensionStatus.js";

test("extension handshake exposes bridge and background state separately", () => {
  assert.deepEqual(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: true }), {
    code: "connected",
    label: `插件已连接 · 后台可用 · v${EXPECTED_EXTENSION_VERSION}`
  });
  assert.equal(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION, backgroundReady: false }).code, "background_unavailable");
  assert.equal(extensionConnectionStatus({ cachedVersion: EXPECTED_EXTENSION_VERSION }).code, "page_refresh_required");
  assert.equal(extensionConnectionStatus({ liveVersion: "1.1.0" }).code, "reload_required");
  assert.equal(extensionConnectionStatus({}).code, "disconnected");
  assert.equal(EXTENSION_CAPTURE_ACK_TIMEOUT_MS, 8000);
});
