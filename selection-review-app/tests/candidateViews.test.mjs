import test from "node:test";
import assert from "node:assert/strict";
import { matchesQueue } from "../src/candidateViews.js";

test("eliminated queue always shows every source", () => {
  const userCandidate = { workflowStatus: "eliminated", source: "user" };
  const codexCandidate = { workflowStatus: "eliminated", source: "codex" };
  assert.equal(matchesQueue(userCandidate, "eliminated", "codex"), true);
  assert.equal(matchesQueue(codexCandidate, "eliminated", "user"), true);
});

test("listed queue always shows every source", () => {
  const userCandidate = { workflowStatus: "listed", source: "user" };
  const codexCandidate = { workflowStatus: "listed", source: "codex" };
  assert.equal(matchesQueue(userCandidate, "listed", "codex"), true);
  assert.equal(matchesQueue(codexCandidate, "listed", "user"), true);
});

test("other queues still honor source filter", () => {
  const candidate = { workflowStatus: "codex_processing", source: "user" };
  assert.equal(matchesQueue(candidate, "codex_processing", "user"), true);
  assert.equal(matchesQueue(candidate, "codex_processing", "codex"), false);
});
