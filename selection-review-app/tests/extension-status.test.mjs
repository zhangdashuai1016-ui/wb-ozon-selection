import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_EXTENSION_VERSION, extensionConnectionStatus } from "../src/extensionStatus.js";

test("extension handshake exposes four unambiguous UI states", () => {
  assert.deepEqual(extensionConnectionStatus({ liveVersion: EXPECTED_EXTENSION_VERSION }), {
    code: "connected",
    label: `插件已连接 · v${EXPECTED_EXTENSION_VERSION}`
  });
  assert.equal(extensionConnectionStatus({ cachedVersion: EXPECTED_EXTENSION_VERSION }).code, "page_refresh_required");
  assert.equal(extensionConnectionStatus({ liveVersion: "1.1.0" }).code, "reload_required");
  assert.equal(extensionConnectionStatus({}).code, "disconnected");
});
