// 1688 商品页内联脚本样本：取自 2026-09-12 主人 Chrome 上的真实页面
// https://detail.1688.com/offer/943009939489.html ，已脱敏并裁剪。
//
// 脱敏：买家/卖家登录名、会员号、用户号、公司名、收货地址与地址ID、发货地、traceId、
// 图片路径全部换成明显的占位值；24 个 SKU 裁剪到 6 个。
// 保留的结构特征（回归测试就靠这些）：
//   1. window.context=(function(b,d){…})(window.contextPath, {"result":…}) 这层立即执行函数外壳；
//      商品数据是第二个实参，起点 {"result":，而且这段 <script> 没有 type 属性。
//   2. skuWeight 使用无引号的数字键（{5846845077736:0.1030,…}）——整段因此不是合法 JSON。
//   3. \uXXXX 转义与字符串内的 \" 转义（括号平衡扫描必须识别）。
//   4. result.global.globalData.model 路径，以及搬到 result.data.Root.fields.dataJson 的
//      offerBaseInfo / skuModel / orderParamModel / tempModel 旧结构。
//   5. 中文标题、"price":"20.50" 这类字符串价格、specAttrs 里的 &gt; 实体、$ref 引用节点。
// 真实页面的 offerId、标题、价格、重量原样保留：它们是公开商品信息，也是回归断言的依据。

export const REDACTED_1688_OFFER_ID = "943009939489";
export const REDACTED_1688_SOURCE_URL = "https://detail.1688.com/offer/943009939489.html";

/** 页面上那段普通内联 <script> 的正文（无 type 属性）。 */
export const REDACTED_1688_INLINE_SCRIPT = [
  `
window.contextPath = "/default";
`,
  `window.context=(function(b,d){var c=d.module||{};var e={};for(var a in c){if(typeof c[a]==="string"){e[a]=c[a]}}Object.assign(e,c[b]||{});Object.assign(d,{module:e});return d})(window.contextPath,`,
  `{"result":{"data":{`,
  `"Root":{"fields":{"dataJson":{`,
  `"offerBaseInfo":{"buyerLoginId":"\\u4E70\\u5BB6\\u5360\\u4F4D","buyerMemberId":"b2b-placeholder-buyer","buyerUserId":1000000000001,"catId":121778003,"offerId":943009939489,`,
  `"sellerLoginId":"\\u5E97\\u94FA\\u5360\\u4F4D","sellerMemberId":"b2b-placeholder-seller","sellerUserId":1000000000002,"sellerWinportUrl":"https://shopmp.1688.com","tradeTemplateId":"[0]"},`,
  `"orderParamModel":{"orderParam":{"beginNum":1,"canBookedAmount":11521,"flow":"general","saledCount":392,"skuParam":{"skuPriceType":"skuPrice","skuRangePrices":[{"price":"20.50","beginAmount":"1"},{"price":"41.50","beginAmount":"1"}]},"supportOnePieceRetail":false}},`,
  `"skuModel":{"skuPriceScale":"20.50-41.50","skuProps":[{"fid":3216,"prop":"颜色","value":[{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"黑色"},{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"米色"},{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"黄色"}]},{"fid":450,"prop":"尺码","value":[{"name":"XL（背长35cm）"},{"name":"2XL（背长40cm）"},{"name":"3XL（背长45cm）"},{"name":"4XL（背长50cm）"},{"name":"5XL（背长55cm）"},{"name":"6XL（背长60cm）"},{"name":"7XL（背长65cm）"},{"name":"8XL（背长72cm）"}]}],"skuInfoMap":{"黄色&gt;XL（背长35cm）":{"specId":"c1cfc7e185779cd5b5a62cc5d8fbcb1d","saleCount":0,"discountPrice":"20.50","canBookCount":494,"specAttrs":"黄色&gt;XL（背长35cm）","price":"20.50","priceAmount":1,"skuId":5846845077736,"isPromotionSku":false},"黄色&gt;2XL（背长40cm）":{"specId":"29becccac1ddc77bd5023e10550a832b","saleCount":0,"discountPrice":"23.50","canBookCount":482,"specAttrs":"黄色&gt;2XL（背长40cm）","price":"23.50","priceAmount":1,"skuId":5846845077737,"isPromotionSku":false},"黑色&gt;3XL（背长45cm）":{"specId":"7f41dc699d27914d6995d9b6d00fec5c","saleCount":0,"discountPrice":"26.50","canBookCount":465,"specAttrs":"黑色&gt;3XL（背长45cm）","price":"26.50","priceAmount":1,"skuId":5846845077722,"isPromotionSku":false},"黑色&gt;2XL（背长40cm）":{"specId":"3b92529ea783f9359fbd6932431e48ef","saleCount":0,"discountPrice":"23.50","canBookCount":492,"specAttrs":"黑色&gt;2XL（背长40cm）","price":"23.50","priceAmount":1,"skuId":5846845077721,"isPromotionSku":false},"黄色&gt;3XL（背长45cm）":{"specId":"0a88ba05a92dbe0b28131b4c0647d331","saleCount":0,"discountPrice":"26.50","canBookCount":482,"specAttrs":"黄色&gt;3XL（背长45cm）","price":"26.50","priceAmount":1,"skuId":5846845077738,"isPromotionSku":false},"黑色&gt;XL（背长35cm）":{"specId":"f1ed4c11f38d334978b1d55866a203dd","saleCount":0,"discountPrice":"20.50","canBookCount":491,"specAttrs":"黑色&gt;XL（背长35cm）","price":"20.50","priceAmount":1,"skuId":5846845077720,"isPromotionSku":false}}},`,
  `"tempModel":{"companyName":"\\u5E97\\u94FA\\u516C\\u53F8\\u5360\\u4F4D\\u6709\\u9650\\u516C\\u53F8","offerId":943009939489,"offerTitle":"跨境中大型犬边牧拉布拉多柴犬四脚衣冲锋衣防水防风狗狗衣服雨衣","offerUnit":"\\u4EF6","saledCount":392,"sellerLoginId":"\\u5E97\\u94FA\\u5360\\u4F4D"}`,
  `}},"id":"Root","type":"od_root"},`,
  `"gallery":{"fields":{"offerId":943009939489,"subject":"跨境中大型犬边牧拉布拉多柴犬四脚衣冲锋衣防水防风狗狗衣服雨衣"},"id":"gallery","type":"od_picture_gallery"},`,
  `"productAttributes":{"fields":{"uiType":"od_product_attributes","label":"\\u5546\\u54C1\\u53C2\\u6570"},"id":"productAttributes","meta":{"errorMessage":"placeholder composer error"},"position":"body","tag":"productAttributes","type":"od_product_attributes"},`,
  `"productPackInfo":{"fields":{"unitWeight":0,"uiType":"od_product_pack_info","label":"\\u5546\\u54C1\\u4EF6\\u91CD\\u5C3A","pieceWeightScale":{"pieceWeightScaleInfo":[{"sku2":"XL（背长35cm）","volume":440,"sku1":"黑色","length":22,"width":20,"weight":103,"skuId":5846845077720,"height":1},{"sku2":"2XL（背长40cm）","volume":440,"sku1":"黑色","length":22,"width":20,"weight":120,"skuId":5846845077721,"height":1},{"sku2":"3XL（背长45cm）","volume":660,"sku1":"黑色","length":22,"width":20,"weight":133,"skuId":5846845077722,"height":1.5},{"sku2":"XL（背长35cm）","volume":440,"sku1":"黄色","length":22,"width":20,"weight":103,"skuId":5846845077736,"height":1},{"sku2":"2XL（背长40cm）","volume":440,"sku1":"黄色","length":22,"width":20,"weight":120,"skuId":5846845077737,"height":1},{"sku2":"3XL（背长45cm）","volume":660,"sku1":"黄色","length":22,"width":20,"weight":133,"skuId":5846845077738,"height":1.5}]}},"id":"productPackInfo","type":"od_product_pack_info"},`,
  `"shippingServices":{"fields":{"freightInfo":{"$ref":"$.result.global.globalData.model.detailDescription.freightInfo"},"skuWeight":{"$ref":"$.result.data.shippingServices.fields.freightInfo.skuWeight"}},"id":"shippingServices","type":"od_shipping_services"},`,
  `"skuSelection":{"fields":{"uiType":"od_sku_selection","label":"\\u89C4\\u683C\\u9009\\u62E9\\u5668"},"id":"skuSelection","meta":{},"position":"body","tag":"skuSelection","type":"od_sku_selection"}`,
  `},"endpoint":{"mode":"PC","osVersion":"9.9.9","protocolVersion":"3.0","standard":true,"ultronage":true},"global":{"globalData":{`,
  `"traceId":"00000000000000000000000000trace",`,
  `"parametersMap":{"offerId":"943009939489"},`,
  `"model":{`,
  `"buyerModel":{"buyerLevel":"L4","loginId":"\\u4E70\\u5BB6\\u5360\\u4F4D","mainAccountUserId":1000000000001,"memberId":"b2b-placeholder-buyer",`,
  `"memberRightModel":{"rightName":"\\u5360\\u4F4D\\u6743\\u76CA","rightQA":"[{\\"question\\":\\"\\u5360\\u4F4D\\u95EE\\u9898\\uFF1F\\",\\"answer\\":\\"\\u5360\\u4F4D\\u7B54\\u6848\\u3002\\"}]"}},`,
  `"channelBizType":"normal",`,
  `"detailDescription":{"freightInfo":{"deliveryFee":"TEMPLATED","location":"\\u5730\\u533A\\u5360\\u4F4D","locationCode":"000000000","receiveAddressId":"0000000000","recieveAddress":"\\u6536\\u8D27\\u5730\\u5740\\u5360\\u4F4D","recieveAddressCode":"000000","receiveAddressRegion":"CN","receiveAddressAreaCodeList":["000000"],"totalCost":3.5,"unitWeight":0,"logisticsText":"\\u7269\\u6D41\\u5360\\u4F4D","skuWeight":{5846845077736:0.1030,5846845077737:0.1200,5846845077738:0.1330,5846845077720:0.1030,5846845077721:0.1200,5846845077722:0.1330,5846845077799:0.5000}}},`,
  `"offerDetail":{"offerId":943009939489,"status":"PUBLISHED","offerType":"fashion","subject":"跨境中大型犬边牧拉布拉多柴犬四脚衣冲锋衣防水防风狗狗衣服雨衣",`,
  `"featureAttributes":[{"fid":287,"isSpecial":false,"itemCpvDecision":false,"lectotype":false,"name":"材质","outputType":0,"value":"涤纶","values":["涤纶"],"vids":[28355]},{"fid":2176,"isSpecial":false,"itemCpvDecision":false,"lectotype":false,"name":"品牌","outputType":0,"value":"无","values":["无"],"vids":[10010]},{"fid":364,"isSpecial":false,"itemCpvDecision":false,"lectotype":false,"name":"产品类别","outputType":0,"value":"雨衣","values":["雨衣"],"vids":[3227355]},{"fid":973,"isSpecial":false,"itemCpvDecision":false,"lectotype":false,"name":"风格","outputType":0,"value":"休闲风","values":["休闲风"],"vids":[4025977]}],`,
  `"imageList":[{"fullPathImageURI":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","imageURI":"img/ibank/PLACEHOLDER-0-cib.jpg"}],`,
  `"skuProps":[{"fid":3216,"prop":"颜色","value":[{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"黑色"},{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"米色"},{"imageUrl":"https://cbu01.alicdn.com/img/ibank/PLACEHOLDER-0-cib.jpg","name":"黄色"}]},{"fid":450,"prop":"尺码","value":[{"name":"XL（背长35cm）"},{"name":"2XL（背长40cm）"},{"name":"3XL（背长45cm）"},{"name":"4XL（背长50cm）"},{"name":"5XL（背长55cm）"},{"name":"6XL（背长60cm）"},{"name":"7XL（背长65cm）"},{"name":"8XL（背长72cm）"}]}]},`,
  `"sellerModel":{"companyName":"\\u5E97\\u94FA\\u516C\\u53F8\\u5360\\u4F4D\\u6709\\u9650\\u516C\\u53F8","loginId":"\\u5E97\\u94FA\\u5360\\u4F4D","memberId":"b2b-placeholder-seller","userId":1000000000002,"sellerIdentity":"cht"},`,
  `"tradeModel":{"beginAmount":1,"canBookedAmount":11521,"maxPrice":"41.50","minPrice":"20.50","offerId":943009939489,`,
  `"offerPriceModel":{"currentPrices":[{"beginAmount":1,"price":"20.50"},{"beginAmount":1,"price":"41.50"}],"onePiecePriceExp":false,"priceDisplayType":"skuPrice"},`,
  `"priceDisplay":"20.50-41.50","saleCount":392,"skuMap":[{"canBookCount":494,"discountPrice":"20.50","price":"20.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077736,"specAttrs":"黄色&gt;XL（背长35cm）","specId":"c1cfc7e185779cd5b5a62cc5d8fbcb1d"},{"canBookCount":482,"discountPrice":"23.50","price":"23.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077737,"specAttrs":"黄色&gt;2XL（背长40cm）","specId":"29becccac1ddc77bd5023e10550a832b"},{"canBookCount":482,"discountPrice":"26.50","price":"26.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077738,"specAttrs":"黄色&gt;3XL（背长45cm）","specId":"0a88ba05a92dbe0b28131b4c0647d331"},{"canBookCount":491,"discountPrice":"20.50","price":"20.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077720,"specAttrs":"黑色&gt;XL（背长35cm）","specId":"f1ed4c11f38d334978b1d55866a203dd"},{"canBookCount":492,"discountPrice":"23.50","price":"23.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077721,"specAttrs":"黑色&gt;2XL（背长40cm）","specId":"3b92529ea783f9359fbd6932431e48ef"},{"canBookCount":465,"discountPrice":"26.50","price":"26.50","priceAmount":1,"promotionSku":false,"saleCount":0,"skuId":5846845077722,"specAttrs":"黑色&gt;3XL（背长45cm）","specId":"7f41dc699d27914d6995d9b6d00fec5c"}],"skuTradeSupported":true,"unit":"\\u4EF6"}`,
  `}`,
  `}},"hierarchy":{"root":"Root"},"reload":false}});`,
].join("");
