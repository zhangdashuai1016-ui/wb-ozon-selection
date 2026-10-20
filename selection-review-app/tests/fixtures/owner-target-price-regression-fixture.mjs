import {
  addEvidenceContext, candidate, confirmedAt, currentOtherCosts, evidencePacks, submission
} from './real-a-b-flow-fixture.mjs';
import { buildRealAConfirmationCard } from '../../lib/real-a-confirmation-card.mjs';
import { runRealAConfirmationToBAndC1 } from '../../lib/real-a-b-c1-flow.mjs';
import { createSkuLifecycleFromConfirmedSupply } from '../../lib/supplier-selection-flow.mjs';

export { confirmedAt };

/** Synthetic official-table evidence; no table download or platform observation is claimed. */
export function officialCommissionPack(source, priceRub, { scope, rate = 0.12 } = {}) {
  const base = evidencePacks()[0];
  const priceTier = priceRub <= 1500 ? 'le1500' : priceRub <= 5000 ? '1500_5000' : 'gt5000';
  return {
    ...base,
    id: `synthetic:official-commission:${source.id}:${source.dataRevision}:${priceRub}`,
    scope: structuredClone(scope ?? base.scope),
    sourceType: 'ozon_official_commission_table',
    sourceRef: `ozon-official-commission:2026-08-01:sha256:${'b'.repeat(64)}:${priceTier}`,
    commissionCatalogRef: {
      effectiveFrom: '2026-08-01', fileSha256: 'b'.repeat(64),
      sourceUrl: 'https://docs.ozon.ru/commission/synthetic-owner-price', priceTier,
      matchedRow: { typeRu: 'Синтетическая категория', typeZh: '合成类目', mpCategoryZh: '合成目录' }
    },
    evidenceData: {
      commissionRate: rate, commissionEvidenceMode: 'official_reference', estimateAuthorized: false,
      exactCommissionRequiredAtC: true,
      officialCommissionBinding: { schemaVersion: 'ozon-official-commission-binding-v1',
        candidateId: source.id, candidateRevision: source.dataRevision, priceRub }
    }
  };
}

/** Keep the public fixture intact: only this regression has market 475 and owner target 848. */
export async function ownerTargetFlowFixture({ marketPriceRub = 475, targetPriceRub = 848,
  mode = 'official_reference', commissionPriceRub = targetPriceRub ?? marketPriceRub } = {}) {
  const source = addEvidenceContext(structuredClone(await candidate()));
  source.salesSnapshotsV11[0].currentPrice = marketPriceRub;
  const input = submission(buildRealAConfirmationCard(source));
  if (targetPriceRub !== null) input.targetSalePriceRub = targetPriceRub;
  const packs = evidencePacks();
  if (mode === 'official_reference') packs[0] = officialCommissionPack(source, commissionPriceRub);
  if (mode === 'estimated') {
    Object.assign(packs[0].evidenceData, {
      commissionEvidenceMode: 'estimated', estimateAuthorized: true,
      commissionEstimateAuthorization: { schemaVersion: 'commission-estimate-authorization-v1',
        candidateId: source.id, candidateRevision: source.dataRevision,
        authorizationRef: 'synthetic:owner-target:estimate', commissionRate: packs[0].evidenceData.commissionRate }
    });
  }
  const args = { candidate: source, submission: input, evidencePacks: packs,
    otherCosts: currentOtherCosts(source), confirmedAt };
  return { source, input, packs, args };
}

export function saveFlowResult(source, result) {
  return { ...structuredClone(source), dataRevision: source.dataRevision + 1,
    lifecycleV11: { schemaVersion: 'product-lifecycle-v1.1',
      status: result.c1Handoff ? 'b_passed_auto_c1' : 'b_conditional_awaiting_exact_commission',
      aConfirmationReceipt: { receiptId: result.confirmationReceiptId, decision: 'confirm',
        sourceCandidateRevision: result.sourceCandidateRevision, confirmedAt },
      opportunityPackage: structuredClone(result.opportunityPackage),
      ownerSupplyConfirmation: structuredClone(result.ownerSupplyConfirmation),
      bSystemEvidenceBundle: structuredClone(result.systemEvidenceBundle),
      skuPackage: structuredClone(result.skuPackage),
      c1Handoffs: result.c1Handoff ? [structuredClone(result.c1Handoff)] : [],
      externalAccesses: [], platformWrites: 0 } };
}

/** Produce B inputs from the real A domain result, without pre-filling a profit or C1 result. */
export function profitInputs(fixture) {
  const result = runRealAConfirmationToBAndC1(fixture.args);
  const skuPackage = createSkuLifecycleFromConfirmedSupply({ candidateId: fixture.source.id,
    opportunityPackage: result.opportunityPackage, storeRef: fixture.source.storeRef,
    ownerSupplyConfirmation: result.ownerSupplyConfirmation, skuPackageId: result.skuPackage.skuPackageId,
    createdAt: confirmedAt });
  const ownerTargetPrice = Object.hasOwn(fixture.input, 'targetSalePriceRub') ? {
    amountRub: fixture.input.targetSalePriceRub, candidateId: fixture.source.id,
    sourceRevision: fixture.source.dataRevision,
    evidenceRef: `owner-a-confirmation:${fixture.source.id}:${fixture.source.dataRevision}`, confirmedAt
  } : null;
  return { opportunityPackage: result.opportunityPackage, skuPackage,
    salesSelection: { salesSnapshotId: fixture.input.salesReview.snapshotId,
      ...(ownerTargetPrice ? { ownerTargetPrice: structuredClone(ownerTargetPrice) } : {}) },
    platformFeeEvidence: result.systemEvidenceBundle.platformFeeEvidence,
    logisticsEvidence: result.systemEvidenceBundle.logisticsEvidence,
    exchangeRateEvidence: result.systemEvidenceBundle.exchangeRateEvidence, calculatedAt: confirmedAt };
}
