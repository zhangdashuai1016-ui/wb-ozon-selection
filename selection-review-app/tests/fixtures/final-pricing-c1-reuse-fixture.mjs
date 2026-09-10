import assert from 'node:assert/strict';
import { createFinalPricingRevalidationFixture } from './final-pricing-revalidation-fixture.mjs';
import { createC1PaidFormalFixture } from './c1-draft-source-fixture.mjs';
import { c1AiSoftwareJobFixture, c1AiSoftwareJobResultEnvelope } from './c1-ai-software-job-fixture.mjs';
import { bindSoftwareJobAdmissionForEnqueue } from '../../lib/software-job-admission.mjs';
import { claimSoftwareJobLease, markSoftwareJobExternalRequestStarted, settleSoftwareJob, readCompletedC1AiSoftwareJobResult } from '../../lib/software-job-contract.mjs';
import { mergeC1AiDraftReceipt } from '../../lib/c1-ai-draft-contract.mjs';
import { createC2SoftwareContainer } from '../../lib/c2-software-orchestrator.mjs';
import { buildLifecycleBExplicitOtherCosts } from '../../lib/lifecycle-b-evidence-runtime.mjs';
import { createLifecycleBInputBundle } from '../../lib/lifecycle-b-input-bundle.mjs';
import { createMemoryBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { createFinalPricingReviewUseCase } from '../../lib/final-pricing-review-use-case.mjs';

export function finalPricingC1ReuseFixture() {
  const base = createFinalPricingRevalidationFixture(), at = '2026-08-22T02:00:00.000Z', observedAt = '2026-08-22T02:03:00.000Z';
  const jobId = 'software-job:c1-pricing:synthetic', authorizationId = 'authorization:c1-ai-draft:pricing-synthetic';
  const formal = createC1PaidFormalFixture({ at, softwareJobId: jobId, authorizationId });
  const f = c1AiSoftwareJobFixture({ formalDraftFixture: formal, jobId, authorizationId });
  let job = bindSoftwareJobAdmissionForEnqueue({ document: f.document, job: f.job, observedAt: at, phase: 'enqueue_current' });
  job = claimSoftwareJobLease({ job, worker: f.worker, leaseId: 'lease:synthetic:pricing', serverTime: at, leaseDurationMs: 300000 });
  job = markSoftwareJobExternalRequestStarted({ job, workerId: f.worker.workerId, leaseId: job.leaseId, externalRequestRef: 'request:synthetic:pricing', serverTime: at });
  job = settleSoftwareJob({ job, workerId: f.worker.workerId, leaseId: job.leaseId, status: 'completed', externalRequestState: 'succeeded', serverTime: '2026-08-22T02:02:00.000Z', resultEnvelope: c1AiSoftwareJobResultEnvelope(job, f.request) });
  const saved = readCompletedC1AiSoftwareJobResult(job);
  const merged = mergeC1AiDraftReceipt({ skuPackage: f.candidate.lifecycleV11.skuPackage, ...saved, mergedAt: '2026-08-22T02:02:00.000Z' });
  const c2 = createC2SoftwareContainer({ skuPackage: merged.skuPackage, expectedDataRevision: merged.skuPackage.dataRevision, assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: '2026-08-22T02:02:00.000Z' });
  const candidate = structuredClone(f.candidate);
  candidate.lifecycleV11.skuPackage = structuredClone(c2.skuPackage);
  candidate.lifecycleEvidenceContextV11 = structuredClone(base.candidate.lifecycleEvidenceContextV11);
  candidate.packagingCostRmb = base.candidate.packagingCostRmb;
  const evidencePacks = structuredClone(base.evidencePacks);
  for (const pack of evidencePacks) { pack.checkedAt = at; pack.expiresAt = '2026-08-24T02:00:00.000Z'; }
  const rules = structuredClone(base.rules), supplier = c2.skuPackage.selectedSupplySnapshot.supplierSku;
  candidate.lifecycleV11.bSystemEvidenceBundle = createLifecycleBInputBundle({ candidate, evidencePacks, createdAt: observedAt,
    otherCosts: buildLifecycleBExplicitOtherCosts(candidate, rules.ozonDandanshu, { asOf: observedAt }),
    normalizedSubmission: { supplierConfirmation: { weightKg: supplier.weight.value, dimensionsCm: supplier.dimensions } } });
  candidate.salesSnapshotsV11 = structuredClone(base.assessmentInput.salesSnapshots).map(snapshot => ({ ...snapshot,
    categoryPath: c2.skuPackage.c1ProductPlan.inputSnapshots.salesSnapshot.categoryPath }));
  const reviews = structuredClone(base.assessmentInput.reviews);
  const document = { candidates: [candidate], evidencePacks, rules, currentCommissionCatalogs: [], runtime: { ...structuredClone(f.document.runtime), softwareJobs: [job] } };
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'owner-1', sessionId: 'synthetic:pricing-session', actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: observedAt });
  const input = { candidateId: candidate.id, expectedRevision: candidate.dataRevision, skuPackageId: c2.skuPackage.skuPackageId,
    selectedPriceRub: 2000, reviews, idempotencyKey: 'synthetic:final-pricing:1', auditEventId: 'synthetic:final-pricing-audit:1' };
  assert.equal(job.status, 'completed'); assert.equal(saved.request.keywordEvidence.expiresAt, '2026-08-23T02:00:00.000Z');
  return { repository, actor, input, document, observedAt, saved,
    usecase: createFinalPricingReviewUseCase({ repository, runtimeMode: 'local_development', serverClock: () => observedAt }) };
}
