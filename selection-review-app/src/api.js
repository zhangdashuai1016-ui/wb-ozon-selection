async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "请求失败");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  getState: () => request("/api/state"),
  getWorkflowMap: (candidateId = "") =>
    request(`/api/workflow-map${candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ""}`),
  addNodeComment: (payload) =>
    request("/api/node-comments", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  dispatchCandidate: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/dispatch`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  decideDispatchApproval: (dispatchId, payload) =>
    request(`/api/dispatches/${encodeURIComponent(dispatchId)}/approval`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/production-authorization`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  resumeCandidate: (payload) =>
    request("/api/control/resume", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  addCandidate: (payload) =>
    request("/api/candidates", { method: "POST", body: JSON.stringify(payload) }),
  updateCandidate: (id, payload) =>
    request(`/api/candidates/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  saveUserEvaluation: (id, payload) =>
    request(`/api/candidates/${id}/user-evaluation`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  addComment: (id, payload) =>
    request(`/api/candidates/${id}/comments`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  markListed: (id, payload) =>
    request(`/api/candidates/${id}/mark-listed`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  applyListingReadback: (id, payload) =>
    request(`/api/candidates/${id}/listing-readback`, {
      method: "POST",
      body: JSON.stringify(payload)
    })
};
