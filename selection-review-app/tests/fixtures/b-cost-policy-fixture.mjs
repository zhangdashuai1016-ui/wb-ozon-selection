/** Synthetic policy declarations for isolated tests; never approved production rules. */
export function createSyntheticBCostPolicy({ scope, values = {} }) {
  const costs = { labelRmb: 1.5, fixedOtherRmb: 0, advertisingRate: 0, returnReserveRate: 0,
    damageReserveRate: 0.05, withdrawalFeeRate: 0.02, acquiringRate: null, taxRate: null, otherRate: null, ...values };
  const items = Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, {
    status: value === null ? 'not_applicable' : 'applicable', value,
    basis: key === 'labelRmb' ? 'per_order_cny' : key === 'fixedOtherRmb' ? 'per_unit_cny' : 'target_price_cny_rate',
    evidenceRef: `synthetic-cost-evidence:${key}`, includedIn: null
  }]));
  return { schemaVersion: 'b-cost-policy-snapshot-v1', policyId: 'synthetic-cost-policy', policyVersion: 'synthetic-cost-policy-v1',
    scope: structuredClone(scope), effectiveFrom: null, effectiveTo: null, policyEvidenceRef: 'synthetic-cost-policy-evidence', items };
}
