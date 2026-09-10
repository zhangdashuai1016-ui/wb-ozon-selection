# 1688 旧路线复用取证（2026-09-09）

## 最新产品决定：人工单链接即选定供货来源

正式决定已保存至 `docs/first-sku-current-decisions-20260909.json` 的 `ownerProvidedSupplierLinkDecision`。当主人提供1688链接时，该链接就是选定货源及后续独立采购参考，不再要求第二条链接、不找替代供应商，也不以多家比较或自动图搜作为首件前置条件。下文此前“两种人工方案”仅保留决策历史，多链接方案不再施工。此覆盖仅适用于主人提供链接的本轮范围，没有改写其他商品或历史规则。

选定商品链接不等于选定链接内的SKU。若存在多个规格且主人未明确，仍在同一A卡选择唯一SKU，确认对应单件价、国内运费、其他费用、实际采购成本和包装；不得按最低价自动选取。缺字段保持unknown。供货事实提供商品属性依据，不替代平台类目、售价、佣金、物流和汇率证据，不自动下单或产生生产授权。

现有单链接入口可复用：A卡已有供应链接输入；服务端针对该链接创建详情采集；扩展按精确offer采集，回到同一A卡显示SKU并由主人选择；客户端已绑定captureId/SKU/variant/直接价并禁止自动确认。没有实际链接，本次仅记录产品方向并核对代码，零采集。

真实剩余缺口限定为单链接：

- 浏览器详情DTO目前提供 `sourceSkuId/attributes/propPath/priceCny`，没有直接提供确认卡选择器所需的完整 `variantKey/minimumOrderQuantity`；不能把API详情的字段支持冒充浏览器支持。需在既有详情适配与同一确认卡补齐可靠映射/明确主人补证来源，缺失保持unknown。
- 服务端当前capture/SKU/对应价格/MOQ与同款的额外严格校验仍只在 `provider_api_read_only` 分支。单链接浏览器路径必须补齐同等身份与事实绑定；不能只依赖客户端校验，不能默认MOQ=1或借其他SKU价格。
- 当前加载扩展未核验，工具URL策略限制持续；这不是网站故障证据，也不允许用旧扩展执行当前被拒的操作。真实详情采集仍须满足合法访问及持久授权。

本次只更新现有决策载体和交接记录，未扩写多链接或图搜，未改变运行代码、部署或业务数据。

## 最新状态：图搜扩写已暂停，已有本地改动完成必要检查

主人最新接受必要时自行找同款，要求遇到困难先共同选择方案。已停止扩大图搜执行层；只收口下述已改代码，不再寻找新入口、猜页面合同或继续外访。物流五输入自动报价已独立交付，不受此次暂停影响。

本轮本地改动：新增图源/单次图搜/授权/回执严格合同，接现software-job-v3和JSON适配器的入队、领取、发送意图与重启终态；新增可注入执行边界和显式晚结果只存证函数。没有真实页面适配器；超时后晚包仍需未来受控Worker主动交回，不能声称浏览器已实现持久交付。现有详情扩展未修改。服务端默认GET未就绪、POST503零业务写，评审台显示缺口。此能力仍是本地开发，不是多人中央生产验收。

必要检查实际结果（Node使用本机bundled绝对路径）：

- `node --test --test-concurrency=1 tests/a-supplier-image-search-contract.test.mjs tests/a-supplier-image-search-store.test.mjs tests/a-supplier-image-search-runner.test.mjs tests/a-supplier-image-search-runtime-services.test.mjs tests/a-supplier-image-search-api.test.mjs tests/capability-registry.test.mjs`：44/44，最终日志 `logs/first-sku-resumption-20260909/image-search-final-tests.log`。包含严格Schema、Seerfar合成回执到图搜来源、并发/过期/掉线/迟到、HTTP零写入。全为隔离或合成协议证据。
- `node --test --test-concurrency=1 tests/extension-capture-request.test.mjs tests/source-capture.test.mjs tests/supplier-selection-flow.test.mjs tests/real-a-confirmation-card.test.mjs`：42/42。
- `node --test tests/software-job-repository.test.mjs tests/software-job-admission.test.mjs tests/runtime-identity-software-job.test.mjs tests/a-product-detail-software-job-store.test.mjs tests/a-discovery-software-job-store.test.mjs`：49/49，实施工位实际执行。
- `node --test --test-concurrency=1 tests/seerfar-software-server-integration.test.mjs tests/a-product-detail-software-job-store.test.mjs tests/a-product-detail-runner.test.mjs`：11/11；`node --test tests/seerfar-discovery-integration.test.mjs`：17/17。
- `node node_modules/vite/bin/vite.js build`：通过，85模块，671ms。`node --check server.mjs`、`git diff --check`：通过。
- `node scripts/generate-capability-snapshot.mjs`：600产物覆盖；能力注册表最终5项已包含在44项中。

最终检查无error或warning。中间Schema遗漏与取消竞态已真实修复，没有关闭严格检查。架构/安全工位复核合同及取消、过期和晚包；实施工位复核复用仓储与能力隔离；验证工位复核真实临时JSON、严格Schema和隔离HTTP。无部署、无扩展安装更新、无实际图搜或详情采集。

### 人工参与的具体可选范围（尚未施工）

1. **最小人工方案**：主人独立提供最终一个精确1688链接及所选SKU。现A入口可承接单个链接，已存在的受控详情采集取得当前SKU资料后，仍在同一A卡确认成本、包装和具体SKU。当前加载扩展及受控采集可用性仍需合法核验；不得因此绕过本轮工具拒绝。此方案由主人完成供应商比较，工作台不能宣称自己已完成两家/三至四家的比较。
2. **保留多家比较的少量工程**：同一候选A卡新增有限备选供应链接列表（两家或三至四家），按offer追加保存每次详情回执，复用现collector/脱敏/SupplierOption/推荐规则，最后仅确认一个供应SKU。现领域已有supplierOptions与推荐/确认抽象，但当前可见A卡和sourceCapture仍是单链接，尚无完整多家列表与追加回执接线；不能让主人反复改同一个链接覆盖历史。浏览器来源的MOQ/精确同款门禁也需在现确认边界补齐，不能冒充API来源。这里只确认方案范围，不继续扩写。

两方案都从用户独立提供的资料进入正式A，不是本次受拒工具操作的替代执行。人工参与意愿不是当前登录态读取、图上传、付费或平台写入授权。

### 本轮方案二的原始范围与证据

主人选定方案二：完善现有1688浏览器采集器。暂不接官方API，不引入第三方替代。此前API成本高、效果不理想是历史判断，本轮没有验证最新报价。继续复用现有详情采集、供货确认和正式软件作业仓储；不同供应结果按作业追加，不循环覆盖单条sourceCapture。

旧首页访问的工具策略阻断仍有效。后续获准核验扩展管理页时，`cua.createBrowserTab("chrome", "chrome://extensions/", …)` 同样被 Browser Use URL policy 拒绝。没有读到页面，没有观察网站响应、登录或扩展状态；不得改用CDP、脚本、其他浏览器表面或扩展绕过。磁盘登记路径仍仅是历史本地元数据，不能替代当前Chrome加载证明。

正在补的本地范围：绑定已保存竞品图和当前revision的一次图搜合同，正式software-job领取/授权/租约/上传前发送意图，有限结构化结果及明确失败、unknown_outcome和迟到材料。图片搜索最多返回四个待核实来源，不自动认定同SKU或MOQ，不自动确认供货、推进B或批量抓详情。牛头基准再找一家、无牛头三至四家的完整同款比较仍须详情证据，不是返回四条搜索结果就算完成。

实际图搜页面合同、上传与解析适配器仍未取得可验证材料。默认服务入口显示未配置，直接提交也先拒绝，不创建授权或作业，不注册假就绪Worker。通用浏览器工具限制只属于本轮外部验收阻断，未写成1688永久不可用规则。

继续真实验收需要：工具允许相应页面操作；核实实际加载扩展及受控Worker版本；取得可保存且覆盖当前商品图上传/登录态读取/网站/数量/阶段/revision的授权；以可靠页面材料实现并核验单次执行器。不能用主人再次同意绕过工具策略。

沟通要求沿用：先查现有Skill、项目实现和成功回执；缺证据或复用不了时先报告具体缺口，再写必要部分。分别交代本地测试、真实图搜结果、精确SKU详情、评审台持久化回读和部署，不能互相替代。

结论：旧知识确实包括“1688 官方以图搜货”，不能把主动找货简单等同关键词搜索。原项目还有两条真实保存的详情采集成功记录。但这两类证据必须分开：目前找到的可执行组件负责已知链接的详情/SKU采集，没有找到可直接恢复的图片上传搜索调用、结果解析器或完整图搜成功回执。不能据此认定1688不可用，也不能改接替代来源。

## 已保存的成功证据

来源：默认主项目 `selection-review-app/data/candidates.json`，按候选 ID 精确读取 sourceCapture 和相关 history，未输出原始响应或秘密。

- 历史实例：已核对本地受控详情采集记录；实际候选、供应商商品和作业身份保留在非公开本地证据。该记录证明详情采集结果曾落盘，不证明图搜成功，也不构成当前供货确认。
- 历史实例：已核对本地受控详情采集记录；实际候选、供应商商品和作业身份保留在非公开本地证据。该记录证明详情采集结果曾落盘，不证明图搜成功，也不构成当前供货确认。

部分其他候选保存过“浏览器站点安全策略禁止直接访问”的失败记录。它们只证明当轮访问层失败，不能推断整个1688或以图搜索功能不可用；旧“失败重新排队”也不能移植成当前自动重试策略。

## 旧知识与实际组件分界

精确历史交接摘要 `2026-08-25T16-17-56-CM0C-wb_ozon_agents_and_three_store_control_handoff.md:142–149` 记载：维护时通过已有登录态浏览器执行1688官方以图搜货，再由1688-capture采集链接详情；底层浏览器工具未确认。这是历史线索，不是已找回的网络/页面操作回执。项目归档 `docs/archive/owner-intent/WB and Ozon选品-老板意图无损决策整合稿-2026-08-28-v4.md:3361–3363` 进一步明确应软件化，而不依赖临时维护操作。

可复用的当前9ce7文件：

- `lib/source-capture.mjs:28,43`：offer身份及允许来源规范化；`:233` 严格脱敏采集DTO；`:341` SKU匹配不明保持 needs_selection。
- `extension/1688-capture/source-routing.js:187,203`：精确详情链接/允许短链识别，最终地址必须解析为一致offer；不要从短链token猜商品ID。
- `extension/1688-capture/background.js:244`：明确captureId领取现有作业；状态探测不能领取。此执行路径是详情采集，不是图片搜索。
- `extension/1688-capture/collector.js`：从页面结构与SKU表读取精确ID、价格/库存来源；无SKU结构明确失败，不拿空结果冒成功。
- `lib/supplier-selection-flow.mjs:142,204,265`：现有推荐、主人确认及生命周期生成边界；可以承接供货结果，但不能把推荐当确认。

默认主项目旧 background.js 的 `:182,226,229` 保留了向评审台回传、打开已知来源、注入详情collector的实现。不要直接运行旧代码或覆盖新领取/租约边界。

## 新版真实缺口与最小继续方式

缺的是详情采集前的原1688以图搜索单步软件化：锁定目标商品/变体和允许搜索的图片引用，执行一次有限搜索，保存有界结果与同款比对依据，再将明确offer交现有详情作业。搜索失败、登录失效、验证、解析失败与真实无结果必须区分。现阶段没有 recovered request/selector，不能凭猜测编码或声称已接通。

下一步只需定位原成功研究轮次的脱敏浏览器动作/结果记录；可以用上述候选、日期与capture引用定向定位，保留上传入口、操作顺序、结果形状、规范链接与同款筛选证据。找不到应明确“原操作记录未恢复”，而非让主人重述全部流程。旧目标截图或图片相似只是线索，不能替代材质/电池/规格事实。

本轮未开1688、未读凭据、未运行旧脚本、未改源码/候选/部署。未进行Seerfar研究或替代供应商接线。结构化明细：`logs/first-sku-resumption-20260909/1688-reuse-findings.json`。

## 桥梁补充原始决定核对与实现去向

已逐段核对主树2026-08-28-v4归档：3165明确UD-30当前有效；3201的原始决定是**有牛头供应商，以它为基准再找1家完全相同SKU变体，总2个样本；无牛头约3至4家可比供应商**。不得沿用历史摘要中“牛头可直接停止/非牛头只需2家”的旧简化。3361起要求图搜成为可记录软件作业；3381起一件起批是硬条件，采用购买1件目标SKU的真实单价和国内运费，牛头不豁免。粗算用偏高合理采购价，不用异常最低价。

主树AGENTS.md:162明确综合成本、销量稳定性、可信标识、规格包装一致性、事实完整度，且不自动确认。当前 `supplier-selection-flow.mjs:86–171` 仅实现成本升序→销量稳定性→标识→事实完整度的字典序排序；成本优先具有绝对排序权，事实完整只看字段存在。目标SKU匹配用variantKey，不能单凭这个字符串证明两家完全同SKU。此函数没有牛头2样本/非牛头3至4家停止规则，亦未在推荐资格中核单件起批和数量1价格。不得把已有推荐函数存在称为完整保留旧规则。

旧技能脚本 `/Users/shuaizhang/.codex/skills/wb-product-selection/scripts/selection_pipeline.mjs:282–283` 排的是市场候选分数，`:327` 只检查moq数值是否存在；不是1688同款采样器、以图搜索执行器或单件资格验证。技能的通用“三至五供应商”描述不能覆盖上述具体主人决定，不应直接执行旧脚本来冒充恢复。

原路线最小实现落点：在现A供应搜索的范围/停止策略中保存竞品首图或合适商品图的明确引用（不是关键词替代）、牛头证据和所需2或3至4家有界样本；在既有供应结果资格层核完全同SKU、一件可买、数量1价格及国内运费，排除不能证明者后交现recommendSupplierOption。推荐层继续保存成本/销量/标识/包装规格对照依据；粗算保守价格和最终供应推荐是两个不同结果，不把最低报价自动当粗算输入。不创建平行物流/搜索体系，也不自动确认主人供应选择。具体图搜请求仍待原操作artifact恢复，本文未声称已找到或已运行。

## 第二次窄追溯：实际执行与已有确认门禁

追加只读搜索的准确范围：默认主项目 `selection-review-app/scripts/`、`extension/`、`lib/` 及旧技能 `wb-product-selection/scripts/`，关键词为 imageSearch、image search、searchByImage、imageAddress、以图搜、图搜、1688/upload组合。没有找到实际上传竞品图至1688官方图搜的实现。旧产品记录 `docs/archive/product-records/蛋蛋鼠选品-2026-07-31.md:48` 是“用竞品图搜相似形态”的工作安排，不是执行回执。历史摘要引用的原总控会话 `/Users/shuaizhang/.codex/sessions/2026/08/26/rollout-2026-08-26T00-17-56-01a039b6-ceed-7593-a7a4-a5b279364246.jsonl` 在该精确路径已不存在；本轮没有扩大扫描其他私密会话。故**图搜执行器/上传调用/成功搜索回执仍未找到**；已有详情capture不能填补这一证据。

纠正并补全“推荐函数缺门禁”适用范围：不能扩大为“当前A没有MOQ/同款门禁”。当前 `lib/real-a-confirmation-card.mjs:209` 的 validateRealAConfirmationSubmission 已被 `lib/real-a-b-c1-flow.mjs:307` 正式调用。对 `provider_api_read_only` 来源，`:263–276` 已验证当前captureId、绑定供应URL、唯一所选SKU/variant、明确返回的单件零售价、selected.minimumOrderQuantity===1及提交minimumOrderQuantity===1，并要求主人matchType===exact_match；近似/未知不能通过。`:246–260` 对通用确认要求精确1688链接、明确价格和国内运费、成本、实际重量尺寸和主人确认。

该现成门禁应直接复用，**不要新造重复MOQ/同款schema**。其作用是正式A确认；它不是图搜阶段两家/三至四家同SKU采样证明，也不是多模态自动认定。特别是MOQ/显式matchType额外校验目前受provider_api_read_only分支限定，不能无证声称旧browser来源也有同等字段门禁。未来原1688图搜接线应先保持明确的来源类型和已有详情采集身份，再评估最小共用资格验证，不冒充另一provider。

测试复用入口：`tests/a-product-detail-evidence.test.mjs:15` 已拒绝错误capture/SKU/variant/price、near_match及MOQ=2；`tests/real-a-confirmation-card.test.mjs` 保留通用确认与成本包装约束。新增图搜测试应聚焦图片输入引用、有限样本与停止、结果解析/失败层及详情作业交接，而不是复制已有A确认测试体系。

## 当前采集器、旧浏览器路径与本次阻断

**详情采集器已在当前源码中复用；本轮没有运行它，当前 Chrome 是否启用、从哪个目录加载尚未取得现场证据。** 不能把这次通用浏览器工具拒绝首页访问写成“原采集器失败”。

| 核对项 | 已观察证据 | 可以得出的结论 |
|---|---|---|
| 旧版怎样访问 | 默认主树 `extension/1688-capture/background.js:221–229` 按精确 offer 查找已有详情标签，使用 `chrome.tabs.update` 或 `chrome.tabs.create`，随后注入详情 collector | 旧版也用 Chrome 打开1688；目标是已知商品详情，不是官方图搜 |
| 当前是否保留 | 当前 `src/App.jsx:366` 在新建且非重复的 `supplier_capture_job_queued` 后调用 `src/captureStart.js`；`bridge.js` 仅转发动作与 captureId；`background.js:244` 领取既有作业，`:182` 新建自己的后台标签，`:194` 注入详情 collector，`:138` 回传结果；`server.mjs:3628` 接收并校验详情结果 | 页面、桥接、领取、详情读取和回传链路仍在。当前源码不是只留下一个没有调用方的采集器目录；不需要重新创建第二套详情采集器 |
| 这次哪里拒绝 | 本次 `mcp__cua_repl` 的 `cua.createBrowserTab('2', 'https://www.1688.com/', …)` 被工具站点安全策略拒绝；1次导航尝试、0页读取，未观察到网站响应，未触发用户审批或自动审批 | 失败层是本次工具入口；没有登录失效、反爬、网站改版或详情采集器失效证据。不能改用扩展、脚本、其他入口绕过本次明确限制 |
| 当前安装包 | 实际服务目录为 `/Users/shuaizhang/Library/Application Support/今日选品评审台-versions/20260908-product-discovery-v6`，服务端仍有 A 确认、作业领取及详情回传代码；包内没有 `extension/1688-capture`。`scripts/runtime-package.mjs:6–9` 的打包清单仅含服务文件及 lib/schema/dist 等 | 浏览器扩展与服务包是分开的；服务升级不会证明扩展已同步升级，也不能由包内无扩展推断 Chrome 没安装 |
| 版本与实际加载 | 默认主树与当前工作树 manifest 均为名称“全店经营工作台 · 商品只读采集器”、版本1.2.7，但后台代码及权限不同。限定检查 Chrome Default/Extensions 下 manifest 的名称/说明未匹配到该打包扩展；未读 Preferences、Cookie 或秘密 | 该检查不能排除从源码目录加载的未打包扩展或其他资料。Chrome 当前启用状态、加载路径和实际代码版本仍未知，不能仅凭1.2.7判定已更新 |
| 支持的动作 | 当前 manifest 仅许可1688允许短链与 `detail.1688.com/offer/*`、Ozon商品页及本地评审台；现有输入是指定商品链接 | 当前可追溯组件是详情/SKU采集，不是图片上传、图搜或搜索结果选择器 |

当前源码只为明确作业打开自身标签，旧代码则可能复用用户详情标签；这项实现差异不等于已发生的运行失败。历史两条详情成功仍只证明当时结果落盘，不能推断当前登录状态与成功率。

服务端 `extensionHeartbeatSnapshot` 保存的是进程内最近心跳，不是业务 JSON 的持久字段；因此业务文件中没有 `extensionHeartbeat` 不能作为“扩展未连接”的证据。按主人最新“只读解释、不执行额外访问”范围，本次未发送状态探针、未打开扩展管理页、未加载或启动 Worker、未领取作业、未打开任何1688页面、未执行采集。

现在可直接确认的是**详情链路已复用，图搜链路仍缺执行证据，实际加载与本轮实采未验证**。后续应先核对已加载扩展的非秘密元数据与当前目录的一致性；不能无证重写采集器，也不能用实采绕过本次工具限制。本节仅补充本地只读证据与文档，未修改生产源码，无需重跑已通过的详情边界测试。

### 后续补证：已定位磁盘登记目录，活跃状态仍未知

随后获准继续只读本地非秘密安装元数据。对 Chrome Default、Profile 1、Profile 2 的扩展登记，仅投影 extension ID、name、version、state、location、path；未导出完整配置、读取 Cookie/Token、复制账号字典或执行扩展。三个资料共6个现存元数据文件中，匹配条目只有 Default 的 `dakjehbcohonajmppgapfdpbdcmfbgdk`，登记路径为 `/Users/shuaizhang/Documents/wb & ozon 选品/selection-review-app/extension/1688-capture`，location=4。该条 name 为空，version/state 未提供，不能推断启用状态。

因此前文“没有任何安装目录证据”已被补足：**当前磁盘登记指向旧主树，不是9ce7工作树。** 这仍不是Chrome当前内存中已启用/已加载该版本的证明，没有打开扩展管理页或发送心跳探针。白名单投影记录见 `logs/first-sku-resumption-20260909/extension-registration-findings.json`。主人随后要求收尾交接，当前停止调查；不借安装核对执行1688访问或采集。
