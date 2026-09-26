// 完整排练：作废归档 → 现有 C1 最终方案修订 → 新卡 / 新授权 ID。
// 真实数据副本、纯本地、零外部请求、零平台写入。
//
// 用法：node 背心救回排练脚本-2026-09-23.mjs /某处/candidates.json 的副本
// 本脚本会「写」传进来的那个文件。绝不能对正式业务数据跑。
import path from 'node:path';
import fsSync from 'node:fs';

const A = '/Users/shuaizhang/.local/share/wb-ozon-engineering/github-checkpoint-20260909/selection-review-app';
const LIVE = path.join(process.env.HOME, 'Library/Application Support/今日选品评审台/data/candidates.json');
const target = process.argv[2];
if (!target) { console.error('用法：本脚本 <candidates.json 的副本路径>'); process.exit(64); }
// 防呆：解析成真实路径后与正式业务数据比对，命中就拒绝执行。
const resolve = file => { try { return fsSync.realpathSync(file); } catch { return path.resolve(file); } };
if (resolve(target) === resolve(LIVE)) {
  console.error('拒绝执行：传进来的是正式业务数据。本脚本会改写该文件，只能对副本运行。');
  console.error('正确做法：先 cp 一份到临时目录，再把副本路径传进来。');
  process.exit(65);
}
const { createJsonBusinessStateRepository } = await import(`file://${A}/lib/business-state-repository.mjs`);
const { prepareC1FinalPlanRevision } = await import(`file://${A}/lib/c1-final-plan-revision-preparation.mjs`);
const repository = createJsonBusinessStateRepository({ filePath: target });
const document = await repository.readSnapshot();
const round = document.runtime.softwareJobs.filter(e => e.jobType === 'd_production_execution').at(-1);
const candidate = document.candidates.find(c => c.id === round.candidateId);
const sku = candidate.lifecycleV11.skuPackage;
const beforeCardId = sku.productionConfirmationCard.cardId;
console.log('作废前：SKU rev=' + sku.dataRevision + '  候选 rev=' + candidate.dataRevision + '  cardRevision=' + sku.productionConfirmationCard.cardRevision);

sku.productionAuthorization = null;
sku.dHandoff = null;
sku.dAssetTransport = null;
sku.businessPhase = 'C2';
sku.productionConfirmationCard = { ...sku.productionConfirmationCard, status: 'awaiting_owner_business_confirmation', ownerDecision: null };
console.log('第1步 作废归档：完成（15 张图、C1 文案、确认卡内容全部保留）');

let result;
try {
  result = prepareC1FinalPlanRevision({ candidate, expectedRevision: candidate.dataRevision, preparedAt: new Date().toISOString() });
  console.log('第2步 C1 最终方案修订：成功');
} catch (error) {
  console.log('第2步 C1 最终方案修订：失败 =>', String(error.message).slice(0, 200));
  process.exit(0);
}
const next = result.candidate.lifecycleV11.skuPackage;
console.log('   修订后 SKU rev=' + next.dataRevision + '  阶段=' + next.businessPhase + '  c2=' + next.c2FinalAssets.status);
const card = next.productionConfirmationCard;
console.log('   新确认卡：' + (card ? card.cardId.slice(-16) + '  rev' + card.cardRevision + '  status=' + card.status : 'null'));
console.log('   最终素材张数：' + (next.c2FinalAssets.productionAuthorizationPreparation?.finalUploads?.length ?? '查不到'));
if (card) console.log('第3步 新卡 ID 与旧卡：' + (card.cardId === beforeCardId ? '★ 相同（新授权会撞旧 ID）' : '不同 → 新授权 ID 也不同，3.4 条满足'));
console.log('   nextStep:', JSON.stringify(result.nextStep ?? null).slice(0, 120));
