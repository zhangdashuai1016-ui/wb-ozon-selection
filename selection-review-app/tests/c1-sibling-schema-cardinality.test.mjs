import test from 'node:test';
import assert from 'node:assert/strict';
import { assertC1SiblingSchemaCompatibility } from '../lib/c1-sibling-neutral-copy.mjs';
import { createC1ProductPlan, validatePlatformSchemaEvidence, verifyC1ProductFacts } from '../lib/c1-product-plan.mjs';
import { buildC1AiDraftRequest, mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitSiblingBatchC1Preparation, previewSiblingBatchC1Preparation } from '../lib/sibling-batch-c1-preparation.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { validateFinalProductPlanConfirmationCard } from '../lib/final-product-plan-confirmation-card.mjs';
import { attachTerraAuxiliaryDraft, SALES_SNAPSHOT_SCHEMA_VERSION, TERRA_AUXILIARY_DRAFT_VERSION } from '../lib/sales-snapshot.mjs';
import { normalizeSoftwareJobScopeKey } from '../lib/software-job-admission.mjs';
import { bindSoftwareJobAdmissionDecision, claimSoftwareJobLease, markSoftwareJobExternalRequestStarted,
  settleSoftwareJob, createSoftwareJobResultEnvelope } from '../lib/software-job-contract.mjs';
import { at, threeColorFixture } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { createFormalC1DraftFixture } from './fixtures/formal-c1-flow-fixture.mjs';
import { authorizedExecution, settledExecution } from './fixtures/c1-ai-draft-fixture.mjs';
import { c1AiSoftwareJobFixture } from './fixtures/c1-ai-software-job-fixture.mjs';
import { finalAssets } from './helpers/c2-software-fixture.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';

const material = { value: 'synthetic material', dictionaryValueId: 61979 };
const secondMaterial = { value: 'synthetic second material', dictionaryValueId: 61980 };
const materialAttribute = { fieldKey: '4967', label: 'Материал', required: false,
  dictionaryId: 1503, isCollection: true, attributeType: 'String', complexId: 0 };
const confirmedFact = value => ({ value: structuredClone(value), verificationStatus: 'confirmed',
  sourceRefs: ['synthetic:confirmed-material'] });

function compatibilityFixture({ value = material, collection = true, maximum = 2, dictionaryId = 1503 } = {}) {
  const schema = { evidenceId: 'schema:synthetic:old', schemaRevision: 'revision:synthetic:old',
    platform: 'ozon', store: 'synthetic-store',
    storeRef: { stableStoreId: 'synthetic-store', platformStoreId: 'synthetic-seller', mappingVersion: 'synthetic-stores-v1' },
    descriptionCategoryId: '17028966', typeId: '96063', categoryName: 'Одежда для животных',
    collectedAt: at, requiredFields: [],
    attributes: [{ ...materialAttribute, isCollection: collection, dictionaryId }] };
  const sourcePlan = { inputSnapshots: { platformSchemaRules: schema },
    productAttributes: { ozonAttributes: [{ fieldKey: '4967', fact: confirmedFact(value) }] } };
  const targetPlan = structuredClone(sourcePlan);
  const current = targetPlan.inputSnapshots.platformSchemaRules;
  Object.assign(current, { evidenceId: 'schema:synthetic:current', schemaRevision: 'revision:synthetic:current' });
  current.attributes[0].maxValueCount = maximum;
  targetPlan.schemaSnapshotRef = current.evidenceId;
  targetPlan.inputRefs = { platformSchemaEvidenceId: current.evidenceId };
  targetPlan.frozenInputRefs = { schemaSnapshotRef: current.evidenceId };
  // The mapping step runs before the target has any adopted Ozon facts.
  targetPlan.productAttributes.ozonAttributes = [];
  assert.equal(validatePlatformSchemaEvidence(current).valid, true);
  return { sourcePlan, targetPlan, attributeIds: ['4967'] };
}

function assertCompatibilityRejected(input, code) {
  const before = structuredClone(input);
  assert.throws(() => assertC1SiblingSchemaCompatibility(input), { message: code });
  assert.deepEqual(input, before);
}

for (const [name, options] of [
  ['single dictionary object at collection limit one', { maximum: 1 }],
  ['dictionary array at its current limit', { value: [material, secondMaterial], maximum: 2 }],
  ['dictionary scalar with a noncollection zero', { collection: false, maximum: 0 }],
  ['text scalar with a noncollection zero', { collection: false, maximum: 0, dictionaryId: 0, value: 'synthetic model' }],
  ['text scalar with a noncollection one', { collection: false, maximum: 1, dictionaryId: 0, value: 'synthetic model' }]
]) {
  test(`schema enrichment accepts ${name} without rewriting saved facts or metadata`, () => {
    const input = compatibilityFixture(options), before = structuredClone(input);
    assertC1SiblingSchemaCompatibility(input);
    assert.deepEqual(input, before);
    assert.equal(Object.hasOwn(input.sourcePlan.inputSnapshots.platformSchemaRules.attributes[0], 'maxValueCount'), false);
    assert.deepEqual(input.targetPlan.productAttributes.ozonAttributes, []);
  });
}

test('historical equal definitions still work and known bounds cannot be changed or removed', () => {
  const equal = compatibilityFixture();
  delete equal.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount;
  assertC1SiblingSchemaCompatibility(equal);
  equal.sourcePlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount = 2;
  equal.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount = 2;
  assertC1SiblingSchemaCompatibility(equal);
  for (const maximum of [1, 3, undefined, null]) {
    const changed = structuredClone(equal);
    changed.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount = maximum;
    assertCompatibilityRejected(changed, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
  }
  delete equal.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount;
  assertCompatibilityRejected(equal, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
});

test('own undefined or null historical bounds are not an absent field', () => {
  for (const maximum of [undefined, null]) {
    const input = compatibilityFixture();
    input.sourcePlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount = maximum;
    assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
  }
});

test('invalid new bounds fail instead of being treated as unlimited', () => {
  for (const maximum of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, undefined, null]) {
    const input = compatibilityFixture();
    input.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount = maximum;
    assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
  }
});

test('added collection bound checks the confirmed source value shape, count and dictionary identity', () => {
  for (const options of [
    { maximum: 0 }, { maximum: 1, value: [material, secondMaterial] }, { value: [] },
    { value: [material, material] }, { value: [material, { ...secondMaterial, dictionaryValueId: 61979 }] },
    { value: [{ value: 'missing id' }] }, { value: [{ ...material, dictionaryValueId: 0 }] },
    { value: [{ ...material, dictionaryValueId: 1.5 }] },
    { value: [{ ...material, dictionaryValueId: Number.MAX_SAFE_INTEGER + 1 }] },
    { value: [{ ...material, value: ' ' }] }, { value: ['synthetic material'] },
    { value: [[material]] }, { value: [null] }, { value: 'unmapped material' },
    { dictionaryId: 0 }, { collection: false, maximum: 0, value: [material] },
    { collection: false, maximum: 2, value: [material, secondMaterial] }
  ]) {
    assertCompatibilityRejected(compatibilityFixture(options), 'C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED');
  }
});

test('new noncollection metadata only accepts the existing scalar submission shapes', () => {
  for (const options of [
    { value: { value: 'missing dictionary id' } },
    { value: { ...material, dictionaryValueId: -1 } },
    { value: { ...material, dictionaryValueId: Number.MAX_SAFE_INTEGER + 1 } },
    { value: { ...material, value: ' ' } }, { value: { bad: 'invalid' } }, { value: true },
    { dictionaryId: 0, value: true }, { dictionaryId: 0, value: { bad: 'invalid' } },
    { dictionaryId: 0, value: { value: undefined } }, { dictionaryId: 0, value: NaN },
    { dictionaryId: 0, value: Infinity }
  ]) {
    assertCompatibilityRejected(compatibilityFixture({ collection: false, maximum: 0, ...options }),
      'C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED');
  }
  for (const value of [0, 150, { value: 'synthetic free text' }]) {
    const input = compatibilityFixture({ collection: false, maximum: 0, dictionaryId: 0, value });
    const before = structuredClone(input);
    assertC1SiblingSchemaCompatibility(input);
    assert.deepEqual(input, before);
  }
});

test('new bounds also validate the actual required value rather than a valid optional shadow', () => {
  const input = compatibilityFixture({ maximum: 3 });
  for (const plan of [input.sourcePlan, input.targetPlan]) {
    plan.inputSnapshots.platformSchemaRules.attributes[0].required = true;
    plan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: '4967', label: 'Материал', required: true }];
  }
  const values = [material, secondMaterial, { value: 'synthetic third', dictionaryValueId: 61981 }];
  input.sourcePlan.productAttributes.requiredPlatformFields = [{ fieldKey: '4967', fact: confirmedFact(values) }];
  const before = structuredClone(input);
  assertC1SiblingSchemaCompatibility(input);
  assert.deepEqual(input, before);
  for (const [change, code] of [
    [row => { row.fact.value.push({ value: 'synthetic fourth', dictionaryValueId: 61982 }); }, 'C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED'],
    [row => { row.fact.value[1].dictionaryValueId = row.fact.value[0].dictionaryValueId; }, 'C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED'],
    [row => { row.fact.verificationStatus = 'unknown'; }, 'C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED'],
    [row => { row.fact.sourceRefs = []; }, 'C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED'],
    [row => { row.fact.sourceRefs = [' ']; }, 'C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED']
  ]) {
    const changed = structuredClone(input); change(changed.sourcePlan.productAttributes.requiredPlatformFields[0]);
    assertCompatibilityRejected(changed, code);
  }
  const duplicate = structuredClone(input);
  duplicate.sourcePlan.productAttributes.requiredPlatformFields.push(structuredClone(duplicate.sourcePlan.productAttributes.requiredPlatformFields[0]));
  assertCompatibilityRejected(duplicate, 'C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
});

test('new bounds require a unique, confirmed and traceable adopted source fact', () => {
  for (const change of [
    plan => { delete plan.productAttributes.ozonAttributes; },
    plan => { plan.productAttributes.ozonAttributes = []; },
    plan => { plan.productAttributes.ozonAttributes[0].fact.verificationStatus = 'unknown'; },
    plan => { plan.productAttributes.ozonAttributes[0].fact.sourceRefs = []; },
    plan => { plan.productAttributes.ozonAttributes[0].fact.sourceRefs = [' ']; },
    ...[null, undefined, '', 'unknown'].map(value => plan => { plan.productAttributes.ozonAttributes[0].fact.value = value; })
  ]) {
    const input = compatibilityFixture(); change(input.sourcePlan);
    assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED');
  }
  const duplicate = compatibilityFixture();
  duplicate.sourcePlan.productAttributes.ozonAttributes.push(structuredClone(duplicate.sourcePlan.productAttributes.ozonAttributes[0]));
  assertCompatibilityRejected(duplicate, 'C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
  for (const section of ['ozonAttributes', 'requiredPlatformFields']) {
    for (const row of [null, 1, 'invalid', []]) {
      const malformed = compatibilityFixture();
      malformed.sourcePlan.productAttributes[section] = [row];
      assertCompatibilityRejected(malformed, 'C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
    }
  }
});

test('current schema provenance and all frozen references must match for new metadata', () => {
  for (const change of [
    plan => { delete plan.schemaSnapshotRef; },
    plan => { plan.schemaSnapshotRef = 'schema:other'; },
    plan => { plan.inputRefs.platformSchemaEvidenceId = 'schema:other'; },
    plan => { plan.frozenInputRefs.schemaSnapshotRef = 'schema:other'; },
    plan => { delete plan.inputRefs; },
    plan => { delete plan.frozenInputRefs; },
    plan => { plan.inputSnapshots.platformSchemaRules.evidenceId = ''; },
    plan => { plan.inputSnapshots.platformSchemaRules.schemaRevision = ''; },
    plan => { plan.inputSnapshots.platformSchemaRules.collectedAt = 'not-a-time'; }
  ]) {
    const input = compatibilityFixture(); change(input.targetPlan);
    assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_SCHEMA_SOURCE_INVALID');
  }
});

test('new max metadata does not permit any other changed adopted-field semantics', () => {
  for (const [key, value] of [['dictionaryId', 2], ['attributeType', 'Integer'], ['isCollection', false],
    ['required', true], ['complexId', 1], ['label', 'changed'], ['fieldKey', 'other']]) {
    const input = compatibilityFixture();
    input.targetPlan.inputSnapshots.platformSchemaRules.attributes[0][key] = value;
    assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
  }
  const required = compatibilityFixture();
  required.sourcePlan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: '4967', label: 'Материал', required: true }];
  required.targetPlan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: '4967', label: 'Материал', required: true, maxValueCount: 2 }];
  assertCompatibilityRejected(required, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
});

test('duplicate or one-sided adopted rows cannot masquerade as schema enrichment', () => {
  for (const section of ['attributes', 'requiredFields']) {
    for (const side of ['sourcePlan', 'targetPlan']) {
      for (const operation of ['duplicate', 'remove']) {
        const input = compatibilityFixture();
        delete input.targetPlan.inputSnapshots.platformSchemaRules.attributes[0].maxValueCount;
        if (section === 'requiredFields') {
          for (const plan of [input.sourcePlan, input.targetPlan]) {
            plan.inputSnapshots.platformSchemaRules.requiredFields = [{ fieldKey: '4967', label: 'Материал', required: true }];
          }
        }
        const rows = input[side].inputSnapshots.platformSchemaRules[section];
        if (operation === 'duplicate') rows.push(structuredClone(rows[0]));
        else rows.pop();
        assertCompatibilityRejected(input, 'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
      }
    }
  }
});

function completedSyntheticJob(formal) {
  const fixture = c1AiSoftwareJobFixture({ formalDraftFixture: formal,
    jobId: formal.receipt.softwareJobId, authorizationId: 'authorization:c1-ai-draft:FORMAL-C1' });
  const admitted = bindSoftwareJobAdmissionDecision(fixture.job, {
    schemaVersion: 'software-job-admission-v1', admissionId: 'software-job-admission:synthetic-cardinality',
    jobId: fixture.job.jobId, candidateId: fixture.job.candidateId, skuPackageId: fixture.job.skuPackageId,
    revision: fixture.job.revision, jobType: fixture.job.jobType, normalizedScopeKey: normalizeSoftwareJobScopeKey(fixture.job),
    authorizationRef: fixture.authorizationRecord.authorizationId, authorizationFingerprint: 'a'.repeat(64),
    credentialBindingRef: fixture.credentialBinding.bindingId, credentialAlias: fixture.credentialBinding.credentialAlias,
    credentialBindingFingerprint: 'b'.repeat(64), phase: 'enqueue_current', observedAt: at });
  const claimed = claimSoftwareJobLease({ job: admitted, worker: fixture.worker,
    leaseId: 'lease:synthetic-cardinality', serverTime: at, leaseDurationMs: 300000 });
  const inFlight = markSoftwareJobExternalRequestStarted({ job: claimed, workerId: fixture.worker.workerId,
    leaseId: claimed.leaseId, externalRequestRef: 'request:synthetic-cardinality', serverTime: at });
  const envelope = createSoftwareJobResultEnvelope({ job: inFlight, resultRef: formal.receipt.receiptId,
    payloadKind: inFlight.jobType, payload: { schemaVersion: 'c1-ai-draft-software-result-v1',
      request: formal.request, receipt: formal.receipt }, recordedAt: at });
  const job = settleSoftwareJob({ job: inFlight, workerId: fixture.worker.workerId, leaseId: inFlight.leaseId,
    status: 'completed', externalRequestState: 'succeeded', serverTime: at, resultEnvelope: envelope });
  job.resultEnvelope.applicationDisposition = 'applied';
  return job;
}

function freezeC1WithAuxiliarySalesDraft(formal, platformSchemaEvidence) {
  const opportunityPackage = structuredClone(formal.state.opportunityPackage);
  const snapshotIndex = opportunityPackage.salesSnapshots.findIndex(snapshot =>
    snapshot.snapshotId === formal.created.c1ProductPlan.inputRefs.salesSnapshotId);
  assert.notEqual(snapshotIndex, -1);
  const snapshot = opportunityPackage.salesSnapshots[snapshotIndex];
  opportunityPackage.salesSnapshots[snapshotIndex] = attachTerraAuxiliaryDraft(snapshot, {
    draftId: 'draft:synthetic:cardinality-sales-label', provider: 'terra', modelVersion: 'synthetic-test-model',
    generatedAt: at, status: 'draft', authoritative: false, mayOverrideObservedFields: false,
    publicTextEvidenceRefs: [snapshot.evidenceRef], authorizedImageRefs: [],
    output: { summary: '合成辅助说明，不覆盖已采集事实', comparabilitySignals: [],
      attributeHints: [{ field: '商品名称', value: snapshot.title, evidenceRef: '商品标题' }] }
  });
  // Freeze a new C1 from the typed A evidence, before its request or receipt is constructed.
  return { opportunityPackage, created: createC1ProductPlan({ ...formal.state, opportunityPackage,
    platformSchemaEvidence, createdAt: at }) };
}

async function enrichedThreeColorFixture({ finalCardPersistenceInputs = false } = {}) {
  const base = await threeColorFixture();
  const document = await base.repository.readSnapshot();
  const parent = document.candidates[0];
  const oldSchema = parent.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  const formal = createFormalC1DraftFixture({ at, candidateId: parent.id,
    supplierSkuId: parent.lifecycleV11.skuPackage.supplierSkuId, variantKey: '颜色:黑cp',
    ...(finalCardPersistenceInputs ? { salesSnapshotVersion: SALES_SNAPSHOT_SCHEMA_VERSION } : {}),
    skuAttributes: { 颜色: '黑cp', model_name: 'synthetic-model',
      ...(finalCardPersistenceInputs ? { piece_count: 8, quantityOneEvidence: { captureId: parent.sourceCapture.captureId } } : {}) },
    platformAttributes: [...oldSchema.attributes, materialAttribute], platformRequiredFields: oldSchema.requiredFields });
  let created = formal.created;
  if (finalCardPersistenceInputs) {
    const frozen = freezeC1WithAuxiliarySalesDraft(formal, formal.schema);
    created = frozen.created;
    parent.lifecycleV11.opportunityPackage = frozen.opportunityPackage;
    const offerId = formal.state.skuPackage.selectedSupplySnapshot.supplierOption.offerId;
    for (const candidate of document.candidates) {
      candidate.sourceCapture.offerId = offerId;
      candidate.sourceCapture.supplierAttributes = { piece_count: 8 };
    }
    for (const candidate of document.candidates.slice(1)) {
      const originalSku = candidate.lifecycleV11.skuPackage;
      const currentSchema = originalSku.c1ProductPlan.inputSnapshots.platformSchemaRules;
      const child = createFormalC1DraftFixture({ at, candidateId: candidate.id,
        supplierSkuId: originalSku.supplierSkuId, variantKey: originalSku.variantKey,
        salesSnapshotVersion: SALES_SNAPSHOT_SCHEMA_VERSION,
        skuAttributes: { 颜色: candidate.sourceCapture.skuChoices[0].attributes.颜色, model_name: 'synthetic-model',
          quantityOneEvidence: { captureId: parent.sourceCapture.captureId } },
        platformAttributes: currentSchema.attributes, platformRequiredFields: currentSchema.requiredFields });
      const { created: childCreated, opportunityPackage } = freezeC1WithAuxiliarySalesDraft(child, currentSchema);
      assert.equal(childCreated.skuPackage.dataRevision, originalSku.dataRevision);
      assert.equal(childCreated.c1ProductPlan.c1PlanId, originalSku.c1ProductPlan.c1PlanId);
      assert.deepEqual(childCreated.skuPackage.g1Identity, originalSku.g1Identity);
      candidate.lifecycleV11.opportunityPackage = opportunityPackage;
      candidate.lifecycleV11.skuPackage = structuredClone(childCreated.skuPackage);
    }
  }
  const beforeFacts = structuredClone(created.skuPackage), plan = beforeFacts.c1ProductPlan;
  const schema = plan.inputSnapshots.platformSchemaRules;
  schema.evidenceId += ':historical'; schema.schemaRevision += ':historical';
  schema.ruleVersion = schema.schemaRevision;
  schema.writeBindings.evidenceRef = schema.evidenceId; schema.writeBindings.schemaRevision = schema.schemaRevision;
  plan.inputRefs.platformSchemaEvidenceId = schema.evidenceId;
  plan.frozenInputRefs.schemaSnapshotRef = schema.evidenceId;
  plan.schemaSnapshotRef = schema.evidenceId;
  beforeFacts.ozonAttributeMappingsV1 = { schemaVersion: 'c1-ozon-attribute-mapping-v1', schemaRevision: schema.schemaRevision,
    confirmationRef: 'owner-ozon-attribute-mapping:synthetic-cardinality', confirmedBy: 'synthetic-owner', confirmedAt: at,
    mappings: [{ attributeId: '4967', attributeLabel: 'Материал', dictionaryId: 1503,
      ...material, sourceFactPath: 'productAttributes.material',
      sourceFactValue: formal.checked.c1ProductPlan.productAttributes.material.value,
      dictionaryEvidenceRef: 'synthetic:dictionary:material' }] };
  const checked = verifyC1ProductFacts({ skuPackage: beforeFacts,
    skuRightsReview: formal.checked.c1ProductPlan.inputSnapshots.skuRightsReview, verifiedAt: at });
  const request = buildC1AiDraftRequest({ skuPackage: checked.skuPackage,
    competitorTextSnapshot: formal.request.competitorTextEvidence,
    keywordEvidence: { ...formal.request.keywordEvidence, status: 'ready', targetPlatform: 'ozon',
      targetSkuPackageId: checked.skuPackage.skuPackageId, sourcePlatform: 'ozon',
      keywords: formal.request.keywordEvidence.keywords.map(keyword => ({ ...keyword,
        relevanceStatus: 'retained', factBindingPaths: keyword.factRefs })) },
    seoRules: formal.request.seoRules, taskClassification: formal.request.taskClassification, requestedAt: at });
  // A new synthetic receipt is bound to the new request, after constructing all source facts.
  // No frozen request or persisted production receipt is repaired to make this fixture pass.
  const receipt = { ...structuredClone(formal.receipt), requestId: request.requestId, requestFingerprint: request.requestFingerprint,
    inputEvidenceRefs: [...new Set([request.competitorTextEvidence.evidenceRef, request.keywordEvidence.evidenceId,
      ...request.verifiedFacts.flatMap(fact => fact.evidenceRefs)])] };
  const admitted = authorizedExecution(request, formal.candidate.dataRevision,
    { softwareJobId: receipt.softwareJobId, authorizationId: 'authorization:c1-ai-draft:FORMAL-C1' });
  const settled = settledExecution(request, receipt, admitted);
  const merged = mergeC1AiDraftReceipt({ skuPackage: checked.skuPackage, request, receipt, settledExecution: settled, mergedAt: at });
  const job = completedSyntheticJob({ ...formal, request, receipt, candidate: { ...formal.candidate,
    lifecycleV11: { ...formal.candidate.lifecycleV11, skuPackage: checked.skuPackage } } });
  const historicalAuthorization = parent.lifecycleV11.skuPackage.productionAuthorization;
  parent.lifecycleV11.skuPackage = { ...merged.skuPackage, technicalStatus: 'unknown_outcome', productionAuthorization: historicalAuthorization };
  parent.lifecycleV11.c1AiDraftRequestV1 = request;
  parent.lifecycleV11.c1AiDraftJobRefV1 = { jobId: job.jobId, jobType: job.jobType, candidateId: parent.id,
    skuPackageId: merged.skuPackage.skuPackageId, resultRevision: job.revision,
    sourceRevision: job.scopeBinding.sourceRevision, inputFingerprint: job.scopeBinding.inputFingerprint };
  document.runtime.softwareJobs = [job];
  for (const child of document.candidates.slice(1)) {
    const target = child.lifecycleV11.skuPackage.c1ProductPlan;
    target.inputSnapshots.platformSchemaRules.attributes.push({ ...materialAttribute, maxValueCount: 1 });
    assert.notEqual(target.schemaSnapshotRef, schema.evidenceId);
    assert.equal(validatePlatformSchemaEvidence(target.inputSnapshots.platformSchemaRules).valid, true);
  }
  // Declare the same synthetic current definition in the saved schema pack. Color dictionary
  // provenance and its already completed read remain unchanged because the color fields did not change.
  const currentSchema = document.candidates[1].lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  document.evidencePacks.find(pack => pack.id === currentSchema.evidenceId).evidenceData.attributes = structuredClone(currentSchema.attributes);
  const repository = createMemoryBusinessStateRepository(document);
  const input = { ...base.input };
  input.previewFingerprint = previewSiblingBatchC1Preparation({ document, actor: base.actor, input, serverClock: () => at }).previewFingerprint;
  return { repository, actor: base.actor, input, ids: base.ids };
}

test('three-color preparation accepts current cardinality with real source receipt and commits only child C1/C2', async t => {
  let unexpectedNetworkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { unexpectedNetworkCalls += 1; throw new Error('Unexpected external request.'); });
  const { repository, actor, input, ids } = await enrichedThreeColorFixture();
  const before = await repository.readSnapshot();
  const preview = previewSiblingBatchC1Preparation({ document: before, actor, input, serverClock: () => at });
  assert.equal(preview.previewFingerprint, input.previewFingerprint);
  assert.deepEqual(await repository.readSnapshot(), before);
  const result = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor, input, serverClock: () => at });
  assert.equal(result.members.length, 3);
  assert.equal(result.externalRequests, 0);
  assert.equal(result.paidCalls, 0);
  assert.equal(result.platformWrites, 0);
  const after = await repository.readSnapshot();
  assert.deepEqual(after.candidates[0], before.candidates[0]);
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.technicalStatus, 'unknown_outcome');
  assert.deepEqual(after.evidencePacks, before.evidencePacks);
  assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
  for (const id of ids) {
    const sku = after.candidates.find(item => item.id === id).lifecycleV11.skuPackage;
    assert.equal(sku.businessPhase, 'C2');
    assert.equal(sku.c2FinalAssets.status, 'awaiting_final_uploads');
    assert.equal(sku.productionAuthorization, null);
    assert.deepEqual(sku.c1ProductPlan.productAttributes.ozonAttributes.find(row => row.fieldKey === '4967').fact.value, material);
    assert.equal(sku.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes.find(row => row.fieldKey === '4967').maxValueCount, 1);
  }
  const replay = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor, input, serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(), after);
  assert.equal(unexpectedNetworkCalls, 0);
});

test('a rejected last member or inconsistent source mapping leaves the entire three-color repository unchanged', async t => {
  let unexpectedNetworkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { unexpectedNetworkCalls += 1; throw new Error('Unexpected external request.'); });
  for (const [change, code] of [
    [document => { document.candidates.at(-1).lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes.find(row => row.fieldKey === '4967').maxValueCount = 0; },
      'C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED'],
    [document => { document.candidates.at(-1).lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes.find(row => row.fieldKey === '4967').dictionaryId += 1; },
      'C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED'],
    [document => { document.candidates[0].lifecycleV11.skuPackage.ozonAttributeMappingsV1.mappings[0].dictionaryValueId += 1; },
      'SIBLING_BATCH_C1_SHARED_MAPPING_CONFLICT']
  ]) {
    const { repository, actor, input } = await enrichedThreeColorFixture();
    await repository.transact(document => { change(document); return { changed: true, document, result: null }; });
    const before = await repository.readSnapshot();
    assert.throws(() => previewSiblingBatchC1Preparation({ document: before, actor, input, serverClock: () => at }), { message: code });
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor, input, serverClock: () => at }), { message: code });
    assert.deepEqual(await repository.readSnapshot(), before);
    assert.equal(before.candidates[0].lifecycleV11.skuPackage.technicalStatus, 'unknown_outcome');
    assert.equal(before.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.productionAuthorization === null), true);
  }
  assert.equal(unexpectedNetworkCalls, 0);
});

test('three-color final cards preserve auxiliary labels and shared facts through C2 persistence and JSON reopen', async t => {
  let unexpectedNetworkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { unexpectedNetworkCalls += 1; throw new Error('Unexpected external request.'); });
  const { repository, actor, input, ids } = await enrichedThreeColorFixture({ finalCardPersistenceInputs: true });
  const before = await repository.readSnapshot();
  const sourceSales = before.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.salesSnapshot;
  const auxiliary = sourceSales.auxiliaryDrafts[0];
  assert.equal(auxiliary.schemaVersion, TERRA_AUXILIARY_DRAFT_VERSION);
  assert.equal(auxiliary.output.attributeHints[0].evidenceRef, '商品标题');
  assert.deepEqual(auxiliary.publicTextEvidenceRefs, [sourceSales.evidenceRef]);
  assert.equal(auxiliary.authoritative, false);
  assert.equal(auxiliary.mayOverrideObservedFields, false);

  const c1 = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => at });
  assert.equal(c1.members.length, 3);
  assert.equal(c1.externalRequests, 0);
  assert.equal(c1.platformWrites, 0);
  const afterC1 = await repository.readSnapshot();
  const verifiedAssets = new Map();
  const templates = finalAssets();
  await repository.transact(document => {
    for (const [index, candidate] of document.candidates.slice(1).entries()) {
      const sku = candidate.lifecycleV11.skuPackage;
      const plan = sku.c1ProductPlan;
      assert.equal(plan.sourceFactsRevision.schemaVersion, 'c1-sibling-shared-facts-v1');
      assert.equal(Object.hasOwn(plan, 'supersedes'), false);
      assert.deepEqual(plan.sourceFactsRevision.ownerConfirmation.adoptedSupplierFieldKeys, ['piece_count']);
      assert.equal(plan.productAttributes.supplierAttributes.find(row => row.fieldKey === 'piece_count').fact.value, 8);
      const assets = Array.from({ length: 3 }, (_, position) => {
        const sha256 = (index * 3 + position + 1).toString(16).padStart(64, '0');
        return { ...structuredClone(templates[position === 0 ? 0 : 1]),
          assetId: `final:synthetic:cardinality:${index}:${position}`,
          assetRef: `https://assets.example.com/synthetic/cardinality/${index}-${position}.jpg`,
          assetVersion: `sha256:${sha256}`, sha256, order: position + 1 };
      });
      verifiedAssets.set(candidate.id, assets);
      candidate.lifecycleV11.c2UploadDraft = { schemaVersion: 'c2-upload-draft-v1', candidateId: candidate.id,
        skuPackageId: sku.skuPackageId, sourceCandidateRevision: candidate.dataRevision,
        sourceSkuRevision: sku.dataRevision, sourceC1Fingerprint: sku.c2FinalAssets.softwareState.sourceC1Fingerprint,
        schemaEvidenceRef: sku.c2FinalAssets.targetContext.schemaEvidenceRef, revision: 1,
        uploads: assets.map(asset => ({ ...structuredClone(asset), status: 'ready' })),
        selection: assets.map(asset => ({ assetId: asset.assetId, order: asset.order })) };
    }
    return { changed: true, document, result: null };
  });
  const withUploads = await repository.readSnapshot();
  const c2Input = { parentCandidateId: input.parentCandidateId, parentRevision: input.parentRevision, confirmed: true,
    members: withUploads.candidates.slice(1).map(candidate => ({ candidateId: candidate.id,
      candidateRevision: candidate.dataRevision, draftRevision: 1,
      approvedAssetIds: candidate.lifecycleV11.c2UploadDraft.selection.map(asset => asset.assetId) })) };
  const c2 = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development', actor,
    input: c2Input, verifiedAssets, serverClock: () => at });
  assert.equal(c2.status, 'awaiting_owner_business_confirmation');
  assert.equal(c2.members.length, 3);
  assert.equal(c2.externalRequests, 0);
  assert.equal(c2.platformWrites, 0);
  const saved = await repository.readSnapshot();
  assert.deepEqual(saved.candidates[0], before.candidates[0]);
  assert.equal(saved.candidates[0].lifecycleV11.skuPackage.technicalStatus, 'unknown_outcome');
  assert.deepEqual(saved.evidencePacks, before.evidencePacks);
  assert.deepEqual(saved.runtime.softwareJobs, before.runtime.softwareJobs);
  const published = await loadPublishedSchemaValidator();
  const validateC2 = published.getSchema('c2-asset-lifecycle-v1.1');
  const validateCard = published.getSchema('final-product-plan-confirmation-card-v1.1');
  for (const id of ids) {
    const candidate = saved.candidates.find(item => item.id === id);
    const original = before.candidates.find(item => item.id === id).lifecycleV11.skuPackage;
    const sku = candidate.lifecycleV11.skuPackage;
    const sourcePlan = afterC1.candidates.find(item => item.id === id).lifecycleV11.skuPackage.c1ProductPlan;
    const frozenC1 = sku.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot;
    assert.deepEqual(sku.profitModels, original.profitModels);
    assert.equal(sku.activeProfitModelVersion, original.activeProfitModelVersion);
    assert.deepEqual(sku.selectedSupplySnapshot, original.selectedSupplySnapshot);
    assert.deepEqual(sku.c1ProductPlan, sourcePlan);
    assert.deepEqual(frozenC1.sourceFactsRevision, sourcePlan.sourceFactsRevision);
    assert.equal(Object.hasOwn(frozenC1, 'supersedes'), false);
    assert.deepEqual(frozenC1.inputSnapshots.salesSnapshot, sourcePlan.inputSnapshots.salesSnapshot);
    const frozenSales = frozenC1.inputSnapshots.salesSnapshot;
    assert.equal(frozenSales.auxiliaryDrafts[0].output.attributeHints[0].evidenceRef, '商品标题');
    assert.deepEqual(frozenSales.auxiliaryDrafts[0].publicTextEvidenceRefs, [frozenSales.evidenceRef]);
    assert.equal(sku.c2FinalAssets.status, 'completed');
    assert.equal(sku.productionConfirmationCard.status, 'awaiting_owner_business_confirmation');
    assert.equal(validateFinalProductPlanConfirmationCard(sku.productionConfirmationCard).valid, true);
    assert.equal(validateC2(sku.c2FinalAssets), true, JSON.stringify(validateC2.errors));
    assert.equal(validateCard(sku.productionConfirmationCard), true, JSON.stringify(validateCard.errors));
    assert.equal(sku.productionAuthorization, null);
    assert.equal(sku.productionRecord, null);
    assert.equal(Object.hasOwn(sku, 'dHandoff'), false);
  }
  const reopened = createMemoryBusinessStateRepository(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(await reopened.readSnapshot(), saved);
  await reopened.transact(document => ({ changed: true, document, result: null }));
  assert.deepEqual(await reopened.readSnapshot(), saved);
  const replay = await commitSiblingBatchC2Final({ repository: reopened, runtimeMode: 'local_development', actor,
    input: c2Input, verifiedAssets, serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await reopened.readSnapshot(), saved);
  assert.equal(unexpectedNetworkCalls, 0);
});
