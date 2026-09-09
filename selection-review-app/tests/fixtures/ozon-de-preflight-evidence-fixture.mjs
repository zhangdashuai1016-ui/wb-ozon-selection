import { preparedFixture } from '../helpers/d-software-fixture.mjs';
import { createDProductionPreparationIntent } from '../../lib/d-production-preparation-contract.mjs';
import { fingerprintProductionAuthorization } from '../../lib/production-plan.mjs';
import { OZON_DE_READBACK_ENDPOINTS } from '../../lib/ozon-seller-api-de-adapter.mjs';
const original = await preparedFixture(), now='2026-08-22T07:25:00.000Z', clone=value=>structuredClone(value);
/** Synthetic evidence only. No platform observations are represented by this fixture. */
export function ozonDEPreflightEvidenceFixture() {
  const f=clone({authorization:original.authorization,plan:original.plan,binding:original.currentProductionBinding,sku:original.fixture.skuPackage});
  const pa=f.authorization, locked=pa.lockedScope;
  const candidate={id:locked.candidateId,dataRevision:pa.resultCandidateRevision,targetStore:locked.storeRef.stableStoreId,storeRef:clone(locked.storeRef),lifecycleV11:{skuPackage:f.sku}};
  candidate.lifecycleV11.skuPackage.productionAuthorization=clone(pa);
  const job={jobId:'job:synthetic:preflight',jobType:'d_production_execution',candidateId:candidate.id,skuPackageId:locked.skuPackageId,revision:candidate.dataRevision,
    workerId:'worker:synthetic:preflight',leaseId:'lease:synthetic:preflight',leaseExpiresAt:'2026-08-22T07:26:00.000Z',scopeBinding:{authorizationFingerprint:fingerprintProductionAuthorization(pa)}};
  const preparation=createDProductionPreparationIntent({job,candidateRevision:candidate.dataRevision,productionPlan:f.plan,startedAt:now});
  const context={candidate,job,candidateRevision:candidate.dataRevision,sourceRevision:job.revision,productionAuthorization:pa,productionPlan:f.plan,productionBinding:f.binding,
    preparationEvidence:preparation,workerId:job.workerId,leaseId:job.leaseId,signal:new AbortController().signal};
  const scope={candidateId:candidate.id,skuPackageId:locked.skuPackageId,supplierSkuId:locked.supplierSkuId,authorizationId:pa.authorizationId,sourceCandidateRevision:pa.sourceCandidateRevision,
    storeRef:clone(locked.storeRef),warehouseRef:locked.warehouseRef,warehouseId:f.binding.warehouseId,credentialAlias:locked.credentialAlias,bindingId:f.binding.bindingId,configurationVersion:f.binding.configurationVersion};
  const inspection={observedStore:locked.storeRef.stableStoreId,observedStoreRef:clone(locked.storeRef),storeIdentityStatus:'matched',storeIdentityEvidenceRef:'evidence:synthetic:store',
    permissionStatus:'verified',permissionEvidenceRef:'evidence:synthetic:permission',connections:{api:{status:'connected',checkedVia:'seller_api_read_only',evidenceRef:'evidence:synthetic:api'},sellerBackend:{status:'connected',checkedVia:'seller_backend_read_only',evidenceRef:'evidence:synthetic:backend'}},
    platformWritableFields:clone(locked.allowedWriteFields),imagePermissionStatus:'verified',imagePermissionEvidenceRef:'evidence:synthetic:images',priceFieldCurrency:'CNY',priceCurrencyEvidenceRef:'evidence:synthetic:currency',risks:[]};
  const record={schemaVersion:'ozon-de-preflight-evidence-v2',evidenceId:'evidence:synthetic:preflight',scope,collectedAt:'2026-08-22T07:00:00.000Z',expiresAt:'2026-08-22T08:00:00.000Z',
    provenance:{sourceKind:'controlled_platform_verification',readAuthorizationRef:'permission:synthetic:read',softwareJobRef:'job:synthetic:account',officialContractRefs:['evidence:synthetic:official-contract']},inspection,
    protocols:{productImport:{status:'verified',protocolVersion:'ozon-product-import-v3',evidenceRef:'evidence:synthetic:import',endpoint:'/v3/product/import',statusEndpoint:'/v1/product/import/info'},
      inventoryWrite:{status:'verified',protocolVersion:'ozon-products-stocks-v2',evidenceRef:'evidence:synthetic:inventory',endpoint:'/v2/products/stocks',warehouseId:scope.warehouseId,storeRef:clone(scope.storeRef),warehouseRef:scope.warehouseRef,credentialAlias:scope.credentialAlias},
      independentReadback:{status:'verified',protocolVersion:'ozon-independent-readback-v2',evidenceRef:'evidence:synthetic:readback',endpoints:clone(OZON_DE_READBACK_ENDPOINTS)}}};
  const query={mode:'read_only_preflight',targetPlatform:'ozon',expectedStore:scope.storeRef.stableStoreId,expectedStoreRef:clone(scope.storeRef),requestedWriteFields:clone(locked.allowedWriteFields),
    imageUploadRequested:true,productCreationRequested:true,inventoryWriteRequested:true,expectedPlatformWriteCurrency:'CNY',platformWriteRequested:false};
  const resolvedAssets=locked.finalUploads.map(asset=>({assetId:asset.assetId,sha256:asset.sha256,order:asset.order,platformAcceptedUrl:`https://assets.example.com/${asset.sha256}.jpg`,authorizationStatus:'approved',stable:true,evidenceRef:`evidence:synthetic:${asset.assetId}`}));
  candidate.lifecycleV11.skuPackage.dAssetTransport={status:'verified',continuationBlocked:false,intent:{status:'completed',persistedAt:'2026-08-22T07:00:00.000Z',completedAt:'2026-08-22T07:01:00.000Z',candidateId:candidate.id,skuPackageId:locked.skuPackageId,authorizationId:pa.authorizationId,
    authorizationFingerprint:fingerprintProductionAuthorization(pa),productionPlan:clone(f.plan),finalUploadAssetIds:locked.finalUploads.map(asset=>asset.assetId)},
    assetTransport:{status:'verified',mode:'preapproved_stable_https',protocolVersion:'aliyun-oss-final-assets-v1',evidenceRef:'evidence:synthetic:oss',approvedHosts:['assets.example.com'],resolvedAssets}};
  return {context,scope,record,query};
}
