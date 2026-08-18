function money(value, currency) {
  if (value === null || value === undefined) return "缺失";
  return `${value} ${currency || ""}`.trim();
}

function dimensions(value) {
  if (!value) return "缺失";
  return `${value.length}×${value.width}×${value.height}cm`;
}

function classificationLabel(value) {
  if (value === "A") return "A类 · 可以直接进入";
  if (value === "B") return "B类 · 补少量资料即可";
  return "C类 · 当前不适合作为首个测试";
}

export default function LifecycleEntryPreview({ preview }) {
  if (!preview?.readOnly || preview.available === false) return null;
  const sales = preview.salesEvidence || {};
  const supply = preview.supplierEvidence || {};
  const readiness = preview.readiness || {};
  return (
    <section className="lifecycle-entry-preview" aria-label="新版生命周期只读接入预览">
      <header>
        <div>
          <small>{preview.previewVersion} · 不改变当前商品状态</small>
          <h3>新版流程接入体检</h3>
        </div>
        <strong>{classificationLabel(readiness.classification)}</strong>
      </header>
      <div className="lifecycle-entry-grid">
        <div>
          <span>销售快照</span>
          <strong>{sales.schemaValid ? `${money(sales.currentPrice, sales.currency)} · ${sales.sellerType}` : "缺失"}</strong>
          <small>{sales.schemaValid ? `采集于 ${new Date(sales.collectedAt).toLocaleString("zh-CN")}` : "没有有效快照"}</small>
        </div>
        <div>
          <span>供应链接 / SKU</span>
          <strong>{supply.sourceUrl ? "链接已有" : "链接缺失"} · {supply.supplierSkuId || "SKU未锁定"}</strong>
          <small>不会从到手总价倒推货价或国内运费</small>
        </div>
        <div>
          <span>采购数据</span>
          <strong>{money(supply.actualPurchaseCost, supply.actualPurchaseCostCurrency)}</strong>
          <small>货价 {money(supply.unitProductPrice, "CNY")} · 国内运费 {money(supply.unitDomesticFreight, "CNY")}</small>
        </div>
        <div>
          <span>包装数据</span>
          <strong>{supply.packedWeightKg ? `${supply.packedWeightKg}kg` : "重量缺失"} · {dimensions(supply.dimensionsCm)}</strong>
          <small>主人供应确认：{supply.ownerSupplyConfirmationStatus === "confirmed" ? "已结构化确认" : "尚未结构化确认"}</small>
        </div>
      </div>
      <div className="lifecycle-entry-gaps">
        <strong>{readiness.canEnterB ? "资料已齐，可以进入B" : `进入B前还缺 ${readiness.missing?.length || 0} 项`}</strong>
        {readiness.missing?.length ? (
          <ul>
            {readiness.missing.map((item) => (
              <li key={item.key}><b>{item.label}</b>：{item.reason}</li>
            ))}
          </ul>
        ) : null}
        <p>{readiness.nextAction}</p>
      </div>
    </section>
  );
}
