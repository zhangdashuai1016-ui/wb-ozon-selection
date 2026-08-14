import {
  assertValidLifecyclePackage,
  validateLifecycleTransition
} from "./product-lifecycle-schema.mjs";
import {
  C1_FACT_VERIFICATION_VERSION,
  assertValidC1ProductPlan
} from "./c1-product-plan.mjs";

export const C1_SEO_DRAFT_VERSION = "c1-seo-draft-v1.1";
export const SEO_SKILL_RECEIPT = Object.freeze({
  skill: "optimize-ecommerce-seo",
  skillPath: "/Users/shuaizhang/Documents/电商能力实验室/optimize-ecommerce-seo/SKILL.md",
  platformGuidance: "references/platform-ozon.md",
  localeGuidance: "references/language-russian-commerce.md",
  executionStatus: "draft_only"
});
export const KEYWORD_SKILL_RECEIPT = Object.freeze({
  skill: "seerfar-reverse-keywords",
  skillPath: "/Users/shuaizhang/Documents/电商能力实验室/seerfar-lab/skills/seerfar-reverse-keywords/SKILL.md",
  handoffContract: "references/seo-handoff.md",
  executionStatus: "evidence_only"
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function factAtPath(plan, path) {
  return String(path || "").split(".").reduce((current, key) => current?.[key], plan);
}

function validateCompetitorTextSnapshot(snapshot, plan) {
  const errors = [];
  if (!isObject(snapshot)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (!nonEmptyString(snapshot.snapshotId)) push(errors, "snapshotId", "必须是非空字符串");
  if (snapshot.sourceSalesSnapshotId !== plan.inputRefs.salesSnapshotId) push(errors, "sourceSalesSnapshotId", "必须来自C1冻结销售快照");
  if (!isoDateTime(snapshot.observedAt)) push(errors, "observedAt", "必须是有效时间");
  if (!nonEmptyString(snapshot.evidenceRef)) push(errors, "evidenceRef", "必须是非空字符串");
  if (!Array.isArray(snapshot.texts) || snapshot.texts.length === 0) {
    push(errors, "texts", "必须至少包含一条竞品文本");
  } else {
    snapshot.texts.forEach((item, index) => {
      if (!isObject(item) || !nonEmptyString(item.textId) || !nonEmptyString(item.text) || !nonEmptyString(item.sourceRef)) {
        push(errors, `texts[${index}]`, "必须包含文本ID、正文和来源");
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateKeywordEvidence(evidence, plan) {
  const errors = [];
  if (!isObject(evidence)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  if (!nonEmptyString(evidence.evidenceId)) push(errors, "evidenceId", "必须是非空字符串");
  if (evidence.status !== "ready") push(errors, "status", "关键词证据必须ready");
  if (evidence.targetPlatform !== plan.identity.targetPlatform) push(errors, "targetPlatform", "必须匹配目标平台");
  if (evidence.targetSkuPackageId !== plan.identity.skuPackageId) push(errors, "targetSkuPackageId", "必须匹配当前SKU生命周期");
  if (!["reused_verified_evidence", "current_frozen_facts_no_volume"].includes(evidence.collectionMode)) {
    push(errors, "collectionMode", "只允许复用已验证关键词证据，或明确标注无搜索量的当前冻结事实词");
  }
  if (evidence.pointsSpent !== 0) push(errors, "pointsSpent", "当前零点数路径不得消耗点数");
  if (!nonEmptyString(evidence.reuseEvidenceNote)) push(errors, "reuseEvidenceNote", "必须说明复用适用性");
  if (!isoDateTime(evidence.observedAt)) push(errors, "observedAt", "必须是有效时间");
  if (!Array.isArray(evidence.keywords) || evidence.keywords.length === 0) {
    push(errors, "keywords", "必须至少包含一条关键词证据");
  } else {
    evidence.keywords.forEach((keyword, index) => {
      const path = `keywords[${index}]`;
      if (!isObject(keyword) || !nonEmptyString(keyword.query)) {
        push(errors, path, "必须包含查询词");
        return;
      }
      if (!nonEmptyString(keyword.keywordEvidenceRef)) push(errors, `${path}.keywordEvidenceRef`, "每个关键词必须有证据引用");
      if (!nonEmptyString(keyword.sourceSku)) push(errors, `${path}.sourceSku`, "每个关键词必须有来源SKU");
      if (!nonEmptyString(keyword.group)) push(errors, `${path}.group`, "每个关键词必须分组");
      if (!Array.isArray(keyword.factBindingPaths) || keyword.factBindingPaths.length === 0) {
        push(errors, `${path}.factBindingPaths`, "每个关键词必须绑定商品事实");
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function unique(values) {
  return [...new Set(values.filter(nonEmptyString))];
}

function capitalized(value) {
  const text = String(value || "").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function keywordRecord(keyword, factRefs) {
  return {
    query: keyword.query.trim(),
    group: keyword.group,
    evidenceRefs: unique([keyword.keywordEvidenceRef, keyword.sourceSku]),
    factRefs: unique(factRefs),
    reason: keyword.reason,
    sourcePlatform: keyword.sourcePlatform,
    sourceSku: keyword.sourceSku
  };
}

function draftField(text, keywordRecords, factRefs) {
  return {
    status: "draft_only",
    text,
    keywordEvidenceRefs: unique(keywordRecords.flatMap((item) => item.evidenceRefs)),
    factRefs: unique(factRefs),
    productionApproved: false
  };
}

export function validateC1SeoDraft(plan) {
  const errors = [];
  try {
    assertValidC1ProductPlan(plan);
  } catch (error) {
    push(errors, "$", error.message);
    return { valid: false, errors };
  }
  if (plan.status !== "seo_draft_ready") push(errors, "status", "必须是seo_draft_ready");
  if (plan.seoEvidenceLayer?.draftVersion !== C1_SEO_DRAFT_VERSION) push(errors, "seoEvidenceLayer.draftVersion", `必须是${C1_SEO_DRAFT_VERSION}`);
  if (plan.seoEvidenceLayer?.executionStatus !== "draft_only") push(errors, "seoEvidenceLayer.executionStatus", "必须是draft_only");
  if (!Array.isArray(plan.seoEvidenceLayer?.keywordsSelected)) push(errors, "seoEvidenceLayer.keywordsSelected", "必须是数组");
  for (const [field, value] of [
    ["seoTitleDraft", plan.seoTitleDraft],
    ["descriptionDraft", plan.descriptionDraft]
  ]) {
    if (!isObject(value) || !nonEmptyString(value.text) || value.status !== "draft_only" || value.productionApproved !== false) {
      push(errors, field, "必须是未获生产批准的非空草稿");
    }
  }
  if (!Array.isArray(plan.bulletPointsDraft) || plan.bulletPointsDraft.some((item) => !isObject(item) || !nonEmptyString(item.text))) {
    push(errors, "bulletPointsDraft", "必须是带证据的非空草稿数组");
  }
  if (!isObject(plan.searchKeywordsDraft) || !Array.isArray(plan.searchKeywordsDraft.keywords)) {
    push(errors, "searchKeywordsDraft", "必须包含关键词数组");
  } else {
    plan.searchKeywordsDraft.keywords.forEach((keyword, index) => {
      if (!nonEmptyString(keyword.query) || !Array.isArray(keyword.evidenceRefs) || keyword.evidenceRefs.length === 0 || !Array.isArray(keyword.factRefs) || keyword.factRefs.length === 0) {
        push(errors, `searchKeywordsDraft.keywords[${index}]`, "每个关键词必须同时有关键词证据和事实依据");
      }
    });
  }
  if (plan.finalSeo !== null || plan.generatedAssets !== null || plan.productionPayload !== null) {
    push(errors, "productionBoundary", "9B不得生成最终SEO、素材或生产数据");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 第9B阶段：只消费9A事实、冻结销售端竞品文本、SEO Skill规则和已验证关键词证据。
 */
export function createC1SeoDraft({
  skuPackage,
  competitorTextSnapshot,
  keywordEvidence,
  createdAt
}) {
  assertValidLifecyclePackage(skuPackage);
  const sourcePlan = skuPackage.c1ProductPlan;
  if (skuPackage.businessPhase !== "C1" || sourcePlan?.status !== "facts_checked" || sourcePlan.factVerificationVersion !== C1_FACT_VERIFICATION_VERSION) {
    throw new Error("C1_SEO_GATE_REJECTED: C1事实核验尚未完成");
  }
  if (!isoDateTime(createdAt)) throw new Error("C1_SEO_INPUT_GAP: 草稿时间无效");
  const competitorValidation = validateCompetitorTextSnapshot(competitorTextSnapshot, sourcePlan);
  if (!competitorValidation.valid) throw new Error("C1_SEO_INPUT_GAP: 销售端竞品文本快照无效");
  const keywordValidation = validateKeywordEvidence(keywordEvidence, sourcePlan);
  if (!keywordValidation.valid) throw new Error(`C1_SEO_INPUT_GAP: 关键词证据无效：${keywordValidation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);

  const selected = [];
  const rejected = [];
  for (const keyword of keywordEvidence.keywords) {
    const boundFacts = keyword.factBindingPaths.map((path) => ({ path, fact: factAtPath(sourcePlan, path) }));
    const unsupported = boundFacts.filter(({ fact }) => !isObject(fact) || fact.verificationStatus !== "confirmed" || fact.value === "unknown");
    if (unsupported.length > 0 || keyword.relevanceStatus !== "retained") {
      rejected.push({
        query: keyword.query,
        evidenceRefs: unique([keyword.keywordEvidenceRef, keyword.sourceSku]),
        reason: unsupported.length > 0 ? "unsupported_by_verified_product_facts" : (keyword.rejectionReason || "not_retained_by_relevance_filter")
      });
      continue;
    }
    selected.push(keywordRecord(keyword, boundFacts.map(({ path }) => path)));
  }
  if (selected.length === 0) throw new Error("C1_SEO_INPUT_GAP: 没有同时具备关键词证据和商品事实依据的关键词");

  const core = selected.find((item) => item.group === "core_product_type") || selected[0];
  const form = selected.find((item) => item.group === "product_form");
  const material = selected.find((item) => item.group === "material");
  const titleKeywords = unique([core?.query, form?.query]);
  const titleText = titleKeywords.map(capitalized).join(" — ");
  const descriptionSegments = [
    core ? `${capitalized(core.query)}.` : null,
    form ? `${capitalized(form.query)}.` : null,
    material ? `${capitalized(material.query)}.` : null
  ].filter(Boolean);
  const descriptionText = descriptionSegments.join(" ");
  const allFactRefs = unique(selected.flatMap((item) => item.factRefs));
  const allKeywordRefs = unique(selected.flatMap((item) => item.evidenceRefs));
  const bullets = selected.slice(0, 5).map((keyword) => draftField(
    `${capitalized(keyword.query)}.`,
    [keyword],
    keyword.factRefs
  ));

  const plan = structuredClone(sourcePlan);
  plan.status = "seo_draft_ready";
  plan.seoTitleDraft = draftField(titleText, selected.filter((item) => titleKeywords.includes(item.query)), allFactRefs);
  plan.descriptionDraft = draftField(descriptionText, selected, allFactRefs);
  plan.bulletPointsDraft = bullets;
  plan.searchKeywordsDraft = {
    status: "draft_only",
    keywords: structuredClone(selected),
    productionApproved: false
  };
  plan.seoEvidenceLayer = {
    draftVersion: C1_SEO_DRAFT_VERSION,
    createdAt,
    executionStatus: "draft_only",
    locale: "ru-RU",
    market: "Russia",
    targetPlatform: plan.identity.targetPlatform,
    skillReceipts: [structuredClone(SEO_SKILL_RECEIPT), structuredClone(KEYWORD_SKILL_RECEIPT)],
    competitorTextSnapshot: structuredClone(competitorTextSnapshot),
    keywordEvidenceReceipt: {
      evidenceId: keywordEvidence.evidenceId,
      status: keywordEvidence.status,
      collectionMode: keywordEvidence.collectionMode,
      pointsSpent: keywordEvidence.pointsSpent,
      observedAt: keywordEvidence.observedAt,
      reuseEvidenceNote: keywordEvidence.reuseEvidenceNote
    },
    keywordsSelected: structuredClone(selected),
    keywordsRejected: rejected,
    evidenceRefs: unique([competitorTextSnapshot.evidenceRef, keywordEvidence.evidenceId, ...allKeywordRefs]),
    productFactRefs: allFactRefs,
    localeQa: {
      status: "draft_requires_owner_review",
      unsupportedClaimsAdded: false,
      keywordStuffingDetected: false,
      finalApprovalGranted: false
    },
    productionWrites: 0
  };

  const validation = validateC1SeoDraft(plan);
  if (!validation.valid) throw new Error(`C1 SEO草稿校验失败：${validation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);

  const protectedFacts = [
    "exactSkuVerification",
    "productAttributes",
    "platformCategory",
    "schemaSnapshot",
    "batteryAssessment",
    "categoryRestrictions",
    "platformCompliance"
  ];
  for (const field of protectedFacts) {
    if (!sameJson(sourcePlan[field], plan[field])) throw new Error(`C1_SEO_PROTECTED_DATA_CHANGED: ${field}被改写`);
  }
  if (!sameJson(sourcePlan.inputSnapshots, plan.inputSnapshots)) throw new Error("C1_SEO_PROTECTED_DATA_CHANGED: 冻结输入被改写");

  const profitModelsBefore = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.c1ProductPlan = plan;
  next.dataRevision += 1;
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "c1_seo_draft_created_from_verified_facts_and_keyword_evidence",
    at: createdAt,
    draftVersion: C1_SEO_DRAFT_VERSION,
    selectedKeywordCount: selected.length,
    rejectedKeywordCount: rejected.length,
    externalAccesses: [],
    productionWrites: 0,
    finalSeoConfirmed: false,
    nextPhaseStarted: false
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C1 SEO生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(profitModelsBefore, next.profitModels) || next.activeProfitModelVersion !== skuPackage.activeProfitModelVersion) {
    throw new Error("C1_SEO_PROTECTED_DATA_CHANGED: B利润结果被改写");
  }
  if (next.businessPhase !== "C1" || next.c2FinalAssets !== null || next.productionAuthorization !== null || next.productionRecord !== null) {
    throw new Error("C1_SEO_BOUNDARY_VIOLATION: 9B不得进入C2或D");
  }
  return deepFreeze({
    flowVersion: "c1-seo-draft-flow-v1.1",
    skuPackage: next,
    c1ProductPlan: next.c1ProductPlan
  });
}
