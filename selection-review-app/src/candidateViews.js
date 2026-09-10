/** Display saved evidence only. This projection grants no rights or production permission. */
export function candidateRightsCompliancePresentation(candidate) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const pending = [];
  const legacyRisks = [];
  for (const [field, label] of [["complianceStatus", "合规"], ["authorizationStatus", "品牌/IP 权利"]]) {
    const status = candidate[field];
    if (status === "clear") continue;
    if (status === undefined || status === null || status === "" || status === "needs_confirmation") {
      pending.push(`${label}资料尚待核验；缺失资料不表示已发现风险。`);
    } else {
      legacyRisks.push(typeof status === "string" ? `${label}旧记录状态：${status}；需核对具体风险。` : `${label}旧记录格式无效，需核对。`);
    }
  }
  if (plan) {
    const { rights, compliance } = candidate.c1ReviewPresentation ?? {};
    const complianceDetail = compliance?.status === "clear" ? "当前 C1 已记录合规核验通过。"
      : compliance?.status === "historical" ? `历史 C1 合规记录：${compliance.assessment}；尚未按当前合同完成核验。`
      : compliance?.status === "review_required" ? `当前 C1 合规结论：${compliance.assessment}；需核对具体风险。`
      : "当前 C1 合规证据尚未完整对应此商品，仍需核验。";
    const rightsDetail = rights?.status === "verified" ? "当前 C1 已记录品牌/IP 权利核验通过。"
      : rights?.status === "requires_authorization" ? "品牌/IP 权利仍待取得适用于当前商品的授权。"
      : rights?.status === "blocked" ? rights.code === "C1_SKU_RIGHTS_REVIEW_BRAND_CONFLICT"
        ? "品牌资料与权利核验记录不一致，需复核。" : "品牌/IP 权利核验已记录阻塞，需复核具体限制。"
      : rights?.status === "expired" ? "品牌/IP 权利证据已过期，须重新核验。"
      : rights?.status === "invalid" ? "品牌/IP 权利证据未完整匹配当前商品，仍需核验。"
      : rights?.code === "C1_SKU_RIGHTS_REVIEW_NOT_YET_VALID" ? "品牌/IP 权利证据尚未生效，仍需核验。"
      : "品牌/IP 权利证据尚未取得，仍需核验；品牌名称不等于权利证明。";
    const rightsBlocked = ["blocked", "requires_authorization", "invalid"].includes(rights?.status);
    return {
      title: legacyRisks.length || rightsBlocked ? "权利或合规记录需复核"
        : compliance?.status === "review_required" ? "合规结论需复核"
        : rights?.status === "verified" && compliance?.status === "clear" ? "权利与合规核验已记录" : "权利与合规资料待核验",
      details: [complianceDetail, rightsDetail, ...legacyRisks]
    };
  }
  const details = [...legacyRisks, ...pending];
  return details.length ? { title: legacyRisks.length ? "权利或合规记录需复核" : "权利与合规资料待核验", details } : null;
}

export function matchesQueue(candidate, queue, sourceFilter = "all") {
  const sourceMatches =
    ["eliminated", "listed"].includes(queue) ||
    sourceFilter === "all" ||
    candidate.source === sourceFilter;
  return candidate.workflowStatus === queue && sourceMatches;
}

export function orderCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const processing = Number(b.workflowStatus === "codex_processing") - Number(a.workflowStatus === "codex_processing");
    if (processing) return processing;
    if (a.workflowStatus === "codex_processing" && b.workflowStatus === "codex_processing" && a.source !== b.source) {
      const userFirst = Number(b.source === "user") - Number(a.source === "user");
      if (userFirst) return userFirst;
    }
    const time = candidate => {
      const value = Date.parse(candidate.updatedAt || candidate.createdAt);
      return Number.isFinite(value) ? value : 0;
    };
    return time(b) - time(a) || String(a.id).localeCompare(String(b.id));
  });
}

export function firstInQueue(candidates, queue, sourceFilter = "all", exceptId = "") {
  return orderCandidates(candidates).find(
    (candidate) =>
      candidate.id !== exceptId && matchesQueue(candidate, queue, sourceFilter)
  );
}
