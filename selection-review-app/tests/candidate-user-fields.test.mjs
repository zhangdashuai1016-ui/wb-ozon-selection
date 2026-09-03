import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCandidateCodexCreateInput,
  normalizeCandidateUserCreateInput,
  normalizeCandidateUserPatchInput
} from "../lib/candidate-user-fields.mjs";

test("普通新增候选校验字段类型且不接受前端硬编码clear作为合规/IP事实", () => {
  const input = normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    purchasePriceRmb: 12.5,
    dimensionsCm: { length: 10, width: null, height: 3 }
  });
  assert.equal(input.complianceStatus, "needs_confirmation");
  assert.equal(input.authorizationStatus, "needs_confirmation");
  assert.equal(input.productUrl, "https://www.ozon.ru/product/test-1/");
  assert.deepEqual(input.dimensionsCm, { length: 10, width: null, height: 3 });
  assert.equal(normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    notes: "第一行\n第二行",
    acceptedTestRisk: false
  }).acceptedTestRisk, false);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "javascript:alert(1)"
  }), /HTTP\/HTTPS/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    productName: { text: "被错误字符串化的标题" }
  }), /productName文本无效/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    materialsAndAge: ["被错误字符串化的材质"]
  }), /materialsAndAge文本无效/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    acceptedTestRisk: "false"
  }), /布尔值/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    notes: "正常说明\u0007带危险控制字符"
  }), /notes文本无效/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    complianceStatus: "clear"
  }), /不能通过普通新增候选设置/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    complianceStatus: true
  }), /clear或needs_confirmation/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    "__proto__.secret": "不能回显"
  }), /^Error: 候选字段不允许写入$/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    purchasePriceRmb: "abc"
  }), /非负数字/);
  assert.throws(() => normalizeCandidateUserCreateInput({
    targetStore: "dandanshu",
    productUrl: "https://www.ozon.ru/product/test-1/",
    dimensionsCm: "not-an-object"
  }), /dimensionsCm必须是对象/);
});

test("普通PATCH未传字段不清空，且不能用默认clear清掉既有合规/IP风险", () => {
  const current = {
    targetStore: "dandanshu",
    complianceStatus: "needs_confirmation",
    authorizationStatus: "needs_confirmation",
    workflowStatus: "needs_user_data",
    dimensionsCm: { length: 10, width: 8, height: 3 }
  };
  assert.deepEqual(normalizeCandidateUserPatchInput({
    productName: "  新标题  ",
    purchasePriceRmb: 18
  }, current), {
    productName: "新标题",
    purchasePriceRmb: 18
  });
  assert.deepEqual(normalizeCandidateUserPatchInput({
    complianceStatus: "needs_confirmation",
    authorizationStatus: "needs_confirmation"
  }, current), {});
  assert.throws(() => normalizeCandidateUserPatchInput({
    complianceStatus: "clear"
  }, current), /不能通过普通资料保存修改/);
  assert.deepEqual(normalizeCandidateUserPatchInput({
    dimensionsCm: { width: 9 }
  }, current), {
    dimensionsCm: { length: 10, width: 9, height: 3 }
  });
  assert.deepEqual(normalizeCandidateUserPatchInput({
    dimensionsCm: null
  }, current), {
    dimensionsCm: { length: null, width: null, height: null }
  });
  assert.throws(() => normalizeCandidateUserPatchInput({
    notes: { text: "不能字符串化" }
  }, current), /notes文本无效/);
  assert.throws(() => normalizeCandidateUserPatchInput({
    "nested.secret": "不能回显"
  }, current), /^Error: 候选字段不允许写入$/);
});

test("生命周期冻结后普通PATCH不能换绑店铺，冻结前仍按字段规则校验", () => {
  const frozen = {
    targetStore: "dandanshu",
    complianceStatus: "clear",
    authorizationStatus: "clear",
    lifecycleV11: { skuPackage: { skuPackageId: "sku-1" } }
  };
  assert.throws(() => normalizeCandidateUserPatchInput({
    targetStore: "wb"
  }, frozen), /不能通过普通资料保存换绑店铺/);
  assert.deepEqual(normalizeCandidateUserPatchInput({
    targetStore: "wb"
  }, { ...frozen, lifecycleV11: null }), { targetStore: "wb" });
});

test("Codex候选仍必须显式给出合规/IP枚举，且走同一字段类型门", () => {
  const input = normalizeCandidateCodexCreateInput({
    targetStore: "wb",
    productUrl: "https://example.test/product",
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "needs_confirmation",
    purchaseCeiling: { status: "unavailable", missing: ["test"] }
  });
  assert.equal(input.complianceStatus, "clear");
  assert.equal(input.authorizationStatus, "needs_confirmation");
  assert.throws(() => normalizeCandidateCodexCreateInput({
    targetStore: "wb",
    productUrl: "https://example.test/product",
    powered: false,
    complianceStatus: "maybe",
    authorizationStatus: "clear"
  }), /clear或needs_confirmation/);
  assert.throws(() => normalizeCandidateCodexCreateInput({
    targetStore: "wb",
    productUrl: "https://example.test/product",
    powered: false,
    complianceStatus: "clear",
    authorizationStatus: "clear",
    "raw.secret": "不能回显"
  }), /^Error: 候选字段不允许写入$/);
});
