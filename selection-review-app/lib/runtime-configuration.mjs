import path from "node:path";

export const RUNTIME_MODES = Object.freeze(["local_development", "central_test", "central_production"]);
export const STATE_ADAPTERS = Object.freeze(["json", "memory", "postgres"]);

function nonEmpty(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}不能为空`);
  return normalized;
}

function port(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}无效`);
  }
  return parsed;
}

function url(value, label) {
  let parsed;
  try {
    parsed = new URL(nonEmpty(value, label));
  } catch {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}无效`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}不得包含凭据`);
  }
  return parsed;
}

function chromeExtensionOrigin(value, label) {
  const parsed = url(value, label);
  const pathSegment = parsed.pathname || "/";
  if (parsed.protocol !== "chrome-extension:" || parsed.username || parsed.password ||
      pathSegment !== "/" || parsed.search || parsed.hash ||
      !/^[a-p]{32}$/.test(parsed.hostname)) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}必须是固定Chrome扩展origin`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function booleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isLoopback(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

export function normalizeServiceOrigin(value, { deploymentMode, label = "serviceOrigin" } = {}) {
  const parsed = url(value, label);
  const mode = nonEmpty(deploymentMode, "deploymentMode");
  if (!RUNTIME_MODES.includes(mode)) throw new Error("RUNTIME_CONFIGURATION_INVALID: deploymentMode无效");
  if (mode === "local_development") {
    if (!(parsed.protocol === "http:" && isLoopback(parsed.hostname)) && parsed.protocol !== "https:") {
      throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}在本地模式只能使用回环HTTP或显式HTTPS`);
    }
  } else if (parsed.protocol !== "https:" || isLoopback(parsed.hostname)) {
    throw new Error(`RUNTIME_CONFIGURATION_INVALID: ${label}在中央模式必须使用非本机HTTPS`);
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function createSelectionReviewRuntimeConfiguration({ env = process.env, appDir, argv = process.argv } = {}) {
  const resolvedAppDir = path.resolve(nonEmpty(appDir, "appDir"));
  const deploymentMode = String(env.SELECTION_REVIEW_RUNTIME_MODE || "local_development").trim();
  if (!RUNTIME_MODES.includes(deploymentMode)) throw new Error("RUNTIME_CONFIGURATION_INVALID: deploymentMode无效");

  const apiOnly = argv.includes("--api-only");
  const bindHost = String(env.SELECTION_REVIEW_BIND_HOST || "127.0.0.1").trim();
  if (deploymentMode === "local_development" && !isLoopback(bindHost)) {
    throw new Error("RUNTIME_CONFIGURATION_INVALID: 本地开发模式只能绑定回环地址");
  }
  const listenPort = port(
    apiOnly ? env.SELECTION_REVIEW_API_PORT || 4319 : env.SELECTION_REVIEW_PORT || 4317,
    "port"
  );
  const stateAdapter = String(env.SELECTION_REVIEW_STATE_ADAPTER || "json").trim();
  if (!STATE_ADAPTERS.includes(stateAdapter)) throw new Error("RUNTIME_CONFIGURATION_INVALID: stateAdapter无效");
  const initializeDataFile = booleanFlag(env.SELECTION_REVIEW_INITIALIZE_DATA_FILE);

  const defaultUserId = String(env.SELECTION_REVIEW_DEFAULT_USER_ID || "local-development-owner").trim();
  const identityProvider = String(env.SELECTION_REVIEW_IDENTITY_PROVIDER || "development_default").trim();
  if (deploymentMode !== "local_development") {
    if (isLoopback(bindHost)) throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式不得隐式绑定本机回环地址");
    if (["json", "memory"].includes(stateAdapter)) throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式必须使用并发安全的中央存储适配器");
    if (identityProvider === "development_default" || defaultUserId === "local-development-owner") {
      throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式必须配置正式身份提供器");
    }
  }

  const publicOriginDefault = deploymentMode === "local_development"
    ? `http://127.0.0.1:${port(env.SELECTION_REVIEW_PUBLIC_PORT || 4317, "publicPort")}`
    : "";
  const publicOrigin = normalizeServiceOrigin(env.SELECTION_REVIEW_PUBLIC_ORIGIN || publicOriginDefault, {
    deploymentMode,
    label: "publicOrigin"
  });
  const aiGatewayUrl = normalizeServiceOrigin(env.SELECTION_REVIEW_AI_GATEWAY_URL || "http://127.0.0.1:4318", {
    deploymentMode,
    label: "aiGatewayUrl"
  });
  const ozonEvidenceServiceUrl = normalizeServiceOrigin(env.SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL || "http://127.0.0.1:4173", {
    deploymentMode,
    label: "ozonEvidenceServiceUrl"
  });
  const legacyFireTrainAssetRoot = String(env.SELECTION_REVIEW_LEGACY_FIRE_TRAIN_ASSET_ROOT || "").trim();
  if (deploymentMode !== "local_development" && legacyFireTrainAssetRoot) {
    throw new Error("RUNTIME_CONFIGURATION_INVALID: 中央模式不得启用本机火车历史素材目录");
  }
  const allowedOrigins = String(env.SELECTION_REVIEW_ALLOWED_ORIGINS || publicOrigin)
    .split(",")
    .map((item) => normalizeServiceOrigin(item.trim(), { deploymentMode, label: "allowedOrigin" }));
  const allowedExtensionOrigins = String(env.SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => chromeExtensionOrigin(item, "allowedExtensionOrigin"));

  return Object.freeze({
    schemaVersion: "selection-review-runtime-configuration-v1",
    deploymentMode,
    apiOnly,
    bindHost,
    port: listenPort,
    publicOrigin,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    allowedExtensionOrigins: Object.freeze([...new Set(allowedExtensionOrigins)]),
    aiGatewayUrl,
    ozonEvidenceServiceUrl,
    stateAdapter,
    initializeDataFile,
    dataFile: path.resolve(env.SELECTION_REVIEW_DATA_FILE || path.join(resolvedAppDir, "data", "candidates.json")),
    workflowMapFile: path.resolve(env.SELECTION_REVIEW_WORKFLOW_MAP_FILE || path.join(resolvedAppDir, "data", "workflow-map.json")),
    c2FinalUploadsDir: path.resolve(env.SELECTION_REVIEW_C2_UPLOAD_DIR || path.join(resolvedAppDir, "data", "c2-final-uploads")),
    legacyFireTrainAssetRoot: legacyFireTrainAssetRoot ? path.resolve(legacyFireTrainAssetRoot) : null,
    identityProvider,
    defaultUserId: nonEmpty(defaultUserId, "defaultUserId")
  });
}
