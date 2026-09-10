const COMMENT_CATEGORIES = new Set(["general", "elimination_feedback"]);

function boundaryError(status, message, code) {
  return Object.assign(new Error(message), { status, extra: code ? { code } : {} });
}

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw boundaryError(400, "留言请求必须是对象", "comment_input_invalid");
  }
}

function commentText(value) {
  if (typeof value !== "string") throw boundaryError(400, "留言不能为空", "comment_message_invalid");
  const normalized = value.trim();
  if (!normalized) throw boundaryError(400, "留言不能为空", "comment_message_invalid");
  if (normalized.length > 5_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw boundaryError(400, "留言文本无效", "comment_message_invalid");
  }
  return normalized;
}

function optionalCommentRef(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw boundaryError(400, "回复对象无效", "comment_reply_ref_invalid");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 160 || /[\u0000-\u001f\u007f\s]/.test(normalized)) {
    throw boundaryError(400, "回复对象无效", "comment_reply_ref_invalid");
  }
  return normalized;
}

export function normalizeCandidateCommentInput(input, { actor = "user" } = {}) {
  assertPlainObject(input);
  if (!Number.isInteger(input.dataRevision)) {
    throw boundaryError(400, "留言必须提供当前数据修订号", "comment_revision_required");
  }
  if (input.requestReview === true) {
    throw boundaryError(409, "普通留言不会启动任务；请使用当前状态卡里的开始按钮或固定处理选项", "comment_request_review_forbidden");
  }
  const normalizedActor = actor === "codex" ? "codex" : "user";
  const category = input.category === undefined || input.category === null || input.category === ""
    ? "general"
    : String(input.category).trim();
  if (!COMMENT_CATEGORIES.has(category)) {
    throw boundaryError(400, "留言分类无效", "comment_category_invalid");
  }
  return Object.freeze({
    dataRevision: input.dataRevision,
    actor: normalizedActor,
    message: commentText(input.message),
    category,
    replyTo: optionalCommentRef(input.replyTo)
  });
}
