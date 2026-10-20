import { isDeepStrictEqual } from 'node:util';
import { assertC1EditorialPlan } from './c1-editorial-review-contract.mjs';
import { mergeC1AiDraftReceipt } from './c1-ai-draft-contract.mjs';
import { assertValidC1ProductPlan, collectC1UnknownManifest, validatePlatformSchemaEvidence } from './c1-product-plan.mjs';
import { isOzonDictionaryCollectionValue, isOzonScalarAttributeValue } from './ozon-submission-attributes.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';

export const C1_SIBLING_NEUTRAL_REUSE_VERSION = 'c1-sibling-neutral-reuse-v2';
const fail = code => { throw new Error(code); };
const factAt = (plan, path) => path.split('.').reduce((value, key) => value?.[key], plan);
const contentOf = plan => ({ seoTitleDraft: plan.seoTitleDraft, descriptionDraft: plan.descriptionDraft,
  bulletPointsDraft: plan.bulletPointsDraft, searchKeywordsDraft: plan.searchKeywordsDraft,
  keywordEvidenceRefs: plan.keywordEvidenceRefs, seoEvidenceLayer: plan.seoEvidenceLayer });
const allPieces = plan => [plan.seoTitleDraft, plan.descriptionDraft, ...plan.bulletPointsDraft,
  ...plan.searchKeywordsDraft.keywords];

function assertFormalSource({ sourcePlan, sourceIdentity, request, receipt, settledExecution, observedAt }) {
  assertValidC1ProductPlan(sourcePlan);
  if (sourcePlan.status !== 'seo_draft_ready') fail('C1_SIBLING_NEUTRAL_SOURCE_NOT_FORMAL');
  if (sourcePlan.draftOnlySeo?.sourceType === 'owner_confirmed_editorial') {
    if (request !== null || receipt !== null || settledExecution !== null) fail('C1_SIBLING_NEUTRAL_SOURCE_IMPERSONATION');
    assertC1EditorialPlan({ plan: sourcePlan, identity: sourceIdentity,
      resultSkuRevision: sourcePlan.draftOnlySeo.editorialSource?.ownerConfirmation?.resultSkuRevision });
    return 'owner_confirmed_editorial';
  }
  if (!request || !receipt || !settledExecution || sourcePlan.draftOnlySeo?.formalProviderResultAccepted !== true) {
    fail('C1_SIBLING_NEUTRAL_SOURCE_NOT_FORMAL');
  }
  mergeC1AiDraftReceipt({ skuPackage: { c1ProductPlan: sourcePlan, g1Identity: sourceIdentity,
    skuPackageId: sourcePlan.identity.skuPackageId, supplierSkuId: sourcePlan.identity.supplierSkuId,
    targetPlatform: sourcePlan.identity.targetPlatform, targetStore: sourcePlan.identity.targetStore,
    dataRevision: request.sourceSkuRevision + 1 }, request, receipt, settledExecution, mergedAt: observedAt });
  return 'provider_receipt';
}

function colorPaths(sourcePlan) {
  const supplier = sourcePlan.productAttributes.supplierAttributes
    .map((item, index) => item.fieldKey === '颜色' ? `productAttributes.supplierAttributes.${index}.fact` : null)
    .filter(Boolean);
  const official = (sourcePlan.productAttributes.ozonAttributes ?? [])
    .map((item, index) => ['10096', '10097'].includes(String(item.fieldKey))
      ? { attributeId: String(item.fieldKey), path: `productAttributes.ozonAttributes.${index}.fact` } : null)
    .filter(Boolean);
  const paths = [...supplier, ...official.map(item => item.path)];
  if (supplier.length !== 1 || new Set(official.map(item => item.attributeId)).size !== official.length ||
      paths.some(path => factAt(sourcePlan, path)?.verificationStatus !== 'confirmed')) {
    fail('C1_SIBLING_NEUTRAL_SOURCE_COLOR_MISSING');
  }
  return paths;
}

// Only the reviewed vest wording has a provable single color slot; other colored drafts need source revision.
function reviewedVestColorCopy(sourcePlan, paths) {
  const colorValue = path => {
    const value = factAt(sourcePlan, path).value;
    return typeof value === 'string' ? value : value?.value;
  };
  const supplierPath = paths.find(path => path.startsWith('productAttributes.supplierAttributes.'));
  const officialPaths = paths.filter(path => path.startsWith('productAttributes.ozonAttributes.'));
  if (!supplierPath || !officialPaths.length) fail('C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION');
  const zhColor = colorValue(supplierPath), ruColor = colorValue(officialPaths[0]);
  if (typeof zhColor !== 'string' || typeof ruColor !== 'string' ||
      officialPaths.some(path => colorValue(path)?.toLocaleLowerCase() !== ruColor.toLocaleLowerCase())) {
    fail('C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION');
  }
  const title = sourcePlan.seoTitleDraft, description = sourcePlan.descriptionDraft;
  const reviewedRussianDescriptions = [
    `Мини-жилет цвета ${ruColor} из ткани оксфорд подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.`,
    `Мини-жилет из ткани оксфорд цвета ${ruColor} подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.`
  ];
  if (!title.factRefs.some(path => paths.includes(path)) ||
      !description.factRefs.some(path => paths.includes(path)) ||
      title.text !== `Одежда для животных: мини-жилет для кошек, ${ruColor}` ||
      ![`宠物服装：适用于猫的${zhColor}迷你背心。`, `宠物服装：适用于猫的${zhColor} 迷你背心。`].includes(title.reviewZh) ||
      !reviewedRussianDescriptions.includes(description.text) ||
      description.reviewZh !== `${zhColor}牛津布迷你背心适用于猫，也可以套在酒瓶上，四季适用。` ||
      sourcePlan.bulletPointsDraft.some(piece => piece.factRefs.some(path => paths.includes(path))) ||
      sourcePlan.searchKeywordsDraft.keywords.some(piece => piece.factRefs.some(path => paths.includes(path)) &&
        (piece.query !== ruColor || piece.reviewZh !== `${zhColor}。`)) ||
      sourcePlan.seoEvidenceLayer.russianAttributes?.some(item => paths.includes(item.factPath) &&
        (item.valueRu !== ruColor || item.reviewZh !== `${zhColor}。`))) {
    fail('C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION');
  }
  return { title: { text: 'Одежда для животных: мини-жилет для кошек', reviewZh: '宠物服装：适用于猫的迷你背心。' },
    description: { text: 'Мини-жилет из ткани оксфорд подходит для кошек. Его также можно надеть на винную бутылку. Модель подходит для любого сезона.',
      reviewZh: '牛津布迷你背心适用于猫，也可以套在酒瓶上，四季适用。' } };
}

export function buildC1SiblingNeutralContent(sourcePlan) {
  const paths = colorPaths(sourcePlan);
  const tokens = [...new Set(paths.flatMap(path => {
    const value = factAt(sourcePlan, path).value;
    return typeof value === 'string' ? [value] : [value?.value];
  })
    .filter(value => typeof value === 'string' && value.trim().length > 1))];
  const colorKeywordRefs = new Set(sourcePlan.searchKeywordsDraft.keywords
    .filter(item => item.factRefs.some(ref => paths.includes(ref)))
    .flatMap(item => item.evidenceRefs));
  const colored = piece => piece.factRefs.some(ref => paths.includes(ref)) ||
    (piece.keywordEvidenceRefs ?? piece.evidenceRefs ?? []).some(ref => colorKeywordRefs.has(ref)) ||
    tokens.some(token => [piece.text, piece.query, piece.reviewZh].some(value =>
      typeof value === 'string' && value.toLocaleLowerCase().includes(token.toLocaleLowerCase())));
  const colorUsed = allPieces(sourcePlan).some(colored) ||
    sourcePlan.seoEvidenceLayer.russianAttributes?.some(item => paths.includes(item.factPath));
  const reviewed = colorUsed ? reviewedVestColorCopy(sourcePlan, paths) : null;
  const neutralKeywords = sourcePlan.searchKeywordsDraft.keywords.filter(item => !colored(item));
  if (!neutralKeywords.length) fail('C1_SIBLING_NEUTRAL_KEYWORD_MISSING');
  const neutralizePiece = (piece, approvedText) => {
    if (!approvedText) {
      if (colored(piece)) fail('C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION');
      return structuredClone(piece);
    }
    const result = structuredClone(piece);
    result.text = approvedText.text;
    result.reviewZh = approvedText.reviewZh;
    result.factRefs = result.factRefs.filter(path => !paths.includes(path));
    result.assertions = result.assertions.filter(item => !paths.includes(item.factPath));
    result.keywordEvidenceRefs = result.keywordEvidenceRefs.filter(ref => !colorKeywordRefs.has(ref));
    if (!result.text || !result.factRefs.length || !result.keywordEvidenceRefs.length) {
      fail('C1_SIBLING_NEUTRAL_SOURCE_REVISION_REQUIRED');
    }
    if (tokens.some(token => [result.text, result.reviewZh].some(value =>
      typeof value === 'string' && value.toLocaleLowerCase().includes(token.toLocaleLowerCase()))) ||
      result.factRefs.some(path => paths.includes(path))) fail('C1_SIBLING_NEUTRAL_COLOR_REMAINS');
    return result;
  };
  const title = neutralizePiece(sourcePlan.seoTitleDraft, reviewed?.title);
  const description = neutralizePiece(sourcePlan.descriptionDraft, reviewed?.description);
  const bullets = sourcePlan.bulletPointsDraft.map(piece => neutralizePiece(piece));
  const keywords = { ...structuredClone(sourcePlan.searchKeywordsDraft), keywords: structuredClone(neutralKeywords) };
  const refs = [...new Set([title, description, ...bullets].flatMap(piece => piece.keywordEvidenceRefs)
    .concat(neutralKeywords.flatMap(item => item.evidenceRefs)))];
  const evidenceLayer = structuredClone(sourcePlan.seoEvidenceLayer);
  if (Array.isArray(evidenceLayer.russianAttributes)) {
    evidenceLayer.russianAttributes = evidenceLayer.russianAttributes.filter(item => !paths.includes(item.factPath));
  }
  if (Array.isArray(evidenceLayer.inputEvidenceRefs)) {
    evidenceLayer.inputEvidenceRefs = evidenceLayer.inputEvidenceRefs.filter(ref => !colorKeywordRefs.has(ref));
  }
  const result = { seoTitleDraft: title, descriptionDraft: description, bulletPointsDraft: bullets,
    searchKeywordsDraft: keywords, keywordEvidenceRefs: refs, seoEvidenceLayer: evidenceLayer,
    differences: { title: colored(sourcePlan.seoTitleDraft), description: colored(sourcePlan.descriptionDraft),
      bulletIndexes: sourcePlan.bulletPointsDraft.flatMap((piece, index) => colored(piece) ? [index] : []),
      removedKeywords: sourcePlan.searchKeywordsDraft.keywords.filter(colored).map(item => item.query),
      removedKeywordEvidenceRefs: [...colorKeywordRefs], sourceColorValues: tokens,
      sourceColor: factAt(sourcePlan, paths[0]).value } };
  const { differences, ...publishedContent } = result;
  const published = JSON.stringify(publishedContent).toLocaleLowerCase();
  if (tokens.some(token => published.includes(token.toLocaleLowerCase())) ||
      paths.some(path => published.includes(path.toLocaleLowerCase())) ||
      [...colorKeywordRefs].some(ref => published.includes(ref.toLocaleLowerCase()))) {
    fail('C1_SIBLING_NEUTRAL_COLOR_REMAINS');
  }
  return result;
}

function adoptedFacts(plan, content, includeRussianAttributes = false) {
  const paths = [...new Set([content.seoTitleDraft, content.descriptionDraft, ...content.bulletPointsDraft,
    ...content.searchKeywordsDraft.keywords].flatMap(piece => piece.factRefs)
    .concat(includeRussianAttributes ? (content.seoEvidenceLayer.russianAttributes ?? []).map(item => item.factPath) : []))].sort();
  if (!paths.length) fail('C1_SIBLING_NEUTRAL_FACTS_MISSING');
  return Object.fromEntries(paths.map(path => {
    const fact = factAt(plan, path);
    if (fact?.verificationStatus !== 'confirmed' || !fact.sourceRefs?.length) fail('C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED');
    return [path, fact.value];
  }));
}

/** Array position is presentation order. Field keys are the identity of an adopted fact. */
export function mapC1SiblingFactPath({ sourcePlan, targetPlan, sourceFactPath }) {
  if (typeof sourceFactPath !== 'string' || !sourceFactPath) fail('C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
  const match = /^productAttributes\.(supplierAttributes|ownerDeclaredFacts|ozonAttributes|requiredPlatformFields)\.(\d+)\.fact$/.exec(sourceFactPath);
  let targetPath = sourceFactPath;
  if (match) {
    const sourceRows = sourcePlan.productAttributes[match[1]], targetRows = targetPlan.productAttributes[match[1]];
    const sourceRow = sourceRows?.[Number(match[2])];
    if (!sourceRow || sourceRows.filter(item => item.fieldKey === sourceRow.fieldKey).length !== 1 ||
        !Array.isArray(targetRows) || targetRows.filter(item => item.fieldKey === sourceRow.fieldKey).length !== 1) {
      fail('C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
    }
    targetPath = `productAttributes.${match[1]}.${targetRows.findIndex(item => item.fieldKey === sourceRow.fieldKey)}.fact`;
  } else if (/\.(?:\d+)\./.test(sourceFactPath)) fail('C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
  const sourceFact = factAt(sourcePlan, sourceFactPath), targetFact = factAt(targetPlan, targetPath);
  if (sourceFact?.verificationStatus !== 'confirmed' || targetFact?.verificationStatus !== 'confirmed' ||
      !sourceFact.sourceRefs?.length || !targetFact.sourceRefs?.length) fail('C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED');
  if (!isDeepStrictEqual(sourceFact.value, targetFact.value)) fail('C1_SIBLING_NEUTRAL_FACT_DIFFERENCE');
  return targetPath;
}

function assertCurrentSchemaSource(plan, schema) {
  if (!validatePlatformSchemaEvidence(schema).valid ||
      plan.inputRefs?.platformSchemaEvidenceId !== schema.evidenceId ||
      plan.frozenInputRefs?.schemaSnapshotRef !== schema.evidenceId || plan.schemaSnapshotRef !== schema.evidenceId) {
    fail('C1_SIBLING_NEUTRAL_SCHEMA_SOURCE_INVALID');
  }
}

function confirmedAttributeFacts(sourcePlan, fieldKey) {
  const facts = [];
  for (const section of ['ozonAttributes', 'requiredPlatformFields']) {
    const rows = sourcePlan.productAttributes?.[section];
    if (section === 'requiredPlatformFields' && rows === undefined) continue;
    if (!Array.isArray(rows)) fail('C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED');
    if (rows.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
      fail('C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
    }
    const matches = rows.filter(item => String(item.fieldKey) === String(fieldKey));
    if (matches.length > 1) fail('C1_SIBLING_NEUTRAL_FACT_KEY_MISMATCH');
    if (section === 'requiredPlatformFields' && matches.length === 0) continue;
    const fact = matches[0]?.fact;
    if (fact?.verificationStatus !== 'confirmed' || !Array.isArray(fact.sourceRefs) || !fact.sourceRefs.length ||
        fact.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
        fact.value === undefined || fact.value === null || fact.value === '' || fact.value === 'unknown') {
      fail('C1_SIBLING_NEUTRAL_FACT_NOT_CONFIRMED');
    }
    facts.push(fact);
  }
  return facts;
}

function assertAdoptedValueFitsNewMaximum(sourcePlan, attribute) {
  for (const fact of confirmedAttributeFacts(sourcePlan, attribute.fieldKey)) {
    if (attribute.isCollection === true) {
      // A saved dictionary object represents one value. This validation never changes its saved or submitted shape.
      if (!isOzonDictionaryCollectionValue(Array.isArray(fact.value) ? fact.value : [fact.value], attribute)) {
        fail('C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED');
      }
    } else if (attribute.isCollection !== false || !isOzonScalarAttributeValue(fact.value, attribute)) {
      // The existing scalar contract allows one value; max=0 never grants permission for an array.
      fail('C1_SIBLING_NEUTRAL_SCHEMA_VALUE_REJECTED');
    }
  }
}

/** A refreshed snapshot may add a previously absent bound only when every adopted value satisfies it. */
export function assertC1SiblingSchemaCompatibility({ sourcePlan, targetPlan, attributeIds = [] }) {
  const source = sourcePlan.inputSnapshots.platformSchemaRules, target = targetPlan.inputSnapshots.platformSchemaRules;
  if (['platform', 'store', 'storeRef', 'descriptionCategoryId', 'typeId', 'categoryName'].some(key =>
    !isDeepStrictEqual(source[key], target[key]))) fail('C1_SIBLING_NEUTRAL_SCOPE_DIFFERENCE');
  for (const attributeId of new Set(attributeIds.map(String))) {
    for (const section of ['attributes', 'requiredFields']) {
      const left = (source[section] ?? []).filter(item => String(item.fieldKey) === attributeId);
      const right = (target[section] ?? []).filter(item => String(item.fieldKey) === attributeId);
      if (left.length > 1 || right.length > 1 || section === 'attributes' && (left.length !== 1 || right.length !== 1)) {
        fail('C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
      }
      if (isDeepStrictEqual(left, right)) continue;
      if (section !== 'attributes' || Object.hasOwn(left[0], 'maxValueCount') || !Object.hasOwn(right[0], 'maxValueCount')) {
        fail('C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
      }
      const { maxValueCount, ...unchangedDefinition } = right[0];
      if (!Number.isSafeInteger(maxValueCount) || maxValueCount < 0 || !isDeepStrictEqual(left[0], unchangedDefinition)) {
        fail('C1_SIBLING_NEUTRAL_SCHEMA_FIELD_CHANGED');
      }
      assertCurrentSchemaSource(targetPlan, target);
      assertAdoptedValueFitsNewMaximum(sourcePlan, right[0]);
    }
  }
}

function rebindContent(sourcePlan, targetPlan, content) {
  const facts = adoptedFacts(sourcePlan, content, true);
  const paths = new Map(Object.keys(facts).map(sourceFactPath => [sourceFactPath,
    mapC1SiblingFactPath({ sourcePlan, targetPlan, sourceFactPath })]));
  const attributeIds = Object.keys(facts).flatMap(path => {
    const match = /^productAttributes\.(ozonAttributes|requiredPlatformFields)\.(\d+)\.fact$/.exec(path);
    return match ? [sourcePlan.productAttributes[match[1]][Number(match[2])].fieldKey] : [];
  });
  assertC1SiblingSchemaCompatibility({ sourcePlan, targetPlan, attributeIds });
  const rebound = structuredClone(content);
  for (const piece of allPieces(rebound)) {
    piece.factRefs = piece.factRefs.map(path => paths.get(path));
    piece.assertions = piece.assertions.map(item => ({ ...item, factPath: paths.get(item.factPath) }));
  }
  if (Array.isArray(rebound.seoEvidenceLayer.russianAttributes)) {
    rebound.seoEvidenceLayer.russianAttributes = rebound.seoEvidenceLayer.russianAttributes.map(item => ({ ...item, factPath: paths.get(item.factPath) }));
  }
  return rebound;
}

function assertPieceAssertions(content, facts) {
  for (const piece of [content.seoTitleDraft, content.descriptionDraft, ...content.bulletPointsDraft,
    ...content.searchKeywordsDraft.keywords]) {
    if (!Array.isArray(piece.factRefs) || !Array.isArray(piece.assertions) ||
        piece.factRefs.length !== piece.assertions.length ||
        !isDeepStrictEqual([...piece.factRefs].sort(), piece.assertions.map(item => item.factPath).sort()) ||
        piece.assertions.some(item => !Object.hasOwn(facts, item.factPath) ||
          !isDeepStrictEqual(item.value, facts[item.factPath]))) {
      fail('C1_SIBLING_NEUTRAL_ASSERTION_DIFFERENCE');
    }
  }
}

export function projectC1SiblingNeutralDraft({ sourcePlan, sourceIdentity, request, receipt, settledExecution,
  targetSkuPackage, sourceCandidateRevision, targetCandidateRevision, observedAt }) {
  const sourceKind = assertFormalSource({ sourcePlan, sourceIdentity, request, receipt, settledExecution, observedAt });
  const next = structuredClone(targetSkuPackage), plan = next.c1ProductPlan;
  if (next.businessPhase !== 'C1' || plan?.status !== 'facts_checked' ||
      sourceIdentity.platform !== next.g1Identity.platform ||
      !isDeepStrictEqual(sourceIdentity.storeRef, next.g1Identity.storeRef) ||
      !isDeepStrictEqual(sourcePlan.platformCategory.categoryName.value, plan.platformCategory.categoryName.value) ||
      !isDeepStrictEqual(sourcePlan.platformCategory.descriptionCategoryId.value, plan.platformCategory.descriptionCategoryId.value) ||
      !isDeepStrictEqual(sourcePlan.platformCategory.typeId.value, plan.platformCategory.typeId.value)) {
    fail('C1_SIBLING_NEUTRAL_SCOPE_DIFFERENCE');
  }
  const sourceContent = buildC1SiblingNeutralContent(sourcePlan);
  assertPieceAssertions(sourceContent, adoptedFacts(sourcePlan, sourceContent));
  const content = rebindContent(sourcePlan, plan, sourceContent);
  const targetFacts = adoptedFacts(plan, content);
  assertPieceAssertions(content, targetFacts);
  const record = { schemaVersion: C1_SIBLING_NEUTRAL_REUSE_VERSION, observedAt, sourceKind,
    sourceCandidateId: sourceIdentity.candidateId, sourceCandidateRevision, targetCandidateRevision,
    sourcePlanFingerprint: fingerprintCanonicalRecord(sourcePlan), sourceContentFingerprint: fingerprintCanonicalRecord(contentOf(sourcePlan)),
    targetIdentity: structuredClone(next.g1Identity), targetPlanIdentity: structuredClone(plan.identity),
    targetPlanId: plan.c1PlanId, resultSkuRevision: next.dataRevision + 1,
    adoptedFactPaths: Object.keys(targetFacts), adoptedFactFingerprint: fingerprintCanonicalRecord(targetFacts),
    contentFingerprint: fingerprintCanonicalRecord(contentOf(content)), differences: content.differences };
  for (const key of Object.keys(contentOf(content))) plan[key] = structuredClone(content[key]);
  plan.status = 'seo_draft_ready';
  plan.draftOnlySeo = { status: 'draft_only', sourceType: 'sibling_shared_formal_provider',
    formalProviderResultAccepted: false, reason: null, siblingFormalReuseRecord: record };
  plan.unknownManifest = collectC1UnknownManifest(plan);
  next.dataRevision += 1;
  next.audit.updatedAt = observedAt;
  next.audit.history.push({ event: 'c1_sibling_neutral_draft_reused', at: observedAt,
    sourceCandidateId: sourceIdentity.candidateId, providerCalls: 0, productionStarted: false });
  assertC1SiblingNeutralReuse({ plan, resultSkuRevision: next.dataRevision });
  assertValidC1ProductPlan(plan);
  return { skuPackage: next, reuseRecord: record, content: contentOf(plan), differences: content.differences, providerCalls: 0 };
}

export function assertC1SiblingNeutralReuse({ plan, resultSkuRevision }) {
  const record = plan?.draftOnlySeo?.siblingFormalReuseRecord;
  const targetFacts = adoptedFacts(plan, contentOf(plan));
  if (record?.schemaVersion !== C1_SIBLING_NEUTRAL_REUSE_VERSION ||
      !['provider_receipt', 'owner_confirmed_editorial'].includes(record.sourceKind) ||
      record.targetPlanId !== plan.c1PlanId || record.resultSkuRevision !== resultSkuRevision ||
      !isDeepStrictEqual(record.targetPlanIdentity, plan.identity) ||
      record.targetIdentity.platform !== plan.identity.targetPlatform ||
      record.targetIdentity.storeRef.stableStoreId !== plan.identity.targetStore ||
      record.contentFingerprint !== fingerprintCanonicalRecord(contentOf(plan)) ||
      record.adoptedFactFingerprint !== fingerprintCanonicalRecord(targetFacts) ||
      !isDeepStrictEqual(record.adoptedFactPaths, Object.keys(targetFacts)) ||
      !isDeepStrictEqual(plan.draftOnlySeo, { status: 'draft_only', sourceType: 'sibling_shared_formal_provider',
        formalProviderResultAccepted: false, reason: null, siblingFormalReuseRecord: record })) {
    fail('C1_SIBLING_NEUTRAL_RECORD_INVALID');
  }
  assertPieceAssertions(contentOf(plan), targetFacts);
  const colors = colorPaths(plan);
  if (record.adoptedFactPaths.some(path => colors.includes(path)) ||
      allPieces(plan).some(piece => piece.factRefs.some(path => colors.includes(path))) ||
      record.differences.removedKeywordEvidenceRefs.some(ref => plan.keywordEvidenceRefs.includes(ref)) ||
      plan.seoEvidenceLayer.russianAttributes?.some(item => colors.includes(item.factPath))) {
    fail('C1_SIBLING_NEUTRAL_COLOR_IN_COPY');
  }
  return record;
}
