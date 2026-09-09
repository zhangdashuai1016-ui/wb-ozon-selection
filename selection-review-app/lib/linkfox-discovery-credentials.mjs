import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { ADiscoveryError } from './a-discovery-contract.mjs';
import { LinkfoxDiscoveryError } from './linkfox-discovery-api.mjs';

const execFileAsync = promisify(execFile);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);

export function normalizeLinkfoxDiscoveryCredentialBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 1) throw new TypeError('A_DISCOVERY_CREDENTIAL_CONFIGURATION_INVALID');
  return Object.freeze(bindings.map(binding => {
    const fields = ['credentialAlias', 'keychainService', 'keychainAccount'];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== fields.length ||
        !fields.every(field => Object.hasOwn(binding, field)) || !isCanonicalFrozenRef(binding.credentialAlias) ||
        !label(binding.keychainService) || !label(binding.keychainAccount)) {
      throw new TypeError('A_DISCOVERY_CREDENTIAL_CONFIGURATION_INVALID');
    }
    return Object.freeze({ ...binding });
  }));
}

/** Local development credential boundary. Construction and configuration reads do not access the keychain. */
export function createLinkfoxDiscoverySecretReader(options) {
  return createLocalDiscoverySecretReader(options, 'linkfox', LinkfoxDiscoveryError);
}

export function createSeerfarDiscoverySecretReader(options) {
  return createLocalDiscoverySecretReader(options, 'seerfar', ADiscoveryError);
}

function createLocalDiscoverySecretReader({ bindings, runtimeMode, execFileImpl = execFileAsync,
  platform = process.platform }, expectedProvider, ErrorType) {
  const routes = normalizeLinkfoxDiscoveryCredentialBindings(bindings);
  if (typeof execFileImpl !== 'function') throw new TypeError('A_DISCOVERY_CREDENTIAL_READER_INVALID');
  return async function readSecret({ credentialAlias, provider, signal }) {
    if (runtimeMode !== 'local_development' || platform !== 'darwin') throw new ErrorType('CREDENTIAL_UNAVAILABLE');
    if (provider !== expectedProvider || !isCanonicalFrozenRef(credentialAlias) || signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('A_DISCOVERY_CREDENTIAL_REQUEST_INVALID');
    }
    const route = routes.find(value => value.credentialAlias === credentialAlias);
    if (!route) throw new ErrorType('CREDENTIAL_MISSING');
    signal?.throwIfAborted();
    let result;
    try {
      result = await execFileImpl('/usr/bin/security', ['find-generic-password', '-w', '-s', route.keychainService, '-a', route.keychainAccount],
        { encoding: 'utf8', maxBuffer: 8192, timeout: 5000, signal });
    } catch (error) {
      signal?.throwIfAborted();
      // Only recognizable process failures are classified here; subprocess text can contain secrets.
      if (Number.isInteger(error?.code) || error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.killed === true) {
        throw new ErrorType(error.code === 44 ? 'CREDENTIAL_MISSING' : 'CREDENTIAL_READ_FAILED');
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (!result || typeof result.stdout !== 'string') throw new TypeError('A_DISCOVERY_CREDENTIAL_READER_RESULT_INVALID');
    const secret = result.stdout.trim();
    if (!secret || secret.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(secret)) throw new ErrorType('CREDENTIAL_MISSING');
    return secret;
  };
}
