import {
  assertNoProductionSecrets,
  assertNoRawPersistenceKeys,
  isCanonicalC1AuthorizationId
} from "./production-contract-primitives.mjs";

export const ACTOR_TYPES = Object.freeze(["human", "software", "worker", "maintenance"]);
export const USER_ROLES = Object.freeze(["owner", "operator", "reviewer", "production_authorizer", "technical_maintainer"]);
export const WORKER_CAPABILITIES = Object.freeze([
  "chrome", "ozon-login", "wb-login", "1688-login", "seerfar-browser", "company-vpn", "file-upload", "image-processing",
  "stable-asset-transport", "seerfar-open-api"
]);

const SECRET_PATTERN = /(?:authorization|bearer|cookie|password|api[_-]?key|secret|token)\s*(?:=|:)/i;
const ACTOR_ROLE_COMPATIBILITY = Object.freeze({
  human: new Set(USER_ROLES),
  software: new Set(["operator"]),
  worker: new Set(["operator"]),
  maintenance: new Set(["technical_maintainer"])
});

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}不能为空`);
  if (SECRET_PATTERN.test(normalized)) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}不得包含秘密`);
  return normalized;
}

function iso(value, label) {
  const normalized = text(value, label);
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`RUNTIME_IDENTITY_INVALID: ${label}无效`);
  return new Date(normalized).toISOString();
}

export function assertSafeRuntimeRecord(value, path = "record") {
  const secretInspectionProjection = (entry) => {
    if (Array.isArray(entry)) return entry.map(secretInspectionProjection);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => [
      key,
      key === "authorizationId" && isCanonicalC1AuthorizationId(item)
        ? "approved-c1-authorization-id"
        : secretInspectionProjection(item)
    ]));
  };
  try {
    assertNoRawPersistenceKeys(value, path);
    assertNoProductionSecrets(secretInspectionProjection(value), path);
  } catch (error) {
    throw new Error(`RUNTIME_IDENTITY_INVALID: ${path}不得保存秘密字段或凭据值`, { cause: error });
  }
  const localReferenceProjections = (entry) => {
    const projections = [entry];
    let current = entry;
    for (let round = 0; round < 3; round += 1) {
      const decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (decoded === current) break;
      projections.push(decoded);
      current = decoded;
    }
    return projections;
  };
  const inspectLocalReference = (entry, currentPath) => {
    if (typeof entry === "string") {
      if (localReferenceProjections(entry).some((projection) =>
        /^(?:file:|\/|\\\\|[A-Za-z]:[\\/])/.test(projection) ||
        /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(projection))) {
        throw new Error(`RUNTIME_IDENTITY_INVALID: ${currentPath}不得保存本机路径或回环地址`);
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => inspectLocalReference(item, `${currentPath}[${index}]`));
      return;
    }
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) inspectLocalReference(item, `${currentPath}.${key}`);
    }
  };
  inspectLocalReference(value, path);
  return value;
}

export function createActorContext({ userId, sessionId, actorType, roles, source, authenticatedAt }) {
  if (!ACTOR_TYPES.includes(actorType) || !Array.isArray(roles) || roles.length === 0 || roles.some((role) => !USER_ROLES.includes(role))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: actorType或roles无效");
  }
  if (roles.some((role) => !ACTOR_ROLE_COMPATIBILITY[actorType].has(role))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: actorType与roles不兼容");
  }
  return Object.freeze({
    schemaVersion: "actor-context-v1",
    userId: text(userId, "userId"),
    sessionId: text(sessionId, "sessionId"),
    actorType,
    roles: Object.freeze([...new Set(roles)]),
    source: text(source, "source"),
    authenticatedAt: iso(authenticatedAt, "authenticatedAt")
  });
}

export function createLocalDevelopmentActor({ at, userId = "local-development-owner", sessionId = "local-development-session" }) {
  return createActorContext({
    userId,
    sessionId,
    actorType: "human",
    roles: ["owner", "production_authorizer"],
    source: "development_default",
    authenticatedAt: at
  });
}

export function authorizeOperation({ actor, requiredRoles }) {
  if (!actor || actor.schemaVersion !== "actor-context-v1" || !Array.isArray(requiredRoles) || requiredRoles.length === 0 ||
      requiredRoles.some((role) => !USER_ROLES.includes(role))) {
    throw new Error("RUNTIME_AUTHORIZATION_INVALID");
  }
  if (!requiredRoles.some((role) => actor.roles.includes(role))) {
    const error = new Error("RUNTIME_OPERATION_FORBIDDEN");
    error.code = "RUNTIME_OPERATION_FORBIDDEN";
    throw error;
  }
  return Object.freeze({ allowed: true, userId: actor.userId, roles: Object.freeze([...actor.roles]) });
}

export function createOperationAuditEvent({
  eventId,
  action,
  actor,
  workerId = null,
  candidateId,
  skuPackageId,
  sourceRevision,
  resultRevision,
  fromState,
  toState,
  authorizationRef = null,
  externalRequestState = "not_sent",
  externalRequestRef = null,
  idempotencyKey,
  serverTime
}) {
  if (!actor || actor.schemaVersion !== "actor-context-v1") throw new Error("RUNTIME_IDENTITY_INVALID: actor无效");
  if (!Number.isInteger(sourceRevision) || !Number.isInteger(resultRevision) || resultRevision < sourceRevision) {
    throw new Error("RUNTIME_IDENTITY_INVALID: revision范围无效");
  }
  if (!['not_sent', 'failed', 'unknown_outcome', 'succeeded'].includes(externalRequestState)) {
    throw new Error("RUNTIME_IDENTITY_INVALID: externalRequestState无效");
  }
  const event = {
    schemaVersion: "operation-audit-event-v1",
    eventId: text(eventId, "eventId"),
    action: text(action, "action"),
    actor: structuredClone(actor),
    workerId: workerId ? text(workerId, "workerId") : null,
    candidateId: text(candidateId, "candidateId"),
    skuPackageId: text(skuPackageId, "skuPackageId"),
    sourceRevision,
    resultRevision,
    fromState: text(fromState, "fromState"),
    toState: text(toState, "toState"),
    authorizationRef: authorizationRef ? text(authorizationRef, "authorizationRef") : null,
    externalRequestState,
    externalRequestRef: externalRequestRef ? text(externalRequestRef, "externalRequestRef") : null,
    idempotencyKey: text(idempotencyKey, "idempotencyKey"),
    serverTime: iso(serverTime, "serverTime")
  };
  assertSafeRuntimeRecord(event, "operationAuditEvent");
  return Object.freeze(event);
}

export function createWorkerDescriptor({ workerId, capabilities, version, status = "online", observedAt }) {
  if (!Array.isArray(capabilities) || capabilities.some((capability) => !WORKER_CAPABILITIES.includes(capability))) {
    throw new Error("RUNTIME_IDENTITY_INVALID: capabilities无效");
  }
  if (!['online', 'offline', 'busy', 'blocked'].includes(status)) throw new Error("RUNTIME_IDENTITY_INVALID: worker status无效");
  return Object.freeze({
    schemaVersion: "worker-descriptor-v1",
    workerId: text(workerId, "workerId"),
    capabilities: Object.freeze([...new Set(capabilities)].sort()),
    version: text(version, "version"),
    status,
    observedAt: iso(observedAt, "observedAt")
  });
}

export function workerSatisfiesCapabilities(worker, requiredCapabilities) {
  if (!worker || !Array.isArray(worker.capabilities) || !Array.isArray(requiredCapabilities)) return false;
  const available = new Set(worker.capabilities);
  return requiredCapabilities.every((capability) => WORKER_CAPABILITIES.includes(capability) && available.has(capability));
}
