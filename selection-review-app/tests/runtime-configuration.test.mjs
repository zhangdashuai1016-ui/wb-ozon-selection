import assert from "node:assert/strict";
import test from "node:test";

import {
  createSelectionReviewRuntimeConfiguration,
  normalizeServiceOrigin
} from "../lib/runtime-configuration.mjs";

const APP_DIR = "/tmp/selection-review-runtime-test";

test("本地开发保留4317、JSON和显式开发身份，但所有值都经过运行配置", () => {
  const config = createSelectionReviewRuntimeConfiguration({ env: {}, appDir: APP_DIR, argv: [] });
  assert.equal(config.deploymentMode, "local_development");
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 4317);
  assert.equal(config.publicOrigin, "http://127.0.0.1:4317");
  assert.deepEqual(config.allowedExtensionOrigins, []);
  assert.equal(config.stateAdapter, "json");
  assert.equal(config.initializeDataFile, false);
  assert.equal(config.defaultUserId, "local-development-owner");
  assert.equal(config.aiGatewayUrl, "http://127.0.0.1:4318");
  assert.equal(config.ozonEvidenceServiceUrl, "http://127.0.0.1:4173");
  assert.match(config.dataFile, /selection-review-runtime-test\/data\/candidates\.json$/);
});

test("缺失数据文件只能通过显式初始化开关创建，不能默认为空业务状态", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_INITIALIZE_DATA_FILE: "true" },
    appDir: APP_DIR,
    argv: []
  });
  assert.equal(config.initializeDataFile, true);
});

test("Chrome扩展来源必须由显式配置固定，默认不信任任意扩展", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: {
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    appDir: APP_DIR,
    argv: []
  });
  assert.deepEqual(config.allowedExtensionOrigins, ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/path" },
    appDir: APP_DIR,
    argv: []
  }), /固定Chrome扩展origin/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "https://extension.example" },
    appDir: APP_DIR,
    argv: []
  }), /固定Chrome扩展origin/);
});

test("本地开发身份没有认证边界，因此只能监听回环地址", () => {
  for (const bindHost of ["0.0.0.0", "::", "192.168.1.20"]) {
    assert.throws(() => createSelectionReviewRuntimeConfiguration({
      env: { SELECTION_REVIEW_BIND_HOST: bindHost }, appDir: APP_DIR, argv: []
    }), /本地开发模式只能绑定回环地址/);
  }
  assert.equal(createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_BIND_HOST: "::1" }, appDir: APP_DIR, argv: []
  }).bindHost, "::1");
});

test("API测试监听端口不会悄悄改写评审台页面来源", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: { SELECTION_REVIEW_API_PORT: "31338" },
    appDir: APP_DIR,
    argv: ["node", "server.mjs", "--api-only"]
  });
  assert.equal(config.port, 31338);
  assert.equal(config.publicOrigin, "http://127.0.0.1:4317");
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:4317"]);
});

test("API-only开发端口不再占用正式AI网关4318", () => {
  const config = createSelectionReviewRuntimeConfiguration({
    env: {}, appDir: APP_DIR, argv: ["node", "server.mjs", "--api-only"]
  });
  assert.equal(config.port, 4319);
  assert.equal(config.aiGatewayUrl, "http://127.0.0.1:4318");
});

test("中央模式拒绝回环地址、单进程JSON和开发默认身份", () => {
  const base = {
    SELECTION_REVIEW_RUNTIME_MODE: "central_test",
    SELECTION_REVIEW_BIND_HOST: "0.0.0.0",
    SELECTION_REVIEW_PUBLIC_ORIGIN: "https://review.internal.example",
    SELECTION_REVIEW_AI_GATEWAY_URL: "https://ai.internal.example",
    SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: "https://ozon-evidence.internal.example",
    SELECTION_REVIEW_IDENTITY_PROVIDER: "company_sso",
    SELECTION_REVIEW_DEFAULT_USER_ID: "team-user",
    SELECTION_REVIEW_STATE_ADAPTER: "postgres"
  };
  const config = createSelectionReviewRuntimeConfiguration({ env: base, appDir: APP_DIR, argv: [] });
  assert.equal(config.deploymentMode, "central_test");
  assert.equal(config.stateAdapter, "postgres");
  assert.equal(config.publicOrigin, "https://review.internal.example");

  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_STATE_ADAPTER: "json" }, appDir: APP_DIR, argv: []
  }), /中央模式必须使用并发安全的中央存储/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_BIND_HOST: "127.0.0.1" }, appDir: APP_DIR, argv: []
  }), /不得隐式绑定本机回环地址/);
  assert.throws(() => createSelectionReviewRuntimeConfiguration({
    env: { ...base, SELECTION_REVIEW_IDENTITY_PROVIDER: "development_default" }, appDir: APP_DIR, argv: []
  }), /正式身份提供器/);
});

test("AI网关远程地址只能由运行配置显式提供，中央模式必须HTTPS且URL不得带凭据", () => {
  assert.equal(normalizeServiceOrigin("http://localhost:4318/path?ignored=yes", {
    deploymentMode: "local_development"
  }), "http://localhost:4318");
  assert.equal(normalizeServiceOrigin("https://ai.internal.example/v1", {
    deploymentMode: "central_test"
  }), "https://ai.internal.example");
  assert.throws(() => normalizeServiceOrigin("http://ai.internal.example", {
    deploymentMode: "central_test"
  }), /中央模式必须使用非本机HTTPS/);
  assert.throws(() => normalizeServiceOrigin("https://user:secret@ai.internal.example", {
    deploymentMode: "central_test"
  }), /不得包含凭据/);
});
