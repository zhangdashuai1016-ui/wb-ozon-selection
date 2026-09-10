async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error(`服务返回了无效JSON（HTTP ${response.status}），结果未确认；请核对后再操作。`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.message || `请求失败（HTTP ${response.status}）`);
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
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error(`素材暂存返回无效JSON（HTTP ${response.status}），结果未确认；请核对后再操作。`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.message || `素材上传失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  getProductDetails: (candidateId,revision,signal) => request(`/api/candidates/${encodeURIComponent(candidateId)}/product-details?revision=${revision}`,{signal}),
  authorizeProductDetails: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/product-details/authorize`,{method:'POST',body:JSON.stringify(payload)}),
  continueProductDetails: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/product-details/continue`,{method:'POST',body:JSON.stringify(payload)}),
  getProductDiscovery: signal => request('/api/product-discovery',{signal}),
  createProductDiscovery: payload => request('/api/product-discovery/create',{method:'POST',body:JSON.stringify(payload)}),
  authorizeProductDiscovery: payload => request('/api/product-discovery/authorize',{method:'POST',body:JSON.stringify(payload)}),
  continueProductDiscovery: payload => request('/api/product-discovery/continue',{method:'POST',body:JSON.stringify(payload)}),
  selectProductDiscovery: payload => request('/api/product-discovery/select',{method:'POST',body:JSON.stringify(payload)}),
  translateProductDiscovery: payload => request('/api/product-discovery/translate',{method:'POST',body:JSON.stringify(payload)}),
  estimateProductDiscovery: payload => request('/api/product-discovery/estimate',{method:'POST',body:JSON.stringify(payload)}),
  recalculateBWithExactCommission: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/b/exact-commission/recalculate`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  saveFinalPricingReview: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/final-pricing/review`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  retryC1KeywordHandoff: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/keyword-handoff/retry`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  getAccountPreparations: signal => request('/api/account-preparations',{signal}),
  createAccountPreparation: payload => request('/api/account-preparations/create',{method:'POST',body:JSON.stringify(payload)}),
  authorizeAccountDiscovery: payload => request('/api/account-preparations/authorize',{method:'POST',body:JSON.stringify(payload)}),
  continueAccountDiscovery: payload => request('/api/account-preparations/continue',{method:'POST',body:JSON.stringify(payload)}),
  selectAccountWarehouse: payload => request('/api/account-preparations/select-warehouse',{method:'POST',body:JSON.stringify(payload)}),
  continueSavedC1Draft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/paid-draft/continue-saved`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  authorizeC1PaidDraft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/paid-draft/authorize`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  saveC1RightsReview: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/rights-review`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  getOwnerAccess: signal => request("/api/owner-access", { signal }),
  setupOwnerAccess: ({ password }) => request("/api/owner-access/setup", { method: "POST", body: JSON.stringify({ password }) }),
  loginOwnerAccess: ({ password }) => request("/api/owner-access/login", { method: "POST", body: JSON.stringify({ password }) }),
  logoutOwnerAccess: () => request("/api/owner-access/logout", { method: "POST", body: JSON.stringify({}) }),
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
  getState: (signal) => request("/api/state", { signal }),
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
  saveC2UploadDraft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/upload-draft`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  uploadLifecycleFinalAsset: (candidateId, { dataRevision, draftRevision, file }) =>
    uploadFile(
      `/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets/upload?dataRevision=${encodeURIComponent(dataRevision)}&draftRevision=${encodeURIComponent(draftRevision)}&fileName=${encodeURIComponent(file.name)}`,
      file
    ),
  saveProductionOwnerDecision: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-owner-decision`, {
      method: "POST", body: JSON.stringify(payload)
    }),
  continueSavedDE: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d-e/continue-saved`, {
      method: "POST", body: JSON.stringify({ candidateId, ...payload })
    }),
  authorizeAccountRead: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/lifecycle/account-read/authorize`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  continueAccountRead: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/lifecycle/account-read/continue`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  productionOwnerPreparation: candidateId =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-owner-preparation`),
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
    request(`/api/candidates/${encodeURIComponent(id)}/comments`, {
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
