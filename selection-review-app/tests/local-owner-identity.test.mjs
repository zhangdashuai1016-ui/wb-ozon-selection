import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConfiguredIdentityProvider } from "../lib/runtime-identity-provider.mjs";
import { createSelectionReviewRuntimeConfiguration } from "../lib/runtime-configuration.mjs";
import { createLocalOwnerIdentityProvider, createPrivateOwnerCredentialRepository, OwnerIdentityError } from "../lib/local-owner-identity.mjs";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";

const PASSWORD = "synthetic owner password 2026";
const requestFor = result => ({ headers: { cookie: result.setCookie.split(";", 1)[0] } });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "owner-identity-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "private", "owner.json");
  let at = Date.parse("2026-09-07T08:00:00.000Z");
  const clock = () => new Date(at).toISOString();
  const repository = createPrivateOwnerCredentialRepository({ filePath, ...options });
  const provider = createLocalOwnerIdentityProvider({ credentialRepository: repository, clock });
  return { directory, filePath, repository, provider, clock, advance: ms => { at += ms; } };
}
function code(expected) { return error => error instanceof OwnerIdentityError && error.code === expected && error.cause === undefined; }

test("显式本地配置才装配正式provider，构造零I/O，开发和未知提供器不冒充登录", async t => {
  const f = await fixture(t);
  const configuration = createSelectionReviewRuntimeConfiguration({ appDir: path.join(f.directory, "app"), argv: [], env: {
    SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: f.filePath } });
  const provider = createConfiguredIdentityProvider({ configuration, clock: f.clock });
  await assert.rejects(fs.stat(path.dirname(f.filePath)), error => error.code === "ENOENT");
  assert.throws(() => provider.publicAccessState(), code("OWNER_IDENTITY_NOT_INITIALIZED"));
  await provider.initialize();
  assert.deepEqual(provider.publicAccessState(), { providerType: "local_owner_password", status: "setup_required", user: null });
  await assert.rejects(fs.stat(path.dirname(f.filePath)), error => error.code === "ENOENT");
  const dev = createConfiguredIdentityProvider({ configuration: { identityProvider: "development_default", defaultUserId: "dev-owner" }, clock: f.clock });
  await dev.initialize(); assert.equal(dev.publicAccessState().status, "development_only");
  assert.equal(dev.resolveActor().source, "development_default");
  await assert.rejects(dev.login({ password: PASSWORD }), code("OWNER_IDENTITY_NOT_CONFIGURED"));
  assert.throws(() => createConfiguredIdentityProvider({ configuration: { identityProvider: "unimplemented" } }), code("IDENTITY_PROVIDER_NOT_IMPLEMENTED"));
});

test("首次设置原子保存私有verifier，登录凭据与公开审计sessionId严格分开", async t => {
  const f = await fixture(t); await f.provider.initialize();
  const result = await f.provider.setup({ password: PASSWORD }); const request = requestFor(result);
  assert.match(result.setCookie, /HttpOnly; SameSite=Strict/);
  const bearer = request.headers.cookie.split("=")[1];
  assert.equal(result.actor.actorType, "human"); assert.deepEqual(result.actor.roles, ["owner"]);
  assert.equal(result.actor.source, "authenticated_identity_provider");
  assert.equal(JSON.stringify(result.actor).includes(bearer), false);
  assert.equal(f.provider.publicAccessState({ request }).user.userId, result.actor.userId);
  assert.equal(JSON.stringify(f.provider.publicAccessState({ request })).includes(bearer), false);
  assert.deepEqual(f.provider.resolveActor({ request }), result.actor);
  assert.throws(() => f.provider.resolveActor({ sessionId: result.actor.sessionId, userId: result.actor.userId }), code("OWNER_LOGIN_REQUIRED"));
  const bytes = await fs.readFile(f.filePath, "utf8");
  assert.equal(bytes.includes(PASSWORD), false); assert.equal(bytes.includes(bearer), false);
  assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.filePath))).mode & 0o777, 0o700);
  await assert.rejects(f.provider.setup({ password: "another synthetic password" }), code("OWNER_ALREADY_CONFIGURED"));
  assert.equal(await fs.readFile(f.filePath, "utf8"), bytes);
});

test("重启、退出和闲置使会话失效，GET/读actor不会续期而真实写动作可touch", async t => {
  const f = await fixture(t); await f.provider.initialize();
  const initial = await f.provider.setup({ password: PASSWORD }); const request = requestFor(initial);
  f.advance(29 * 60 * 1000); f.provider.resolveActor({ request });
  f.advance(60 * 1000); assert.equal(f.provider.publicAccessState({ request }).status, "login_required");
  assert.throws(() => f.provider.resolveActor({ request }), code("OWNER_LOGIN_REQUIRED"));
  const login = await f.provider.login({ password: PASSWORD }); const currentRequest = requestFor(login);
  f.advance(29 * 60 * 1000); f.provider.resolveActor({ request: currentRequest, touch: true });
  f.advance(2 * 60 * 1000); assert.equal(f.provider.publicAccessState({ request: currentRequest }).status, "authenticated");
  const restarted = createLocalOwnerIdentityProvider({ credentialRepository: f.repository, clock: f.clock }); await restarted.initialize();
  assert.equal(restarted.publicAccessState({ request: currentRequest }).status, "login_required");
  const again = await restarted.login({ password: PASSWORD }); assert.equal(again.actor.userId, initial.actor.userId);
  assert.match(restarted.logout({ request: requestFor(again) }).setCookie, /Max-Age=0/);
  assert.throws(() => restarted.resolveActor({ request: requestFor(again) }), code("OWNER_LOGIN_REQUIRED"));
});

test("真实两实例并发首次设置只有一个账户写入，落败实例必须读取已保存主人", async t => {
  const f = await fixture(t);
  const second = createLocalOwnerIdentityProvider({ credentialRepository: createPrivateOwnerCredentialRepository({ filePath: f.filePath }), clock: f.clock });
  await Promise.all([f.provider.initialize(), second.initialize()]);
  const results = await Promise.allSettled([f.provider.setup({ password: PASSWORD }), second.setup({ password: "second synthetic password" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected"); assert.ok(code("OWNER_ALREADY_CONFIGURED")(failed.reason));
  const winner = results.find(result => result.status === "fulfilled").value;
  assert.equal(JSON.parse(await fs.readFile(f.filePath, "utf8")).ownerId, winner.actor.userId);
  assert.deepEqual((await fs.readdir(path.dirname(f.filePath))).sort(), ["owner.json"]);
  assert.equal([f.provider, second].filter(provider => provider.publicAccessState().status === "login_required").length, 2);
});

test("输入闭合且口令按Unicode字符/UTF8字节计，scrypt并发、会话数及失败次数有界", async t => {
  const f = await fixture(t); await f.provider.initialize();
  for (const password of ["abc", "中文字", "😀".repeat(3), "😀".repeat(2), "x".repeat(1025), "valid password\0unwanted"]) {
    await assert.rejects(f.provider.setup({ password }), code("OWNER_PASSWORD_INPUT_INVALID"));
  }
  await assert.rejects(f.provider.setup({ password: PASSWORD, roles: ["owner"] }), code("OWNER_PASSWORD_INPUT_INVALID"));
  const setup = f.provider.setup({ password: PASSWORD });
  await assert.rejects(f.provider.setup({ password: PASSWORD }), code("OWNER_IDENTITY_BUSY")); await setup;
  for (let index = 0; index < 5; index++) await assert.rejects(f.provider.login({ password: "wrong password" }), code("OWNER_LOGIN_REJECTED"));
  await assert.rejects(f.provider.login({ password: PASSWORD }), code("OWNER_LOGIN_RATE_LIMITED"));
  f.advance(15 * 60 * 1000);
  for (let index = 0; index < 3; index++) await f.provider.login({ password: PASSWORD });
  await assert.rejects(f.provider.login({ password: PASSWORD }), code("OWNER_SESSION_CAPACITY"));
});

test("四个Unicode字符可以设置及重启后登录，空格和原始字符保持不变", async t => {
  for (const password of ["aB4!", "中文口令", "😀🙂🙃😄", " x y", "a".repeat(1024)]) {
    const f = await fixture(t); await f.provider.initialize();
    const setup = await f.provider.setup({ password });
    const bytes = await fs.readFile(f.filePath);
    const restarted = createLocalOwnerIdentityProvider({ credentialRepository: f.repository, clock: f.clock });
    await restarted.initialize();
    const login = await restarted.login({ password });
    assert.equal(login.actor.userId, setup.actor.userId);
    assert.deepEqual(await fs.readFile(f.filePath), bytes);
    if (password.trim() !== password) {
      await assert.rejects(restarted.login({ password: password.trim() }), code("OWNER_LOGIN_REJECTED"));
    }
  }
});

test("文件损坏、非私有权限和符号链接明确拒绝，异常不回显文件内容", async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.filePath), { mode: 0o700 });
  await fs.writeFile(f.filePath, "private-value malformed", { mode: 0o600 });
  await assert.rejects(f.provider.initialize(), error => code("OWNER_IDENTITY_STORAGE_INVALID")(error) && !JSON.stringify(error).includes("private-value") && !error.message.includes("private-value"));
  await fs.chmod(f.filePath, 0o644); await assert.rejects(f.repository.read(), code("OWNER_IDENTITY_STORAGE_INVALID"));
  await fs.unlink(f.filePath); const other = path.join(f.directory, "other.json"); await fs.writeFile(other, "private-value", { mode: 0o600 });
  await fs.symlink(other, f.filePath); await assert.rejects(f.repository.read(), code("OWNER_IDENTITY_STORAGE_INVALID"));
  assert.equal(await fs.readFile(other, "utf8"), "private-value");
});

test("首次持久化未知或回读失败保持503，不签发cookie、不再次设置或伪装setup_required", async t => {
  const f = await fixture(t, { atomicWriter: async (file, value, options) => {
    await persistJsonThroughRealTarget(file, value, options);
    const error = new Error("private-value"); error.code = "ATOMIC_JSON_DURABILITY_UNCONFIRMED"; throw error;
  } });
  await f.provider.initialize();
  await assert.rejects(f.provider.setup({ password: PASSWORD }), error => code("OWNER_IDENTITY_STORAGE_UNCERTAIN")(error) && !error.message.includes("private-value"));
  assert.throws(() => f.provider.publicAccessState(), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
  assert.throws(() => f.provider.resolveActor(), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
  await assert.rejects(f.provider.setup({ password: PASSWORD }), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
  const fresh = createLocalOwnerIdentityProvider({ credentialRepository: createPrivateOwnerCredentialRepository({ filePath: f.filePath }), clock: f.clock });
  await fresh.initialize(); assert.equal(fresh.publicAccessState().status, "login_required");
  const loggedIn = await fresh.login({ password: PASSWORD }); assert.equal(loggedIn.actor.source, "authenticated_identity_provider");
});

test("成功保存及并发已存在后的回读异常都冻结认证，不能显示可再次设置", async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t);
    const repository = { boundaryType: "private_owner_credential_repository", read: async () => null, create: async record => {
      await f.repository.create(record);
      repository.read = async () => { throw new Error("private-value"); };
      if (existing) throw new OwnerIdentityError("OWNER_ALREADY_CONFIGURED", 409, "账户已存在");
    } };
    const provider = createLocalOwnerIdentityProvider({ credentialRepository: repository, clock: f.clock });
    await provider.initialize();
    await assert.rejects(provider.setup({ password: PASSWORD }), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
    assert.throws(() => provider.publicAccessState(), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
    await assert.rejects(provider.setup({ password: PASSWORD }), code("OWNER_IDENTITY_STORAGE_UNCERTAIN"));
    const fresh = createLocalOwnerIdentityProvider({ credentialRepository: f.repository, clock: f.clock });
    await fresh.initialize(); assert.equal(fresh.publicAccessState().status, "login_required");
  }
});

test("私有目录祖先链接不能落入源码或业务导出目录，普通系统别名可安全使用", async t => {
  const f = await fixture(t);
  const appDir = path.join(f.directory, "app");
  const businessDir = path.join(f.directory, "business");
  await fs.mkdir(path.join(appDir, "public"), { recursive: true });
  await fs.mkdir(businessDir);
  for (const target of [path.join(appDir, "public"), businessDir]) {
    const alias = path.join(f.directory, `alias-${path.basename(target)}`); await fs.symlink(target, alias);
    const filePath = path.join(alias, "private", "owner.json");
    const configuration = createSelectionReviewRuntimeConfiguration({ appDir, argv: [], env: {
      SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: filePath,
      SELECTION_REVIEW_DATA_FILE: path.join(businessDir, "state.json")
    } });
    const provider = createConfiguredIdentityProvider({ configuration, clock: f.clock });
    await assert.rejects(provider.initialize(), code("OWNER_IDENTITY_CONFIGURATION_INVALID"));
    await assert.rejects(fs.stat(path.dirname(filePath)), error => error.code === "ENOENT");
    const privateRepository = createPrivateOwnerCredentialRepository({ filePath, protectedPaths: configuration.localOwnerIdentity.protectedPaths });
    await f.provider.initialize();
    if (f.provider.publicAccessState().status === "setup_required") await f.provider.setup({ password: PASSWORD });
    await assert.rejects(privateRepository.create(await f.repository.read()), code("OWNER_IDENTITY_CONFIGURATION_INVALID"));
    await assert.rejects(fs.stat(path.dirname(filePath)), error => error.code === "ENOENT");
  }
  const safeAlias = path.join(f.directory, "safe-system-alias"); await fs.symlink(f.directory, safeAlias);
  const privateRepository = createPrivateOwnerCredentialRepository({ filePath: path.join(safeAlias, "private", "owner.json"), protectedPaths: [appDir, businessDir] });
  assert.deepEqual(await privateRepository.read(), await f.repository.read());
  for (const field of ["SELECTION_REVIEW_DATA_FILE", "SELECTION_REVIEW_WORKFLOW_MAP_FILE"]) {
    const businessAlias = path.join(businessDir, `${field}.json`); await fs.symlink(f.filePath, businessAlias);
    const configuration = createSelectionReviewRuntimeConfiguration({ appDir, argv: [], env: {
      SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: f.filePath,
      [field]: businessAlias
    } });
    const provider = createConfiguredIdentityProvider({ configuration, clock: f.clock });
    await assert.rejects(provider.initialize(), code("OWNER_IDENTITY_CONFIGURATION_INVALID"));
  }
});

test("会话绝对八小时上限不被持续真实动作延长，重复cookie不构成认证", async t => {
  const f = await fixture(t);
  const provider = createLocalOwnerIdentityProvider({ credentialRepository: f.repository, clock: f.clock, secureCookies: true });
  await provider.initialize(); const result = await provider.setup({ password: "😀".repeat(15) });
  assert.match(result.setCookie, /; Secure$/);
  const request = requestFor(result);
  assert.throws(() => provider.resolveActor({ request: { headers: { cookie: `${request.headers.cookie}; ${request.headers.cookie}` } } }), code("OWNER_LOGIN_REQUIRED"));
  for (let index = 0; index < 16; index++) { f.advance(29 * 60 * 1000); provider.resolveActor({ request, touch: true }); }
  f.advance(16 * 60 * 1000);
  assert.equal(provider.publicAccessState({ request }).status, "login_required");
});
