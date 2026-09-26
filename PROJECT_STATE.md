# 项目能力与目标

更新：2026-09-21。本文件只说明实现及验证边界，当前节点与运行快照只在 [HANDOFF](HANDOFF.md)。[8 月原状态全文](docs/archive/2026-09-20-document-baseline/PROJECT_STATE.md)已归档，其中旧 D/E 缺口、固定关键词数量及模型安排不能作为今天的要求。

## 规范与事实各自回答什么

- **规范依据**：长期 [AGENTS](AGENTS.md)、已确认且仍有效的[项目决定](docs/current/老板当前决定索引-2026-08-29.md)和已批准版本化配置，说明软件应当怎样运行。代码或测试不能批准、覆盖业务规则；冲突应记录为实现差距。
- **实际事实**：平台结果看当前官方证据或 E 独立回读；生命周期、授权和作业看中央持久状态及正式回执（本地阶段使用已标明的开发适配器）；源码与测试说明实现行为，部署回执说明安装范围，页面是派生展示。不同证据不能相互冒充。
- 未核实的运行或平台能力写明“未核实”；旧缺口不能未经复查当作当前缺口。

## 架构边界

规范对象链：`OpportunityPackage → SalesSnapshot / SupplierOption → OwnerSupplyConfirmation → SkuLifecyclePackage → ProfitModel → C1ProductPlan → C2 最终素材与商品确认卡 → ProductionAuthorization → ProductionPlan / execution intent → ProductionRecord 或 ExternalListingRecord → EVerificationRecord`。

领域/用例负责规则和状态变更；Repository 负责持久化及原子提交；连接器、作业运行器和 Worker 负责受控 I/O；UI 展示状态和提交主人决定。业务阶段、业务结果、技术状态、主人动作分别表达。正常流程不依赖开发对话，具体约束见 AGENTS。

当前为本地开发能力。本机 JSON、单进程队列和单 Worker 不等于中央数据库、多机续作或多人权限已经完成。平台、店铺和每 SKU 的利润、身份、授权与回执独立，不要求前台每规格分成独立商品卡，也不要求重做适用的商品级研究。

## 能力分档

仅使用以下四档；每档均须看对应范围，不能按阶段名称直接推导生产完成。

| 能力 | 分档 | 可核对依据 / 实际限制 |
| --- | --- | --- |
| A、B 及 B→C1 | 有代码且有实际记录 | 本品已留 A/B 和 C1 交接记录，近期施工报告核对到 C1；[A/B/C1 流程](selection-review-app/lib/real-a-b-c1-flow.mjs)。不表示所有商品或多人闭环已验通。 |
| C1 修订文案采用 | 有代码且有实际记录 | [商品页](selection-review-app/src/components/ProductPage.jsx)、[文案审核](selection-review-app/src/components/C1ContentReviewPanel.jsx)。r56 已部署，主人正式确认后持久状态进入 C2/revision 60；不表示新模型输出已验证或图片节点已完成。最新证据见 HANDOFF。 |
| C2 图片新版入口 | 有代码且有实际记录 | [最终素材面板](selection-review-app/src/components/C2FinalAssetsPanel.jsx)。r57 已部署，主人已反馈图片节点通过；施工任务回读正式 C2 completed、15 个 finalUploads。Finder 实际拖入按主人反馈，非工具系统拖拽实测。该单商品验收不代表共享素材或同卡多规格全部完成，最新证据见 HANDOFF。 |
| 最终商品确认卡 | 有代码但本商品未验通 | 本品方案卡已生成、等待主人商业确认；现有生产确认表单在[原审核界面](selection-review-app/src/components/UserInspector.jsx)，最终确认路径及后段门禁正在工程核对，不表示新版生产确认或 D 已验通。尚无生产授权，具体核对状态见 HANDOFF。 |
| Ozon 正式 D/E | 有代码但本商品未验通 | [服务接线](selection-review-app/server.mjs)、[D/E 运行服务](selection-review-app/lib/d-e-runtime-services.mjs)、[正式 HTTP transport](selection-review-app/lib/ozon-de-http-transport.mjs)、[Seller API 适配器](selection-review-app/lib/ozon-seller-api-de-adapter.mjs)。本轮也只读确认 r55 的服务接线存在；不沿用 8 月“server 未接”的旧结论。 |
| D 异步观察、继续库存及 E 后台回读 | 有代码但入口/配置未接齐 | [平台观察用例](selection-review-app/lib/d-platform-observation-use-case.mjs)、[D/E 运行服务](selection-review-app/lib/d-e-runtime-services.mjs)、[E 回读用例](selection-review-app/lib/e-readback-software-use-case.mjs)。当前配置缺口见 HANDOFF；有限观察不等于失败自动重放。 |
| Ozon 账户读取 | 有代码但入口/配置未接齐 | [配置边界](selection-review-app/lib/runtime-configuration.mjs)及服务端已有入口；本轮配置核对结果见 HANDOFF，实际影响需按本件路线验证。 |
| 同一卡追加全部盈利规格 | 仅目标或未核实 | 已确定先一规格跑通再追加；本品未完成平台合卡及追加验收。 |
| 素材上传一次、按 SKU 选用 | 仅目标或未核实 | 已提出共享素材目标；现有素材模块不证明全链路已满足。 |
| 多人中央运行 | 仅目标或未核实 | [中央边界](selection-review-app/lib/multi-user-central-runtime.mjs)存在，但中央数据库、身份权限和多机续作未在此验通。 |
| WB 正式 D/E | 仅目标或未核实 | 本轮未查验 WB 真实闭环；不作不存在或已可用的推断。 |

实现与测试文件只作代码定位，测试是否通过以相应施工报告为准。本轮是文档整理，没有重新运行应用测试、构建或平台业务。最新施工与部署报告由 HANDOFF 精确链接。

## 验收边界

- 代码、测试、安装副本、UI 保存、平台提交和独立回读分别举证；“请求已接受”不等于可售。
- 每阶段回答：开发会话完全退出后能否完成正常步骤；一台员工电脑关闭后中央状态是否准确且其他用户能否继续。后者未通过只能称本地开发能力。
- 失败须分类、持久化并安全停止；`unknown_outcome` 先对账，禁止自动换路径或重放。
- 页面按节点交给主人验证；准确链接、按钮和成功/异常标准由当前施工交付，不能用历史说明替代。

工程命令与运行方法见[应用 README](selection-review-app/README.md)及[贡献检查](README.md)。纯文档修改只做范围、链接、归档及差异检查，不要求运行应用全量 CI。
