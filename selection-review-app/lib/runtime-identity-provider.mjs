import { authorizeOperation, createLocalDevelopmentActor } from "./runtime-identity.mjs";

export function createDevelopmentIdentityProvider({ userId, clock = () => new Date().toISOString() } = {}) {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId || typeof clock !== "function") throw new Error("IDENTITY_PROVIDER_CONFIGURATION_INVALID");
  return Object.freeze({
    boundaryType: "runtime_identity_provider",
    providerType: "development_default",
    multiUserReady: false,
    resolveActor(requestContext = {}) {
      return createLocalDevelopmentActor({
        at: clock(),
        userId: normalizedUserId,
        sessionId: String(requestContext.sessionId || "local-development-session")
      });
    }
  });
}

export function assertIdentityProviderBoundary(provider) {
  if (!provider || provider.boundaryType !== "runtime_identity_provider" || typeof provider.resolveActor !== "function") {
    throw new Error("IDENTITY_PROVIDER_BOUNDARY_REQUIRED");
  }
  return Object.freeze({
    providerType: String(provider.providerType || "unknown"),
    multiUserReady: provider.multiUserReady === true
  });
}

export function authorizeIdentityProviderOperation({ provider, requestContext, requiredRoles }) {
  const boundary = assertIdentityProviderBoundary(provider);
  const actor = provider.resolveActor(requestContext);
  authorizeOperation({ actor, requiredRoles });
  return Object.freeze({ actor, boundary });
}
