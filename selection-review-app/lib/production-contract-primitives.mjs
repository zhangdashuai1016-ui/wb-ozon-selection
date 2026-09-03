import { createHash } from "node:crypto";

export const SAFE_FROZEN_REF_MAX_LENGTH = 256;
export const PERCENT_ENCODING_MAX_DECODE_DEPTH = 3;
export const PRODUCTION_CONTRACT_MAX_DEPTH = 128;
export const PRODUCTION_CONTRACT_MAX_NODES = 10_000;
export const PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED = "PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED";
export const C2_DIAGNOSTIC_MAX_PATH_SEGMENTS = 24;
export const C2_DIAGNOSTIC_MAX_PATHS = 16;
export const C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES = 2_048;

/**
 * The C2 contract's declared reference fields.  This is intentionally a
 * field-name allowlist rather than a `*Ref`/`*Id` convention: dynamic fact
 * keys remain business data and must not acquire reference semantics merely
 * because of their spelling.
 */
export const C2_REFERENCE_FIELD_SEMANTICS = Object.freeze({
  assetRef: "assetRef",
  authorizationId: "authorizationId",
  sourceRef: "sourceRef",
  sourceRefs: "canonicalFrozenRef",
  aiRequestId: "canonicalFrozenRef",
  aiReceiptId: "canonicalFrozenRef",
  approvedAssetIds: "canonicalFrozenRef",
  approvedMainImageAssetId: "canonicalFrozenRef",
  assetId: "canonicalFrozenRef",
  assetPackageId: "canonicalFrozenRef",
  candidateId: "canonicalFrozenRef",
  categoryId: "canonicalFrozenRef",
  descriptionCategoryId: "canonicalFrozenRef",
  evidenceRef: "canonicalFrozenRef",
  evidenceRefs: "canonicalFrozenRef",
  factRefs: "canonicalFrozenRef",
  generatorRef: "canonicalFrozenRef",
  inheritedSalesSnapshotRefs: "canonicalFrozenRef",
  inputEvidenceRefs: "canonicalFrozenRef",
  jobId: "canonicalFrozenRef",
  keywordEvidenceRefs: "canonicalFrozenRef",
  mainImageAssetId: "canonicalFrozenRef",
  offerId: "canonicalFrozenRef",
  ownerSupplyConfirmationRef: "canonicalFrozenRef",
  platformProductId: "canonicalFrozenRef",
  platformStoreId: "canonicalFrozenRef",
  providerId: "canonicalFrozenRef",
  providerVersion: "canonicalFrozenRef",
  receiptRef: "canonicalFrozenRef",
  salesSnapshotId: "canonicalFrozenRef",
  schemaEvidenceRef: "canonicalFrozenRef",
  schemaSnapshotRef: "canonicalFrozenRef",
  selectedSupplySnapshotId: "canonicalFrozenRef",
  skuPackageId: "canonicalFrozenRef",
  slotId: "canonicalFrozenRef",
  sourceConfirmationCardId: "canonicalFrozenRef",
  sourceEvidenceRef: "canonicalFrozenRef",
  stableStoreId: "canonicalFrozenRef",
  stableUrlEvidenceRef: "canonicalFrozenRef",
  storeRef: "canonicalFrozenRef",
  supplierOptionId: "canonicalFrozenRef",
  supplierSkuId: "canonicalFrozenRef",
  typeId: "canonicalFrozenRef",
  warehouseRef: "canonicalFrozenRef",
  // inputRefs is an object: its declared C1 source fields are independently
  // canonical references, while the object itself has no scalar semantics.
  platformSchemaEvidenceId: "canonicalFrozenRef",
  profitModelVersion: "canonicalFrozenRef"
});
const C2_REFERENCE_SEMANTIC_KINDS = new Set(Object.values(C2_REFERENCE_FIELD_SEMANTICS));

const C2_DIAGNOSTIC_STATIC_FIELDS = new Set([
  "assets", "collected", "aiDrafts", "finalUploads", "assetId", "mediaType", "assetRef", "assetVersion",
  "sha256", "addedAt", "sourcePlatform", "sourceEvidenceRef", "usageAuthorization", "sourceType",
  "generatorRef", "fileName", "byteSize", "width", "height", "order", "role", "slotId",
  "stableUrlEvidenceRef", "ownerConfirmed", "productionEligible", "status", "evidenceRef",
  "mediaRequirements", "unknownManifest", "softwareState", "productionAuthorizationPreparation",
  "skuPackage", "c2SourceSnapshots", "selectedSupplySnapshot", "activeProfitModel", "c1ProductPlan",
  "technicalFailureRecord", "failure", "ownerDecision",
  "frozenC1Handoff", "seoEvidenceLayer", "draftOnlySeo", "providerJobRef", "authorizationRef",
  "authorizationId", "authorizationType", "scope", "finalCardInputSnapshot", "c1Snapshot", "canonicalC1",
  "exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment",
  "categoryRestrictions", "platformCompliance", "inputSnapshots",
  "lockedScope", "c1", "seoDraft", "evidenceLayer", "targetContext", "candidateId", "skuPackageId",
  "variantKey", "platform", "storeRef", "merchantSku", "supplierSkuId", "warehouseRef", "credentialAlias",
  "sourceDataRevision", "resultRevision", "sourceC1Fingerprint", "requirementsFingerprint", "schemaVersion",
  "blockingItems", "finalUploadsFingerprint", "mediaRequirementsFingerprint", "cardId", "value", "inputRefs",
  ...Object.keys(C2_REFERENCE_FIELD_SEMANTICS)
]);

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function boundedDiagnosticPath(path) {
  const text = String(path);
  return text.length <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES
    ? text
    : "$.[path-truncated]";
}

export function appendC2DiagnosticPath(path, rawKey, isArray = false) {
  const base = boundedDiagnosticPath(path);
  const key = String(rawKey);
  if (isArray) {
    return /^(?:0|[1-9][0-9]{0,4})$/.test(key) && Number(key) < PRODUCTION_CONTRACT_MAX_NODES
      ? `${base}[${key}]`
      : `${base}[index]`;
  }
  const segment = C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
  const segmentCount = (base.match(/\.|\[/g) || []).length;
  return segmentCount < C2_DIAGNOSTIC_MAX_PATH_SEGMENTS
    ? `${base}.${segment}`
    : `${base}.[path-truncated]`;
}

function diagnosticSemanticSegment(rawKey, isArray) {
  const key = String(rawKey);
  return isArray || C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
}

function semanticPathSegment(rawKey, isArray) {
  const key = String(rawKey);
  // Array indexes and unrecognised keys can never make the exact C1 opaque
  // authorizationId path eligible.  Keep a stable sentinel instead of any
  // user-controlled text.
  return isArray ? "[array]" : C2_DIAGNOSTIC_STATIC_FIELDS.has(key) ? key : "[unknown]";
}

function appendBoundedDiagnosticPart(message, part) {
  const candidate = `${message}${part}`;
  return byteLength(candidate) <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES ? candidate : null;
}

export function formatC2ReferenceDiagnostic(code, paths, summary = null) {
  let message = String(code);
  const uniquePaths = [...new Set(paths.map(boundedDiagnosticPath))];
  let included = 0;
  for (const path of uniquePaths) {
    if (included >= C2_DIAGNOSTIC_MAX_PATHS) break;
    const next = appendBoundedDiagnosticPart(message, `${included === 0 ? ":" : ","}${path}`);
    if (next === null) break;
    message = next;
    included += 1;
  }
  if (included < uniquePaths.length) {
    const next = appendBoundedDiagnosticPart(message, `${included === 0 ? ":" : ","}[truncated]`);
    if (next !== null) message = next;
  }
  if (summary !== null) {
    const next = appendBoundedDiagnosticPart(message, `:${summary}`);
    if (next !== null) message = next;
  }
  return message;
}

const RAW_PERSISTENCE_KEYS = new Set([
  "rawresponse", "rawrequest", "rawhtml", "rawpayload", "rawbody", "rawheader", "rawheaders",
  "requestbody", "responsebody", "requestheader", "requestheaders", "responseheader", "responseheaders"
]);

export function assertNoRawPersistenceKeys(value, path, {
  errorCode = "C2_SENSITIVE_INPUT_REJECTED"
} = {}) {
  const stack = [{ kind: "value", value, path: boundedDiagnosticPath(path), depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [key, child] = next.value;
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      if (!current.isArray && RAW_PERSISTENCE_KEYS.has(normalizeSecretKey(key))) {
        throw new Error(formatC2ReferenceDiagnostic(errorCode, [childPath], "raw-persistence-key"));
      }
      stack.push({ kind: "value", value: child, path: childPath, depth: current.depth + 1 });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      throw new Error(formatC2ReferenceDiagnostic(
        errorCode,
        [current.path],
        "resource-limit"
      ));
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) continue;
    stack.push({
      kind: "entries",
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      depth: current.depth
    });
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ownEnumerableEntries(value) {
  if (Array.isArray(value)) return value.entries();
  return (function* iterateOwnEntries() {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) yield [key, value[key]];
    }
  })();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function fingerprintCanonicalRecord(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeSecretKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES = Object.freeze([
  Object.freeze({
    key: "x-amz-signature",
    words: Object.freeze(["x", "amz", "signature"]),
    atVariant: true
  }),
  Object.freeze({ key: "x-amz-security-token", words: Object.freeze(["x", "amz", "security", "token"]) }),
  Object.freeze({ key: "x-amz-credential", words: Object.freeze(["x", "amz", "credential"]) }),
  Object.freeze({ key: "x-goog-signature", words: Object.freeze(["x", "goog", "signature"]) }),
  Object.freeze({ key: "x-goog-credential", words: Object.freeze(["x", "goog", "credential"]) }),
  Object.freeze({ key: "x-goog-security-token", words: Object.freeze(["x", "goog", "security", "token"]) }),
  Object.freeze({ key: "AWSAccessKeyId", words: Object.freeze(["aws", "access", "key", "id"]) }),
  Object.freeze({ key: "GoogleAccessId", words: Object.freeze(["google", "access", "id"]) }),
  Object.freeze({ key: "x-oss-security-token", words: Object.freeze(["x", "oss", "security", "token"]) }),
  Object.freeze({ key: "security-token", words: Object.freeze(["security", "token"]) }),
  Object.freeze({ key: "OSSAccessKeyId", words: Object.freeze(["oss", "access", "key", "id"]) }),
  Object.freeze({ key: "x-oss-signature", words: Object.freeze(["x", "oss", "signature"]) }),
  Object.freeze({ key: "x-oss-credential", words: Object.freeze(["x", "oss", "credential"]) }),
  Object.freeze({ key: "x-oss-signature-version", words: Object.freeze(["x", "oss", "signature", "version"]) }),
  Object.freeze({ key: "x-oss-date", words: Object.freeze(["x", "oss", "date"]) }),
  Object.freeze({ key: "x-oss-expires", words: Object.freeze(["x", "oss", "expires"]) }),
  Object.freeze({ key: "x-oss-additional-headers", words: Object.freeze(["x", "oss", "additional", "headers"]) }),
  Object.freeze({ key: "sig", words: Object.freeze(["sig"]) })
]);
export const CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS = Object.freeze(
  CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ key, atVariant }) => [
    key,
    ...(atVariant ? [`${key}-at`] : [])
  ])
);

const CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS = new Set([
  "expires", "expiresat", "expiry", "expiryat",
  ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ words, atVariant }) => [
    words.join(""),
    ...(atVariant ? [`${words.join("")}at`] : [])
  ])
]);

function boundedDecode(value, maxRounds = PERCENT_ENCODING_MAX_DECODE_DEPTH) {
  const values = [String(value)];
  for (let round = 0; round < maxRounds; round += 1) {
    const current = values.at(-1).replace(/\+/g, "%20");
    let decoded = current;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // A malformed escape must not hide valid escapes that follow it. Decode
      // only complete byte escapes and leave malformed escapes intact.
      decoded = current.replace(/%([0-9a-f]{2})/gi, (_match, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
    if (decoded === values.at(-1)) break;
    values.push(decoded);
  }
  return values;
}

export function hasPercentEncodingBeyondDecodeDepth(value) {
  return /%[0-9a-f]{2}/i.test(boundedDecode(value).at(-1));
}

function normalizeMalformedPercentBoundary(value) {
  // Preserve a following complete %HH escape: it may decode to the first
  // character of a sensitive key.  Only the malformed percent marker and
  // its immediate non-percent prefix become a non-word boundary.
  return String(value).replace(/%(?![0-9a-f]{2})(?:[^%\s])?/gi, " ");
}

function normalizeMalformedPercentEscape(value) {
  // Keep the wider malformed-escape projection as a second bounded scan:
  // `%ZZ-token` must still preserve `-token` as an assignment boundary.
  return String(value).replace(/%(?![0-9a-f]{2})(?:[^%\s]{1,2})?/gi, " ");
}

function secretScanCandidates(value) {
  return boundedDecode(value).flatMap((candidate) => {
    const normalizedCandidates = [
      normalizeMalformedPercentBoundary(candidate),
      normalizeMalformedPercentEscape(candidate)
    ];
    // Normalize before a further bounded decode so `%G%74oken` retains the
    // valid `%74` byte as the first character of a sensitive key; retain the
    // two bounded malformed projections for `%Gtoken` and `%ZZ-token`.
    return [candidate, ...normalizedCandidates.flatMap((normalized) =>
      normalized === candidate ? [] : boundedDecode(normalized)
    )];
  });
}

function isForbiddenSecretKey(key) {
  if (hasPercentEncodingBeyondDecodeDepth(key)) return true;
  return boundedDecode(key).some((candidate) => {
    const normalized = normalizeSecretKey(candidate);
    if ([
      "authorization", "bearer", "basic", "password", "cookie", "cookies", "cookiejar",
      "headers", "requestheaders", "token", "secret", "credential", "credentials"
    ].includes(normalized)) return true;
    if (/^(?:token|secret|credentials?)(?:at)?$/.test(normalized)) return true;
    if (/^(?:access|refresh)token(?:at)?$/.test(normalized)) return true;
    if (/^(?:clientsecret|sessioncookie|apikey|signature)(?:at)?$/.test(normalized)) return true;
    return /^credential(?:value|secret|token|password)(?:at)?$/.test(normalized);
  });
}

function isSensitiveAssignmentKey(key) {
  return isForbiddenSecretKey(key) ||
    CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS.has(normalizeSecretKey(key));
}

function isSafeSecretAssignmentValue(value) {
  // Assignment scanning evaluates the original text as well as its bounded
  // percent-decoded projections.  Apply the same bounded projection here so
  // a harmless encoded separator (for example, `none%2Dlabel`) has exactly
  // the same meaning as its decoded form, while encoded `=` / `:` remains
  // ineligible as a safe terminator.
  const normalizedValue = boundedDecode(value).at(-1);
  return /^(?:required|not[-_ ]?required|none|not[-_ ]?applicable)(?:$|[^A-Za-z0-9_=%:])/i.test(normalizedValue);
}

const C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS_VALUE = Object.freeze({
  runtimeRootPrefixes: Object.freeze([
    Object.freeze([]),
    Object.freeze(["productionAuthorizationPreparation"]),
    Object.freeze(["c2FinalAssets", "productionAuthorizationPreparation"])
  ]),
  runtimePaths: Object.freeze([
    Object.freeze(["frozenC1Handoff", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["frozenC1Handoff", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "c1Snapshot", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["finalCardInputSnapshot", "canonicalC1", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "c1Snapshot", "seoEvidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "c1Snapshot", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["lockedScope", "finalCardInputSnapshot", "canonicalC1", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["c1", "seoDraft", "evidenceLayer", "providerJobRef", "authorizationRef", "authorizationId"]),
    Object.freeze(["c1", "canonicalHandoff", "draftOnlySeo", "providerJobRef", "authorizationRef", "authorizationId"])
  ]),
  schemaPaths: Object.freeze({
    c2SoftwareInput: Object.freeze([
      Object.freeze(["$defs", "paidAuthorizationRef", "properties", "authorizationId"])
    ]),
    c2AssetLifecycle: Object.freeze([
      Object.freeze([
        "$defs", "canonicalC1Handoff", "properties", "draftOnlySeo", "properties", "providerJobRef",
        "properties", "authorizationRef", "properties", "authorizationId"
      ])
    ])
  })
});

/**
 * One public source for collector field semantics and the single C1 opaque-ID
 * exception that the schema generator materializes at explicit paths.
 */
export const C2_REFERENCE_SEMANTICS = Object.freeze({
  fields: C2_REFERENCE_FIELD_SEMANTICS,
  c1OpaqueAuthorizationId: C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS_VALUE
});
export const C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS = C2_REFERENCE_SEMANTICS.c1OpaqueAuthorizationId;

function isAllowedC1OpaqueAuthorizationId(value, pathSegments) {
  const text = String(value);
  const allowedPath = C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimeRootPrefixes.some((prefix) =>
    C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths.some((path) => {
      const expected = [...prefix, ...path];
      return expected.length === pathSegments.length && expected.every(
        (segment, index) => segment === pathSegments[index]
      );
    })
  );
  if (!allowedPath ||
      !isCanonicalC1AuthorizationId(text)) {
    return false;
  }
  return true;
}

function secretValueReason(value, pathSegments) {
  if (hasPercentEncodingBeyondDecodeDepth(value)) return "encoded content exceeds approved depth";
  const allowedOpaqueAuthorizationId = isAllowedC1OpaqueAuthorizationId(value, pathSegments);
  for (const text of secretScanCandidates(value)) {
    if (/\b(?:bearer|basic)\s+(?!(?:plant|extract|required|documentation|material|design)\b)[A-Za-z0-9._~+/=-]{3,}/i.test(text)) {
      return "authorization value";
    }
    if (/^(?:bearer|basic)[-_:](?=.*(?:token|key|secret|credential))[A-Za-z0-9._~+/-]{3,}$/i.test(text)) {
      return "authorization value";
    }
    if (/(?:^|[^A-Za-z0-9_])note\s*[:=]\s*(?:bearer|basic)(?:$|[^A-Za-z0-9_])/i.test(text)) {
      return "authorization value";
    }
    const assignmentPattern = /[=:]\s*(\S{0,192})/g;
    for (let match = assignmentPattern.exec(text); match; ) {
      const prefix = text.slice(Math.max(0, match.index - 64), match.index).trimEnd();
      const singleKey = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z0-9][A-Za-z0-9_-]*)$/)?.[1];
      const words = singleKey ? [singleKey] : [];
      const spacedSuffix = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*){1,2})$/)?.[1];
      if (spacedSuffix) words.push(...spacedSuffix.split(/\s+/).map((_, index, all) => all.slice(index).join(" ")));
      const forbiddenAssignment = words.some(isSensitiveAssignmentKey);
      const keyStart = singleKey ? match.index - singleKey.length : -1;
      const ampersandDelimited = keyStart > 0 && text[keyStart - 1] === "&";
      if (forbiddenAssignment && (ampersandDelimited || !isSafeSecretAssignmentValue(match[1])) &&
          !(allowedOpaqueAuthorizationId && text === value)) {
        return "secret assignment";
      }
      // Advance one delimiter at a time: a value such as `x=token=abc`
      // must not hide the later `token=abc` assignment behind the first `=`.
      assignmentPattern.lastIndex = match.index + 1;
      match = assignmentPattern.exec(text);
    }
    if (ENCODED_URL_USERINFO_PATTERN.test(text) || ENCODED_SCHEME_RELATIVE_USERINFO_PATTERN.test(text)) {
      return "URL userinfo";
    }
    const candidates = [text];
    if (text.startsWith("//")) candidates.push(`https:${text}`);
    else if (/^[/?#]/.test(text) || /[?#]/.test(text)) candidates.push(`https://schema.invalid/${text}`);
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate);
        if (parsed.username || parsed.password) return "URL userinfo";
        for (const key of [...parsed.searchParams.keys(), ...new URLSearchParams(parsed.hash.replace(/^#/, "")).keys()]) {
          if (isForbiddenSecretKey(key) ||
              CANONICAL_REFERENCE_SENSITIVE_NORMALIZED_KEYS.has(normalizeSecretKey(key))) {
            return "URL secret parameter";
          }
        }
      } catch {
        // Non-URL business text is validated by the explicit assignment patterns above.
      }
    }
  }
  return null;
}

export function collectProductionSecretErrors(value, path, errors, pathSegments = []) {
  const stack = [{ kind: "value", value, path, pathSegments, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [rawKey, entry] = next.value;
      const key = String(rawKey);
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      if (!current.isArray && isForbiddenSecretKey(key)) {
        errors.push({ path: childPath, message: "不得保存秘密字段" });
      }
      stack.push({
        kind: "value",
        value: entry,
        path: childPath,
        pathSegments: [...current.pathSegments, diagnosticSemanticSegment(key, current.isArray)],
        depth: current.depth + 1
      });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      errors.push({ path: current.path, message: PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED });
      return;
    }
    if (typeof current.value === "string") {
      const reason = secretValueReason(current.value, current.pathSegments);
      if (reason) errors.push({ path: current.path, message: `不得保存秘密：${reason}` });
      continue;
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) continue;
    stack.push({
      kind: "entries",
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      pathSegments: current.pathSegments,
      depth: current.depth
    });
  }
}

export function assertNoProductionSecrets(value, path = "productionAuthorization") {
  const errors = [];
  collectProductionSecretErrors(value, path, errors);
  if (errors.length > 0) {
    const secretPaths = errors
      .filter((item) => item.message !== PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
      .map((item) => item.path);
    if (secretPaths.length > 0) {
      throw new Error(formatC2ReferenceDiagnostic(
        "PRODUCTION_AUTHORIZATION_SECRET_REJECTED",
        secretPaths,
        "secret-rejected"
      ));
    }
    if (errors.some((item) => item.message === PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)) {
      throw new Error(formatC2ReferenceDiagnostic(
        PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
        errors.filter((item) => item.message === PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED).map((item) => item.path),
        "resource-limit"
      ));
    }
  }
  return value;
}

function asciiCaseInsensitive(value) {
  return [...value].map((character) => /[a-z]/i.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]`
    : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
}

const canonicalKeyPattern = (...words) => words.map(asciiCaseInsensitive).join("[._~-]*");
const canonicalObfuscatedWordPattern = (word) => [...word]
  .map(asciiCaseInsensitive)
  .join("[._~-]*");
const canonicalSensitiveNamespacePattern = `(?:${[
  ["authorization"], ["bearer"], ["basic"], ["password"], ["cookie"], ["cookies"],
  ["cookiejar"], ["headers"], ["request", "headers"], ["token"], ["token", "at"],
  ["secret"], ["secret", "at"], ["credential"], ["credentials"], ["credential", "at"],
  ["credentials", "at"], ["access", "token"], ["access", "token", "at"],
  ["refresh", "token"], ["refresh", "token", "at"], ["client", "secret"],
  ["client", "secret", "at"], ["session", "cookie"], ["session", "cookie", "at"],
  ["api", "key"], ["api", "key", "at"], ["signature"], ["signature", "at"],
  ["credential", "value"], ["credential", "secret"], ["credential", "token"],
  ["credential", "password"], ["raw", "response"], ["raw", "response", "at"],
  ["raw", "request"], ["raw", "request", "at"], ["request", "body"],
  ["response", "headers"], ["response", "headers", "at"], ["raw", "html"], ["raw", "payload"]
].map((words) => words.length === 1
  ? canonicalObfuscatedWordPattern(words[0])
  : canonicalKeyPattern(...words)).join("|")})`;
const canonicalReferenceSensitiveKeyPattern = `(?:${canonicalSensitiveNamespacePattern}|${[
  ["expires"], ["expires", "at"], ["expiry"], ["expiry", "at"],
  ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEY_ENTRIES.flatMap(({ words, atVariant }) => [
    words,
    ...(atVariant ? [[...words, "at"]] : [])
  ])
].map((words) => canonicalKeyPattern(...words)).join("|")})`;
const canonicalReferenceSensitivePathSegmentPattern =
  `(?:^|[/:])${canonicalReferenceSensitiveKeyPattern}(?::|/|$)`;
export const PERCENT_ENCODING_BEYOND_MAX_DEPTH_PATTERN_SOURCE =
  `%(?:25){${PERCENT_ENCODING_MAX_DECODE_DEPTH},}[0-9A-Fa-f]{2}`;
const ENCODED_URL_USERINFO_PATTERN = /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\r\n]*@/;
const ENCODED_SCHEME_RELATIVE_USERINFO_PATTERN = /(?:^|[^A-Za-z0-9+.-])\/\/[^/?#\r\n]*@/;

export const C2_REFERENCE_REJECTED_NONCANONICAL = "C2_REFERENCE_REJECTED_NONCANONICAL";
export const C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED = "C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED";
export const C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED = "C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED";
export const CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH = 1024;

export const C2_SOFTWARE_INPUT_C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE = [
  "^(?=.{27,256}$)authorization:c1-ai-draft:",
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[._~-]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~-]*$"
].join("");

export const C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE = [
  "^(?=.{27,256}$)authorization:c1-ai-draft:",
  "(?!.*[\\r\\n])",
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[._~-]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~-]*$"
].join("");
const C1_OPAQUE_AUTHORIZATION_ID_PATTERN = new RegExp(C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE);

export const C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE = [
  `^(?=.{1,${SAFE_FROZEN_REF_MAX_LENGTH}}$)`,
  "(?!.*//)",
  `(?!(?:${asciiCaseInsensitive("bearer")}|${asciiCaseInsensitive("basic")})(?:[._~@#+-]|$))`,
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[:/]|$))`,
  "[A-Za-z0-9][A-Za-z0-9._~:/@#+-]*$"
].join("");

export const CANONICAL_FROZEN_REF_PATTERN_SOURCE = [
  `^(?=.{1,${SAFE_FROZEN_REF_MAX_LENGTH}}$)`,
  "(?!.*[\\r\\n])",
  "(?!.*//)",
  `(?!(?:${asciiCaseInsensitive("bearer")}|${asciiCaseInsensitive("basic")})(?:[._~@#+-]|$))`,
  `(?!${canonicalReferenceSensitiveKeyPattern}(?:[:/]|$))`,
  `(?!.*${canonicalReferenceSensitivePathSegmentPattern})`,
  "[A-Za-z0-9][A-Za-z0-9._~:/@#+-]*$"
].join("");

const canonicalQueryPair = "[A-Za-z0-9._~-]+=[A-Za-z0-9._~-]+";
export const C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE = [
  `^(?=.{1,${CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH}}$)`,
  `(?!.*[?&]${canonicalReferenceSensitiveKeyPattern}=)`,
  "(?!.*(?:/\\.{1,2})(?:/|\\?|$))",
  "(?!https://[^/]+/.*//)",
  "https://",
  "(?!localhost(?:/|$))",
  "(?![^/]*\\.(?:localhost|local)(?:/|$))",
  "(?!(?:[0-9.]+|\\[[^\\]]+\\])(?:/|$))",
  "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+",
  "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
  "/[A-Za-z0-9._~!$'()*+,:@/-]+",
  `(?:\\?${canonicalQueryPair}(?:&${canonicalQueryPair})*)?$`
].join("");
export const CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE = [
  `^(?=.{1,${CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH}}$)`,
  "(?!.*[\\r\\n])",
  `(?!.*[?&]${canonicalReferenceSensitiveKeyPattern}=)`,
  `(?!.*${canonicalReferenceSensitivePathSegmentPattern})`,
  "(?!.*(?:/\\.{1,2})(?:/|\\?|$))",
  "(?!https://[^/]+/.*//)",
  "https://",
  "(?!localhost(?:/|$))",
  "(?![^/]*\\.(?:localhost|local)(?:/|$))",
  "(?!(?:[0-9.]+|\\[[^\\]]+\\])(?:/|$))",
  "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+",
  "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
  "/[A-Za-z0-9._~!$'()*+,:@/-]+",
  `(?:\\?${canonicalQueryPair}(?:&${canonicalQueryPair})*)?$`
].join("");

const CANONICAL_FROZEN_REF_PATTERN = new RegExp(CANONICAL_FROZEN_REF_PATTERN_SOURCE);
const CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN = new RegExp(CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE);
export const CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE =
  "^https://(?:localhost|[^/]*\\.(?:localhost|local|localdomain|lan|home|internal))(?:/|$)";

export const C2_REFERENCE_SCHEMA_DEFS = Object.freeze({
  canonicalFrozenRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE
  }),
  canonicalStableHttpsAssetRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  }),
  analysisAssetRef: Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({ $ref: "#/$defs/canonicalFrozenRef" }),
      Object.freeze({ $ref: "#/$defs/canonicalStableHttpsAssetRef" })
    ])
  }),
  c1OpaqueAuthorizationId: Object.freeze({
    type: "string",
    minLength: 27,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C2_SOFTWARE_INPUT_C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE
  })
});

export const C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS = Object.freeze({
  ...C2_REFERENCE_SCHEMA_DEFS,
  canonicalFrozenRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: CANONICAL_FROZEN_REF_PATTERN_SOURCE
  }),
  canonicalStableHttpsAssetRef: Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH,
    allOf: Object.freeze([
      Object.freeze({
        not: Object.freeze({
          pattern: CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE
        })
      })
    ]),
    pattern: CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  }),
  c1OpaqueAuthorizationId: Object.freeze({
    type: "string",
    minLength: 27,
    maxLength: SAFE_FROZEN_REF_MAX_LENGTH,
    pattern: C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE
  })
});

export function isCanonicalFrozenRef(value) {
  return typeof value === "string" && CANONICAL_FROZEN_REF_PATTERN.test(value);
}

export function assertCanonicalFrozenRef(value, path = "canonicalFrozenRef") {
  if (!isCanonicalFrozenRef(value)) throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  return value;
}

export function isCanonicalStableHttpsAssetRef(value) {
  return typeof value === "string" && CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN.test(value);
}

export function assertCanonicalStableHttpsAssetRef(value, path = "canonicalStableHttpsAssetRef") {
  if (!isCanonicalStableHttpsAssetRef(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

export function isCanonicalAnalysisAssetRef(value) {
  return isCanonicalFrozenRef(value) || isCanonicalStableHttpsAssetRef(value);
}

export function assertCanonicalAnalysisAssetRef(value, path = "analysisAssetRef") {
  if (!isCanonicalAnalysisAssetRef(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

export function isCanonicalC1AuthorizationId(value) {
  return typeof value === "string" && C1_OPAQUE_AUTHORIZATION_ID_PATTERN.test(value);
}

export function assertCanonicalC1AuthorizationId(value, path = "authorizationId") {
  if (!isCanonicalC1AuthorizationId(value)) {
    throw new Error(`${C2_REFERENCE_REJECTED_NONCANONICAL}:${path}`);
  }
  return value;
}

function isAnalysisAssetRefPath(pathSegments) {
  if (pathSegments.at(-1) !== "assetRef") return false;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (["assets", "assetRegions"].includes(pathSegments[index]) &&
        ["collected", "aiDrafts"].includes(pathSegments[index + 1])) return true;
  }
  return false;
}

function isCanonicalC2ReferenceValue(value, semanticKind, pathSegments) {
  if (semanticKind === "assetRef") {
    return isAnalysisAssetRefPath(pathSegments)
      ? isCanonicalAnalysisAssetRef(value)
      : isCanonicalStableHttpsAssetRef(value);
  }
  if (semanticKind === "authorizationId") {
    return isAllowedC1OpaqueAuthorizationId(value, pathSegments)
      ? isCanonicalC1AuthorizationId(value)
      : isCanonicalFrozenRef(value);
  }
  if (semanticKind === "sourceRef") {
    return isCanonicalFrozenRef(value) || isCanonicalStableHttpsAssetRef(value);
  }
  if (semanticKind === "canonicalFrozenRef") return isCanonicalFrozenRef(value);
  return true;
}

export function collectCanonicalC2ReferenceErrors(value, path = "$", semanticField = null, errors = []) {
  const stack = [{ kind: "value", value, path, semanticField, pathSegments: [], depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === "entries") {
      const next = current.iterator.next();
      if (next.done) continue;
      stack.push(current);
      const [rawKey, entry] = next.value;
      const key = String(rawKey);
      const childPath = appendC2DiagnosticPath(current.path, key, current.isArray);
      const childSemanticKind = current.isArray
        ? current.semanticField
        : key === "value" && C2_REFERENCE_SEMANTIC_KINDS.has(current.semanticField)
          ? current.semanticField
          : C2_REFERENCE_FIELD_SEMANTICS[key] || null;
      stack.push({
        kind: "value",
        value: entry,
        path: childPath,
        semanticField: childSemanticKind,
        pathSegments: [...current.pathSegments, semanticPathSegment(key, current.isArray)],
        depth: current.depth + 1
      });
      continue;
    }
    nodeCount += 1;
    if (current.depth > PRODUCTION_CONTRACT_MAX_DEPTH || nodeCount > PRODUCTION_CONTRACT_MAX_NODES) {
      errors.push({ path: current.path, message: C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED });
      return errors;
    }
    if (!Array.isArray(current.value) && !isObject(current.value)) {
      if (typeof current.value === "string" && current.semanticField !== null &&
          !isCanonicalC2ReferenceValue(current.value, current.semanticField, current.pathSegments)) {
        errors.push({ path: current.path, message: C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED });
      }
      continue;
    }
    stack.push({
      kind: "entries",
      iterator: ownEnumerableEntries(current.value),
      isArray: Array.isArray(current.value),
      path: current.path,
      semanticField: current.semanticField,
      pathSegments: current.pathSegments,
      depth: current.depth
    });
  }
  return errors;
}

export function assertCanonicalC2ReferenceTree(value, path = "productionAuthorizationPreparation") {
  const errors = collectCanonicalC2ReferenceErrors(value, path);
  if (errors.length > 0) {
    if (errors.some((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED)) {
      throw new Error(formatC2ReferenceDiagnostic(
        C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
        errors.filter((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED).map((item) => item.path),
        "resource-limit"
      ));
    }
    throw new Error(formatC2ReferenceDiagnostic(
      C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED,
      errors.filter((item) => item.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED).map((item) => item.path),
      "migration-required"
    ));
  }
  return value;
}
