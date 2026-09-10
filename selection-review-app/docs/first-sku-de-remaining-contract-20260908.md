# 首件 D/E 剩余官方合同核验

核验日期：2026-09-08。结论：已保存的官方材料可以证明库存前置要求和部分字段结构，但不足以关闭 `price_sent` 机器字段映射、普通商品 `quant_size` 请求规则、正向在售状态及转换后图片对应。此次不改源码、不产生实际读取或写入，不阻止其余本地工程准备继续。

## 来源与本轮边界

- 官方原始来源：[Seller API OpenAPI](https://docs.ozon.ru/api/seller/swagger.json?1788843872856)，此前取得时间 `2026-09-08T05:04:32.856Z`，HTTP 200。当前核对载体是 `logs/preflight-remaining-contracts-20260908/acquisition-manifest.json` 和对应归档。
- `official-de-structural-openapi.json` 是递归删除 description/example 的结构投影，**不能据其缺少说明断言完整官方文档没有说明**。`official-field-semantics.json`、`official-auth-import-semantics.json` 与精确仓库合同保存了选定原文。
- 已阅读历史库存、销售、媒体查证记录 `logs/preflight-three-facts-20260908/*findings.json`，以及 `docs/ozon-miska-preflight-async-20260908.md`。历史同一 docs 操作页出现 Redirect loop，swagger 读取超时；此次不重复这些失败读取，不跟随验证或读取登录态。
- 本轮 web 查询 4/4，均为精确官方域名查询，工具合并返回 `Empty search results`：`site:docs.ozon.ru "statuses" "price_sent"`；`site:docs.ozon.ru "SIZE_REQUIRED_FOR_NOT_UNIQUE_OFFER_ID" "quant_size"`；`site:docs.ozon.ru "ProductInfoPicturesV2" "original"`；`site:docs.ozon.ru "status" "sale" "GetProductInfoListResponseStatuses"`。
- 本轮官方页面读取 0/4；没有找到新的精确入口，不为消耗预算重复旧页面。无结果只说明这些查询未取得正文，**不是官方不存在该合同，也不是所有公开获取路径已穷尽**。
- 真实商品、Seller API、账户、凭据、付费、上传、客服发送、部署均为 0；源码与封存包未改。仅新增本文，未运行测试。

## 1. 库存前置 `price_sent` 与回读机器字段

**官方已证：** [库存方法 ProductsStocksV2](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductsStocksV2) 的已存原文 `official-field-semantics.json#/stockUpdate` 明确要求商品状态变为 `price_sent` 后才能设置库存，并要求先读指定仓库预留量。对应只读方法为 `/v2/product/info/stocks-by-warehouse/fbs`。

**未证：** `/v3/product/info/list` 的 `items[].statuses.status` 是否承载这个值，以及哪些后续机器值仍满足库存前提。结构投影中 `GetProductInfoListResponseStatuses` 的 status、moderate_status、validation_status、status_failed 均为 string，没有可用枚举语义。import/info 的 pending/imported/failed/skipped 是导入操作状态，不能替代库存前提。

**推断（inference，不能放行）：** 库存正文出现的状态名与 info/list 的机器 status 字段很可能有关，但仅凭名字无法建立规范映射。`imported`、`is_created=true`、无错误或显示文案均不构成替代证明。

**软件停止点：** `lib/ozon-seller-api-de-adapter.mjs:538` 的 observePriceSent 需要有效 prerequisitePolicy；`:585` 起的库存续行还要求同 policy、同 scope 的 priceSent verified 和预留量观察。未核实来源时不得填 acceptedValues 使之生效。`lib/ozon-inventory-prerequisite-policy.mjs` 已支持版本化字段映射，但校验通过只是结构有效，**不是官方语义成立**。真实策略尚无可核实来源时保留缺口，库存 not_sent，不重发 import。

**最小官方证据请求（草稿，未发送）：** 提供当前 `/v3/product/info/list` 的 `GetProductInfoListResponseStatuses` 未删描述定义，并明确 `/v2/products/stocks` 提及的 price_sent 对应哪个 JSON 字段；列出允许库存写入的精确机器值，说明是否只接受 price_sent 本身。只需相关字段原文或官方版本化答复，不需店铺样本、密钥或完整站点导出。若实际字段不同，应局部修订策略版本，不能硬塞现有 statuses.status 合同。

## 2. 普通非套装商品的 `quant_size`

**官方已证的矛盾：** `official-de-structural-openapi.json#/components/schemas/productv2ProductsStocksRequestStock` 的 required 为 product_id、quant_size、stock、warehouse_id，但 properties 没有 quant_size。库存正文又要求 offer_id/product_id 二选一，并说明同时传时 offer_id 优先。因此既不能从 required 推导完整可用请求，也不能从缺 properties 推导允许省略。

**仅第三方线索：** 已存固定版本镜像提及 `SIZE_REQUIRED_FOR_NOT_UNIQUE_OFFER_ID`，把普通商品量值 1 与 quant 至少 2 区分；另一个 SDK 的库存模型未定义 quant_size。准确 commit 和采用/拒绝理由见 `logs/preflight-async-contracts-20260908/third-party-findings.json`。此次未重新读取，二者均不代替当前官方合同。

**推断（inference，不能放行）：** quant_size 可能用于普通商品与同货号套装的区分；这不能证明精确 product_id 可省略，也不能证明所有普通商品必须或允许传 1。项目单 SKU、一件起订不是平台 quant 身份证据。

**软件停止点：** 同一 prerequisitePolicy 明确保存 identityField 和 quantSize；null 代表已有正式依据允许省略，不代表缺省成功。adapter `:613` 仅按政策构造请求。真实来源缺失不能选择 null 或 1 试写，库存仍 not_sent。

**最小官方证据请求（草稿，未发送）：** 提供 ProductsStocksV2 普通非套装商品的规范最小请求，明确 quant_size 的类型、是否必填、普通商品值、精确 product_id 与 offer_id 两种身份下的差异，以及 SIZE_REQUIRED_FOR_NOT_UNIQUE_OFFER_ID 的适用条件。请求修正或解释 required/properties/正文矛盾；无需真实写库存实验。

## 3. 正向在售与转换后图片对应

### 在售

**已证结构：** [info/list 官方操作入口](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductInfoList) 对应归档 statuses 为字符串字段，visibility_details 包含 has_price、has_stock。另一个 productList 方法的已存正文说明按精确 offer_id/product_id 查询会忽略可见性过滤；不能把其他方法的 VISIBLE/IN_SALE 字样移植成当前商品在售证明。

**未证规则：** status 的哪些机器值或字段组合足以证明当前可售。price_sent 是库存前提，不等于买家可购买；status_name 是展示词，不能猜测语言或状态映射。

**软件停止点：** adapter `:330` 的 saleStatus 只识别明确归档，其余 unknown；`lib/e-stage-readback.mjs:177` 起的最终验收不接受未知在售，不能生成已验证成功结果。

**最小官方证据请求（草稿，未发送）：** 在同一份 statuses 字段原文中补充精确在售机器枚举/组合及适用条件，区分已创建、已审核、价格已处理、已上架、可购买。若需要不同官方只读方法，先提供该单一方法和完整筛选/分页语义，再单独限定读取范围，不把旧许可扩用。

### 转换后 CDN 图片

**已证结构：** info/list 的 images、primary_image、color_image 为字符串数组。attributes 的 `GetProductAttributesResponseImage` 有 default、file_name、index，但外围 images 类型说明存在不一致。已存字段没有源上传 URL 与转换后 CDN URL 的逐项配对定义；导入成功也没有已存的媒体处理终态保证。

**仅第三方入口线索：** 固定 a-ulianov/OzonAPI 实现调用 `/v2/product/pictures/info`，提及主图、颜色图、360 图和加载错误；它没有定义响应字段，不能证明身份映射。准确记录见 `logs/preflight-three-facts-20260908/media-correspondence-findings.json`。[对应官方操作入口](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductInfoPicturesV2) 此前重定向失败，不把链接存在写成正文取得。

**软件停止点：** adapter `:692` 保持有限 attributes 观察；`lib/e-stage-readback.mjs:125` 起核对素材集合、原提交 URL、顺序和首图。URL 被转换而没有正式对应时为 media_identity_unverified；不能因数量相同、相似文件名、CDN 同域或肉眼相似放行。原 URL 完全相同的现有严格比较也不构成转换后字节等价证明。

**最小官方证据请求（草稿，未发送）：** 提供 ProductInfoPicturesV2 单个 operation 的完整请求/响应引用闭包和图片字段说明，明确有无源 URL/稳定导入素材引用 → 平台图片 ID/URL 的对应、顺序/主图及逐图处理错误/终态。若只有 URL 数组，请指明正式支持这种对应的读取方法；若平台不提供，该能力缺口应如实保存，不能杜撰 DTO。真实商品样本最多验证具体形状，不能单独建立稳定身份规则；本轮不申请或执行样本读取。

## 可继续工程与收口判据

现有单次 import、有限只读观察、原 D 剩余库存、独立 E 及不可重放路径继续准备，不需要再建队列或引入账户身份体系。此次没有足够新依据支持放宽任何生产判据。

后续仅需两类公开技术材料即可判断是否有最小局部补丁：一份 info/list 状态定义和库存 quant_size 纠正文档；一份 pictures/info 的完整媒体语义。取得后先核对现有政策/观察 DTO 能否准确表达，再补定向合同与边界测试；真实来源、当前商品观察和生产授权仍分别核验。技术文档获得不等于平台验证完成，也不自动授予请求权限。
