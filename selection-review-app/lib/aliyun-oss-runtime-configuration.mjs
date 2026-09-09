import { isIP } from "node:net";

const CONFIG_FIELDS = ["region", "endpoint", "bucket", "publicBaseUrl", "objectPrefix", "keychainService", "keychainAccounts"];
const ACCOUNT_FIELDS = ["accessKeyId", "accessKeySecret"];
function invalid() { throw new Error("OSS_RUNTIME_CONFIGURATION_INVALID"); }

function closedObject(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field) || !Object.getOwnPropertyDescriptor(value, field).enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), "value"))) invalid();
}

function identifier(value, maximum = 128) {
  if (typeof value !== "string" || value.length > maximum || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(value)) invalid();
}

function httpsOrigin(value) {
  if (typeof value !== "string" || value.length > 300) invalid();
  let url;
  try { url = new URL(value); } catch (error) { if (error instanceof TypeError) invalid(); throw error; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
      url.pathname !== "/" || value !== url.origin || isIP(url.hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) invalid();
  return url;
}

// Explicit deployment configuration only; historical uploader defaults never enter this path.
export function normalizeAliyunOssRuntimeConfiguration(config) {
  if (config === null || config === undefined) return null;
  closedObject(config, CONFIG_FIELDS);
  if (typeof config.region !== "string" || !/^oss-[a-z0-9-]{1,55}$/.test(config.region) ||
      typeof config.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) invalid();
  const endpoint = httpsOrigin(config.endpoint);
  if (!/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint.hostname)) invalid();
  httpsOrigin(config.publicBaseUrl);
  if (typeof config.objectPrefix !== "string" || config.objectPrefix.length > 256 ||
      !/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)+$/.test(config.objectPrefix)) invalid();
  identifier(config.keychainService);
  closedObject(config.keychainAccounts, ACCOUNT_FIELDS);
  ACCOUNT_FIELDS.forEach(field => identifier(config.keychainAccounts[field]));
  if (config.keychainAccounts.accessKeyId === config.keychainAccounts.accessKeySecret) invalid();
  return Object.freeze({ ...config, keychainAccounts: Object.freeze({ ...config.keychainAccounts }) });
}
