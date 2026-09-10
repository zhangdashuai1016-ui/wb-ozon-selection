import { exactObservation } from './d-software-fixture.mjs';

/**
 * Explicit synthetic DTO producer for domain/schema test preconditions only.
 * Every transition still goes through the real persistCheckpoint and terminal
 * reducers. This is not the seller adapter and proves no platform acceptance.
 */
export function createSyntheticDCompletionAdapter({request,beforeCheckpoint=null,afterCheckpoint=null,readback=null}) {
  return {
    async executeSellerApi(_request,{persistCheckpoint}) {
      const identity={taskId:'501',productId:'910001',merchantSku:request.merchantSku};
      const events=[{kind:'import_intent'},{kind:'import_task_received',taskId:identity.taskId},
        {kind:'import_result_observed',...identity,itemCount:1,status:'imported',errorCount:0,requestReceiptRef:'receipt:synthetic:import'},
        {kind:'stock_intent',...identity,warehouseId:request.inventoryWrite.warehouseId,stock:request.stock},
        {kind:'stock_receipt_observed',...identity,warehouseId:request.inventoryWrite.warehouseId,updated:true,itemCount:1,errorCount:0,inventoryReceiptRef:'receipt:synthetic:stock'}];
      for(const event of events) {
        if(beforeCheckpoint)await beforeCheckpoint({event:structuredClone(event),request});
        await persistCheckpoint(event);
        if(afterCheckpoint)await afterCheckpoint({event:structuredClone(event),request});
      }
      return {status:'accepted',taskId:identity.taskId,productId:identity.productId,offerId:request.merchantSku,
        requestReceiptRef:'receipt:synthetic:import',inventoryReceiptRef:'receipt:synthetic:stock'};
    },
    async readbackSellerApi(query) {return readback ? readback({query,request}) : exactObservation(request);}
  };
}
