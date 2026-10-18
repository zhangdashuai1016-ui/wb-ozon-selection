# Ozon 多规格批次部署与验证

日期：2026-10-18（America/Los_Angeles）。

本轮代码已按准确确认卡授权并部署；真实三色商品仍未取得完整正式前置材料和生产授权，未执行上架、OSS 上传或平台写入。

## 运行与数据

- 已部署版本：`20261018-ozon-first-batch-1947772b98ad`；本机服务端口 4317。
- 上一版本保留：`20261008-s1-health-drafts-514a9e0ad225`。
- 确认卡与授权分别持久保存，授权只覆盖这次代码包和启动路径。
- 包清单：5,956 个文件/链接；383 个第一方文件与已验证源码逐字一致。
- 清单摘要：`1947772b98ad7055bd0c2b0d66511f079895708983b4ff37f881e8eca097474c`，仅检测意外损坏和部署基线变化。
- 正式健康与页面资源均 200，插件 1.2.7 已连接，Worker 身份及能力集合保持；未以此推断外部服务可用。
- 28 个数据及上传文件共 58,010,871 字节逐字保全；65 个候选、原 revision 和 16 个非活跃 softwareJobs 不变。
- 自动化保持关闭，重启后主人需正常重新登录；页面与控制台实测通过，新增服务日志及控制台 0 error/warning。

## 根因与实现

旧路径需要明确区分中断后未发送和结果未知；价格、库存和商品卡存在不能单独证明在售；平台 CDN 地址又不能直接与批准原图建立身份映射。新增路径分别保存执行意图、受控名单命中和主人核图，最后合成独立 E 证据。

- 资产、导入、库存复用现有续作与持久化边界，租约到期分类收口，未知结果不重放。
- 新版批次绑定逐 SKU 授权与 revision；当前官方每请求 100 件的事实由当前批次明确采用一次，旧过期事实不续期。
- 无精确 ID 筛选的 IN_SALE 名单读取采用每批共享有界预算，只接受同一行 offerId/productId 精确正向命中；未命中仍为未验证。
- 已认证主人并排核对批准原图与平台图，确认绑定准确来源、回读、数量、主图和顺序；服务端独立检查且幂等追加。
- 最终 E 仍要求价格、指定仓库库存、原审核/校验门禁、在售和核图全部满足。历史候选和 D/E 记录不改写。
- 修复文案映射、核图入口分支、长组合引用、外部货号合同、权限/损坏来源误分类和部分分块对成功成员的阻塞。

## 架构与审查

领域规则、服务编排、Repository、平台适配器及 UI 边界保持分离，复用原后台 pump，没有新依赖或平行状态机。架构、实现、测试、安全四项审查在当前三色范围均无剩余阻断。新增合同明确保留旧记录，不自动迁移或重试。当前仍是本地 JSON 单进程适配器，并未取得多人中央运行验收。

## 实际验证命令

以下命令在 selection-review-app 中执行，使用 Node v24.19.0。每组均退出 0，无 error/warning/skip；组间覆盖重叠，不相加计总数。早期失败已修复，原日志留在本机证据目录。

### frozen-contracts-final：78/78

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/ozon-product-import-batch-limit.test.mjs tests/d-batch-production-contract.test.mjs tests/ozon-seller-api-production-adapter.test.mjs tests/d-batch-import-state.test.mjs tests/d-batch-stock-state.test.mjs tests/d-batch-production-authorization.test.mjs tests/d-batch-import-runtime.test.mjs tests/c1-sibling-neutral-copy.test.mjs
```

### final-document-and-source-whitespace：通过

```sh
git diff --check
```

### batch-service-complete-final：47/47

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/d-batch-import-software-service.test.mjs
```

### account-and-preflight-corrected-final：52/52

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/ozon-account-read-integration.test.mjs tests/ozon-de-batch-preflight.test.mjs
```

### final-e-list-media-final：54/54

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/d-batch-e-verification.test.mjs tests/d-batch-in-sale-software-service.test.mjs tests/d-batch-e-media-review.test.mjs tests/ozon-in-sale-list-observation.test.mjs tests/sibling-batch-authorization-input.test.mjs
```

### batch-assets-and-shared-ui-final：120/120

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/d-batch-asset-transport.test.mjs tests/aliyun-oss-d-asset-integration.test.mjs tests/d-batch-offer-readback.test.mjs tests/product-page-ui.test.mjs
```

### phase2-media-api-3：10/10

```sh
node scripts/run-local-api-tests.mjs d-batch-media-review-api.test.mjs
```

### phase2-media-ui-2：3/3

```sh
node --throw-deprecation --test tests/batch-media-review-ui.test.mjs
```

### phase2-c2-api-1：2/2

```sh
node scripts/run-local-api-tests.mjs c2-upload-api.test.mjs
```

### batch-http-final：1/1

```sh
node scripts/run-local-api-tests.mjs d-batch-import-api.test.mjs
```

### runtime-startup-final：1/1

```sh
node scripts/run-local-api-tests.mjs runtime-package-api.test.mjs
```

### independence-and-coverage-final：18/18

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/codex-independence.test.mjs tests/capability-registry.test.mjs tests/capability-source-snapshot.test.mjs
```

### source-snapshot-generate-corrected-final：通过

```sh
node --throw-deprecation scripts/generate-capability-snapshot.mjs
```

### snapshot-current-check-final：通过

```sh
node --throw-deprecation scripts/generate-capability-snapshot.mjs --check
```

### package-production-build：通过

```sh
node --throw-deprecation node_modules/vite/bin/vite.js build
```

### syntax-and-whitespace-final：通过

```sh
node --check server.mjs
```

### diff-whitespace-final：通过

```sh
git diff --check
```

### in-sale-external-offer-id-tests：91/91

```sh
node --throw-deprecation --test --test-concurrency=1 --test-timeout=60000 tests/ozon-in-sale-list-observation.test.mjs tests/ozon-de-http-transport.test.mjs tests/ozon-seller-api-de-adapter.test.mjs
```

## 打包及部署验收

执行 scripts/prepare-local-runtime.mjs --output 指定全新目录准备包，再通过 scripts/verify-package-with-real-env.mjs 使用正式配置和静止数据副本在 OS 隔离环境启动。预验禁止外网和密钥访问，健康 200、副本不变。主人确认准确卡后，先保存完整恢复点，再切换现有 LaunchAgent；独立核对新进程路径、页面字节、健康、能力、日志和全部持久文件。完整命令中的机器路径、配置值、数据副本及运行包留在本机，不提交到仓库。

## 尚未验通及回退限制

- 本轮三色业务仍需正式 A/B/C1/C2、最终图片权利/主图/顺序、各色账户读取许可与真实回执、适用观察策略和正式生产授权。
- 人工核图产品方向已确认，但尚未核对任何真实平台图片。真实审核字段、在售和三色平台 E 尚未验通。
- 多 SKU 批次设计可供后续 Ozon 同店商品复用，每款事实和授权须独立；WB 与多人中央运行不在本轮验收范围。
- 历史间歇 readiness 超时本轮未复现，原因尚未确定。大批次用例有较高计算耗时，本轮未做生产规模性能承诺。
- 上一代码版本保留；若新版已有新格式作业/结果，旧版不能接管，禁止盲目回退或覆盖用户新数据。

部署详情与继续工作入口见仓库根目录 HANDOFF.md。GitHub 同步不等于真实商品上架或下一版部署授权。
