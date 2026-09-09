import { assertC2FinalMediaContent } from "../lib/c2-media-content-rules.mjs";

export function c2MediaSlots(candidate) {
  const media = candidate.lifecycleV11?.skuPackage?.c2FinalAssets?.mediaRequirements;
  if (!media || !Array.isArray(media.imageSlots) || !Array.isArray(media.videoSlots)) return [];
  return [...media.imageSlots, ...media.videoSlots];
}

export function buildC2FinalAssetInput({ candidate, sourceRevision, draftRevision, assets, ownerChecked }) {
  if (!Number.isInteger(sourceRevision) || sourceRevision !== candidate.dataRevision) throw new Error("商品修订已变化，未提交旧素材。");
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) throw new Error("素材清单尚未持久保存，不能确认。");
  if (!ownerChecked) throw new Error("请明确确认最终素材、首图、顺序和视频处置。");
  const slots = c2MediaSlots(candidate);
  if (!slots.length) throw new Error("当前Schema未提供完整媒体槽位，请等待合同补齐；不猜测角色。");
  if (new Set(slots.map(slot => slot.slotId)).size !== slots.length || slots.some(slot =>
    typeof slot.slotId !== "string" || !slot.slotId.trim() || typeof slot.role !== "string" || !slot.role.trim() ||
    !["image", "video"].includes(slot.mediaType) || !Number.isInteger(slot.minCount) ||
    !Number.isInteger(slot.maxCount) || slot.minCount < 0 || slot.maxCount < slot.minCount)) {
    throw new Error("媒体Schema缺少唯一槽位、角色或完整数量边界。");
  }
  if (!assets.length || new Set(assets.map(asset => asset.assetId)).size !== assets.length) throw new Error("最终素材清单为空或重复。");
  const finalUploadAssets = assets.map((asset, index) => {
    const matches = slots.filter(slot => slot.slotId === asset.slotId && slot.mediaType === asset.mediaType);
    if (matches.length !== 1) throw new Error(`${asset.fileName}：请从当前Schema选择明确槽位。`);
    const slot = matches[0];
    const result = {};
    for (const key of ["assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "byteSize", "sourceEvidenceRef", "sourceType", "stagedAt", "stableUrlEvidenceRef", "usageAuthorization", "width", "height"]) {
      if (asset[key] !== undefined) result[key] = structuredClone(asset[key]);
    }
    return { ...result, slotId: slot.slotId, role: slot.role, order: index + 1, addedAt: asset.stagedAt };
  });
  const main = finalUploadAssets.filter(asset => asset.role === "main_image");
  if (main.length !== 1 || main[0].mediaType !== "image" || main[0].order !== 1) throw new Error("必须明确选择唯一首图槽位，并将该图片排在第1位。");
  for (const slot of slots) {
    const count = finalUploadAssets.filter(asset => asset.slotId === slot.slotId).length;
    if (count < slot.minCount || count > slot.maxCount) throw new Error(`槽位 ${slot.slotId} 需要 ${slot.minCount}–${slot.maxCount} 个素材。`);
  }
  const includesVideo = finalUploadAssets.some(asset => asset.mediaType === "video");
  const c2 = candidate.lifecycleV11.skuPackage.c2FinalAssets;
  if (!includesVideo && (c2.mediaRequirements.schemaVideoRequirement?.status === "required" || c2.ownerVideoRequirement?.required === true)) {
    throw new Error("当前Schema或主人已要求视频，缺少视频不能确认。");
  }
  assertC2FinalMediaContent({ mediaRequirements: c2.mediaRequirements, assets: finalUploadAssets, checkedAt: new Date().toISOString() });
  return {
    dataRevision: sourceRevision,
    draftRevision,
    finalUploadAssets: finalUploadAssets.map(({ assetId, slotId, order }) => ({ assetId, slotId, order })),
    approvedAssetIds: finalUploadAssets.map(asset => asset.assetId),
    approvedMainImageAssetId: main[0].assetId,
    approvedVideoDisposition: includesVideo ? "includes_video" : "excludes_video",
    confirmationNote: null
  };
}
