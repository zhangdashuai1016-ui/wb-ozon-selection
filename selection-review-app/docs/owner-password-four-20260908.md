# 主人密码最短四字符维护结果

2026-09-08。**已完成并在当前工作台生效。** 主人通过“施工前讨论语音五”明确要求最低长度由15改为4，并授权更新当前安装及必要重启。授权记录见 [本轮授权](../logs/owner-password-four-20260908/authorization.json)。实际浏览器已显示“请设置至少4个字符、最多1024字节的密码；空格会原样保留。”，两个密码输入框未填写。

## 根因与实施

15字符是现有本机主人密码设置路径的硬编码产品规则。前端和后端分别执行这一限制，页面另有提示，因此只改提示不能改变实际行为。本轮把三个现有位置一致改为4字符：

- `lib/local-owner-identity.mjs`：仅首次设置的最小Unicode字符数及对应错误提示。
- `src/ownerAccess.js`：前端首次设置校验及错误提示。
- `src/components/LocalOwnerAccessPanel.jsx`：可见说明。
- 原有三个密码测试文件：覆盖3字符拒绝、4字符允许，中文、表情、空格、1024字节上限、空字符拒绝、原长密码、重启登录及权限边界。

字符按现有Unicode码点计数；不新增按UTF-16长度工作的HTML minLength。空格原样保留，不裁剪或规范化。登录路径、scrypt及盐、私有身份存储、会话、Origin/CSRF、失败次数及15分钟限制均未改动。未增加PIN入口、模块、依赖、数据格式或迁移。

## 实际验证

工作目录为本工作树 `selection-review-app`；下表 `node` 的实际路径均为 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。

| 实际命令或检查 | 结果 |
|---|---|
| `node --test --test-concurrency=1 tests/local-owner-identity.test.mjs tests/local-owner-access-ui.test.mjs` | 17/17，通过；含旧长密码和4字符设置后重启登录 |
| `SELECTION_REVIEW_TEST_PORT=52394 node --test tests/local-owner-access-api.test.mjs` | 2/2，通过；3字符返回400且不创建身份，4字符走完整隔离接口流程，生产授权与认证边界保留 |
| `node --test tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs` | 8/8，通过 |
| `node node_modules/vite/bin/vite.js build` | 85模块构建通过，无error/warning |
| `node scripts/generate-capability-snapshot.mjs` | 当前v2快照刷新为581项，历史v1不变；登记/快照测试随后通过 |
| `node --check`，分别检查 `lib/local-owner-identity.mjs`、`src/ownerAccess.js`、`tests/local-owner-identity.test.mjs`、`tests/local-owner-access-ui.test.mjs`、`tests/local-owner-access-api.test.mjs` | 5/5，通过；JSX另由构建验证 |
| `git diff --check` | 通过 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-password-length-20260908` | 准备成功，安装后全部5415文件与包逐字一致 |
| 当前工作台 GET `/api/owner-access`、`/api/health`、`/api/state`、`/`、JS资产、CSS资产 | 全部200，页面资产与安装文件相同；JS含4字符提示 |
| 实际浏览器页面 | 显示至少4字符提示，输入框为空，未提交设置 |
| 源码冻结及部署数据比较 | 581源文件一致；52候选ID/revision、业务数据、流程图及10张历史图未变；身份文件仍未创建 |

最终所运行检查无未解决error/warning，测试无跳过或取消。初次HTTP测试因临时服务的Origin没有设置为实际测试端口而返回403，被现有保护正确拒绝；为隔离子进程明确设置public origin和allowed origins后最终2/2通过。生产Origin校验未放宽，初次失败日志 `owner-http-tests.log` 保留。没有重跑全仓测试，未声称执行独立lint/typecheck。

## 实际部署与证据

- 当前安装目录仍为 `/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`，页面地址 [工作台](http://127.0.0.1:4317/)。
- 当前维护包为 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-password-length-20260908`。旧v6及legacy-read包保持原样。
- 冷备份为 `/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/activation-backups/20260908T144332Z-password-length`，保存原业务数据、10张历史图、启动配置、原后端模块及完整旧dist。
- 仅对工作台4317执行 `launchctl bootout gui/用户UID <原plist>`；确认端口释放后原子替换后端和构建资源，再以 `launchctl bootstrap gui/用户UID <原plist>` 启动。原启动配置未改，网关4318未重启。
- 当前JS资产为 `index-CltkWtTg.js`。HTTP回读时主人状态为 `setup_required`，身份文件不存在；未读取身份内容、未替主人设置或提交密码。
- 相对上一冻结仅3生产文件和3测试文件变化。源码581项，摘要 `7f142d0f07c294843eaeef0e60ec818ead3de76a033f2af421dd1e91a5ae923d`；摘要仅用于检测意外变化。

独立证据：[安装回执](../logs/owner-password-four-20260908/installation-receipt.json)、[当前服务回读](../logs/owner-password-four-20260908/readback-receipt.json)、[本轮最终回执](../logs/owner-password-four-20260908/final-receipt.json)。各测试日志同目录。准备包中的prepared状态保持其历史含义，实际安装与启动由独立回执证明。

## 架构和审查

三名只读审查成员覆盖四项职责，唯一实施者修改源码：架构/安全联合审查确认后端只改阈值与提示，既有存储和鉴权边界保留；实现审查确认复用三个现有位置，无重复身份体系或公共合同变化；测试审查要求3/4字符、Unicode、字节上限、空格、旧长密码及重启路径，并核对隔离接口Origin。本轮无未关闭审查发现。

模块边界保持原状，没有新增技术债或迁移负担。最低4字符比15字符更容易猜测，这是主人明确选择的产品取舍；现有本机进程内限速会随服务重启清空，本机可执行程序也不能单靠Origin形成身份隔离。这些既有边界未在本轮扩展为新的身份工程。

主人刷新页面即可自行设置至少4字符的密码。此维护不涉及商品、账号凭据、付费或平台业务动作，也不改变真实首件A→E与多人中央运行尚未验收的状态。
