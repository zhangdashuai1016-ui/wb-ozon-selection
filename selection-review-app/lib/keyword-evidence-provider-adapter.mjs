import { classifyKeywordSourceFailure, validateKeywordSourceAttempt } from "./keyword-evidence-snapshot.mjs";

const CHANNELS = new Set(["api", "browser"]);
const SECRET_FIELD = /(^|_)(token|cookie|password|secret|authorization|api_?key)($|_)/i;

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function iso(value) { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }

function assertNoSecrets(value, path = "providerReceipt") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`KEYWORD_PROVIDER_SECRET_FORBIDDEN:${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function normalizeTransportReceipt(channel, request, receipt) {
  assertNoSecrets(receipt);
  if (!CHANNELS.has(channel) || !isObject(receipt) || !isObject(receipt.observation) || !Array.isArray(receipt.candidates)) {
    throw new Error("KEYWORD_PROVIDER_TRANSPORT_RECEIPT_INVALID");
  }
  const observation = { ...receipt.observation, channel };
  const failureClass = classifyKeywordSourceFailure(observation);
  const resultCount = observation.resultCount;
  if (failureClass === null && !(observation.completed === true && Number.isInteger(resultCount) && resultCount > 0)) {
    throw new Error("KEYWORD_PROVIDER_TRANSPORT_OUTCOME_UNCLASSIFIED");
  }
  if (failureClass === "true_empty" && receipt.candidates.length !== 0) throw new Error("KEYWORD_PROVIDER_TRUE_EMPTY_CANDIDATES_FORBIDDEN");
  if (failureClass !== null && failureClass !== "true_empty" && receipt.candidates.length !== 0) throw new Error("KEYWORD_PROVIDER_FAILURE_CANDIDATES_FORBIDDEN");
  if (failureClass === null && receipt.candidates.length !== resultCount) throw new Error("KEYWORD_PROVIDER_RESULT_COUNT_MISMATCH");
  const technical = failureClass !== null && failureClass !== "true_empty";
  const completedAt = technical ? null : observation.completedAt;
  const attempt = {
    schemaVersion: "keyword-source-attempt-v1",
    attemptId: observation.attemptId,
    provider: observation.provider,
    channel,
    queryId: observation.queryId,
    queryText: request.queryText,
    locale: request.locale,
    targetPlatform: request.targetPlatform,
    requestId: observation.requestId ?? null,
    receiptId: observation.receiptId ?? null,
    startedAt: observation.startedAt,
    completedAt,
    status: technical ? "failed" : "completed",
    resultCount: technical ? null : resultCount,
    failureClass,
    failureStage: observation.failureStage ?? null,
    traceRef: observation.traceRef
  };
  const validation = validateKeywordSourceAttempt(attempt);
  if (!validation.valid) throw new Error(`KEYWORD_PROVIDER_ATTEMPT_INVALID:${validation.errors.map((item) => item.message).join(";")}`);
  const candidates = receipt.candidates.map((candidate) => ({ ...structuredClone(candidate), sourceRefs: [...new Set([...(candidate.sourceRefs ?? []), attempt.attemptId])] }));
  return {
    attempt,
    candidates,
    pointsBefore: receipt.pointsBefore ?? null,
    pointsAfter: receipt.pointsAfter ?? null,
    pointsSpent: receipt.pointsSpent ?? null,
    providerEvidence: receipt.evidence === undefined ? null : structuredClone(receipt.evidence)
  };
}

export function createSeerfarKeywordProviderAdapter({ openApiTransport, browserTransport, standardSkuHealthTransport } = {}) {
  const calls = { api: 0, browser: 0, standardSkuHealth: 0 };
  const once = (channel, transport) => async ({ input, attemptLimit }) => {
    calls[channel] += 1;
    if (calls[channel] > 1 || attemptLimit !== 1) throw new Error(`KEYWORD_PROVIDER_ATTEMPT_LIMIT_EXCEEDED:${channel}`);
    if (typeof transport !== "function") throw new Error(`KEYWORD_PROVIDER_TRANSPORT_MISSING:${channel}`);
    const request = {
      queryText: input.exactSku,
      locale: input.locale ?? "und",
      targetPlatform: input.platform,
      exactSku: input.exactSku,
      fulfillment: input.fulfillment,
      identity: structuredClone(input.identity),
      seerfarRequest: input.seerfarRequest === undefined ? null : structuredClone(input.seerfarRequest),
      attemptLimit: 1
    };
    return normalizeTransportReceipt(channel, request, await transport(request));
  };
  return {
    calls,
    providers: {
      seerfarApi: once("api", openApiTransport),
      browser: once("browser", browserTransport),
      standardSkuHealth: async (request) => {
        calls.standardSkuHealth += 1;
        if (calls.standardSkuHealth > 3) throw new Error("KEYWORD_STANDARD_SKU_ATTEMPT_LIMIT_EXCEEDED");
        if (typeof standardSkuHealthTransport !== "function") throw new Error("KEYWORD_STANDARD_SKU_TRANSPORT_MISSING");
        const receipt = await standardSkuHealthTransport(structuredClone(request));
        assertNoSecrets(receipt, "healthReceipt");
        return structuredClone(receipt);
      }
    }
  };
}
