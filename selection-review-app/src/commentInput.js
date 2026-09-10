const CATEGORIES = new Set(["general", "elimination_feedback"]);

// Browser intent only. Actor identity and comment time are server-owned facts.
export function buildCandidateCommentInput(candidate, message, category = "general", replyTo = null) {
  if (!candidate?.id || !Number.isInteger(candidate.dataRevision)) {
    throw new Error("当前候选身份或修订未取得；请刷新后再留言。");
  }
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new Error("留言不能为空。");
  if (!CATEGORIES.has(category)) throw new Error("留言类别无效；未提交。");
  if (replyTo !== null && (typeof replyTo !== "string" || !replyTo.trim())) {
    throw new Error("回复引用无效；未提交。");
  }
  return {
    candidateId: candidate.id,
    dataRevision: candidate.dataRevision,
    message: trimmed,
    category,
    ...(replyTo ? { replyTo: replyTo.trim() } : {})
  };
}

export function validateCandidateCommentReceipt(input, result) {
  const comment = result?.comment;
  const candidate = result?.candidate;
  if (!comment || !candidate || candidate.id !== input.candidateId || !Number.isInteger(candidate.dataRevision) ||
      candidate.dataRevision <= input.dataRevision || comment.message !== input.message || comment.category !== input.category) {
    throw new Error("留言回执不完整或与当前候选/修订不一致；内容仍保留，请刷新后核对。");
  }
  return result;
}

export function shouldClearSubmittedComment(currentValue, submittedValue) {
  return currentValue === submittedValue;
}
