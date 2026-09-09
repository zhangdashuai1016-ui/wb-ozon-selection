import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCandidateCommentInput } from "../lib/candidate-comment-boundary.mjs";

test("普通留言必须绑定当前revision且actor来自调用边界而不是body", () => {
  const comment = normalizeCandidateCommentInput({
    dataRevision: 7,
    actor: "codex",
    message: "主人补充一行\n保留换行",
    category: "general",
    replyTo: "C-existing-1"
  }, { actor: "user" });
  assert.deepEqual(comment, {
    dataRevision: 7,
    actor: "user",
    message: "主人补充一行\n保留换行",
    category: "general",
    replyTo: "C-existing-1"
  });
  const internal = normalizeCandidateCommentInput({
    dataRevision: 8,
    actor: "user",
    message: "内部回写",
    category: "elimination_feedback"
  }, { actor: "codex" });
  assert.equal(internal.actor, "codex");
});

test("留言拒绝缺revision、自动派发请求和危险控制字符", () => {
  assert.throws(() => normalizeCandidateCommentInput({
    message: "没有revision"
  }), /必须提供当前数据修订号/);
  assert.throws(() => normalizeCandidateCommentInput({
    dataRevision: 1,
    message: "请处理",
    requestReview: true
  }), /普通留言不会启动任务/);
  assert.throws(() => normalizeCandidateCommentInput({
    dataRevision: 1,
    message: "ok\u0007bad"
  }), /留言文本无效/);
  assert.throws(() => normalizeCandidateCommentInput({
    dataRevision: 1,
    message: "ok",
    replyTo: "C 1"
  }), /回复对象无效/);
});
