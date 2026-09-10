# Miska 首件只读核验草案与平台异步边界

状态：2026-09-08，16:21 草案后的异步续执行及独立账户准备已完成本地工程验证，运行包未启用；准确实现、最终测试及剩余问题以 HANDOFF 顶部交付入口为准。本文保留设计依据与真实核验草案，不是读取许可、生产授权或部署授权。已确认首件选择 **Miska 的 Ozon 店铺**，只确认显示名称；内部店铺键、官方店铺编号、Client ID、凭据别名和仓库均未由本文推定。沿用既有候选，不新建商品，不修改长期规则。

最新优先级：主人明确将身份、登录和账户绑定的非必要深化后置。已有独立账户准备及必要基础检查保留，不继续研究完整身份模型，也不以尚缺账户字段等价证明阻塞本轮异步 D/E 工程交付。当前集中单次 import、有限持久观察、原 D 未发送库存续执行、图片核验及不重放回归。未核实账户事实仍待核验，真正访问或写入时再核对当步必需的账户、店铺和有效许可；本次优先级调整没有授权真实外部操作。

## 1. 异步判定：已证实的根因

依据为当前 AGENTS.md 的 9.4、10.1–10.4，以及已取得的官方 import/info、库存方法原文。以下是应保存的不同事实，不是把所有情况变成成功。

| 精确观察 | 正确含义 | 后续边界 |
|---|---|---|
| 本轮 import 返回合法稳定 task_id | 请求已接受；导入、库存、审核尚未因此完成 | 保存本轮 PA/job/SKU/revision/路由与任务关联，绝不重新发送 import |
| 对此任务的单商品结果为 pending，offer 匹配、响应结构有效 | 平台明确排队，technicalStatus=waiting_platform | 保存本次观察，库存未发送；不能归作未知写结果，也不能生成 ProductionRecord |
| imported，精确 product_id/offer 匹配且完整回执没有错误 | 导入成功 | 仍须取得库存写前条件及预留量证据；不推导在售或 price_sent |
| failed，精确任务/offer 关联有效 | 已知导入失败，可能已有部分平台对象 | 保存错误及可确定商品身份；不声称请求未发出或平台零变化，不自动重试 |
| skipped，精确任务/offer 关联有效 | 本请求未更新 | 对新品创建不能冒充本轮创建；保存事实并停止，不自动转外部已存在成功 |
| 已接受且官方事实明确待处理/待审核 | 等待平台 | 保留等待与未执行步骤，不产生已验证结果 |
| 请求超时、损坏回执、错身份、任务范围冲突或无法判定终态 | unknown_outcome | 保留最后确定成功步骤、已有接受事实与禁止重放动作；先对账 |

16:21 实施前已核实的原实现限制（保留根因，不作为新代码状态）：

- `lib/ozon-seller-api-de-adapter.mjs` 保存 task_id 后只查询一次 import/info；非 imported 统一进入 unknown。导入通过后立即保存 stock_intent，没有 price_sent 等待或写前预留量读取。
- `lib/d-e-software-integration.mjs` 的库存检查点只要求 imported、无错误和身份一致；没有库存前置条件来源。
- `lib/d-e-software-closure.mjs` 的即时回读要求三个状态已知；它没有硬要求 D 已在售，但当前 saleStatus 除 archived 外不能可靠映射，因此 D 不能完成。
- `lib/d-e-runtime-services.mjs` 只从 queued 启动 D；generic waiting_platform 是当前持租约外部请求状态，不是可恢复的异步等待队列。旧 in_flight 重启仍收为 unknown。
- `lib/d-e-software-job-scope.mjs`、`lib/e-readback-software-use-case.mjs` 要求正式 ProductionRecord、成功 D 和完整检查点。当前 E 是一次独立读取加超时，重复入口幂等返回；没有稳定 task_id 来源、逐次计数/期限、到期查询队列或观察链。

## 2. 最小工程合同及不可默加的行为

先实施的分类边界应继续放在现有 D 合同、用例和持久状态内：为新版本作业区分接受、排队、导入成功、明确失败、未更新及未知，保存已发步骤/未发步骤和逐条脱敏观察；库存意图门必须引用准确 price_sent 与预留量证据。缺证据时不创建库存意图，不把导入成功改成整体 D 成功。新状态应同步 adapter、closure、integration、job-results、cursor/schema、runtime 和视图，不能只改显示文案。

有限状态查询按 AGENTS 10.4 留在 **E 的纯只读观察能力**：复用现有队列、repository、租约和传输，增加一个严格的“本轮 D 接受回执＋稳定任务/商品”来源分支。该分支产物只是平台观察，不能生成或伪装 ProductionRecord、不能进入 listed_verified；原有 ProductionRecord→完整 E 验证分支不降低要求。候选 businessPhase 在 D 未完成前仍为 D，UI 单独显示等待平台。

每个观察作业锁定原 PA、candidate、SKU、revision、task_id/已证实 product_id、店铺/凭据路由、正式方法和版本化查询策略；计数、总期限、间隔、单次超时由明确策略输入，不设置未经批准的永久通用数值。每次领取/发送前原子检查预算、身份、revision、许可、租约和取消，保存查询意图及结果，重启不能重发写请求。耗尽后停止查询：最后明确 pending 仍显示等待平台及查询已停止；无法判定终态仍为 unknown。

**已批准的续执行关系：** E 的只读观察取得可信的 price_sent 及指定仓库预留量证据后，交由原 D 作业执行原授权中尚未发送的库存步骤。E 不调库存、不创建库存意图；不新建隐式 D 重试，不重发已发库存。import 最多一次、库存最多一次，每次发送前重验原 PA、revision、路由、来源、查询策略及租约；过期、冲突和不能证明从未发送时停止。旧 unknown 不自动恢复。这是已批准的工程合同范围，不增加任何真实写入许可。具体新旧版本见 HANDOFF 顶部冻结表。

历史边界：仅新版本作业创建新等待状态和查询游标；旧请求、旧 executionKey、旧 PA/回执/unknown 原样读取，不凭旧摘要补认 pending，不自动迁移、补跑或重放。最小方案不引入第二个调度器或本地会话轮询。

## 3. A 组：Miska 最小只读核验卡草案

### 主人看见的范围

目的：核对 Miska 的准确账户路由、实际价格设置币种，并展示现有仓库供选择。不会读取商品、改价、改库存或创建商品。

| 卡片字段 | 当前准确状态 |
|---|---|
| 平台与店铺显示名称 | Ozon / Miska，主人已选择 |
| 内部引用与官方店铺身份 | 待核对；显示名称不能替代稳定身份 |
| Client ID 与凭据别名 | 从准确本地配置/经授权的非秘密账户页面核对，不猜值；秘密留在凭据服务，不进入卡片、聊天或证据 |
| 仓库 | 未选择；由下表列表来源展示名称、编号、模式和状态，再选择具体行 |
| 作用域 | 首件前检准备记录及其 revision；不能使用假 candidate/SKU 或创建合成候选占位 |
| 请求预算 | 新卡提议三个 API 方法各最多一次，总计最多 3 次；无重试、无翻页。与旧三方法许可完全独立 |
| 有效期/操作者 | 生成可执行卡时明确填写并保存；当前没有许可或作业 |
| 输出 | 当前账户观察、部分/完整仓库列表和证据缺口；不是完整前检通过 |

### 准确来源与最小字段

| 目标 | 官方入口与请求 | 仅保存字段 | 当前能证明／不能证明 |
|---|---|---|---|
| API 路由与方法权限 | `POST /v1/roles`，无请求体，一次。[官方操作](https://docs.ozon.ru/api/seller/#operation/AccessAPI_RolesByToken) | expires_at、逐路径 methods；绑定明确 Client ID 引用和凭据别名 | 能证明该凭据可访问的方法及到期事实；不能证明 Client ID 等于 store ID，不能用角色名替代方法集合 |
| 公司币种 | `POST /v1/seller/info`，无请求体，一次。[官方操作](https://docs.ozon.ru/api/seller/#operation/SellerAPI_SellerInfo) | company.currency 与观察时间 | 只证明公司币种。它与 import.currency_code 所要求后台设置的等价关系尚未得到官方明确说明；不自动升级成后台价格币种 |
| 展示现有仓库 | `POST /v2/warehouse/list`，提议新 discovery 范围请求 `{ "limit": 20 }`，省略可选 warehouse_ids/cursor，一次。[官方操作](https://docs.ozon.ru/api/seller/#operation/WarehouseListV2) | warehouse_id、name、is_rfbs、warehouse_type、status、pause_at、has_next；不保留地址、电话、坐标和完整响应 | 官方方法列 FBS/rFBS；20 是本张草案的有限上限，非永久规则。has_next=true 时标注“仅取得部分”，不自动翻页；可见具体行只作选仓材料，未显示的仓库不能认为不存在。选仓后锁定具体行及来源，不自动确认库存/物流能力 |
| 非秘密账户路由页面 | [设置 → Seller API](https://seller.ozon.ru/app/settings/api-keys)，地址来自已获官方 Auth 原文；本轮未打开 | 获准后只读当前店铺上下文和非秘密 Client ID；不显示/生成/删除/修改 API Key，不截图保存整页 | 是已证实的 API 设置入口；**没有证据证明这里必然提供 G1 所需 store ID**，不能将此页当作已完成身份核验路径 |
| 平台稳定店铺编号/实际后台价格设置 | 尚未取得可核对的准确页面 URL 或接口字段；见下方支持问题 6、7 | 官方答复确定后，只读其明确字段及 Miska 当前上下文 | 当前不能生成可执行页面读取授权；不虚构设置地址，不让主人猜 ID 或找技术字段 |

上述操作链接的 operationId 已逐项核对归档合同；链接不得作为页面成功访问证明。官方公开帮助目录本轮重定向到 `global-help.ozon.com/en/` 后显示验证页；已停止该页面读取。公开索引定向查询未取得身份/币种正文，因此不把未读页面写成正式来源。

**账户设置页是待授权的候选来源，不包含在本卡最多三次 API 请求内；任何登录态页面读取须另行列明范围、动作数量与许可。** 本轮既未打开该账户页，也没有准备可消费的页面读取许可。

### 现有能力与必要入口工程

- 复用 `ozon-account-read-api.mjs` 的固定 endpoint 和白名单归一化、现有 SoftwareJob/admission/repository/租约、账户回执、凭据路由与 `OzonAccountReadCard.jsx`；保留旧三方法路径。
- 现有 `ozon-account-read-preparation.mjs` 必须先有真实 candidate/SKU、完整 storeRef 和 production binding；现有 warehouse 请求固定已知 warehouseId＋limit=1。因此它**尚不能**展示未选择的仓库，也不能承载没有首件 SKU 的账户准备。不能用空 ID、伪造绑定、假核验声明或合成候选绕过。
- 最小新增合同是现有账户准备的严格独立 scope 分支，保存 preparationId/revision、Miska 选择、显式账户路由和只读方法预算；允许“待核实店铺身份/未选仓库”，但永远不能满足 D 的完整绑定合同。随后在既有作业合同中明确此准备来源，而非放宽所有 candidate/SKU 字段。新增来源和 schema 分支应先版本化，不能把旧账户 job 重新标记。
- `warehouse_list` 新 discovery 归一化保留有界名称与唯一编号列表，不套用旧“仅目标仓库一行”断言；旧 targeted 模式仍严格保持原合同。选择具体仓库后从原观察行追加确认引用，不能由列表成功自动确认完整绑定。是否无需再读即可作为当前指定仓库证据，须按新来源合同和时效检查裁决，不默认重跑一次接口。
- 官方身份/价格设置的独立观察需新增到已有来源重建器；来源没确定以前不实现 selector 或 mapping。真实账户/登录态读取许可与配置中的凭据引用仍独立，当前卡片不能执行。

## 4. B 组：准确资料入口与可选现有商品样本

| 问题 | 已有准确入口 | 下一步可解除条件 |
|---|---|---|
| 在售机器状态 | `/v3/product/info/list` 的 statuses.status、status_failed、moderate_status、validation_status、status_name。[官方方法](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductInfoList) | 官方给出机器枚举/组合语义，再实现状态映射；样本中的展示词不能形成通用规则 |
| 库存可写状态 | `/v2/products/stocks` 明示 price_sent 前置；import/info 的四个值没有 price_sent。[库存方法](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductsStocksV2)、[导入结果](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetImportProductsInfo) | 官方确定可观察端点/字段及 imported 是否足够，再实现库存意图门 |
| 库存请求矛盾 | 同一库存方法的 stock schema：required 包含未定义 quant_size 和 product_id，正文却建议 offer_id/product_id 二选一 | 官方给出规范最小请求与字段说明；不发试验写请求验证 |
| 媒体返回形状与对应 | attributes 的 images 定义不一致；同份 info/list 的 images、primary_image 为字符串数组 | info/list 可作为更明确的返回形状入口，但仍须证明来源素材到 CDN 的对应及顺序；不能仅换 endpoint 就判相同 |

本轮 B 组仅做 3 次精确官方搜索，未得到结果；对应 operation 页面读取遇到重定向循环后停止。以上是归档中已知的准确操作入口，**不是本轮网页新取得的结论**。归档位于 `logs/preflight-remaining-contracts-20260908/`，原始取得方式在 acquisition-manifest.json。

若官方答复仍需真实样本对照，另立一张 **Miska 既有商品诊断只读卡**，不得复用账户三方法许可：

- 样本为 Miska 下一个已知 offer_id 与 product_id 对、一个指定仓库；若核对媒体，必须已有来源素材及原导入记录。若核对导入状态，必须已有同商品历史 task_id。样本不作为首件候选，不新建导入任务、不重新上传。
- `/v3/product/info/list` 一次：只留商品/offer 身份、状态字段、errors、主图及图片序列；`/v4/product/info/attributes` 一次：只对照身份和图片返回形状；`/v2/product/info/stocks-by-warehouse/fbs` 一次：limit=10，保存指定商品/仓库身份、free_stock/present/reserved、has_next，绝不翻页。
- 已有可靠历史 task_id 时可另列 `/v1/product/import/info` 一次；没有则零调用该方法。总计最多 3 次，含历史任务时最多 4 次。每次先保存意图，失败停止，不自动补查，脱敏观察逐条追加。
- 样本只能说明该对象在该时间的返回形状和状态值。不能证明完整枚举、price_sent 的因果/充分条件、quant_size 的写请求合法性、原素材与 CDN 内容相同，或本轮创建成功。即使样本看似成功，也不能把协议标 verified。

## 5. 官方技术支持问题草稿（未发送）

Please clarify the following Seller API contracts and provide an official field reference or corrected OpenAPI. We are not requesting a store change or sharing an API key.

1. For `/v3/product/info/list`, what are the complete machine values and combined meanings of `statuses.status`, `status_failed`, `moderate_status`, and `validation_status` for FBS/rFBS? Which exact fields distinguish processing, moderation pending, active for sale, and definitively not for sale? Is `status_name` localized display text only?
2. `/v2/products/stocks` requires the product to reach `price_sent`. Which read-only endpoint and exact response field expose that value? Does `/v1/product/import/info` returning `status=imported` guarantee this prerequisite? If not, please specify the observable transition and stopping conditions. A fixed delay is not sufficient evidence.
3. In `productv2ProductsStocksRequestStock`, `required` contains `quant_size`, but this property is undefined. Is it currently required? What are its type, units, allowed values and applicability to a normal single-piece product? The same schema requires `product_id`, while the method text recommends only one of `offer_id` and `product_id`. Please provide the normative minimal valid request using only `offer_id`, or explain why it is invalid.
4. `/v4/product/info/attributes` describes `images` as an array of strings, but the item schema refers to objects with `default`, `file_name`, and `index`. Which response shape is normative? May `/v3/product/info/list` `images` and `primary_image` be used to establish the current primary image and image order?
5. When images supplied to `/v3/product/import` are converted from source URLs to Ozon CDN URLs, which read-only response provides a stable source-to-platform media mapping and order? Please provide the complete current `/v2/product/pictures/info` contract (`ProductAPI_ProductInfoPicturesV2`) and clarify whether its fields supply this mapping. Is there a media identifier or import receipt mapping? Does `imported` guarantee image processing is complete? We understand unchanged URLs with changed content may return `skipped`; we need evidence of the actual accepted media, not URL similarity.
6. For a seller with multiple stores, which official read-only endpoint or exact account page exposes the stable store/seller identifier associated with the current Seller API credential? Please distinguish company identifier, Client-Id and store ID, and specify which identifiers are equivalent, if any. What official evidence connects the selected store context to that API client? Do not send or request API key values.
7. `/v1/seller/info` describes `company.currency` only as currency, while `/v3/product/import` `currency_code` must match the currency configured in the seller account. Are these formally the same setting for a Chinese cross-border store? Please provide the original description of `/v5/product/info/prices` item `price.currency_code` (`ItemPricev5.currency_code`) and confirm whether it proves the same backend setting. Otherwise, which read-only endpoint/field or exact account settings page exposes the import price currency? Please distinguish buyer-facing RUB from the currency used to write seller prices.

Only the bridge should arrange submission through an authorized official support channel. This document has not been sent to Ozon; no support ticket or outbound message to a third party exists.

## 6. 验收清单与本轮实际动作

后续施工的有效断言：明确 pending 持久等待；failed/skipped 保留不同结果；错误身份/损坏/超时仍 unknown；import 全程最多一次；price_sent 未证明零库存意图/请求；查询预算耗尽零额外请求；查询前后重启及两 worker 竞争不重复领取/写入；原 PA/revision/路由变化停止；旧 unknown 不自动恢复；D 未完成无 ProductionRecord/无正式 E 验证；真实完成后唯一 E；账户准备不创建假 SKU；新发现仓库许可不复用旧 targeted 许可。

16:21 草案阶段仅只读核查代码/已存官方合同、有限访问官方公开文档、形成草案与交接，当时没有改可执行代码、测试或运行包。随后批准范围内已开始实施；最终命令、日志与源码冻结记录见 HANDOFF 当前入口，前一交付的 72/72、8/8、81 模块构建只证明原冻结工程。真实账户/凭据读取、真实商品请求、付费、公开素材、平台写入、安装及正式服务重启仍未执行。

## 7. 三条固定第三方线索与准确后续资料

核查记录：`logs/preflight-async-contracts-20260908/third-party-findings.json`。只读三个固定 commit，无安装或执行第三方代码。公开官方 Swagger 再次返回带验证标记的 HTTP 307，未跟随挑战，没有新官方正文。

- SDK 的 `prices/types.go` 注释把 `price.currency_code` 与后台设置联系起来。官方结构已证实字段存在；尚需上述第7问的原始字段说明及当前账户适用证据。[固定实现](https://github.com/QuoVadis86/go-ozon-sdk/blob/c73b356cfc49c220de1b9c6ebd759b16443984ba/prices/types.go)
- 文档镜像把 `SIZE_REQUIRED_FOR_NOT_UNIQUE_OFFER_ID` 与重复货号的 `quant_size` 联系起来，普通商品为1、quant至少2。尚需官方总说明原文解释适用性；不能推出一律必填或一律省略，也未证明 `statuses.status` 就是 `price_sent` 的载体。[固定文档](https://github.com/etozhearut/ozon-seller-api/blob/3470fa55d706359779620fbeee79993694d2eacd/docs/00-overview.md)
- 已确认第三方调用 `/v2/product/pictures/info` 及准确 operationId。当前归档没有其完整方法/schema，不能证明来源图与平台图稳定对应。[固定实现](https://github.com/a-ulianov/OzonAPI/blob/ad28b376eb8ea84da77a113d4d3047dfc8e35b45/src/ozonapi/seller/methods/products/product_pictures_info.py)

这些线索均未关闭官方事实缺口，未生成真实库存前提策略或在售映射，七问仍未发送。

实际文档校验：`git diff --check` 通过；使用本机已配置 Node 以 `--input-type=module` 执行只读检查，将本文 6 个 operation 链接逐项对照两份已存 OpenAPI，6/6 匹配，并确认 Miska、不可执行、未发送边界存在。两项检查均退出0，无 error/warning。架构与安全工位独立复核草案，确认 E只观察、D续写待明确、准备范围不冒充SKU和旧许可；此审查没有运行测试。
