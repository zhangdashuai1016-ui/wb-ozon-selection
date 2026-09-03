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

async function uploadFile(path, file) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || "素材上传失败");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  getSeerfarRuntimeStatus: () => request("/api/integrations/seerfar/runtime-status"),
  getPhase2ASimulation: () => request("/api/simulations/phase-2a"),
  confirmPhase2ASimulation: (payload) =>
    request("/api/simulations/phase-2a/confirm", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmRealAStage: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/a-confirm`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getState: () => request("/api/state"),
  getThreeStoreMap: () => request("/api/three-store-map"),
  dispatchCandidate: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/dispatch`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/production-authorization`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmLifecycleFinalAssets: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  uploadLifecycleFinalAsset: (candidateId, { dataRevision, file }) =>
    uploadFile(
      `/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets/upload?dataRevision=${encodeURIComponent(dataRevision)}&fileName=${encodeURIComponent(file.name)}`,
      file
    ),
  confirmLifecycleProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-authorization`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  reviseLifecycleProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-authorization/revise`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  startSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  startOzonSalesCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sales-capture/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  completeOzonSalesCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sales-capture/result`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  completeSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/result`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  selectSourceCaptureSku: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/select-sku`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  resumeCandidate: (payload) =>
    request("/api/control/resume", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  chooseRecoveryAction: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/recovery-action`, {
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
