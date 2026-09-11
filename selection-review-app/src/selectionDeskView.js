import { STORE_LABELS, STATUS_LABELS } from "./constants.js";
import { orderCandidates } from "./candidateViews.js";
import { errorMessage, safeImageUrl, safeWebUrl } from "./formState.js";

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

/** The market jobs of one round that actually saved a result; a supplier search is never part of the feed. */
function completedMarketJobs(entry) {
  return list(entry.jobs).filter(({ job }) =>
    job?.scopeBinding?.request?.method !== "supplier_search" && job?.status === "completed");
}

/**
 * Everything the home feed shows for one store: the newest finished round first, then the rows an estimate already
 * ruled out, the rows the owner personally turned down, and — folded away — whatever older rounds left undecided.
 * Nothing here is computed: each number comes from a saved query result or a saved estimate, and a missing number
 * stays missing.
 */
export function feedRows(discoveryView, store, sort = "profit") {
  const entries = batchesForStore(discoveryView, store);
  const rows = [];
  // Older rounds keep only what the owner already acted on; their undecided rows wait behind one toggle.
  const carried = [];
  const history = [];
  const excluded = [];
  const declined = [];
  let pendingTranslations = 0;
  let estimable = 0;
  let newest = null;
  // One product appears once even when several rounds returned it; the newest round that returned it wins.
  const seen = new Set();
  for (const entry of entries) {
    const jobs = completedMarketJobs(entry);
    // A round that has not saved a result yet — created, queued or failed — contributes nothing and heads nothing.
    if (jobs.length === 0) continue;
    const latestRound = newest === null;
    if (latestRound) newest = entry;
    const imported = new Map(list(entry.importedCandidates).map(value => [value.marketProductId, value.candidateId]));
    const selections = new Map(list(entry.selections).map(value => [value.marketProductId, value]));
    const declines = new Map(list(entry.declines).map(value => [value.marketProductId, value.reason]));
    for (const { receipt } of jobs) {
      for (const product of list(marketResultOf(entry, receipt)?.products)) {
        if (typeof product?.productId !== "string" || seen.has(product.productId)) continue;
        seen.add(product.productId);
        const row = feedRow(entry, product, { imported, selections, declines });
        // The two refresh buttons act on the newest finished round, so their counters describe that round only.
        if (latestRound) estimable += 1;
        if (latestRound && row.titleZh === null) pendingTranslations += 1;
        if (row.outcome === "excluded_negative") excluded.push(row);
        else if (row.declineReason !== null) declined.push(row);
        else if (latestRound) rows.push(row);
        else if (row.importedCandidateId !== null) carried.push(row);
        else history.push(row);
      }
    }
  }
  return {
    store,
    storeLabel: storeLabel(store),
    direction: text(newest?.batch.plan?.direction),
    queriedAt: formatInstant(newest?.batch.createdAt),
    current: newest === null ? null : { batchId: newest.batch.batchId, expectedRevision: newest.batch.revision },
    rows: [...sortFeedRows(rows, sort), ...sortFeedRows(carried, sort)],
    history: sortFeedRows(history, sort),
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

/** The saved capture job in the owner's words. A job that failed or was never asked for is not a step of its own. */
function captureStage(candidate) {
  const capture = candidate.sourceCapture;
  if (!isObject(capture)) return null;
  if (["captured_waiting_owner_selection", "verified"].includes(capture.status)) return "done";
  if (capture.jobStatus === "claimed" || ["capturing", "extension_running"].includes(capture.status)) return "running";
  if (capture.jobStatus === "queued" || capture.status === "waiting_extension") return "queued";
  return null;
}

const CAPTURE_CHIPS = Object.freeze({ queued: "待采集", running: "采集中", done: "已采到" });

/**
 * The one thing that still has to happen to this product, read from its own saved records: the 找货 declaration, the
 * estimate that was saved beside it and the capture job it already carries. Nothing is computed and nothing is guessed;
 * a missing estimate says so instead of turning into "没过线".
 */
function myProductStep(candidate) {
  const capture = captureStage(candidate);
  if (capture !== null) return { step: `capture_${capture}`, chip: CAPTURE_CHIPS[capture], action: "查看" };
  if (!isObject(candidate.supplierDraftV1)) return { step: "draft_missing", chip: "找货未填", action: "填找货" };
  const record = isObject(candidate.supplierDraftEstimateV1) ? candidate.supplierDraftEstimateV1 : null;
  if (record?.estimate?.status !== "ok") return { step: "draft_incomplete", chip: "找货已填 · 缺数据", action: "补资料" };
  const profit = isObject(record.profitAtDeclaredPurchase) ? record.profitAtDeclaredPurchase : null;
  if (profit?.passes !== true) return { step: "draft_blocked", chip: "找货已填 · 未过线", action: "改找货" };
  const unit = finite(profit.unitProfitRmb);
  return { step: "draft_passes", action: "申请插件采集",
    chip: `找货已填 · 过线 单件利润 ${unit === null ? "未取得" : `¥${unit.toFixed(2)}`}` };
}

/** The Ozon price this product carried when the round returned it; the unit is only named when the record names it. */
function marketPriceLine(candidate) {
  const observed = (candidate.aDiscoveryEvidenceV2 ?? candidate.aDiscoveryEvidenceV1)?.observedMarketPrice;
  const price = finite(observed?.value);
  if (price === null) return "售价未取得";
  const currency = text(observed.currency);
  if (currency === null) return `售价 ${price}`;
  return ["₽", "RUB"].includes(currency) ? `售价 ${price} 卢布` : `售价 ${price} ${currency}`;
}

const fromDiscovery = candidate => isObject(candidate.aDiscoveryEvidenceV2) || isObject(candidate.aDiscoveryEvidenceV1);

/**
 * The owner's own shelf, newest first: every product this store took out of a query round — picked by hand or imported
 * by the plan — with the next thing to do to it. Owner feedback 2026-09-11: a filled 找货 form became unfindable once
 * the page was left, so this block is the fixed way back into any product, and every row opens that product's page.
 * Products the owner already dropped are not on the shelf any more, exactly as they leave 进行中.
 */
export function myProductRows(candidates, discoveryView, store) {
  return list(candidates)
    .filter(candidate => isObject(candidate) && candidate.workflowStatus !== "eliminated" &&
      (store === null || candidate.targetStore === store) && fromDiscovery(candidate))
    .sort((a, b) => ((Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)) || String(a.id).localeCompare(String(b.id)))
    .map(candidate => ({
      id: candidate.id,
      // The Chinese title only shows when the round actually translated it; otherwise the provider's own title stands.
      title: discoveredTitleZh(discoveryView, candidate) ?? text(candidate.productName) ?? candidate.id,
      imageUrl: safeImageUrl(candidate.imageUrl),
      priceLine: marketPriceLine(candidate),
      ...myProductStep(candidate)
    }));
}

/**
 * The name the top bar shows while the owner is on one product page: the translated title when the round saved one,
 * then the provider's own product name, then the saved id — short enough to sit on one line beside the way back.
 */
export function shortProductTitle(candidate, titleZh) {
  const name = [titleZh, candidate?.productName, candidate?.id].map(value => (text(value) ?? "").trim()).find(value => value !== "") ?? "未取得名称";
  return name.length > 16 ? `${name.slice(0, 16)}…` : name;
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
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * One sentence for "this store is already querying this direction", wherever the answer comes from: the saved rounds
 * the rail reads before a click, and the server's own ROUND_ALREADY_RUNNING refusal after one.
 */
export const ROUND_ALREADY_RUNNING_MESSAGE = "本店已有一轮查询在进行，等它完成后再找。";

/**
 * What the desk shows when a write comes back refused. The server answers ROUND_ALREADY_RUNNING when this store is
 * already asking this question — a job still running, or a round that was created and never started — so the answer
 * names both and points at the button that continues the saved round instead of opening a second, paid one.
 */
export function deskErrorMessage(cause) {
  return cause?.body?.code === "ROUND_ALREADY_RUNNING"
    ? `${ROUND_ALREADY_RUNNING_MESSAGE}上一次点了却没真的开始的那一轮也算，用「找一轮新品」继续它。`
    : errorMessage(cause);
}
const notReady = (reason, extra = {}) =>
  ({ ready: false, reason, plan: null, binding: null, warning: null, estimatedPoints: null, maxCredits: null, direction: null, resume: null, ...extra });

/**
 * What one click on 找一轮新品 would do, in the owner's words, before anything is created or billed.
 * Owner rule 2026-09-11: never show a confusing engineering step; one explicit cost confirmation, then automatic.
 */
export function newRoundPlan(discoveryView, store, now = Date.now()) {
  const plans = list(discoveryView?.plans), bindings = list(discoveryView?.bindings);
  if (discoveryView?.canPrepare !== true || plans.length === 0 || bindings.length !== 1) {
    return notReady("还没有可执行的查询计划，需要维护人员先配置方向。");
  }
  const plan = plans[0], binding = bindings[0];
  const entries = batchesForStore(discoveryView, store);
  let latestCompleted = null;
  for (const entry of entries) {
    for (const { job } of list(entry.jobs)) {
      if (RUNNING_JOB_STATUSES.includes(job?.status)) {
        return notReady(ROUND_ALREADY_RUNNING_MESSAGE, { plan, binding, direction: text(plan.direction) });
      }
      const at = Date.parse(job?.completedAt ?? "");
      if (Number.isFinite(at) && (latestCompleted === null || at > latestCompleted.at)) latestCompleted = { at, entry };
    }
  }
  const estimatedPoints = plan.budget?.estimatedPointsByStep?.category_detail ?? null;
  const maxCredits = plan.budget?.maxCredits ?? null;
  const direction = text(plan.direction) ?? "";
  // An earlier click that saved the round but never started it: continue that same batch instead of opening a new one.
  // canAuthorize is the server's own answer, so a batch the current configuration can no longer run is never offered.
  const orphan = entries.find(entry => list(entry.jobs).length === 0 && entry.canAuthorize === true) ?? null;
  const resume = orphan === null ? null : { batchId: orphan.batch.batchId, expectedRevision: orphan.batch.revision,
    direction: text(orphan.batch.plan?.direction) ?? direction, createdAt: formatInstant(orphan.batch.createdAt) };
  let warning = null;
  if (latestCompleted !== null && now - latestCompleted.at < DAY_MS) {
    const at = formatInstant(new Date(latestCompleted.at).toISOString());
    const previous = text(latestCompleted.entry.batch.plan?.direction);
    warning = latestCompleted.entry.batch.plan?.planId === plan.planId
      ? `本店 ${at} 刚查过同一方向「${previous ?? direction}」，结果就在下面；再查会再扣一次点数。`
      : `本店 ${at} 刚查过「${previous ?? "未记录的方向"}」，这一轮是「${direction}」，不是同一个方向；这次查询会再扣一次点数。`;
  }
  return { ready: true, reason: null, plan, binding, warning, estimatedPoints, maxCredits, direction, resume };
}
