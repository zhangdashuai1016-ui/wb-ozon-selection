import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSeerfarOpenApiTransport } from '../../lib/seerfar-open-api-transport.mjs';
import { createInitialCandidate } from '../../lib/candidate-initialization.mjs';
import { createJsonBusinessStateRepository } from '../../lib/business-state-repository.mjs';
import { buildRealAConfirmationCard } from '../../lib/real-a-confirmation-card.mjs';

/** Isolated seam verification, NOT a production importer or collection authorization. */
export async function verifySeerfarMarketEntryReplay({ body, platform, categoryId, sourceReference, historicalDate, targetStore }) {
  assert.equal(['ozon', 'wb'].includes(platform), true);
  assert.equal(platform === 'wb' ? targetStore === 'wb' : ['miska', 'dandanshu'].includes(targetStore), true);
  const at = new Date(`${historicalDate}T00:00:00.000Z`).toISOString();
  const steps = [];
  const transport = createSeerfarOpenApiTransport({
    secretProvider: async () => 'isolated-replay-placeholder', clock: { now: () => 0 }, sleep: async () => {},
    httpTransport: async request => {
      steps.push(request.step);
      return { status: 200, json: request.step === 'category_detail' ? body : { code: 200, data: {} },
        requestId: `isolated-replay:${request.step}`, completedAt: at };
    }
  });
  const receipt = await transport({ targetPlatform: platform, fulfillment: platform === 'ozon' ? 'rfbs' : 'FBS_OVERSEAS',
    attemptLimit: 1, seerfarRequest: { operation: 'category_detail', platform, categoryId,
      queryId: `isolated-replay:${platform}`, attemptId: 'isolated-replay:1', startedAt: at } });
  assert.equal(receipt.marketProducts.length, body.data.productList.length);
  assert.equal(receipt.observation.resultCount, receipt.marketProducts.length);
  assert.equal(receipt.explicitEmpty, false);
  assert.deepEqual(receipt.candidates, []);
  assert.deepEqual(steps, ['quota_before', 'category_detail', 'quota_after']);
  assert.deepEqual([receipt.pointsBefore, receipt.pointsAfter, receipt.pointsSpent], [null, null, null]);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'seerfar-market-entry-'));
  try {
    const filePath = path.join(temporary, 'state.json');
    const repository = createJsonBusinessStateRepository({ filePath, initializeIfMissing: true,
      initialDocument: () => ({ candidates: [], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } }) });
    // Intentionally invoke the current candidate factory, not the LinkFox importer.
    // No copied/renamed permit or successful job is manufactured for this replay.
    await repository.transact(document => {
      document.candidates = receipt.marketProducts.map((product, index) => createInitialCandidate({
        input: { targetStore, productName: product.title, productUrl: product.productUrl, imageUrl: product.imageUrl,
          notes: `历史回放测试材料，非当前市场证据；来源 ${sourceReference}，历史日期 ${historicalDate}，行 ${index}。` },
        source: 'software', id: `isolated-replay:${platform}:${product.productId}`, timestamp: at, storeBindings: []
      }));
      return { changed: true, document };
    });
    const cold = createJsonBusinessStateRepository({ filePath });
    const saved = await cold.readSnapshot(), before = await fs.readFile(filePath, 'utf8');
    assert.equal(saved.candidates.length, receipt.marketProducts.length);
    for (const [index, candidate] of saved.candidates.entries()) {
      const product = receipt.marketProducts[index], card = buildRealAConfirmationCard(candidate);
      assert.equal(candidate.productUrl, product.productUrl); assert.equal(candidate.productName, product.title);
      assert.equal(product.productId, String(body.data.productList[index].sku)); assert.equal(product.currency, null);
      assert.equal(candidate.executionRuntime.businessPhase, 'A'); assert.equal(candidate.executionRuntime.stepId, 'A_DETAIL_EVIDENCE_REQUIRED');
      assert.equal(candidate.workflowStatus, 'needs_user_data'); assert.equal(candidate.processing.state, 'idle');
      assert.match(candidate.notes, /历史回放测试材料，非当前市场证据/);
      for (const key of ['expectedPriceRub', 'sellerRevenueCny', 'purchasePriceRmb', 'domesticShippingRmb', 'packagingCostRmb', 'defaultStock', 'storeRef']) assert.equal(candidate[key], null);
      for (const key of ['aDiscoveryEvidenceV1', 'lifecycle', 'lifecycleV11', 'sourceCapture']) assert.equal(Object.hasOwn(candidate, key), false);
      assert.equal(candidate.listingPreparation, null); assert.equal(candidate.bPassedAt, null);
      assert.equal(card.sourceCandidateId, candidate.id); assert.equal(card.productName, product.title);
      assert.equal(card.targetPlatform, platform); assert.equal(card.salesReview, null);
      assert.equal(card.confirmation.ownerSupplyConfirmed, false); assert.equal(card.confirmation.businessStateChanged, false);
    }
    assert.deepEqual(saved.runtime, { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] });
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    return { platform, historicalDate, sourceReference, rows: receipt.marketProducts.length,
      parser: 'createSeerfarOpenApiTransport/category_detail', entry: 'createInitialCandidate/software',
      persistence: 'temporary JSON repository reopened', view: 'buildRealAConfirmationCard',
      phase: 'A', step: 'A_DETAIL_EVIDENCE_REQUIRED', historicalMaterialOnly: true,
      syntheticTransportCalls: steps.length, currentExternalRequests: 0, currentSecretReads: 0,
      productionJobsCreated: 0, productionPermitsCreated: 0, installed: false, enabled: false,
      productionDiscoveryImporterExercised: false, actualStoreSelectedByOwner: false };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
