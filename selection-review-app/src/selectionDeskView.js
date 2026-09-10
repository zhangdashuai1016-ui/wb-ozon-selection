import { STORE_LABELS, STATUS_LABELS } from "./constants.js";
import { orderCandidates } from "./candidateViews.js";
import { safeImageUrl, safeWebUrl } from "./formState.js";

/** The owner only makes judgment calls here, so every label below is a plain business word. */
export const DESK_STORES = Object.freeze(["dandanshu", "miska", "wb"]);
export const DECLINE_REASONS = Object.freeze(["尺寸太大", "利润太薄", "品牌风险", "不想做这类", "其他"]);
export const FEED_SORTS = Object.freeze([
  { value: "profit", label: "按预估利润" },
  { value: "sales", label: "按月销" },
  { value: "freight", label: "按运费占比" }
]);
export const BOARD_COLUMNS = Object.freeze([
  { key: "find", title: "找货" },
  { key: "profit", title: "算利润" },
  { key: "copy", title: "文案素材" },
  { key: "publish", title: "上架" },
  { key: "live", title: "在售" }
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (typeof value === "string" && value.trim() !== "" ? value : null);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function storeLabel(store) {
  return STORE_LABELS[store] ?? "未选择店铺";
}

/** Instants are saved as ISO strings; the owner reads the local date and minute, never the raw string. */
export function formatInstant(value) {
  const at = Date.parse(typeof value === "string" ? value : "");
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const pad = part => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Freight against the money that can still be spent on the goods; both numbers come from the same saved estimate. */
export function freightShare(estimate) {
  const freight = finite(estimate?.freight?.freightRmb);
  const ceiling = finite(estimate?.maximumAllInPurchaseRmb);
  if (freight === null || ceiling === null || freight + ceiling <= 0) return null;
  return freight / (freight + ceiling);
}

function batchesForStore(discoveryView, store) {
  return list(discoveryView?.batches)
    .filter(entry => isObject(entry?.batch) && entry.batch.targetStore === store)
    .sort((a, b) => (Date.parse(b.batch.createdAt) || 0) - (Date.parse(a.batch.createdAt) || 0));
}

/** Mirrors the discovery card: a Seerfar round keeps its market rows in the category step, LinkFox in the first step. */
function marketResultOf(entry, receipt) {
  if (!isObject(receipt) || !Array.isArray(receipt.steps)) return null;
  return entry.batch.plan?.provider === "seerfar"
    ? receipt.steps.find(step => step?.method === "category_detail")?.result ?? null
    : receipt.steps[0]?.result ?? null;
}

function chipsFor(product) {
  const chips = [];
  const estimate = product.estimate ?? null;
  if (estimate === null) chips.push("待估算");
  if (estimate?.outcome === "needs_data" && estimate.freight?.route === null) chips.push("待补尺寸");
  if (estimate?.freight?.oversize === true) chips.push("超抛");
  if (text(product.categoryPath?.cnTitlePath) === null) chips.push("类目未知");
  return chips;
}

function feedRow(entry, product, { imported, selections, declines }) {
  const { batch } = entry;
  const estimate = isObject(product.estimate) ? product.estimate : null;
  const selection = selections.get(product.productId) ?? null;
  return {
    key: `${batch.batchId}:${batch.revision}:${product.productId}`,
    batchId: batch.batchId,
    expectedRevision: batch.revision,
    marketProductId: product.productId,
    title: product.title ?? "",
    titleZh: text(product.titleZh),
    productUrl: safeWebUrl(product.productUrl),
    imageUrl: safeImageUrl(product.imageUrl),
    price: finite(product.price),
    salesCount: finite(product.salesCount),
    reviewCount: finite(product.reviewCount),
    reviewRating: finite(product.reviewRating),
    categoryZh: text(product.categoryPath?.cnTitlePath),
    estimate,
    outcome: estimate?.outcome ?? null,
    freightShare: freightShare(estimate),
    chips: chipsFor(product),
    importedCandidateId: imported.get(product.productId) ?? null,
    duplicate: selection?.status === "all_duplicates",
    failureClass: ["blocked", "failed"].includes(selection?.status) ? selection.failureClass ?? "未知" : null,
    declineReason: declines.get(product.productId) ?? null
  };
}

function compareRows(sort) {
  const rank = row => {
    if (sort === "sales") return row.salesCount;
    if (sort === "freight") return row.freightShare;
    return finite(row.estimate?.maximumAllInPurchaseRmb);
  };
  const ascending = sort === "freight";
  return (a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left === null && right === null) return a.key.localeCompare(b.key);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return ascending ? left - right : right - left;
    return a.key.localeCompare(b.key);
  };
}

export function sortFeedRows(rows, sort = "profit") {
  return [...rows].sort(compareRows(sort));
}

/**
 * Everything the home feed shows for one store: the rows still waiting for a decision, the rows an estimate already
 * ruled out, and the rows the owner personally turned down. Nothing here is computed: each number comes from a saved
 * query result or a saved estimate, and a missing number stays missing.
 */
export function feedRows(discoveryView, store, sort = "profit") {
  const entries = batchesForStore(discoveryView, store);
  const rows = [];
  const excluded = [];
  const declined = [];
  let pendingTranslations = 0;
  let estimable = 0;
  // One product appears once even when several rounds returned it; the newest round (entries[0]) wins.
  const seen = new Set();
  for (const entry of entries) {
    // The two refresh buttons act on the newest round, so their counters describe that round only.
    const latestRound = entry === entries[0];
    const imported = new Map(list(entry.importedCandidates).map(value => [value.marketProductId, value.candidateId]));
    const selections = new Map(list(entry.selections).map(value => [value.marketProductId, value]));
    const declines = new Map(list(entry.declines).map(value => [value.marketProductId, value.reason]));
    for (const { job, receipt } of list(entry.jobs)) {
      if (job?.scopeBinding?.request?.method === "supplier_search" || job?.status !== "completed") continue;
      for (const product of list(marketResultOf(entry, receipt)?.products)) {
        if (typeof product?.productId !== "string" || seen.has(product.productId)) continue;
        seen.add(product.productId);
        const row = feedRow(entry, product, { imported, selections, declines });
        if (latestRound) estimable += 1;
        if (latestRound && row.titleZh === null) pendingTranslations += 1;
        if (row.outcome === "excluded_negative") excluded.push(row);
        else if (row.declineReason !== null) declined.push(row);
        else rows.push(row);
      }
    }
  }
  const latest = entries[0] ?? null;
  return {
    store,
    storeLabel: storeLabel(store),
    direction: text(latest?.batch.plan?.direction),
    queriedAt: formatInstant(latest?.batch.createdAt),
    current: latest === null ? null : { batchId: latest.batch.batchId, expectedRevision: latest.batch.revision },
    rows: sortFeedRows(rows, sort),
    excluded: sortFeedRows(excluded, sort),
    declined: sortFeedRows(declined, sort),
    pendingTranslations,
    estimable
  };
}

/** Remaining service points, when the saved query results carry them; never a guess. */
export function pointsLine(discoveryView, store) {
  let remaining = null;
  for (const entry of batchesForStore(discoveryView, store)) {
    for (const { receipt } of list(entry.jobs)) {
      for (const step of list(receipt?.steps)) {
        const value = finite(step?.result?.remainingPoints);
        if (value !== null) remaining = value;
      }
    }
  }
  return remaining === null ? null : `本店查询点数还剩 ${remaining}`;
}

/** The display-only Chinese title already saved for this candidate's market product, when the round translated it. */
export function discoveredTitleZh(discoveryView, candidate) {
  const productId = candidate?.aDiscoveryEvidenceV2?.marketProductId ?? candidate?.aDiscoveryEvidenceV1?.marketProductId ?? null;
  if (text(productId) === null) return null;
  for (const entry of list(discoveryView?.batches)) {
    for (const job of list(entry?.jobs)) {
      const product = list(marketResultOf(entry, job?.receipt)?.products).find(value => value?.productId === productId);
      if (product && text(product.titleZh) !== null) return product.titleZh;
    }
  }
  return null;
}

export function boardColumnKey(candidate) {
  if (candidate.workflowStatus === "listed") return "live";
  const phase = typeof candidate.executionRuntime?.businessPhase === "string" ? candidate.executionRuntime.businessPhase : "";
  if (phase.startsWith("A")) return "find";
  if (phase.startsWith("B")) return "profit";
  if (phase.startsWith("C")) return "copy";
  if (phase.startsWith("D")) return "publish";
  if (phase.startsWith("E")) return "live";
  return {
    awaiting_user_direction: "find",
    codex_processing: "find",
    needs_user_data: "find",
    listing_preparation: "copy",
    ready_to_list: "publish"
  }[candidate.workflowStatus] ?? "find";
}

function boardCard(candidate) {
  const needs = list(candidate.needsFromUser).filter(need => text(need) !== null);
  return {
    id: candidate.id,
    // A saved candidate keeps one product name: the title the provider returned when it entered the review board.
    title: text(candidate.productName) ?? candidate.id,
    imageUrl: safeImageUrl(candidate.imageUrl),
    storeLabel: storeLabel(candidate.targetStore),
    statusLine: STATUS_LABELS[candidate.displayStatus ?? candidate.workflowStatus] ?? "状态未取得",
    waitingLine: needs[0] ?? null
  };
}

export function activeCandidates(candidates, store) {
  return orderCandidates(list(candidates).filter(candidate =>
    isObject(candidate) && candidate.workflowStatus !== "eliminated" && (store === null || candidate.targetStore === store)));
}

export function boardColumns(candidates, store) {
  const active = activeCandidates(candidates, store);
  return BOARD_COLUMNS.map(column => ({
    ...column,
    cards: active.filter(candidate => boardColumnKey(candidate) === column.key).map(boardCard)
  }));
}

export function inboxItems(candidates, store) {
  return activeCandidates(candidates, store)
    .map(candidate => ({ candidate, card: boardCard(candidate) }))
    .filter(({ card }) => card.waitingLine !== null)
    .map(({ candidate, card }) => ({
      id: card.id,
      title: card.title,
      storeLabel: card.storeLabel,
      statusLine: card.statusLine,
      need: card.waitingLine,
      moreNeeds: Math.max(list(candidate.needsFromUser).length - 1, 0)
    }));
}

/** The three counters the top bar shows beside the view names. */
export function deskCounts({ discoveryView, candidates, store }) {
  const feed = feedRows(discoveryView, store);
  return {
    desk: feed.rows.length,
    board: boardColumns(candidates, store).reduce((total, column) => total + column.cards.length, 0),
    inbox: inboxItems(candidates, store).length
  };
}

const RUNNING_JOB_STATUSES = ["queued", "claimed", "waiting_platform"];
/**
 * What one click on 找一轮新品 would do, in the owner's words, before anything is created or billed.
 * Owner rule 2026-09-11: never show a confusing engineering step; one explicit cost confirmation, then automatic.
 */
export function newRoundPlan(discoveryView, store, now = Date.now()) {
  const plans = list(discoveryView?.plans), bindings = list(discoveryView?.bindings);
  if (discoveryView?.canPrepare !== true || plans.length === 0 || bindings.length !== 1) {
    return { ready: false, reason: "还没有可执行的查询计划，需要维护人员先配置方向。", plan: null, binding: null, warning: null, estimatedPoints: null, maxCredits: null };
  }
  const plan = plans[0], binding = bindings[0];
  const entries = batchesForStore(discoveryView, store);
  let latestCompletedAt = null;
  for (const entry of entries) {
    for (const { job } of list(entry.jobs)) {
      if (RUNNING_JOB_STATUSES.includes(job?.status)) {
        return { ready: false, reason: "本店已有一轮查询在进行，等它完成后再找。", plan, binding, warning: null, estimatedPoints: null, maxCredits: null };
      }
      const at = Date.parse(job?.completedAt ?? "");
      if (Number.isFinite(at) && (latestCompletedAt === null || at > latestCompletedAt)) latestCompletedAt = at;
    }
  }
  const estimatedPoints = plan.budget?.estimatedPointsByStep?.category_detail ?? null;
  const maxCredits = plan.budget?.maxCredits ?? null;
  const warning = latestCompletedAt !== null && now - latestCompletedAt < 24 * 60 * 60 * 1000
    ? `本店 ${formatInstant(new Date(latestCompletedAt).toISOString())} 刚查过同一方向，结果就在下面；再查会再扣一次点数。` : null;
  return { ready: true, reason: null, plan, binding, warning, estimatedPoints, maxCredits, direction: plan.direction ?? "" };
}
