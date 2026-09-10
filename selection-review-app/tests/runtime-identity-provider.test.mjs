import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIdentityProviderBoundary,
  authorizeIdentityProviderOperation,
  createDevelopmentIdentityProvider
} from "../lib/runtime-identity-provider.mjs";

const NOW = "2026-08-25T06:00:00.000Z";

test("开发身份由服务端Provider生成且显式标记不具备多人能力", () => {
  const provider = createDevelopmentIdentityProvider({ userId: "owner-1", clock: () => NOW });
  assert.deepEqual(assertIdentityProviderBoundary(provider), {
    providerType: "development_default", multiUserReady: false
  });
  const authorized = authorizeIdentityProviderOperation({
    provider, requestContext: { sessionId: "session-1" }, requiredRoles: ["owner"]
  });
  assert.deepEqual([authorized.actor.userId, authorized.actor.sessionId], ["owner-1", "session-1"]);
  assert.throws(() => authorizeIdentityProviderOperation({
    provider, requestContext: {}, requiredRoles: ["technical_maintainer"]
  }), /RUNTIME_OPERATION_FORBIDDEN/);
});
