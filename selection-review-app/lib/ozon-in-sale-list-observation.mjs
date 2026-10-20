import { isCompleteStoreRef } from './store-binding.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord, isCanonicalFrozenRef, isOpaqueProductionSourceRef } from './production-contract-primitives.mjs';

export const OZON_IN_SALE_LIST_ENDPOINT = '/v3/product/list';
export const OZON_IN_SALE_LIST_PROTOCOL_VERSION = 'ozon-in-sale-list-v1';
export const OZON_IN_SALE_LIST_OFFICIAL_EVIDENCE_REF = 'official:ozon-in-sale-list:20261018';
const SCOPE_VERSION = 'ozon-in-sale-list-scope-v1';
const JOB_VERSION = 'ozon-in-sale-list-job-v1';
const QUERY_VERSION = 'ozon-in-sale-list-page-query-v1';
const PAGE_VERSION = 'ozon-in-sale-list-page-v1';
const scopeFields = ['schemaVersion','batchId','authorizationRef','officialEvidenceRef','accountEvidenceRef','storeRef','warehouseRef',
  'warehouseId','credentialAlias','bindingId','configurationVersion','targets'];
const targetFields = ['candidateId','skuPackageId','sourceRevision','sourceRecordId','authorizationId',
  'authorizationFingerprint','offerId','productId'];
const jobFields = ['schemaVersion','jobId','scope','policy','workerId','workerVersion','leaseId','leaseExpiresAt',
  'createdAt','updatedAt','deadlineAt','status','requestCount','nextLastId','attempts','matches','stopReason'];
const queryFields = ['schemaVersion','jobId','requestId','sequence','scope','lastId','limit','deadlineAt'];
const pageFields = ['schemaVersion','jobId','requestId','sequence','requestedLastId','returnedLastId','itemCount',
  'matchedItems','pageIdentityFingerprint','observedAt','officialEvidenceRef'];
const attemptFields = ['sequence','requestId','requestedAt','lastId','limit','status','requestTransmission',
  'receivedAt','returnedLastId','itemCount','matchedItems','pageIdentityFingerprint','failureCode'];
const stopReasons = new Set(['deadline_exhausted','lease_expired','page_limit','cursor_stalled','cursor_empty',
  'empty_page','repeated_page','source_changed','permission_unavailable','worker_not_current','cancelled',
  'read_interrupted','transport_failure','request_timeout','platform_data_invalid','system_failure']);
const object = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value, fields) => object(value) && Reflect.ownKeys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value,field) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,field),'value'));
const ref = value => typeof value === 'string' && value.length > 0 && isCanonicalFrozenRef(value);
// External offer IDs are business strings; this is a local response capacity, not an official ID format.
const externalOfferId = value => typeof value === 'string' && value.length <= 1024 && value.trim().length > 0 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const cursor = value => typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) &&
  value.length <= 16 && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => structuredClone(value);
const requireValue = (value, code) => { if (!value) throw new Error(`OZON_IN_SALE_LIST_${code}`); };
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
const unique = values => new Set(values).size === values.length;
const matchedPair = value => closed(value,['offerId','productId']) && ref(value.offerId) && id(value.productId);
const scopeHasPair = (scope, pair) => scope.targets.some(target => target.offerId === pair.offerId && target.productId === pair.productId);

/** This is the frozen scope of one approved batch read, not a permission inferred from account roles. */
export function assertInSaleListScope(scope) {
  // Composite production IDs are opaque persisted identities; leaf references retain their canonical limits.
  requireValue(closed(scope,scopeFields) && scope.schemaVersion === SCOPE_VERSION &&
    ['batchId','accountEvidenceRef','warehouseRef','credentialAlias','bindingId','configurationVersion'].every(field => ref(scope[field])) &&
    isOpaqueProductionSourceRef(scope.authorizationRef) && scope.authorizationRef === `${scope.batchId}:in-sale-list` &&
    scope.officialEvidenceRef === OZON_IN_SALE_LIST_OFFICIAL_EVIDENCE_REF &&
    isCompleteStoreRef(scope.storeRef,scope.storeRef?.stableStoreId) && id(scope.warehouseId) &&
    Array.isArray(scope.targets) && scope.targets.length > 0 &&
    scope.targets.every(target => closed(target,targetFields) &&
      ['candidateId','skuPackageId','offerId'].every(field => ref(target[field])) &&
      ['authorizationId','sourceRecordId'].every(field => isOpaqueProductionSourceRef(target[field])) &&
      Number.isSafeInteger(target.sourceRevision) && target.sourceRevision > 0 && id(target.productId) && fingerprint(target.authorizationFingerprint)) &&
    ['candidateId','skuPackageId','sourceRecordId','offerId','productId'].every(field => unique(scope.targets.map(target => target[field]))), 'SCOPE_INVALID');
  assertSafeRuntimeRecord(scope,'ozonInSaleListScope');
  return scope;
}

/** Explicit approved limits; these caps are implementation capacity, never production defaults. */
export function assertInSaleListPolicy(policy) {
  requireValue(closed(policy,['pageSize','maxPages','requestTimeoutMs','durationMs']) &&
    Object.values(policy).every(value => Number.isSafeInteger(value) && value > 0) &&
    policy.pageSize <= 1000 && policy.maxPages <= 3 && policy.requestTimeoutMs <= 30_000 &&
    policy.durationMs <= 90_000 && policy.requestTimeoutMs <= policy.durationMs, 'POLICY_INVALID');
  return policy;
}

export function assertInSaleListJob(job) {
  requireValue(closed(job,jobFields) && job.schemaVersion === JOB_VERSION, 'JOB_INVALID');
  assertInSaleListScope(job.scope); assertInSaleListPolicy(job.policy);
  requireValue(job.jobId === `${job.scope.authorizationRef}:job` && ['workerId','workerVersion','leaseId'].every(field => ref(job[field])) &&
    ['leaseExpiresAt','createdAt','updatedAt','deadlineAt'].every(field => time(job[field])) &&
    Date.parse(job.leaseExpiresAt) > Date.parse(job.createdAt) && Date.parse(job.updatedAt) >= Date.parse(job.createdAt) &&
    job.deadlineAt === new Date(Date.parse(job.createdAt) + job.policy.durationMs).toISOString() &&
    ['queued','page_in_flight','page_observed','matched','stopped','failed'].includes(job.status) &&
    Number.isSafeInteger(job.requestCount) && job.requestCount >= 0 && job.requestCount <= job.policy.maxPages &&
    Array.isArray(job.attempts) && job.attempts.length === job.requestCount && cursor(job.nextLastId) &&
    Array.isArray(job.matches) && job.matches.length <= job.scope.targets.length &&
    job.matches.every(match => closed(match,['offerId','productId','requestId','observedAt']) &&
      matchedPair({offerId:match.offerId,productId:match.productId}) && scopeHasPair(job.scope,match) &&
      isOpaqueProductionSourceRef(match.requestId) && time(match.observedAt)) &&
    unique(job.matches.map(match => match.offerId)) &&
    (['stopped','failed'].includes(job.status) ? stopReasons.has(job.stopReason) : job.stopReason === null), 'JOB_INVALID');
  job.attempts.forEach((attempt,index) => {
    requireValue(closed(attempt,attemptFields) && attempt.sequence === index + 1 &&
      attempt.requestId === `${job.jobId}:page:${attempt.sequence}` && time(attempt.requestedAt) &&
      Date.parse(attempt.requestedAt) >= Date.parse(job.createdAt) && Date.parse(attempt.requestedAt) <= Date.parse(job.updatedAt) &&
      Date.parse(attempt.requestedAt) < Date.parse(job.deadlineAt) &&
      cursor(attempt.lastId) && attempt.lastId === (index === 0 ? '' : job.attempts[index - 1].returnedLastId) &&
      attempt.limit === job.policy.pageSize && ['intent','observed','failed'].includes(attempt.status) &&
      ['not_attempted','possibly_sent','response_received'].includes(attempt.requestTransmission) &&
      Array.isArray(attempt.matchedItems) && attempt.matchedItems.every(pair => matchedPair(pair) && scopeHasPair(job.scope,pair)) &&
      unique(attempt.matchedItems.map(pair => pair.offerId)), 'ATTEMPT_INVALID');
    if (attempt.status === 'observed') {
      requireValue(attempt.requestTransmission === 'response_received' && time(attempt.receivedAt) &&
        Date.parse(attempt.receivedAt) >= Date.parse(attempt.requestedAt) && Date.parse(attempt.receivedAt) <= Date.parse(job.updatedAt) && cursor(attempt.returnedLastId) &&
        Number.isSafeInteger(attempt.itemCount) && attempt.itemCount >= attempt.matchedItems.length && attempt.itemCount <= attempt.limit &&
        fingerprint(attempt.pageIdentityFingerprint) && attempt.failureCode === null, 'ATTEMPT_INVALID');
    } else {
      requireValue(attempt.receivedAt === null && attempt.returnedLastId === null && attempt.itemCount === null &&
        attempt.matchedItems.length === 0 && attempt.pageIdentityFingerprint === null &&
        (attempt.status === 'failed' ? stopReasons.has(attempt.failureCode) : attempt.failureCode === null), 'ATTEMPT_INVALID');
    }
    requireValue(index === job.attempts.length - 1 || attempt.status === 'observed', 'ATTEMPT_SEQUENCE_INVALID');
  });
  const last = job.attempts.at(-1);
  requireValue((job.status !== 'queued' || job.requestCount === 0 && job.matches.length === 0 && job.nextLastId === '') &&
    (job.status !== 'page_in_flight' || last?.status === 'intent' && job.nextLastId === last.lastId) &&
    (job.status !== 'page_observed' || last?.status === 'observed' && job.nextLastId === last.returnedLastId && job.nextLastId !== '') &&
    (job.status !== 'matched' || last?.status === 'observed' && job.matches.length === job.scope.targets.length) &&
    job.matches.every(match => job.attempts.some(attempt => attempt.status === 'observed' && attempt.requestId === match.requestId &&
      attempt.receivedAt === match.observedAt && attempt.matchedItems.some(pair => pair.offerId === match.offerId && pair.productId === match.productId))), 'JOB_STATE_INVALID');
  assertSafeRuntimeRecord(job,'ozonInSaleListJob');
  return job;
}

export function createInSaleListJob({scope,policy,workerId,workerVersion,leaseId,leaseExpiresAt,createdAt}) {
  assertInSaleListScope(scope); assertInSaleListPolicy(policy);
  requireValue(time(createdAt),'CLOCK_INVALID');
  return frozen(assertInSaleListJob({schemaVersion:JOB_VERSION,jobId:`${scope.authorizationRef}:job`,scope:clone(scope),policy:clone(policy),
    workerId,workerVersion,leaseId,leaseExpiresAt,createdAt,updatedAt:createdAt,
    deadlineAt:new Date(Date.parse(createdAt)+policy.durationMs).toISOString(),status:'queued',requestCount:0,nextLastId:'',attempts:[],matches:[],stopReason:null}));
}

function held(job,workerId,leaseId,at,{allowExpired=false}={}) {
  assertInSaleListJob(job);
  requireValue(workerId === job.workerId && leaseId === job.leaseId && time(at) && Date.parse(at) >= Date.parse(job.updatedAt), 'LEASE_INVALID');
  if (!allowExpired) requireValue(Date.parse(at) < Date.parse(job.leaseExpiresAt) && Date.parse(at) < Date.parse(job.deadlineAt), 'DEADLINE_EXPIRED');
}

/** Persist the returned state atomically before constructing or sending the page request. */
export function beginInSaleListPage({job,workerId,leaseId,at}) {
  held(job,workerId,leaseId,at);
  requireValue(['queued','page_observed'].includes(job.status) && job.requestCount < job.policy.maxPages, 'PAGE_NOT_ADMITTED');
  const next=clone(job),sequence=next.requestCount+1;
  next.attempts.push({sequence,requestId:`${next.jobId}:page:${sequence}`,requestedAt:at,lastId:next.nextLastId,limit:next.policy.pageSize,
    status:'intent',requestTransmission:'not_attempted',receivedAt:null,returnedLastId:null,itemCount:null,matchedItems:[],pageIdentityFingerprint:null,failureCode:null});
  next.requestCount=sequence;next.status='page_in_flight';next.updatedAt=at;
  return frozen(assertInSaleListJob(next));
}

/** Called by the persisted final-send guard. Possibly sent is intentionally conservative. */
export function markInSaleListPageSending({job,workerId,leaseId,at}) {
  held(job,workerId,leaseId,at);
  requireValue(job.status === 'page_in_flight' && job.attempts.at(-1).requestTransmission === 'not_attempted', 'SEND_NOT_ADMITTED');
  const next=clone(job);next.attempts.at(-1).requestTransmission='possibly_sent';next.updatedAt=at;
  return frozen(assertInSaleListJob(next));
}

export function assertInSaleListPageQuery(query) {
  requireValue(closed(query,queryFields) && query.schemaVersion === QUERY_VERSION, 'QUERY_INVALID');
  assertInSaleListScope(query.scope);
  requireValue(query.jobId === `${query.scope.authorizationRef}:job` && Number.isSafeInteger(query.sequence) && query.sequence > 0 && query.sequence <= 3 &&
    query.requestId === `${query.jobId}:page:${query.sequence}` && cursor(query.lastId) && (query.sequence === 1 ? query.lastId === '' : query.lastId !== '') &&
    Number.isSafeInteger(query.limit) && query.limit > 0 && query.limit <= 1000 && time(query.deadlineAt), 'QUERY_INVALID');
  return query;
}

export function buildInSaleListPageQuery(job) {
  assertInSaleListJob(job);requireValue(job.status === 'page_in_flight','PAGE_NOT_ADMITTED');
  const attempt=job.attempts.at(-1);
  return frozen(assertInSaleListPageQuery({schemaVersion:QUERY_VERSION,jobId:job.jobId,requestId:attempt.requestId,sequence:attempt.sequence,
    scope:clone(job.scope),lastId:attempt.lastId,limit:attempt.limit,deadlineAt:job.deadlineAt}));
}

/** Deliberately excludes all identifier filters: Ozon ignores visibility with offer_id/product_id. */
export function assertInSaleListRequestBody(body) {
  requireValue(closed(body,['filter','last_id','limit']) && closed(body.filter,['visibility']) && body.filter.visibility === 'IN_SALE' &&
    cursor(body.last_id) && Number.isSafeInteger(body.limit) && body.limit > 0 && body.limit <= 1000,'REQUEST_BODY_INVALID');
  return body;
}

export function normalizeInSaleListPage({query,response,observedAt}) {
  assertInSaleListPageQuery(query);
  requireValue(time(observedAt),'CLOCK_INVALID');
  requireValue(object(response) && object(response.result) && Array.isArray(response.result.items) &&
    response.result.items.length <= query.limit && cursor(response.result.last_id),'RESPONSE_INVALID');
  const identities=response.result.items.map(item => {
    requireValue(object(item) && externalOfferId(item.offer_id) && typeof item.product_id === 'number' && Number.isSafeInteger(item.product_id) && item.product_id > 0 &&
      (!Object.hasOwn(item,'archived') || typeof item.archived === 'boolean'),'RESPONSE_IDENTITY_INVALID');
    const pair={offerId:item.offer_id,productId:String(item.product_id)};
    requireValue(!scopeHasPair(query.scope,pair) || item.archived !== true,'RESPONSE_IDENTITY_CONFLICT');
    return pair;
  });
  requireValue(unique(identities.map(pair => JSON.stringify([pair.offerId,pair.productId]))),'RESPONSE_DUPLICATE_IDENTITY');
  for (const pair of identities) requireValue(!query.scope.targets.some(target =>
    (target.offerId === pair.offerId || target.productId === pair.productId) &&
    (target.offerId !== pair.offerId || target.productId !== pair.productId)), 'RESPONSE_IDENTITY_CONFLICT');
  // Detect accidental repeated pagination pages without persisting unrelated product identities.
  const result={schemaVersion:PAGE_VERSION,jobId:query.jobId,requestId:query.requestId,sequence:query.sequence,
    requestedLastId:query.lastId,returnedLastId:response.result.last_id,itemCount:identities.length,
    matchedItems:identities.filter(pair => scopeHasPair(query.scope,pair)),pageIdentityFingerprint:fingerprintCanonicalRecord(identities),
    observedAt,officialEvidenceRef:query.scope.officialEvidenceRef};
  assertSafeRuntimeRecord(result,'ozonInSaleListPage');
  return frozen(result);
}

export function applyInSaleListPageResult({job,result,workerId,leaseId,at}) {
  held(job,workerId,leaseId,at,{allowExpired:true});
  const attempt=job.attempts.at(-1);
  requireValue(job.status === 'page_in_flight' && attempt.requestTransmission === 'possibly_sent' && closed(result,pageFields) &&
    result.schemaVersion === PAGE_VERSION && result.jobId === job.jobId && result.requestId === attempt.requestId && result.sequence === attempt.sequence &&
    result.requestedLastId === attempt.lastId && cursor(result.returnedLastId) && Number.isSafeInteger(result.itemCount) && result.itemCount >= 0 && result.itemCount <= attempt.limit &&
    Array.isArray(result.matchedItems) && result.matchedItems.length <= result.itemCount && result.matchedItems.every(pair => matchedPair(pair) && scopeHasPair(job.scope,pair)) &&
    unique(result.matchedItems.map(pair => pair.offerId)) && fingerprint(result.pageIdentityFingerprint) &&
    result.officialEvidenceRef === job.scope.officialEvidenceRef && time(result.observedAt) &&
    Date.parse(result.observedAt) >= Date.parse(attempt.requestedAt) && Date.parse(result.observedAt) <= Date.parse(at),'PAGE_RESULT_INVALID');
  const next=clone(job),last=next.attempts.at(-1);
  Object.assign(last,{status:'observed',requestTransmission:'response_received',receivedAt:result.observedAt,returnedLastId:result.returnedLastId,
    itemCount:result.itemCount,matchedItems:clone(result.matchedItems),pageIdentityFingerprint:result.pageIdentityFingerprint});
  for(const pair of result.matchedItems) if(!next.matches.some(match=>match.offerId===pair.offerId))
    next.matches.push({...pair,requestId:result.requestId,observedAt:result.observedAt});
  next.updatedAt=at;next.nextLastId=result.returnedLastId;
  const reason=Date.parse(at)>=Date.parse(job.deadlineAt)?'deadline_exhausted':Date.parse(at)>=Date.parse(job.leaseExpiresAt)?'lease_expired':
    next.matches.length===next.scope.targets.length?null:result.itemCount===0?'empty_page':
    job.attempts.some(page=>page.pageIdentityFingerprint===result.pageIdentityFingerprint)?'repeated_page':
    result.returnedLastId===''?'cursor_empty':job.attempts.some(page=>page.lastId===result.returnedLastId)?'cursor_stalled':
    next.requestCount>=next.policy.maxPages?'page_limit':null;
  next.status=reason?'stopped':next.matches.length===next.scope.targets.length?'matched':'page_observed';next.stopReason=reason;
  return frozen(assertInSaleListJob(next));
}

/** A failed/interrupted attempt retains its budget and cannot be resumed by creating another page. */
export function stopInSaleListJob({job,workerId,leaseId,at,reason,requestTransmission=null}) {
  held(job,workerId,leaseId,at,{allowExpired:true});
  requireValue(['queued','page_in_flight','page_observed'].includes(job.status) && stopReasons.has(reason),'STOP_INVALID');
  const next=clone(job),last=next.attempts.at(-1);
  if(job.status==='page_in_flight') {
    requireValue(['not_attempted','possibly_sent','response_received'].includes(requestTransmission) &&
      (reason!=='read_interrupted'||requestTransmission===last.requestTransmission),'TRANSMISSION_INVALID');
    Object.assign(last,{status:'failed',requestTransmission,failureCode:reason});
  } else requireValue(requestTransmission===null,'TRANSMISSION_INVALID');
  next.status=['read_interrupted','transport_failure','request_timeout','platform_data_invalid','system_failure'].includes(reason)?'failed':'stopped';next.stopReason=reason;next.updatedAt=at;
  return frozen(assertInSaleListJob(next));
}
