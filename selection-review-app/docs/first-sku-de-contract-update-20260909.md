# 首件 D/E 官方合同补核（2026-09-09）

结论：本轮未取得新的官方机器语义，不能填入猜测策略放行库存或把 E 标成成功。已有工程的单次导入、持久等待、有限观察和禁止重放仍可继续准备；未修改源码、封存包或业务数据。

## 实际获取与来源

复核 [原核验报告](first-sku-de-remaining-contract-20260908.md) 和 `logs/preflight-remaining-contracts-20260908` 原始字段切片。来源为 [官方 Seller API OpenAPI](https://docs.ozon.ru/api/seller/swagger.json?1788843872856)，归档记录取得于 2026-09-08T05:04:32.856Z、HTTP 200。本轮没有重新取得该文档，结构投影删除过 description/example，不能据此断言完整官方文档没有说明。

本轮四次精确官方域检索全部返回 Empty search results：`site:docs.ozon.ru/global/products "price_sent"`、`site:docs.ozon.ru "quant_size" "1"`、`site:docs.ozon.ru "IN_SALE" "VISIBLE"`、`site:docs.ozon.ru "pictures" "original" "url"`。官方检索 **4/4**，公开技术页面读取 **0/4**。未找到新精确入口，不重复昨日已确认的操作页重定向环或 swagger 超时路径；无结果不表示官方不存在资料或全部路径已穷尽。核验记录时间：2026-09-09T01:36:52Z。完整结构化结论见 `logs/first-sku-resumption-20260909/de-findings.json`。

## 采用与拒绝

| 主题 | 可采用的官方事实 | 仍缺的最小技术定义 |
| --- | --- | --- |
| price_sent | 库存正文要求到达此状态，并先读精确仓库预留量 | 对应哪个 JSON 字段；哪些后续机器值也满足前提 |
| quant_size | required 包含该字段，properties 却缺失；正文要求 offer_id/product_id 二选一 | 类型、必填性、普通非套装值，以及两种商品身份下的差异 |
| 在售 | productList 精确 ID 查询会忽略可见性限制；导入状态不等于可购买 | 原始 statuses 字段语义或明确可购买规则与适用读取方法 |
| 转换后媒体 | 归档包含 default/file_name/index 与图片 URL 数组 | 源素材引用到平台图片的对应、首图/顺序和处理终态；需 pictures/info 完整引用闭包 |

分别依据官方归档 `official-field-semantics.json#/stockUpdate`、`#/productList`，`official-de-structural-openapi.json#/components/schemas/productv2ProductsStocksRequestStock`、`GetProductInfoListResponseStatuses`、`GetProductAttributesResponseImage`，以及 `official-auth-import-semantics.json`。对应官方入口：[库存](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductsStocksV2)、[商品信息](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductInfoList)、[图片信息](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductInfoPicturesV2)；后者链接仅是精确获取目标，不表示本轮正文已取得。

拒绝：imported/price_sent 单独等于在售；中文/俄文展示名推机器状态；has_price 与 has_stock 组合自行充当可购买；VISIBLE 精确 ID 查询证明可见或可售；第三方 SDK 推定 quant_size=1/省略；同数量、文件名、CDN 域名或肉眼相似证明转换图片身份。本轮第三方事实采用数为零。

## 最小下一步与工程边界

技术获取只需要两组官方原文：①未删描述的 statuses 定义及库存 quant_size 修正说明；② ProductInfoPicturesV2 的完整 operation/schema 引用闭包和对应语义。无需主人猜字段，也无需真实商品、账户样本或写库存试错。取得后才能判断是否局部更新现有版本化策略/观察 DTO，并补精确商品身份、错误机器值、分页不完整、素材乱序与首图错误回归。

当前 adapter 已有显式策略控制 priceSent 和 quantSize，不能用结构校验通过替代来源核实。继续保持缺前提零库存意图、已接受 import 不重发、在售未知不通过 E、转换媒体未证明时报 media_identity_unverified；不新建调度器、不减少验收判据。本轮真实 Seller API、凭据、用户 Chrome、外部写入、部署和测试执行均为零。
