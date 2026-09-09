import { successfulExecution, exactObservation } from "./d-software-fixture.mjs";
import { authorizedProductionFixture } from "./c2-software-fixture.mjs";

/** Synthetic D result for independent E service and HTTP persistence verification. */
export async function systemEReadbackFixture() {
  const authorized = authorizedProductionFixture();
  const { result } = await successfulExecution();
  const sku = structuredClone(authorized.skuPackage);
  sku.productionRecord = structuredClone(result.productionRecord);
  const candidate = { id: authorized.candidateId, dataRevision: authorized.candidateRevision,
    targetStore: sku.targetStore, storeRef: structuredClone(sku.g1Identity.storeRef), workflowStatus: "listing_in_progress",
    notes: "保留主人备注", lifecycleV11: { skuPackage: sku } };
  const untouched = { id: "other-synthetic-product", dataRevision: 4, notes: "不得改变" };
  const document = { candidates: [candidate, untouched], dispatches: [{ id: "historical-read-only" }] };
  const input = { candidateId: candidate.id, expectedCandidateRevision: candidate.dataRevision,
    sourceRecordId: sku.productionRecord.productionRecordId };
  const observation = exactObservation(sku.productionRecord, { moderationStatus: "approved", validationStatus: "success", saleStatus: "on_sale" });
  return { document, candidate, input, observation, untouched };
}
