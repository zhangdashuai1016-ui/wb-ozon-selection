import { applyLifecycleBEvidenceContext } from "./lifecycle-b-evidence-context.mjs";
import { runLifecycleBEvidencePreparation } from "./lifecycle-b-evidence-preparation.mjs";
import { buildRealAConfirmationCard, validateRealAConfirmationSubmission } from "./real-a-confirmation-card.mjs";
import { runRealAConfirmationToBAndC1 } from "./real-a-b-c1-flow.mjs";

export const REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION = "real-a-b-evidence-orchestration-v1.1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function productIdFromSnapshot(snapshot) {
  if (String(snapshot?.productId || "").trim()) return String(snapshot.productId).trim();
  try {
    return new URL(String(snapshot?.productUrl || "")).pathname.match(/(\d{7,})(?:\/|$)/)?.[1] || null;
  } catch {
    return null;
  }
}

function freezeResolvedCompetitorCategory({ candidate, submission, evidencePreparation, evidencePacks, verifiedAt }) {
  const readinessFields = Array.isArray(evidencePreparation?.finalReadiness?.fields)
    ? evidencePreparation.finalReadiness.fields
    : [];
  const evidenceById = new Map((Array.isArray(evidencePacks) ? evidencePacks : []).map((pack) => [pack.id, pack]));
  const categoryPacks = ["commission", "schema"].map((kind) => {
    const field = readinessFields.find((item) => item.key === kind && item.available === true);
    return field?.evidencePackId ? evidenceById.get(field.evidencePackId) : null;
  });
  if (categoryPacks.some((pack) => !pack)) {
    throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前竞品类目缺少佣金或Schema的准确平台身份");
  }
  const identities = categoryPacks.map((pack) => ({
    descriptionCategoryId: positiveInteger(pack.evidenceData?.descriptionCategoryId),
    typeId: positiveInteger(pack.evidenceData?.typeId),
  }));
  if (identities.some((item) => !item.descriptionCategoryId || !item.typeId)) {
    throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前竞品类目证据没有准确description_category_id和type_id");
  }
  const identityKeys = new Set(identities.map((item) => `${item.descriptionCategoryId}:${item.typeId}`));
  if (identityKeys.size !== 1) {
    throw new Error("B_CATEGORY_EVIDENCE_CONFLICT: 当前佣金和Schema返回的竞品类目身份不一致");
  }

  const source = structuredClone(candidate);
  const snapshotId = submission?.salesReview?.snapshotId;
  const snapshot = (source.salesSnapshotsV11 || []).find((item) => item.snapshotId === snapshotId);
  if (!snapshot) throw new Error("B_CATEGORY_EVIDENCE_GAP: 当前确认的竞品销售快照不存在");
  const identity = identities[0];
  const categoryToken = `ozon:${identity.descriptionCategoryId}:${identity.typeId}`;
  snapshot.attributes = {
    ...structuredClone(snapshot.attributes || {}),
    description_category_id: identity.descriptionCategoryId,
    type_id: identity.typeId,
  };
  snapshot.platformCategoryEvidence = {
    status: "verified",
    descriptionCategoryId: identity.descriptionCategoryId,
    typeId: identity.typeId,
    categoryToken,
    sourceProductId: productIdFromSnapshot(snapshot),
    sourceSnapshotId: snapshot.snapshotId,
    sourceEvidenceRefs: categoryPacks.map((pack) => pack.id),
    verifiedAt,
  };
  return {
    candidate: source,
    persistedEvidenceContext: {
      ...structuredClone(source.lifecycleEvidenceContextV11 || {}),
      category: categoryToken,
    },
  };
}

/**
 * A确认的一次性只读编排：先校验主人提交，再由服务端锁定技术证据范围，
 * 四类证据全有或全无准备，最后才运行纯函数B/C1闭环。
 * 本函数不持久化、不派发任务、不写平台；调用方负责修订号复核后的原子提交。
 */
export async function runRealAConfirmationWithSystemEvidence({
  candidate,
  submission,
  evidencePacks = [],
  providers = {},
  confirmedAt,
  guooFilePath
}) {
  const card = buildRealAConfirmationCard(candidate);
  const validation = validateRealAConfirmationSubmission(card, submission);
  if (!validation.valid) {
    const detail = validation.errors.map((item) => `${item.label}：${item.reason}`).join("；");
    throw new Error(`REAL_A_CONFIRMATION_INVALID: ${detail}`);
  }

  // 淘汰是纯业务决定，绝不能触发佣金、物流、汇率或Schema读取。
  if (validation.decision === "reject") {
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "completed",
      contextualCandidate: structuredClone(candidate),
      evidenceContext: null,
      evidencePreparation: null,
      evidencePacksToCommit: [],
      result: runRealAConfirmationToBAndC1({
        candidate,
        submission,
        evidencePacks,
        confirmedAt
      }),
      externalAccesses: [],
      platformWrites: 0
    });
  }

  const contextResult = applyLifecycleBEvidenceContext(candidate, {
    submission: validation.normalized,
    guooFilePath
  });
  const evidencePreparation = await runLifecycleBEvidencePreparation({
    candidate: contextResult.candidate,
    evidencePacks,
    providers,
    plannedAt: confirmedAt
  });
  if (evidencePreparation.status !== "completed") {
    return deepFreeze({
      orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
      status: "blocked",
      contextualCandidate: contextResult.candidate,
      evidenceContext: contextResult.context,
      evidencePreparation,
      evidencePacksToCommit: [],
      result: null,
      externalAccesses: evidencePreparation.providerCalls,
      platformWrites: 0
    });
  }

  const combinedPacks = [...evidencePacks, ...evidencePreparation.evidencePacksToCommit];
  const categoryFreeze = freezeResolvedCompetitorCategory({
    candidate: contextResult.candidate,
    submission: validation.normalized,
    evidencePreparation,
    evidencePacks: combinedPacks,
    verifiedAt: confirmedAt,
  });
  const result = runRealAConfirmationToBAndC1({
    candidate: categoryFreeze.candidate,
    submission,
    evidencePacks: combinedPacks,
    confirmedAt,
    processedAt: evidencePreparation.finalReadiness.checkedAt
  });
  return deepFreeze({
    orchestrationVersion: REAL_A_B_EVIDENCE_ORCHESTRATION_VERSION,
    status: "completed",
    contextualCandidate: categoryFreeze.candidate,
    evidenceContext: categoryFreeze.persistedEvidenceContext,
    evidencePreparation,
    evidencePacksToCommit: evidencePreparation.evidencePacksToCommit,
    result,
    externalAccesses: evidencePreparation.providerCalls,
    platformWrites: 0
  });
}
