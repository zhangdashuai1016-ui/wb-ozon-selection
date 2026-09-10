# 首件工作台部署结果

2026-09-08。**本次批准的本地部署已完成，实际页面及数据回读通过；真实首件 A→E 尚未完成。** 主人经“施工前讨论语音五”对准确启用卡回复“是”，授权依据已保存。此结果替代此前“v6未启用”的当前状态，不改写原批准卡、封存准备回执或历史测试记录。

本文件记录最初启用结果。后续主人已授权将密码最短长度改为4并完成实际维护；当前维护包、校验和回读以 [密码维护结果](owner-password-four-20260908.md) 为准，下面的旧包与源码摘要保留为当次部署历史。

## 实际启用及数据保留

- 新工作台位置：`/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`，实际包内 Node 和 server 进程监听 `127.0.0.1:4317`。
- 网关在原源码位置应用已审 11 文件修复，未列源码与原启动配置不变，监听 `127.0.0.1:4318`。没有调用 `/health`、`/v1/capabilities` 或 `/settings`，没有读取提供者密钥。
- 原 `candidates.json`、`workflow-map.json`、网关 `inference-jobs.json` 在启动、HTTP回读和浏览器页面检查后均与冷备份逐字一致。52 个候选的 ID/revision、38 条旧派发及 2 条已完成网关作业保留。
- 原 10 张历史图片在新代码目录完整复制，逐字比较及各自 HTTP 读取均通过。原 `data/c2-final-uploads` 不存在；新配置仍指向原准确位置，没有伪称已迁移一组不存在的最终素材。
- DD-H1 旧 `listingPreparation=queued` 与已结束执行记录不一致。已核实 processing=idle、handoff=completed/active=false/runId=null、关联旧dispatch=responded_unverified，不满足任一实际队列消费条件；原记录逐字保留，未将其改为业务成功或复活。
- 外部服务、计划、凭据和生产绑定均保持批准的空配置，D/E轮询与OSS未启用。页面实际运行作业显示 0，旧停止待决定 13、旧淘汰 35；这些是旧记录展示，不是首件运行结果。

冷备份目录：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/activation-backups/20260908T141137Z`。备份为私有目录，含工作台完整数据13文件、历史图10文件、网关源码15文件、网关作业文件及两份启动配置，全部逐字核对。旧版源码和原封存包保留。

## 部署中发现并修复的根因

首次 v6 启动后健康及主人入口正常，但实际 `/api/state` 返回 500：历史 v2 文档允许没有 `runtime`，账户准备视图却直接读取 `runtime.softwareJobs`。此前隔离包夹具包含 runtime，未覆盖这一旧格式。

在既有 `lib/ozon-account-read-services.mjs` 的只读边界严格校验类型后，仅于临时浅副本复用现有作业集合规范化函数。合法缺失可读；显式损坏的 runtime、jobs、receipts 或空值回执仍明确拒绝。原文档、历史回执、作业和许可均不修改。没有新增模块、依赖、公共合同或数据迁移。

新增/增强现有集成和包 HTTP 测试，覆盖缺 runtime、有真实 SKU 的旧文档、现有三方法回执、损坏类型及不改原数据。修复只涉及一个生产模块和两个测试文件；架构、实现、测试、安全四职责由三个子代理及总控复核，无未关闭发现。

通过隔离验证后，在同一已批准部署目录内冷停工作台，备份原模块，原子替换该一个模块再启动；网关没有再次重启。当前安装文件与维护包全部 5415 文件比较一致（含运行时和依赖），原 243 个代码/构建文件口径保持明确。

当前维护包：`/Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-legacy-read-20260908`。原 v6 准备包及双方 `runtime-package.json` 保持 prepared 历史语义，实际安装/启动用独立启用回执证明。当前源码581项，摘要 `d2b4b4f5aeed2776c5d8581813bbd50f1044b3bf308fdb75ec4bb081de49564b`，相对原v6仅3源文件变化；摘要只检测意外字节变化。

## 实际验证

Node 实际执行路径为 `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`；安装包语法检查使用其 `runtime/node`。

| 命令/检查 | 结果 |
|---|---|
| 网关源码目录 `node --test tests/*.test.mjs` | 35/35，通过 |
| 工作台 `node --test --test-concurrency=1 tests/ozon-account-read-integration.test.mjs` | 11/11，通过 |
| `SELECTION_REVIEW_TEST_PORT=52396 SELECTION_REVIEW_TEST_GATEWAY_PORT=52397 node --test --test-concurrency=1 tests/runtime-package-api.test.mjs` | 1/1，包含有/无runtime两种历史格式共4次启动；页面、匿名权限、原数据及零依赖调用均通过 |
| `node --test tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs` | 8/8，通过 |
| `node scripts/generate-capability-snapshot.mjs` | 581项快照已刷新，随后登记/快照测试通过 |
| `node --check` | 安装前8个文件、维护修改后3个文件均通过 |
| `git diff --check` | 通过 |
| `node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-legacy-read-20260908` | 维护包准备成功；安装5415文件逐字匹配 |
| 真实历史数据隔离回读（临时端口52398/52399） | 52候选、2个有SKU的旧记录、无runtime；HTTP200，身份/revision和数据字节不变，依赖调用0；临时副本已清理 |
| 实际工作台 GET `/api/health`、`/api/owner-access`、`/api/state`、`/api/workflow-map`、`/`、2个静态资产及10张旧图 | 全部200；身份/版本及响应字节符合安装内容 |
| 实际浏览器页面 | 标题“全店经营工作台”，显示“首次设置主人密码”，列表正常、实际运行0；密码字段未填写 |
| 启动控制 | 对两个精确标签执行 `launchctl bootout gui/用户UID <原plist>`，冷备份后依次 `launchctl bootstrap gui/用户UID <原plist>`；兼容修复时仅对4317重复冷停/启动 |
| 安装后启动配置、进程路径、端口及日志增量 | 与批准范围一致，修复后新增error 0、warning 0 |

所有最终相关验证通过，无跳过/取消。首次线上500和扩展包测试初次失败日志保留：包测试失败是新增身份夹具与数据父目录重叠，被正确拒绝；分离夹具目录后完整通过，生产隔离校验未放宽。未重跑全仓测试，未声称执行未配置的独立lint/typecheck。页面构建无改动，采用此前已验85模块构建并比较实际HTTP字节，没有用重复构建冒充新验证。

完整机器回执及各项日志：[最终启用回执](../logs/first-sku-activation-20260908/final-activation-receipt.json)。初次失败、冷备份、安装、维护安装、真实副本隔离回读及当前HTTP回读都在同目录分别保留。

## 主人下一步与真实限制

打开 [新版工作台](http://127.0.0.1:4317/)，在“首次设置主人密码”中两次输入至少4个字符的个人工作台密码，点击“设置密码并登录”。无需提供店铺密码、API Key 或商品链接。不要在聊天中发送密码。

这一步仅建立本机主人身份。实际 LinkFox 账号/服务/凭据路由、单独搜索与详情许可仍未建立；真实首件的事实、精确费用、C1来源、最终素材和生产决定尚未验收。D/E 官方库存字段、quant_size、在售语义和转换后图片对应仍存在技术证据缺口，详见 [官方合同核验](first-sku-de-remaining-contract-20260908.md)。部署成功不能代替它们。

当前仍为本地JSON及单机Worker能力；多人中央运行未验收。真实商品查询、提供者凭据读取、付费、上传、平台写入均为0。
