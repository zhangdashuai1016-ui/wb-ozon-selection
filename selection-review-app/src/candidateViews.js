export function matchesQueue(candidate, queue, sourceFilter = "all") {
  const sourceMatches =
    ["eliminated", "listed"].includes(queue) ||
    sourceFilter === "all" ||
    candidate.source === sourceFilter;
  return candidate.workflowStatus === queue && sourceMatches;
}

export function orderCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.workflowStatus === "codex_processing" && a.source !== b.source) {
      return a.source === "user" ? -1 : 1;
    }
    return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
  });
}

export function firstInQueue(candidates, queue, sourceFilter = "all", exceptId = "") {
  return orderCandidates(candidates).find(
    (candidate) =>
      candidate.id !== exceptId && matchesQueue(candidate, queue, sourceFilter)
  );
}
