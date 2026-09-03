/**
 * 全店能力地图是代码事实的只读注册表，不是候选商品状态，也不是店铺事实。
 *
 * 维护规则：每次改变一个模块的真实接线、UI入口、测试或已知断点时，必须在同一次
 * 变更中更新本文件和 tests/three-store-map.test.mjs。没有证据时保持“未接通”或“未知”，
 * 不能因为存在文件、按钮或授权就提升为闭环完成。
 */

export const THREE_STORE_MAP_VERSION = "three-store-map-v1";

export const THREE_STORE_MAP_EXECUTION_STATES = Object.freeze({
  connected: Object.freeze({
    label: "已写死且真实接通",
    shortLabel: "本地软件链已接通",
    tone: "connected",
    description: "代码、今日选品评审入口和本地服务接线都存在；这不等于当前店铺已经写入或全链路已经跑完。"
  }),
  code_not_connected: Object.freeze({
    label: "已有代码但未接通",
    shortLabel: "代码未接入正常链路",
    tone: "not-connected",
    description: "有领域代码或适配器，但缺少正常运行所需的受控入口、持续作业、独立回读或真实连接。"
  }),
  manual_or_codex_experiment: Object.freeze({
    label: "人工 / Codex 协作实验",
    shortLabel: "实验或异常维护",
    tone: "experiment",
    description: "只能作为人类判断、本机受控采集或真正异常的维护支路；不是正常商品的主流程。"
  }),
  not_implemented: Object.freeze({
    label: "尚未实现",
    shortLabel: "尚未有正式能力",
    tone: "not-implemented",
    description: "没有可用于正常业务的实现或接线，不能由页面、授权或测试名称补成已完成。"
  })
});

const TEST_EVIDENCE_NOTE = "列出的是相关定向测试文件；地图本身不读取测试运行记录，不能把“有测试”显示成“本轮已通过”。";

function ref(path, anchor, label = anchor) {
  return Object.freeze({ path, anchor, label });
}

function area(id, title, summary) {
  return Object.freeze({ id, title, summary });
}

function module(definition) {
  return Object.freeze({
    ...definition,
    inputs: Object.freeze(definition.inputs),
    outputs: Object.freeze(definition.outputs),
    upstream: Object.freeze(definition.upstream),
    downstream: Object.freeze(definition.downstream),
    codeRefs: Object.freeze(definition.codeRefs),
    uiRefs: Object.freeze(definition.uiRefs),
    testEvidence: Object.freeze({
      kind: "test_files_present",
      note: TEST_EVIDENCE_NOTE,
      refs: Object.freeze(definition.testEvidence.refs)
    }),
    connection: Object.freeze({ ...definition.connection })
  });
}

export const THREE_STORE_MAP_AREAS = Object.freeze([
  area("1", "运行底座与状态保存", "谁保存状态、修订号和本地运行边界。"),
  area("2", "A：候选、市场与供应确认", "把一个方向和一个准确供应 SKU 变成可审查的输入。"),
  area("3", "B：利润与自动 C1 交接", "用冻结输入做具体 SKU 利润判断，并把通过项交给 C1。"),
  area("4", "C1：商品事实、Schema、SEO 与关键词", "准备上架前的商品事实和文字证据。"),
  area("5", "C2：最终素材与最终方案", "把参考、草稿和可上传素材分开，并锁定最终方案。"),
  area("6", "D：生产授权、素材与平台写入", "只在精确授权后准备实际写店；当前写店链路仍不完整。"),
  area("7", "E：独立平台回读", "从平台重新确认写入后的真实商品状态。"),
  area("8", "异常维护与多人化边界", "让异常走维护支路，不把 Codex 变成正常流水线。")
]);

export const THREE_STORE_MAP_REGISTRY = Object.freeze([
  module({
    id: "1.1",
    areaId: "1",
    title: "保存候选、修订号和本地状态",
    plainDescription: "把候选、输入版本和处理结果保存到今日选品评审使用的业务状态中；页面刷新后仍能重新读到同一份本地状态。",
    inputs: ["主人或软件提交的候选资料", "当前 dataRevision"],
    outputs: ["带修订号的候选记录", "今日选品评审可读取的状态视图"],
    upstream: [],
    downstream: ["2.1"],
    executionStatus: "connected",
    statusReason: "今日选品评审、服务端 Repository 边界和 /api/state 已接通；当前仍是本地 JSON 单进程开发适配器，不是多人中央服务。",
    connection: { codePresent: true, uiConnected: true, executionConnected: true },
    actualChain: "今日选品评审 → 候选 API → BusinessStateRepository → /api/state → 今日选品评审",
    ownerAction: "新增或修正候选资料时由主人提交；普通页面阅读不会改变状态。",
    codexRule: "不需要 Codex；正常状态保存不能依赖 Codex 会话。",
    failureAndUnknown: "读取或保存失败必须显示技术错误；不能把失败显示成空候选或保存成功。",
    breakpoint: "JSON 适配器仅支持单进程，不具备多人并发与中央恢复能力。",
    nextStep: "保留当前 Repository 边界，后续用中央数据库和租约替换本地适配器。",
    codeRefs: [
      ref("server.mjs", "createConfiguredBusinessStateRepository", "服务端状态 Repository"),
      ref("lib/business-state-repository.mjs", "createConfiguredBusinessStateRepository", "状态保存边界"),
      ref("lib/multi-user-central-runtime.mjs", "assertRuntimeBoundaries", "本地与中央运行边界")
    ],
    uiRefs: [ref("src/App.jsx", "function App", "今日选品评审读取共享状态")],
    testEvidence: { refs: [
      ref("tests/business-state-repository.test.mjs", "test(", "Repository 边界测试"),
      ref("tests/multi-user-central-runtime.test.mjs", "test(", "本地/中央运行边界测试")
    ] }
  }),
  module({
    id: "2.1",
    areaId: "2",
    title: "确认一个可计算的供应方案",
    plainDescription: "把销售快照、精确 1688 链接、供应 SKU、采购成本、重量和尺寸放进同一张主人确认卡；没有这些输入就不能进入利润计算。",
    inputs: ["已保存的销售快照", "供应链接、SKU、价格、运费、重量、尺寸", "主人确认"],
    outputs: ["已确认供应 SKU", "冻结的 A 阶段证据和生命周期包"],
    upstream: ["1.1"],
    downstream: ["2.2", "3.1"],
    executionStatus: "connected",
    statusReason: "主人确认卡、服务端校验和 A→B/C1 原子交接均有代码与 UI 接线；这里只说明本地软件链，不代表外部证据永远可取。",
    connection: { codePresent: true, uiConnected: true, executionConnected: true },
    actualChain: "销售/供应证据 → A 确认卡 → 服务端校验 → SkuLifecyclePackage",
    ownerAction: "必须由主人确认准确供应 SKU；软件不能自行替换供应商或 SKU。",
    codexRule: "正常确认后由软件继续，Codex 不能成为 A 阶段的队列消费者。",
    failureAndUnknown: "证据缺失、冲突或采集失败会停在当前 SKU，不能冒充零结果、利润通过或已上架。",
    breakpoint: "外部销售和供应证据的取得仍受本机受控采集能力影响。",
    nextStep: "把每个外部证据来源的健康、失败层和回执持续写入同一数据包。",
    codeRefs: [
      ref("lib/real-a-confirmation-card.mjs", "buildRealAConfirmationCard", "A 阶段主人确认卡"),
      ref("lib/real-a-b-evidence-orchestration.mjs", "runRealAConfirmationWithSystemEvidence", "A 阶段证据编排"),
      ref("lib/real-a-b-c1-flow.mjs", "runRealAConfirmationToBAndC1", "确认后的生命周期交接")
    ],
    uiRefs: [ref("src/components/RealAConfirmationCard.jsx", "RealAConfirmationCard", "供应方案确认界面")],
    testEvidence: { refs: [
      ref("tests/real-a-confirmation-card.test.mjs", "test(", "确认卡规则测试"),
      ref("tests/real-a-b-c1-flow.test.mjs", "test(", "A→B→C1 交接测试")
    ] }
  }),
  module({
    id: "2.2",
    areaId: "2",
    title: "从登录态页面补采外部证据",
    plainDescription: "让本机浏览器扩展按一次性受控请求读取 1688 或 Ozon 页面，并把脱敏结果交回今日选品评审；这是外部证据入口，不是自动选品的主脑。",
    inputs: ["已创建的单次采集请求", "本机浏览器登录态和扩展桥接"],
    outputs: ["脱敏后的供应或销售证据", "明确失败分类或待人工处理"],
    upstream: ["2.1"],
    downstream: ["3.1", "8.1"],
    executionStatus: "manual_or_codex_experiment",
    statusReason: "页面和扩展桥接代码存在，但真实运行依赖当前机器的浏览器登录态与扩展可用性；它不能当作已验证的跨机器生产链路。",
    connection: { codePresent: true, uiConnected: true, executionConnected: false },
    actualChain: "今日选品评审单次请求 → 本机扩展 → 外部页面 → 脱敏回执 → 服务端保存",
    ownerAction: "需要时由主人在已登录的本机浏览器上发起一次受控采集。",
    codexRule: "Codex 不操作正常采集；只有无法分类的技术异常才可进入 8.1。",
    failureAndUnknown: "扩展未安装、后台无响应、登录失效或页面失败都必须保留为技术缺口，不能写成 true_empty。",
    breakpoint: "浏览器能力尚未作为可租约、可多 Worker 使用的正式运行服务。",
    nextStep: "将受控 Worker 能力、登录有效性与失败回执接入中央作业边界。",
    codeRefs: [
      ref("server.mjs", "sourceCaptureStartRoute", "供应证据采集入口"),
      ref("lib/source-capture.mjs", "sanitize1688Evidence", "1688 证据脱敏"),
      ref("extension/1688-capture/background.js", "SELECTION_REVIEW_1688_CAPTURE_REQUEST", "浏览器扩展桥接")
    ],
    uiRefs: [ref("src/App.jsx", "request1688ExtensionCapture", "今日选品评审发起一次采集")],
    testEvidence: { refs: [
      ref("tests/ozon-sales-capture-api.test.mjs", "test(", "销售采集 API 测试"),
      ref("tests/real-a-b-evidence-orchestration.test.mjs", "test(", "证据编排测试")
    ] }
  }),
  module({
    id: "3.1",
    areaId: "3",
    title: "算具体 SKU 的利润，并自动交给 C1",
    plainDescription: "只使用 A 阶段已经确认的供应 SKU 和证据，算该 SKU 是否达到利润门槛；通过后由软件原子创建 C1 输入，而不是让人再点一次“开始上架”。",
    inputs: ["已确认供应 SKU", "销售、佣金、物流和成本证据", "当前利润规则"],
    outputs: ["利润结论和计算依据", "C1 的冻结输入或明确证据缺口"],
    upstream: ["2.1", "2.2"],
    downstream: ["4.1"],
    executionStatus: "connected",
    statusReason: "利润模型和 A→B→C1 原子交接已有服务端实现与今日选品评审展示；是否能得到精确利润仍取决于输入证据是否齐全。",
    connection: { codePresent: true, uiConnected: true, executionConnected: true },
    actualChain: "确认供应方案 → 利润模型 → B 结论 → 原子创建 C1 输入",
    ownerAction: "主人只处理明确显示的商业选择或证据冲突，不需要手动派发正常 C1。",
    codexRule: "正常 B 计算不依赖 Codex；复杂证据冲突才走异常支路。",
    failureAndUnknown: "佣金、物流或采购输入缺失时只给出缺口或条件测算，不能冒充精确利润通过。",
    breakpoint: "后续 C1 的真实外部关键词作业尚未接通，所以 B 通过不等于可上架。",
    nextStep: "继续保持 B 只读取冻结 A 输入，并补齐 C1 的正式作业接线。",
    codeRefs: [
      ref("lib/profit-model.mjs", "runSkuProfitModel", "具体 SKU 利润模型"),
      ref("lib/real-a-b-c1-flow.mjs", "runRealAConfirmationToBAndC1", "自动 C1 交接"),
      ref("server.mjs", "realAConfirmationRoute", "A 确认后的服务端入口")
    ],
    uiRefs: [ref("src/components/CandidateDetail.jsx", "Profit", "利润结果展示")],
    testEvidence: { refs: [
      ref("tests/profit-model.test.mjs", "test(", "利润模型测试"),
      ref("tests/real-a-b-c1-api.test.mjs", "test(", "A/B/C1 API 交接测试")
    ] }
  }),
  module({
    id: "4.1",
    areaId: "4",
    title: "整理商品事实、属性和 SEO 草稿",
    plainDescription: "从 A/B 冻结输入整理标题、属性、Schema 和 SEO 草稿；它只能生成待核验的上架前资料，不能自己改供应事实或越过 C1 证据门。",
    inputs: ["A/B 冻结数据包", "适用的 Schema 与已保存证据"],
    outputs: ["C1 商品事实和 SEO 草稿", "供关键词证据与 C2 使用的版本化输入"],
    upstream: ["3.1"],
    downstream: ["4.2"],
    executionStatus: "code_not_connected",
    statusReason: "C1 编排、Schema 和草稿能力已有代码与测试，但完整 C1 普通生产作业尚未由通用持久化队列接通。",
    connection: { codePresent: true, uiConnected: true, executionConnected: false },
    actualChain: "B 冻结输入 → C1 事实/Schema/草稿编排 → 等待正式关键词证据",
    ownerAction: "只在事实冲突或需商业判断时要求主人；不能把草稿当作最终商品事实。",
    codexRule: "Codex 只能诊断异常，不能替代 C1 正常作业或填补商品事实。",
    failureAndUnknown: "Schema 不适用、证据冲突或生成失败会停在 C1，不会自动进入 C2。",
    breakpoint: "当前 C1 缺少完整的通用耐久作业接线与正常生产续跑。",
    nextStep: "把 C1 计划、外部调用回执和结果保存接入 SoftwareJobStore。",
    codeRefs: [
      ref("lib/c1-software-orchestrator.mjs", "runC1SoftwareOrchestration", "C1 编排"),
      ref("lib/c1-product-plan.mjs", "createC1ProductPlan", "商品方案"),
      ref("lib/c1-fact-keyword-runtime.mjs", "prepareC1FactKeywordRuntime", "C1 运行时输入")
    ],
    uiRefs: [ref("src/components/CandidateDetail.jsx", "CandidateDetail", "商品事实状态展示")],
    testEvidence: { refs: [
      ref("tests/c1-product-plan.test.mjs", "test(", "C1 商品方案测试"),
      ref("tests/c1-fact-keyword-server-integration.test.mjs", "test(", "C1 服务端集成测试")
    ] }
  }),
  module({
    id: "4.2",
    areaId: "4",
    title: "取得正式关键词与市场证据",
    plainDescription: "为已经整理好的 C1 商品事实创建一次受控关键词作业，向正式数据连接器索取回执；本地算法不能伪造搜索量、竞品或 true_empty。",
    inputs: ["C1 冻结商品事实", "单次关键词作业计划", "正式数据连接器回执"],
    outputs: ["版本化关键词证据", "C1 完成或技术失败/未知状态"],
    upstream: ["4.1"],
    downstream: ["5.1", "8.1"],
    executionStatus: "code_not_connected",
    statusReason: "关键词作业、Seerfar 连接器与失败处理已有代码；当前默认运行开关关闭，而且缺少通用耐久队列与用户可用启动入口。",
    connection: { codePresent: true, uiConnected: false, executionConnected: false },
    actualChain: "C1 计划 → 单次关键词作业 → 正式连接器 → 回执校验 → C1 证据",
    ownerAction: "不要求主人反复点击重试；失败必须先显示失败层，再由主人决定是否开启新的受控轮次。",
    codexRule: "不允许用 Codex 聊天结果代替正式关键词证据。",
    failureAndUnknown: "额度、权限、超时或解析失败都是技术失败；不能被转写为无关键词、无销量或成功。",
    breakpoint: "SELECTION_REVIEW_SEERFAR_SOFTWARE_ENABLED 默认未开启，且正常作业未接入通用持久化队列。",
    nextStep: "先接入 SoftwareJobStore、一次性 attempt 与正式回执保存，再增加只读运行状态入口。",
    codeRefs: [
      ref("server.mjs", "runC1KeywordEvidenceSoftwareJob", "C1 关键词服务端作业"),
      ref("lib/c1-keyword-software-use-case.mjs", "prepareC1KeywordSoftwareExecution", "关键词作业准备"),
      ref("lib/seerfar-runtime-connector.mjs", "createSeerfarRuntimeTransport", "正式连接器")
    ],
    uiRefs: [],
    testEvidence: { refs: [
      ref("tests/c1-keyword-software-use-case.test.mjs", "test(", "关键词作业用例测试"),
      ref("tests/seerfar-software-api-guard.test.mjs", "test(", "运行开关与安全边界测试")
    ] }
  }),
  module({
    id: "5.1",
    areaId: "5",
    title: "锁定最终素材和最终商品方案",
    plainDescription: "把采集参考、AI 草稿和允许上传的最终素材分开保存；只有主人确认的最终素材版本、顺序和首图才能形成最终商品方案。",
    inputs: ["完成的 C1 商品事实", "三类素材区域", "主人确认的最终上传清单"],
    outputs: ["锁定的 finalUploads", "最终商品方案确认卡"],
    upstream: ["4.2"],
    downstream: ["6.1"],
    executionStatus: "connected",
    statusReason: "C2 素材生命周期、上传 API、主人确认与版本锁定已在本地今日选品评审/服务端接通；但它仍受上游 C1 未接通限制。",
    connection: { codePresent: true, uiConnected: true, executionConnected: true },
    actualChain: "C1 事实 → 素材三区 → 主人确认 finalUploads → 最终商品方案",
    ownerAction: "必须确认最终上传素材、顺序和首图；参考图或 AI 草稿不能自动升级。",
    codexRule: "Codex 不得把草稿直接标成最终素材，也不能替代主人确认。",
    failureAndUnknown: "上传或校验失败会保留当前素材状态；不会修改 C1 事实或自动写店。",
    breakpoint: "上游 C1 正常生产链尚未完成，所以 C2 不能组成完整 A→E 闭环。",
    nextStep: "等 C1 接通后，用真实 C1 输出做单 SKU C2 端到端验收。",
    codeRefs: [
      ref("lib/c2-software-orchestrator.mjs", "confirmC2SoftwareFinalUploads", "最终素材确认"),
      ref("lib/c2-asset-lifecycle.mjs", "confirmFinalUploads", "素材生命周期规则"),
      ref("server.mjs", "genericC2FinalAssetsRoute", "C2 最终素材 API")
    ],
    uiRefs: [ref("src/components/UserInspector.jsx", "onConfirmLifecycleFinalAssets", "最终素材确认界面")],
    testEvidence: { refs: [
      ref("tests/c2-software-orchestrator.test.mjs", "test(", "C2 编排测试"),
      ref("tests/c2-final-assets-ui-contract.test.mjs", "test(", "C2 UI 契约测试")
    ] }
  }),
  module({
    id: "6.1",
    areaId: "6",
    title: "锁定精确生产授权，不执行写店",
    plainDescription: "把平台、店铺、SKU、价格、库存、最终素材和发布范围冻结成一份精确授权；保存授权本身不创建商品、不上传图片，也不改变店铺。",
    inputs: ["最终商品方案", "主人精确生产确认"],
    outputs: ["版本化 ProductionAuthorization", "D 阶段可读取的生产计划输入"],
    upstream: ["5.1"],
    downstream: ["6.2"],
    executionStatus: "connected",
    statusReason: "生产授权的校验、持久化与今日选品评审确认卡已接通；代码明确把“授权已保存”和“店铺已写入”分开。",
    connection: { codePresent: true, uiConnected: true, executionConnected: true },
    actualChain: "最终方案 → 主人精确确认 → ProductionAuthorization → D 计划输入",
    ownerAction: "必须由主人确认准确写入范围；不能用普通留言或旧授权扩大范围。",
    codexRule: "Codex 不得把授权解释成写店授权已经执行。",
    failureAndUnknown: "字段不完整、revision 变化或确认不精确时应拒绝保存；不能形成半套授权。",
    breakpoint: "D 的实际 Seller API 执行和独立 E 回读尚未连接，授权不是业务闭环。",
    nextStep: "在受控 D 作业先持久化一次性 intent 后，才接入店铺适配器。",
    codeRefs: [
      ref("lib/production-authorization.mjs", "createProductionAuthorization", "生产授权创建"),
      ref("lib/production-plan.mjs", "createProductionPlan", "授权后的生产计划"),
      ref("server.mjs", "realProductionAuthorizationRoute", "生产授权 API")
    ],
    uiRefs: [ref("src/components/UserInspector.jsx", "onLifecycleProductionAuthorization", "生产授权确认界面")],
    testEvidence: { refs: [
      ref("tests/production-plan.test.mjs", "test(", "生产计划测试"),
      ref("tests/lifecycle-c-stage-generic-api.test.mjs", "test(", "生命周期授权 API 测试")
    ] }
  }),
  module({
    id: "6.2",
    areaId: "6",
    title: "把 Ozon 素材和商品真正写进店铺",
    plainDescription: "准备单次写店意图、素材传输和 Ozon Seller API 请求；真正执行前必须先持久化 intent，执行后还要有准确平台回执。",
    inputs: ["精确 ProductionAuthorization", "已验证素材地址", "当前店铺只读前检与适配器能力"],
    outputs: ["一次性 D 执行意图", "平台写入回执和 ProductionRecord，或 unknown_outcome"],
    upstream: ["6.1"],
    downstream: ["7.1", "8.1"],
    executionStatus: "code_not_connected",
    statusReason: "OSS 意图、D 执行状态和 Ozon Seller API 适配器已有代码；当前运行服务只展示准备度，没有把 Seller API 写入路由和回执持久化接通。",
    connection: { codePresent: true, uiConnected: true, executionConnected: false },
    actualChain: "生产授权 → 单次 intent → 受控素材传输 → Seller API → ProductionRecord",
    ownerAction: "主人只能对当前精确范围授权；结果未知时必须先对账，不能直接重发。",
    codexRule: "Codex 只能诊断未知异常；不能代替正式适配器执行写店。",
    failureAndUnknown: "请求已发出但无法确认终态时必须保存 unknown_outcome，禁止自动重试或假定未写入。",
    breakpoint: "当前 d-e 软件视图明确 canExecutePlatformWrite=false，服务端没有正式 Seller API 写入路由。",
    nextStep: "接入有幂等键的一次性 D 执行路由、受控适配器和回执保存，再做独立平台回读。",
    codeRefs: [
      ref("lib/d-e-software-integration.mjs", "buildDESoftwareIntegrationView", "D/E 准备度视图"),
      ref("lib/aliyun-oss-d-asset-integration.mjs", "createPersistableAliyunOssAssetIntent", "素材传输 intent"),
      ref("lib/ozon-seller-api-production-adapter.mjs", "createOzonSellerApiProductionAdapter", "Ozon Seller API 适配器")
    ],
    uiRefs: [ref("src/components/DESoftwareRuntimeCard.jsx", "DESoftwareRuntimeCard", "D/E 准备度展示")],
    testEvidence: { refs: [
      ref("tests/d-e-software-integration.test.mjs", "test(", "D/E 准备度测试"),
      ref("tests/ozon-seller-api-production-adapter.test.mjs", "test(", "Ozon 适配器测试"),
      ref("tests/aliyun-oss-d-asset-integration.test.mjs", "test(", "素材传输意图测试")
    ] }
  }),
  module({
    id: "6.3",
    areaId: "6",
    title: "把商品正式写进 WB 店铺",
    plainDescription: "全店能力地图需要为 WB 保留独立写店位置，但当前今日选品评审没有可用于正常生产的 WB 写店适配器、受控执行路由和回执保存。",
    inputs: ["未来需要：精确 WB 授权、类目/属性、素材和价格库存"],
    outputs: ["未来需要：WB ProductionRecord 或明确 unknown_outcome"],
    upstream: ["6.1"],
    downstream: ["7.2"],
    executionStatus: "not_implemented",
    statusReason: "当前项目没有 WB 正式写店的运行实现；不能把现有候选 UI 或通用授权对象说成 WB 已接通。",
    connection: { codePresent: false, uiConnected: false, executionConnected: false },
    actualChain: "尚未建立正式链路",
    ownerAction: "未来仍需独立的精确 WB 生产确认。",
    codexRule: "不能用 Codex 临时浏览器操作替代正式 WB 适配器。",
    failureAndUnknown: "尚未实现时不产生“写入失败”假象；必须明确显示尚未有运行能力。",
    breakpoint: "缺少 WB 写店 adapter、一次性执行作业和回执持久化。",
    nextStep: "先定义 WB 生产 DTO、只读前检与独立回读契约，再实现受控写入。",
    codeRefs: [],
    uiRefs: [],
    testEvidence: { refs: [] }
  }),
  module({
    id: "7.1",
    areaId: "7",
    title: "独立读取 Ozon，确认真实结果",
    plainDescription: "写店后必须从独立平台接口重新读取商品 ID、审核、图片、价格、库存和销售状态；不能只相信写入请求返回成功。",
    inputs: ["平台商品身份或 ProductionRecord", "独立平台读取结果"],
    outputs: ["EVerificationRecord", "已验证或明确失败/未知状态"],
    upstream: ["6.2"],
    downstream: ["8.1"],
    executionStatus: "code_not_connected",
    statusReason: "E 阶段规则、DTO 和读回验证函数已有代码；当前服务端仍接受调用方提供的观察结果，未接通独立 Ozon 平台读取者。",
    connection: { codePresent: true, uiConnected: true, executionConnected: false },
    actualChain: "平台商品身份 → 独立平台读取 → E 验证规则 → EVerificationRecord",
    ownerAction: "除非发生异常或需要商业判断，主人不应手工替代独立回读。",
    codexRule: "Codex 不能把聊天观察、请求成功或本地页面变化当作 E 回读。",
    failureAndUnknown: "未能独立读取时必须保持未验证或 unknown_outcome，不能显示“已上架”。",
    breakpoint: "独立平台 readback producer 未接线；现有 API 仍接收 caller-supplied verifiedObservation。",
    nextStep: "接入店铺隔离的只读 Ozon API 读取者，并把结果与 D 幂等键对账。",
    codeRefs: [
      ref("lib/e-stage-readback.mjs", "verifySystemCreatedListing", "E 阶段验证规则"),
      ref("server.mjs", "lifecycleEReadbackRoute", "现有 E 回读入口"),
      ref("lib/ozon-seller-api-de-adapter.mjs", "inspectAdapterCapabilities", "Ozon D/E 适配器")
    ],
    uiRefs: [ref("src/components/DESoftwareRuntimeCard.jsx", "DESoftwareRuntimeCard", "D/E 状态展示")],
    testEvidence: { refs: [
      ref("tests/e-stage-readback.test.mjs", "test(", "E 验证规则测试"),
      ref("tests/ozon-seller-api-de-adapter.test.mjs", "test(", "Ozon D/E 适配器测试")
    ] }
  }),
  module({
    id: "7.2",
    areaId: "7",
    title: "独立读取 WB，确认真实结果",
    plainDescription: "WB 需要独立的商品、图片、价格、库存和审核回读能力；当前今日选品评审没有可用于正常生产的 WB E 阶段实现。",
    inputs: ["未来需要：WB 平台商品身份和只读访问能力"],
    outputs: ["未来需要：WB EVerificationRecord"],
    upstream: ["6.3"],
    downstream: [],
    executionStatus: "not_implemented",
    statusReason: "当前没有 WB 独立回读 provider、运行路由或测试过的生产接线。",
    connection: { codePresent: false, uiConnected: false, executionConnected: false },
    actualChain: "尚未建立正式链路",
    ownerAction: "未来不应由主人用页面截图替代独立回读。",
    codexRule: "不能用 Codex 临时检查页面替代正式 WB 回读。",
    failureAndUnknown: "未实现时必须显示“尚未实现”，不能显示空结果或已验证。",
    breakpoint: "缺少 WB 读回 DTO、只读适配器、状态保存和 UI 证据展示。",
    nextStep: "在 WB 写店能力之前，先定义独立回读数据契约和只读能力探针。",
    codeRefs: [],
    uiRefs: [],
    testEvidence: { refs: [] }
  }),
  module({
    id: "8.1",
    areaId: "8",
    title: "异常停机与 Codex 维护支路",
    plainDescription: "低置信度、证据冲突、权限问题、技术失败或结果未知时，软件先保存 ExceptionCase 并停止；Codex 只在真实维护轮次中诊断和修复，不能成为正常流水线工人。",
    inputs: ["结构化技术失败、未知结果或冲突证据", "安全脱敏的 ExceptionCase"],
    outputs: ["停止原因、维护授权和可审计的恢复建议", "由状态机重新判断的下一轮，不自动推进"],
    upstream: ["2.2", "4.2", "6.2", "7.1"],
    downstream: [],
    executionStatus: "manual_or_codex_experiment",
    statusReason: "异常运行时、ExceptionCase 和 Codex 离线门禁已有代码与测试；维护案件不是正常商品的自动续跑能力。",
    connection: { codePresent: true, uiConnected: true, executionConnected: false },
    actualChain: "技术/证据异常 → 软件停止并持久化 → 真正维护 → 回归验证 → 状态机重新决定",
    ownerAction: "主人决定是否提供新的精确授权、补证据或发起新的受控轮次；不能用“再试一次”绕过 unknown_outcome。",
    codexRule: "只允许异常诊断、修复代码、验证恢复；绝不提供正常业务结果或推进正常阶段。",
    failureAndUnknown: "错误必须分层保存；已发外部请求而终态不明时保持 unknown_outcome，禁止静默重试。",
    breakpoint: "维护仍是施工期协作活动，不是可由普通用户依赖的在线生产服务。",
    nextStep: "把 ExceptionCase 的人类可读详情和局部测试/回归证据持续接入本地图。",
    codeRefs: [
      ref("lib/software-execution-state.mjs", "openExceptionCase", "异常案件状态机"),
      ref("lib/codex-independence.mjs", "assertRuntimeCodexDependencyAllowed", "Codex 离线门禁"),
      ref("server.mjs", "recordExceptionMaintenanceStarted", "维护轮次记录")
    ],
    uiRefs: [ref("src/components/ExecutionRuntimeCard.jsx", "ExecutionRuntimeCard", "异常状态展示")],
    testEvidence: { refs: [
      ref("tests/software-execution-state.test.mjs", "test(", "异常状态机测试"),
      ref("tests/codex-independence.test.mjs", "test(", "Codex 离线门禁测试")
    ] }
  }),
  module({
    id: "8.2",
    areaId: "8",
    title: "多人中央运行与受控 Worker",
    plainDescription: "未来让 4—5 人同时使用时，中央服务保存唯一业务状态，本机浏览器 Worker 只领取授权作业；现在还不能把本地 JSON 和单 Worker 说成多人运行。",
    inputs: ["中央数据库、身份、队列、Worker 租约和店铺隔离能力"],
    outputs: ["可多人协作的中央状态与可追踪的受控作业"],
    upstream: [],
    downstream: [],
    executionStatus: "not_implemented",
    statusReason: "项目有多用户边界、迁移阶段和本地适配器保护，但没有中央数据库、多人身份、持久队列或多 Worker 生产验收。",
    connection: { codePresent: false, uiConnected: true, executionConnected: false },
    actualChain: "当前仅有本地开发边界；中央正式链路尚未建立",
    ownerAction: "当前只能按本地开发能力使用，不能把关闭一台机器后的恢复能力当作已经实现。",
    codexRule: "Codex 不是中央调度器或 Worker；多人化也不能以聊天任务替代。",
    failureAndUnknown: "运行架构状态未取得时应显示未知/不可用，不能默认显示中央运行可用。",
    breakpoint: "缺少中央服务、PostgreSQL、真实身份/权限、持久作业队列和 Worker 租约验收。",
    nextStep: "按单机多身份 → 中央测试服务 → 两人试用 → 数据迁移 → 多 Worker 的顺序推进。",
    codeRefs: [
      ref("lib/multi-user-central-runtime.mjs", "MULTI_USER_MIGRATION_STAGES", "多人化迁移阶段"),
      ref("lib/worker-registry.mjs", "createLocalDevelopmentWorkerRegistry", "当前本地 Worker 适配器"),
      ref("src/runtimeArchitectureView.js", "runtimeArchitectureView", "运行边界展示")
    ],
    uiRefs: [ref("src/components/RuntimeArchitectureStatus.jsx", "RuntimeArchitectureStatus", "本地/中央状态提示")],
    testEvidence: { refs: [
      ref("tests/multi-user-central-runtime.test.mjs", "test(", "中央运行边界测试"),
      ref("tests/runtime-architecture-view.test.mjs", "test(", "运行状态 UI 测试")
    ] }
  })
]);

const EXECUTION_STATE_IDS = new Set(Object.keys(THREE_STORE_MAP_EXECUTION_STATES));

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRefs(refs, path) {
  if (!Array.isArray(refs)) throw new Error(`THREE_STORE_MAP_REFS_INVALID:${path}`);
  for (const [index, item] of refs.entries()) {
    if (!item || !hasText(item.path) || item.path.startsWith("/") || item.path.includes("..") || !hasText(item.anchor) || !hasText(item.label)) {
      throw new Error(`THREE_STORE_MAP_REF_INVALID:${path}[${index}]`);
    }
  }
}

export function assertThreeStoreMapIntegrity({ areas = THREE_STORE_MAP_AREAS, modules = THREE_STORE_MAP_REGISTRY } = {}) {
  const areaIds = new Set();
  for (const item of areas) {
    if (!item || !hasText(item.id) || !hasText(item.title) || !hasText(item.summary) || areaIds.has(item.id)) {
      throw new Error("THREE_STORE_MAP_AREA_INVALID");
    }
    areaIds.add(item.id);
  }

  const moduleIds = new Set();
  for (const item of modules) {
    if (!item || !hasText(item.id) || moduleIds.has(item.id) || !areaIds.has(item.areaId) ||
        !hasText(item.title) || !hasText(item.plainDescription) || !EXECUTION_STATE_IDS.has(item.executionStatus) ||
        !hasText(item.statusReason) || !hasText(item.actualChain) || !hasText(item.ownerAction) ||
        !hasText(item.codexRule) || !hasText(item.failureAndUnknown) || !hasText(item.breakpoint) || !hasText(item.nextStep)) {
      throw new Error(`THREE_STORE_MAP_MODULE_INVALID:${item?.id || "unknown"}`);
    }
    if (!Array.isArray(item.inputs) || item.inputs.length === 0 || !Array.isArray(item.outputs) || item.outputs.length === 0 ||
        !Array.isArray(item.upstream) || !Array.isArray(item.downstream) ||
        !item.connection || typeof item.connection.codePresent !== "boolean" ||
        typeof item.connection.uiConnected !== "boolean" || typeof item.connection.executionConnected !== "boolean") {
      throw new Error(`THREE_STORE_MAP_MODULE_SHAPE_INVALID:${item.id}`);
    }
    if (item.executionStatus === "connected" && (!item.connection.codePresent || !item.connection.uiConnected || !item.connection.executionConnected || item.testEvidence.refs.length === 0)) {
      throw new Error(`THREE_STORE_MAP_CONNECTED_WITHOUT_EVIDENCE:${item.id}`);
    }
    if (item.executionStatus === "not_implemented" && (item.connection.codePresent || item.connection.executionConnected)) {
      throw new Error(`THREE_STORE_MAP_NOT_IMPLEMENTED_MISSTATED:${item.id}`);
    }
    assertRefs(item.codeRefs, `${item.id}.codeRefs`);
    assertRefs(item.uiRefs, `${item.id}.uiRefs`);
    if (!item.testEvidence || item.testEvidence.kind !== "test_files_present") {
      throw new Error(`THREE_STORE_MAP_TEST_EVIDENCE_INVALID:${item.id}`);
    }
    assertRefs(item.testEvidence.refs, `${item.id}.testEvidence`);
    moduleIds.add(item.id);
  }

  for (const item of modules) {
    for (const linkedId of [...item.upstream, ...item.downstream]) {
      if (!moduleIds.has(linkedId) || linkedId === item.id) throw new Error(`THREE_STORE_MAP_LINK_INVALID:${item.id}:${linkedId}`);
    }
  }
  return true;
}

function publicModule(item, runtimeFacts) {
  const status = THREE_STORE_MAP_EXECUTION_STATES[item.executionStatus];
  const c1RuntimeNote = item.id === "4.2"
    ? runtimeFacts.seerfarSoftwareExecutionEnabled
      ? "当前进程开关显示已开启；通用耐久作业仍未接通，因此状态不升级。"
      : "当前进程开关显示未开启；状态保持“已有代码但未接通”。"
    : null;
  return {
    ...structuredClone(item),
    currentStatus: status,
    runtimeNote: c1RuntimeNote
  };
}

/**
 * 只把启动期安全运行事实投影到地图，不读取候选、不读密钥、不探测平台，也不触发作业。
 */
export function buildThreeStoreMapView({ runtimeArchitecture = null, seerfarSoftwareExecutionEnabled = false } = {}) {
  assertThreeStoreMapIntegrity();
  const runtimeFacts = Object.freeze({
    deploymentMode: runtimeArchitecture?.deploymentMode || "unknown",
    runtimeStatus: runtimeArchitecture?.status || "unknown",
    multiUserReady: runtimeArchitecture?.multiUserReady === true,
    seerfarSoftwareExecutionEnabled: seerfarSoftwareExecutionEnabled === true
  });
  const modules = THREE_STORE_MAP_REGISTRY.map((item) => publicModule(item, runtimeFacts));
  return {
    schemaVersion: THREE_STORE_MAP_VERSION,
    title: "全店能力地图",
    subtitle: "持续施工中的代码事实驾驶舱",
    readOnly: true,
    evidenceScope: "本页展示当前工作区已审查的代码、UI、测试文件和运行接缝；它不证明 4317 运行副本、店铺、平台或某个商品已经完成。",
    maintenanceRule: "修改模块实现、入口、测试或断点时，必须同步更新本注册表；没有新验证证据时不要把状态升级为已接通。",
    runtimeFacts,
    statusDefinitions: Object.entries(THREE_STORE_MAP_EXECUTION_STATES).map(([id, value]) => ({ id, ...value })),
    areas: structuredClone(THREE_STORE_MAP_AREAS),
    modules,
    mainFlow: ["1.1", "2.1", "2.2", "3.1", "4.1", "4.2", "5.1", "6.1", "6.2", "7.1"],
    exceptionRoute: {
      from: ["2.2", "4.2", "6.2", "7.1"],
      to: "8.1",
      label: "技术失败、冲突或未知结果 → 停止并进入维护支路",
      returnRule: "维护后由状态机按保存的证据重新判断；不能从地图自动跳过原断点。"
    }
  };
}
