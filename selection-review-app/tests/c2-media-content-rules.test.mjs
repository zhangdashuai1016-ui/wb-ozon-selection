import test from "node:test";
import assert from "node:assert/strict";
import { assertC2FinalMediaContent, assertC2MediaContentRules } from "../lib/c2-media-content-rules.mjs";
import { syntheticContentRules } from "./helpers/c2-software-fixture.mjs";

const NOW = "2026-09-07T00:00:00.000Z";
function fixture() {
  const slots = [{ slotId: "main", mediaType: "image" }];
  const mediaRequirements = { imageSlots: slots, videoSlots: [], contentRules: syntheticContentRules(slots) };
  const rule = mediaRequirements.contentRules.slotRules[0];
  rule.byteSize = { min: 10, max: 100 };
  rule.width = { min: 10, max: 20 };
  rule.height = { min: 10, max: 20 };
  rule.aspectRatio = { min: 0.5, max: 2 };
  return { mediaRequirements, assets: [{ slotId: "main", mediaType: "image", fileName: "main.png", byteSize: 10, width: 10, height: 20 }], checkedAt: NOW };
}

test("旧媒体合同保持可读，缺失规则不能被当作无上限", () => {
  assert.doesNotThrow(() => assertC2MediaContentRules(undefined, []));
  const value = fixture(); delete value.mediaRequirements.contentRules;
  const before = structuredClone(value);
  assert.throws(() => assertC2FinalMediaContent(value), /CONTENT_RULES_MISSING/);
  assert.deepEqual(value, before);
});

test("格式、真实字节与尺寸使用同一槽位规则，边界含端点", () => {
  assert.doesNotThrow(() => assertC2FinalMediaContent(fixture()));
  for (const [field, value, code] of [
    ["byteSize", 9, /CONTENT_REJECTED/], ["byteSize", 101, /CONTENT_REJECTED/],
    ["width", 9, /CONTENT_REJECTED/], ["height", 21, /CONTENT_REJECTED/],
    ["width", null, /OBSERVATION_MISSING/], ["byteSize", undefined, /OBSERVATION_MISSING/],
    ["fileName", "main.gif", /FORMAT_REJECTED/]
  ]) {
    const input = fixture(); input.assets[0][field] = value;
    assert.throws(() => assertC2FinalMediaContent(input), code);
  }
  const input = fixture(); input.assets[0] = { ...input.assets[0], byteSize: 100, width: 20, height: 10 };
  assert.doesNotThrow(() => assertC2FinalMediaContent(input));
});

test("失效、缺槽位以及省略上限的规则均不能确认，未选视频不设额外门禁", () => {
  const expired = fixture(); expired.mediaRequirements.contentRules.validUntil = "2026-09-06T00:00:00.000Z";
  assert.throws(() => assertC2FinalMediaContent(expired), /CONTENT_RULES_EXPIRED/);
  const incomplete = fixture(); delete incomplete.mediaRequirements.contentRules.slotRules[0].width.max;
  assert.throws(() => assertC2FinalMediaContent(incomplete), /CONTENT_RULES_INVALID/);
  const missing = fixture(); missing.assets[0].slotId = "detail";
  assert.throws(() => assertC2FinalMediaContent(missing), /CONTENT_RULES_MISSING/);
  const noVideo = fixture(); noVideo.mediaRequirements.videoSlots.push({ slotId: "video", mediaType: "video" });
  assert.doesNotThrow(() => assertC2FinalMediaContent(noVideo));
});
