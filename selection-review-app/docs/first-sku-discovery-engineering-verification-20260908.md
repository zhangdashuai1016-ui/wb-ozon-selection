# 首件主动发现工程验收记录

2026-09-08。任务结论：**本轮本地工程已验证，真实首件 A→E 部分完成，尚未跑通。** 新包 prepared，未安装、未启用；4317/4318 未部署或重启。测试、源码包和隔离 HTTP 均不代表真实商品、费用或平台结果。

## 根因与实施内容

| 根因 | 当前实现及边界 |
|---|---|
| 主动搜索缺正式软件生产者，已有详情 Worker 只能按已知商品打开页面 | 新 A 发现批次接入原 SoftwareJob、仓储、许可、租约和配置式服务。固定三次 LinkFox 搜索、有限页大小、最多一个待核验 A 候选；已有或淘汰身份不复活。批次无 SKU 时使用真实批次身份，不虚构 SKU。 |
| 搜索结果没有可靠进入原 A 卡；详情的两次异步返回可能与候选版本错位 | 独立两次详情许可和持久作业绑定同一 sourceRevision；两个完整回执核验齐备后，原子更新同一候选到 resultRevision。保存 provider_api_read_only 来源和原始证据引用，不创建假的浏览器采集。精确版本冲突刷新原卡，迟到响应不能覆盖新版本。 |
| 已保存 API 详情仍会触发旧浏览器采集，错误展示或不完整字段可能被当作事实 | A 确认复用既有冻结链并核对精确来源 URL；不再重复开供应页面。直接 SKU 零售价、规格及一件起订有明确门禁，品牌风险阻止普通无品牌确认；缺失字段保持 unknown。技术等待转为明确等待主人完整供货确认。 |
| B 条件测算补齐精确佣金后没有独立恢复动作 | 接入现有正式利润计算及精确费用复算入口，保留 A 冻结证据和旧测算；同一事务读取当前四类精确费用证据，只有正式通过才唯一创建 C1。 |
| 异步库存完成后缺少独立 E 续执行，已有 queued E 无正式恢复消费者 | 原 D 完成后接原 E；明确配置的消费者只处理首次、未发送的 E 作业。失败、已发送或 unknown 不重放，不再次执行 D。 |
| 进程退出后新 A 已发送作业缺启动终态收口 | 服务器监听前仅对两类新 A 作业执行严格过滤的重启对账；未知外部结果保存 unknown，不重发。真实隔离启动证明历史 C1 不被改写，第二次启动幂等。 |

主要模块：a-discovery-*、a-product-detail-*、linkfox-*、SoftwareJob 合同与仓储、运行配置/server、既有 A/B 流程、B 精确费用复算、D/E 服务及对应页面和测试。完整本轮文件差异见 [源码差异](../logs/first-sku-discovery-source-delta.json)。相对前一 v5 快照为 55 新增、30 修改、0 删除；仓库更早的未提交变更原样保留，不能把全部 git 差异归于本轮。

## 实际运行的验证

以下命令均在本工作树 selection-review-app 目录执行。各组存在重叠，**不得累加为全库覆盖**。首次 A 主组后又修改了页面文案并增加一项页面测试，最终页面组针对最终源码通过。

| 范围 | 实际命令 | 结果 | 记录 |
|---|---|---|---|
| A 搜索与详情 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/a-discovery-*.test.mjs tests/a-product-detail-*.test.mjs tests/a-read-restart-filter.test.mjs tests/linkfox-*.test.mjs` | 111/111；error 0，warning 0 | [日志](../logs/first-sku-discovery-complete-final.log) |
| A 确认及 B 冻结证据 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/a-product-detail-evidence.test.mjs tests/real-a-confirmation-card.test.mjs tests/real-a-b-c1-flow.test.mjs tests/real-a-b-evidence-orchestration.test.mjs tests/b-exact-commission-recalculation-use-case.test.mjs tests/b-exact-commission-runtime-view.test.mjs tests/candidateViews.test.mjs` | 35/35；error 0，warning 0 | [日志](../logs/a-detail-frozen-ab-regression-final.log) |
| 配置与页面 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/a-discovery-runtime-configuration.test.mjs tests/runtime-configuration.test.mjs tests/a-product-detail-ui.test.mjs tests/a-discovery-ui.test.mjs tests/frontend-review-behavior.test.mjs tests/candidate-user-fields.test.mjs` | 52/52；error 0，warning 0 | [日志](../logs/a-detail-root-ui-configuration-final.log) |
| 最终页面改动 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/a-product-detail-ui.test.mjs tests/real-a-confirmation-card.test.mjs tests/frontend-review-behavior.test.mjs` | 36/36；error 0，warning 0 | [日志](../logs/first-sku-discovery-ui-final.log) |
| 共享作业、重启与离线边界 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/runtime-identity-software-job.test.mjs tests/software-job-admission.test.mjs tests/software-job-repository.test.mjs tests/c1-ai-software-job-contract.test.mjs tests/d-e-software-job-schema.test.mjs tests/ozon-account-read-runtime.test.mjs tests/codex-independence.test.mjs tests/multi-user-central-runtime.test.mjs tests/software-execution-state.test.mjs tests/business-candidate-capacity.test.mjs tests/ci-test-policy.test.mjs` | 122/122；error 0，warning 0 | [日志](../logs/first-sku-discovery-shared-offline-verified.log) |
| 既有 HTTP 与 C1 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/b-exact-commission-recalculation-http.test.mjs tests/real-a-b-c1-api.test.mjs tests/c1-keyword-handoff-retry-http.test.mjs tests/c1-draft-runtime-services.test.mjs tests/c1-draft-software-use-case.test.mjs` | 32/32；error 0，warning 0 | [日志](../logs/first-sku-discovery-existing-http-final.log) |
| D 接 E 与恢复 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/d-e-runtime-services.test.mjs` | 29/29；error 0，warning 0 | [日志](../logs/d-e-recovery-pump-root-final.log) |
| 源码能力登记 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs` | 8/8；error 0，warning 0 | [日志](../logs/first-sku-discovery-source-checks-final.log) |
| 隔离运行包 HTTP | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 tests/runtime-package-api.test.mjs` | 1/1；error 0，warning 0 | [日志](../logs/first-sku-discovery-package-http-final.log) |

隔离运行包 HTTP 使用 SELECTION_REVIEW_TEST_PORT=52396、SELECTION_REVIEW_TEST_GATEWAY_PORT=52397 和临时状态，验证两次启动及既有状态保留；未启动真实 4317/4318，也未配置真实外部服务。

| 其他检查 | 实际命令或执行方式 | 结果 |
|---|---|---|
| 构建 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vite/bin/vite.js build` | 85 模块构建成功，error 0、warning 0 |
| 能力快照生成 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/generate-capability-snapshot.mjs` | 通过，581 项 |
| 能力快照核对 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/generate-capability-snapshot.mjs --check` | 通过 |
| 语法 | 使用上述 Node 对源码差异清单中的 72 个 JS/mjs 文件分别执行 `--check`；准确文件列表在源码差异记录 syntaxChecked | 72/72，无 error/warning |
| 差异格式 | `git diff --check` | 通过 |
| 运行包 | `/Users/shuaizhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/prepare-local-runtime.mjs --output /Users/shuaizhang/.local/share/wb-ozon-engineering/20260907-single-product-baseline/integration/single-product-discovery-v6-20260908` | prepared；243 个代码/构建文件与最终源码逐字相同；未安装或启用 |
| 模块图 | 最终 178 个 lib 模块的静态 import 解析 | 0 循环，0 缺失静态导入 |

完整结构化命令、耗时和日志：[最终质量记录](../logs/first-sku-discovery-final-quality.json)。[包独立比较](../logs/first-sku-discovery-package-verification.json)确认当前源未变。冻结摘要仅用于检测意外字节变化，不用作授权或防篡改。

最终所运行验证无未解决 error 或 warning，未跳过、取消或留下 todo。未重新运行整个仓库测试；项目未配置独立 lint/typecheck，未声称执行。

## 先前失败及真实修复

- 页面组首次 51/52：测试的失败回执夹具遗漏必需 steps，补全夹具，未削弱生产校验。
- 详情 HTTP 曾 1/2：实际 GET 分支引用未定义 URL 变量，修复服务器分支内解析；随后真实 HTTP 3/3，并包含新 A 重启 unknown 和不重放验证。
- 共享组曾 120/122：旧静态规则误判新增的回环地址拒绝表达式，并禁止所有启动对账。仅登记准确拒绝表达式，保留禁止新增本机业务依赖的规则；启动断言改为要求唯一、封闭的新 A 对账及显式配置消费者。实际存储过滤与真实 HTTP 共同证明不会改写旧 C1。最终完整该组 122/122。

上述失败日志保留在最终质量记录中。没有把旧失败组改写为成功、降低断言、关闭检查或用默认成功掩盖错误。

## 架构及子代理审查

- 架构审查：复用同一仓储、队列、准入、租约、用例和原 A 卡；没有第二套调度体系。新增模块有固定领域调用方，178 个模块无静态循环。
- 实现方案审查：将两种固定 LinkFox 协议放在同一传输及单次作业运行边界，领域合同和归一化分别验证。搜索许可与详情许可独立，不跨 revision 或作用域复用；新 v3 与历史 v1/v2 保持明确兼容边界。
- 测试与验证审查：覆盖原子落盘、两回执应用、幂等、超期、失败、unknown、重启、迟到响应、旧 C1 保留和真实隔离 HTTP。独立审查发现的版本刷新与启动对账缺口均已修复并验证。
- 安全与健壮性审查：实际发送前校验当前身份、版本、许可、预算、路由及凭据声明；固定外部网关，入口为封闭 JSON，响应先归一化和脱敏。未知错误保存失败后原样抛出，包括 throw null；不自动换路、重试或吞异常。

本轮由三个子代理覆盖架构、实现、测试和安全四个职责；各自结论由总控整合，不声称四个独立进程。源码已冻结，工位均停止写入。没有新增依赖或密码学机制。正常作业不依赖维护会话；当前 JSON 与单机 Worker 仍是本地开发适配器，**不代表多人中央运行已经验收**。

## 真实剩余项和下一步

1. 新版尚未部署。具体安装位置、原数据/素材保留、4317/4318 冷停、网关已审修复、验证及回滚写在 [启用与回滚审查卡](first-sku-activation-review-20260908.md)。首次启用所有外部消费者和凭据绑定为空，不自动运行旧候选。
2. LinkFox 真实账号与凭据路由尚未配置。拟议搜索三次 30 积分、详情两次 13 积分各需页面上的准确独立许可；这些是公开合同标称费用，实际余额、失败及空结果收费未核实。主人无需提供商品链接。详情仍可能因 SKU、起订量或其他事实缺失停在 A 补资料。
3. 首件 Miska 当前店铺事实、实际包装和完整精确费用、C1 来源及单次付费、C2 最终素材和生产决定均未实际验收；不能由代码或店铺名称替代。
4. D/E 仍缺官方库存状态映射、quant_size 规则、正向在售机器语义、平台转换图片与最终素材对应。具体缺口和两类最小官方材料见 [D/E 官方合同核验](first-sku-de-remaining-contract-20260908.md)。这属于技术证据缺口，不能统称等待主人授权，也不能猜值放行。
5. 全流程及多人中央运行未实测。实际商品查询、账号/凭据读取、付费、平台写入、部署和在线服务重启均为 0。

后续最小决定是批准上述明确部署范围，使新工作台可用。部署不会自动取得各阶段业务权限，也不能关闭 D/E 官方语义缺口。真正首件完成必须有当前 SKU 的 A 至 E 持久记录和独立平台回读。
