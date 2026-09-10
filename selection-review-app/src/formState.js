export function optionalNumber(value, label = "数值") {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) {
    throw new Error(`${label}必须是非负有限数字；小数请用点，不要带单位或逗号。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}必须是非负有限数字。`);
  return number;
}

export function safeWebUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function safeImageUrl(value) {
  if (typeof value === "string" && value.startsWith("/product-images/") &&
      !/[\\?#%\x00-\x20\x7f]/.test(value) && value.split("/").slice(2).every(part => part && part !== "." && part !== "..")) return value;
  return "";
}

export function createSelectionGuard() {
  let generation = 0;
  return { changed() { generation += 1; }, capture: () => generation, isCurrent: token => token === generation };
}

export function shouldContinuePolling({ active, failed }) { return active && !failed; }

export function candidatePlatform(candidate) {
  const platform = candidate.lifecycleV11?.skuPackage?.g1Identity?.platform;
  const configured = { wb: "wb", dandanshu: "ozon", miska: "ozon" }[candidate.targetStore];
  if (!configured || (platform && platform !== configured)) throw new Error("平台与目标店铺不一致或身份未取得，不能提交。");
  return configured;
}

export function newDraft(record, initial) {
  return { id: record.id, revision: record.dataRevision, value: initial, dirty: false };
}

export function receiveDraft(draft, record, initial) {
  if (draft.id !== record.id || (!draft.dirty && draft.revision !== record.dataRevision)) return newDraft(record, initial);
  return draft;
}

export function createSubmitLock() {
  let busy = false;
  return async action => {
    if (busy) return undefined;
    busy = true;
    try { return await action(); }
    finally { busy = false; }
  };
}

export function errorMessage(error) {
  const details = [error.body?.errors, error.body?.missing, error.body?.details].filter(Boolean);
  const evidence = error.body?.evidencePreparation;
  return [error.message || "操作失败", details.length ? JSON.stringify(details) : "", evidence ? `证据准备：${JSON.stringify(evidence)}` : ""].filter(Boolean).join("；");
}

// Only the latest read may publish. Cancellation is never treated as success.
export function createLatestRead() {
  let sequence = 0;
  let pending;
  return {
    cancel() { sequence += 1; pending?.controller.abort(); pending = undefined; },
    run(read, publish, { protect = false, signal } = {}) {
      if (signal?.aborted) return Promise.resolve(null);
      // A background refresh must not cancel an explicit permission read.
      if (!protect && pending?.protect) return pending.promise;
      pending?.controller.abort();
      const controller = new AbortController();
      const current = ++sequence;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const operation = { controller, protect, promise: null };
      pending = operation;
      operation.promise = (async () => {
        try {
          const result = await read(controller.signal);
          if (current !== sequence || controller.signal.aborted) return null;
          publish(result);
          return result;
        } catch (error) {
          if (current !== sequence || controller.signal.aborted) return null;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          if (pending === operation) pending = undefined;
        }
      })();
      return operation.promise;
    }
  };
}
