import { isDeepStrictEqual } from 'node:util';
import { preparationFamily, validatePreparationValues } from './sibling-preparation-draft.mjs';
import { siblingPlatform, siblingSupplyPreparation } from './sibling-supply-preparation.mjs';
import { parentCardBinding } from './sibling-sku-card-guard.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { applyLifecycleBEvidenceContext } from './lifecycle-b-evidence-context.mjs';
import { buildLifecycleBEvidencePreparationPlan, runLifecycleBEvidencePreparation } from './lifecycle-b-evidence-preparation.mjs';
import { buildLifecycleBExplicitOtherCosts, inspectLifecycleBCostReadiness, resolveLifecycleBProfitRule } from './lifecycle-b-evidence-runtime.mjs';

export const SIBLING_BATCH_EVIDENCE_PREPARATION_VERSION = 'sibling-batch-evidence-preparation-v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Resolve the same-card category from the accepted parent request, never a market breadcrumb. */
export function resolveSiblingBatchEvidenceCandidate({ document, parent, child, route, packagingCostRmb,
  guooFilePath, submission }) {
  const platform = siblingPlatform(parent, child);
  const sku = parent.lifecycleV11?.skuPackage;
  const identity = sku?.g1Identity;
  const source = child.siblingSourceV1;
  const selected = parent.sourceCapture?.selectedSkuIds;
  if (platform !== 'ozon' || !sku || identity?.candidateId !== parent.id ||
      identity.skuPackageId !== sku.skuPackageId || identity.supplierSkuId !== sku.supplierSkuId ||
      identity.platform !== platform || !sameStoreRef(identity.storeRef, parent.storeRef) ||
      !Array.isArray(selected) || new Set(selected).size !== selected.length ||
      !selected.includes(source.supplierSkuId) || source.supplierSkuId === sku.supplierSkuId ||
      !Number.isSafeInteger(source.parentRevision) || source.parentRevision < 0 || source.parentRevision > parent.dataRevision ||
      !Array.isArray(sku.dSoftwareExecution?.checkpoints) ||
      !sku.dSoftwareExecution.checkpoints.some(item => item.kind === 'import_task_received') ||
      child.sourceCapture.skuChoices?.length !== 1 ||
      child.sourceCapture.skuChoices[0].sourceSkuId !== source.supplierSkuId ||
      parent.sourceCapture.skuChoices?.filter(item => item.sourceSkuId === source.supplierSkuId).length !== 1) {
    fail('SIBLING_BATCH_EVIDENCE_FAMILY_IDENTITY_INVALID');
  }
  const binding = parentCardBinding(sku, document);
  if (!isDeepStrictEqual(source.parentCardBinding, binding)) fail('SIBLING_BATCH_EVIDENCE_PARENT_BINDING_CHANGED');
  const category = `ozon:${binding.descriptionCategoryId}:${binding.typeId}`;
  const prior = child.lifecycleEvidenceContextV11;
  if (prior !== undefined && (!object(prior) || prior.category !== undefined && prior.category !== category)) {
    fail('SIBLING_BATCH_EVIDENCE_CATEGORY_CONFLICT');
  }
  if (!Number.isFinite(packagingCostRmb) || packagingCostRmb < 0) fail('SIBLING_BATCH_EVIDENCE_PACKAGING_REQUIRED');
  return applyLifecycleBEvidenceContext({ ...child, targetPlatform: platform, packagingCostRmb,
    lifecycleEvidenceContextV11: { ...prior, category } }, { submission, route, guooFilePath }).candidate;
}

const effective = (values, member, key) => member.overrides[key] === undefined || member.overrides[key] === ''
  ? values.shared[key] : member.overrides[key];

function numberInput(value, field, positive, missing) {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value)) ||
      (positive ? Number(value) <= 0 : Number(value) < 0)) {
    missing.push({ field, reason: 'saved_draft_value_missing_or_invalid' });
    return null;
  }
  return Number(value);
}

function memberInputs(values, member) {
  const missing = [];
  const read = (key, positive = false) => numberInput(effective(values, member, key), key, positive, missing);
  const unitProductPrice = read('goods', true), unitDomesticFreight = read('freight'), otherPurchaseCosts = read('other');
  const weightKg = read('weight', true), packagingCostRmb = read('packaging'), targetSalePriceRub = read('price', true);
  const dimensionsCm = Object.fromEntries(['length', 'width', 'height'].map(key => [key, read(key, true)]));
  const route = effective(values, member, 'route');
  if (!text(route)) missing.push({ field: 'route', reason: 'saved_draft_value_missing_or_invalid' });
  return { missing, route, packagingCostRmb, submission: { targetSalePriceRub,
    supplierConfirmation: { supplierSkuId: member.sourceSkuId, unitProductPrice, unitDomesticFreight,
      otherPurchaseCosts, actualPurchaseCost: missing.some(item => ['goods', 'freight', 'other'].includes(item.field))
        ? null : unitProductPrice + unitDomesticFreight + otherPurchaseCosts,
      weightKg, dimensionsCm, ownerSupplyConfirmed: false } } };
}

function savedDraft(document, input, family, catalog) {
  const history = document.runtime?.siblingPreparationDrafts;
  if (!Array.isArray(history)) fail('SIBLING_BATCH_EVIDENCE_DRAFT_REQUIRED');
  const draft = history.filter(item => item.parentCandidateId === input.parentCandidateId).at(-1);
  if (!draft || draft.draftRevision !== input.draftRevision || draft.sourceRevision !== input.parentRevision ||
      family.parent.dataRevision !== input.parentRevision || draft.catalogId !== catalog.catalogId ||
      draft.catalogVersion !== catalog.version || !Array.isArray(draft.memberRevisions) ||
      draft.memberRevisions.length !== family.members.length || family.members.some((child, index) =>
        draft.memberRevisions[index]?.candidateId !== child.id || draft.memberRevisions[index]?.revision !== child.dataRevision)) {
    fail('SIBLING_BATCH_EVIDENCE_DRAFT_CHANGED');
  }
  validatePreparationValues(draft.values, family, catalog);
  if (family.members.some(child => child.lifecycleV11?.skuPackage)) fail('SIBLING_BATCH_EVIDENCE_PHASE_CONFLICT');
  return draft;
}

/** Draft edits do not change candidate revisions; an official price-tier reading still binds its exact price. */
export function selectSiblingBatchEvidenceForPrice({ candidate, evidencePacks, targetSalePriceRub }) {
  if (!Number.isFinite(targetSalePriceRub) || targetSalePriceRub <= 0 || !Array.isArray(evidencePacks)) {
    fail('SIBLING_BATCH_EVIDENCE_PRICE_REQUIRED');
  }
  const excludedEvidence = [];
  const applicable = evidencePacks.filter(pack => {
    const binding = pack.evidenceData?.officialCommissionBinding;
    const priceChanged = pack.kind === 'commission' && pack.evidenceData?.commissionEvidenceMode === 'official_reference' &&
      binding?.candidateId === candidate.id && binding.candidateRevision === candidate.dataRevision &&
      binding.priceRub !== targetSalePriceRub;
    if (priceChanged) excludedEvidence.push({ evidencePackId: pack.id, reason: 'official_commission_price_changed',
      candidateId: candidate.id, candidateRevision: candidate.dataRevision,
      previousPriceRub: binding.priceRub, targetSalePriceRub });
    return !priceChanged;
  });
  return { evidencePacks: applicable, excludedEvidence };
}

/** Internal read-only inputs. The caller exposes the plans, not these candidate projections, to the UI. */
export function prepareSiblingBatchEvidenceInputs({ document, catalog, input, plannedAt, guooFilePath }) {
  if (!object(input) || Object.keys(input).sort().join() !== 'draftRevision,parentCandidateId,parentRevision' ||
      !text(input.parentCandidateId) || !Number.isSafeInteger(input.parentRevision) || input.parentRevision < 0 ||
      !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1 || !time(plannedAt) ||
      !Array.isArray(catalog?.supplierSkuIds) || catalog.supplierSkuIds.length < 1 || catalog.supplierSkuIds.length > 100 ||
      !catalog.supplierSkuIds.every(text) || new Set(catalog.supplierSkuIds).size !== catalog.supplierSkuIds.length) {
    fail('SIBLING_BATCH_EVIDENCE_INPUT_INVALID');
  }
  const family = preparationFamily(document, input.parentCandidateId, catalog);
  const familyIds = new Set([family.parent.id, ...family.members.map(member => member.id)]);
  const identityCounts = new Map([...familyIds].map(id => [id, 0]));
  for (const candidate of document.candidates) {
    if (familyIds.has(candidate.id)) identityCounts.set(candidate.id, identityCounts.get(candidate.id) + 1);
  }
  if (familyIds.size !== family.members.length + 1 || [...identityCounts.values()].some(count => count !== 1)) {
    fail('SIBLING_BATCH_EVIDENCE_FAMILY_IDENTITY_INVALID');
  }
  const draft = savedDraft(document, input, family, catalog);
  const supply = siblingSupplyPreparation(family.parent, family.members);
  const evidencePacks = document.evidencePacks ?? [];
  const currentCommissionCatalogs = document.currentCommissionCatalogs ?? [];
  const members = family.members.map((child, index) => {
    const values = memberInputs(draft.values, draft.values.members[index]);
    const missing = [...values.missing, ...supply.gaps.filter(gap => gap.candidateId === child.id)
      .map(gap => ({ field: 'quantityOneEvidence', reason: gap.message }))];
    const scope = { candidateId: child.id, candidateRevision: child.dataRevision,
      sourceSkuId: child.siblingSourceV1.supplierSkuId };
    if (missing.length) return { ...scope, status: 'blocked_input', missing, candidate: null,
      submission: null, otherCosts: null, plan: null };
    const candidate = resolveSiblingBatchEvidenceCandidate({ document, parent: family.parent, child,
      route: values.route, packagingCostRmb: values.packagingCostRmb, guooFilePath, submission: values.submission });
    const costReadiness = inspectLifecycleBCostReadiness({ candidate, rules: document.rules, asOf: plannedAt });
    const applicable = selectSiblingBatchEvidenceForPrice({ candidate, evidencePacks,
      targetSalePriceRub: values.submission.targetSalePriceRub });
    const plan = buildLifecycleBEvidencePreparationPlan({ candidate, evidencePacks: applicable.evidencePacks, plannedAt, currentCommissionCatalogs });
    return { ...scope, status: costReadiness.ready ? plan.status : 'blocked_cost_policy',
      missing: [...costReadiness.missing.map(reason => ({ field: 'costPolicy', reason })),
        ...plan.actions.filter(action => action.action === 'prepare_once').map(action => ({ field: action.kind, reason: action.reason }))],
      candidate, submission: values.submission, excludedEvidence: applicable.excludedEvidence,
      otherCosts: costReadiness.ready ? buildLifecycleBExplicitOtherCosts(candidate,
        resolveLifecycleBProfitRule(candidate, document.rules), { asOf: plannedAt }) : null,
      plan };
  });
  return { schemaVersion: SIBLING_BATCH_EVIDENCE_PREPARATION_VERSION, ...structuredClone(input), plannedAt,
    status: members.some(member => ['blocked_input', 'blocked_cost_policy', 'blocked_context'].includes(member.status))
      ? 'blocked_input' : members.every(member => member.status === 'ready_from_reuse') ? 'ready_from_reuse' : 'preparation_required',
    members, evidencePacks: structuredClone(evidencePacks), currentCommissionCatalogs: structuredClone(currentCommissionCatalogs),
    businessStateEffect: 'unchanged', productionAuthorizationGranted: false, platformWrites: 0, externalRequests: 0 };
}

function mergePreparedPacks(existing, additions) {
  const next = [...existing];
  for (const pack of additions) {
    const sameId = next.find(item => item.id === pack.id);
    if (sameId && !isDeepStrictEqual(sameId, pack)) fail('SIBLING_BATCH_EVIDENCE_PACK_ID_CONFLICT');
    if (!sameId) next.push(pack);
  }
  return next;
}

function providersForSubmittedPrice(providers, targetSalePriceRub) {
  if (typeof providers.commission !== 'function') return providers;
  return { ...providers, commission: async request => {
    const pack = await providers.commission(request);
    if (pack?.evidenceData?.commissionEvidenceMode === 'official_reference' &&
        pack.evidenceData.officialCommissionBinding?.priceRub !== targetSalePriceRub) {
      fail('SIBLING_BATCH_EVIDENCE_PREPARED_COMMISSION_PRICE_MISMATCH');
    }
    return pack;
  } };
}

/** Providers own authorized I/O; this bounded runner neither creates jobs nor approves A. */
export async function runSiblingBatchEvidencePreparation({ prepared, providers, clock = () => new Date(),
  getCurrentCommissionCatalogs = () => prepared.currentCommissionCatalogs }) {
  if (prepared?.schemaVersion !== SIBLING_BATCH_EVIDENCE_PREPARATION_VERSION || !Array.isArray(prepared.members) ||
      prepared.members.length < 1 || prepared.members.length > 100 || !object(providers) || typeof clock !== 'function' ||
      typeof getCurrentCommissionCatalogs !== 'function') fail('SIBLING_BATCH_EVIDENCE_RUN_INVALID');
  if (prepared.status === 'blocked_input') return { status: 'blocked_input', members: [], evidencePacksToCommit: [],
    failure: { layer: 'saved_draft_inputs', reason: '本批草稿或成本政策尚未齐备' },
    businessStateEffect: 'unchanged', productionAuthorizationGranted: false, platformWrites: 0, providerCalls: [] };
  let evidencePacks = structuredClone(prepared.evidencePacks);
  const members = [], evidencePacksToCommit = [], providerCalls = [];
  for (const member of prepared.members) {
    if (member.candidate?.id !== member.candidateId || member.candidate.dataRevision !== member.candidateRevision ||
        member.candidate.siblingSourceV1?.supplierSkuId !== member.sourceSkuId ||
        member.submission?.supplierConfirmation?.ownerSupplyConfirmed !== false) fail('SIBLING_BATCH_EVIDENCE_RUN_IDENTITY_CHANGED');
    const applicable = selectSiblingBatchEvidenceForPrice({ candidate: member.candidate, evidencePacks,
      targetSalePriceRub: member.submission.targetSalePriceRub });
    const run = await runLifecycleBEvidencePreparation({ candidate: member.candidate, submission: member.submission,
      evidencePacks: applicable.evidencePacks,
      providers: providersForSubmittedPrice(providers, member.submission.targetSalePriceRub),
      plannedAt: prepared.plannedAt, clock,
      currentCommissionCatalogs: prepared.currentCommissionCatalogs, getCurrentCommissionCatalogs });
    members.push({ candidateId: member.candidateId, candidateRevision: member.candidateRevision,
      sourceSkuId: member.sourceSkuId, excludedEvidence: applicable.excludedEvidence, ...run });
    providerCalls.push(...run.providerCalls.map(call => ({ candidateId: member.candidateId, ...call })));
    if (run.status !== 'completed') return { status: 'failed', members, evidencePacksToCommit,
      failure: { candidateId: member.candidateId, ...run.failure }, providerCalls,
      businessStateEffect: 'unchanged', productionAuthorizationGranted: false, platformWrites: 0 };
    evidencePacks = mergePreparedPacks(evidencePacks, run.evidencePacksToCommit);
    evidencePacksToCommit.push(...run.evidencePacksToCommit);
  }
  return { status: 'completed', members, evidencePacksToCommit, failure: null, providerCalls,
    businessStateEffect: 'unchanged', productionAuthorizationGranted: false, platformWrites: 0 };
}
