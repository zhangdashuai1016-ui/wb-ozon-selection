import { useEffect, useMemo, useState } from "react";
import { toggleLocalSupplierSkuSelection } from "../aSupplierCaptureSelection";

const SELLER_LABELS = {
  cross_border_cn: "中国跨境卖家",
  other_cross_border: "其他跨境卖家",
  unknown: "卖家身份未确认",
  local_ru: "俄罗斯本土卖家（仅背景）"
};

const EVIDENCE_STATUS_LABELS = {
  current: "当前可复用",
  waiting_context: "等待适用范围",
  metadata_only: "只有摘要",
  invalid: "证据无效",
  expired: "已经过期",
  scope_mismatch: "适用范围不匹配",
  missing: "尚未准备"
};

const CONTEXT_STATUS_LABELS = {
  available: "已确定",
  missing: "待系统确定",
  conflict: "存在冲突"
};

function dateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN");
}

function inputValue(field) {
  return field?.value ?? "";
}

function Field({ label, hint, children, wide = false }) {
  return (
    <label className={wide ? "span-2" : ""}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export default function RealAConfirmationCard({ card, onSubmit, disabled = false }) {
  const initial = useMemo(() => ({
    decision: "confirm",
    salesReview: {
      snapshotId: card.salesReview?.snapshotId || "",
      comparability: card.salesReview?.comparability || "unknown",
      validityStatus: card.salesReview?.validityStatus || "unknown",
      confidence: card.salesReview?.confidence || "unknown"
    },
    supplierConfirmation: {
      productUrl: inputValue(card.supplierConfirmation.productUrl),
      supplierSkuId: inputValue(card.supplierConfirmation.supplierSkuId),
      variantKey: inputValue(card.supplierConfirmation.variantKey),
      unitProductPrice: inputValue(card.supplierConfirmation.unitProductPrice),
      unitDomesticFreight: inputValue(card.supplierConfirmation.unitDomesticFreight),
      otherPurchaseCosts: inputValue(card.supplierConfirmation.otherPurchaseCosts),
      actualPurchaseCost: inputValue(card.supplierConfirmation.actualPurchaseCost),
      weightKg: inputValue(card.supplierConfirmation.weightKg),
      dimensionsCm: {
        length: inputValue(card.supplierConfirmation.dimensionsCm.length),
        width: inputValue(card.supplierConfirmation.dimensionsCm.width),
        height: inputValue(card.supplierConfirmation.dimensionsCm.height)
      },
      ownerSupplyConfirmed: false
    }
  }), [card]);
  const [form, setForm] = useState(initial);
  const [localSelectedSkuIds, setLocalSelectedSkuIds] = useState([]);

  useEffect(() => {
    setLocalSelectedSkuIds([]);
  }, [card.sourceCandidateId, card.sourceDataRevision, card.supplierCapture?.captureId]);

  function updateSupplier(key, value) {
    setForm((current) => ({
      ...current,
      supplierConfirmation: { ...current.supplierConfirmation, [key]: value }
    }));
  }

  function updateDimension(key, value) {
    setForm((current) => ({
      ...current,
      supplierConfirmation: {
        ...current.supplierConfirmation,
        dimensionsCm: { ...current.supplierConfirmation.dimensionsCm, [key]: value }
      }
    }));
  }

  function submit(decision) {
    onSubmit?.({ ...form, decision });
  }

  const sales = card.salesReview;
  const readiness = card.systemEvidenceReadiness;
  const preparationPlan = card.systemEvidencePreparationPlan;
  const supplierCapture = card.supplierCapture;
  const captureInProgress = ["waiting_extension", "capturing", "extension_version_mismatch"].includes(supplierCapture?.status);
  const captureReady = supplierCapture?.status === "captured_waiting_owner_selection";
  const systemReady = readiness?.ready === true;
  const prepareCount = (preparationPlan?.actions || []).filter((action) => action.action === "prepare_once").length;
  const reuseCount = (preparationPlan?.actions || []).filter((action) => action.action === "reuse").length;
  return (
    <section className="real-a-confirmation-card" aria-label="真实A阶段完整确认卡">
      <header>
        <div>
          <small>{card.cardVersion} · 修订 {card.sourceDataRevision}</small>
          <h3>A阶段完整确认卡</h3>
          <p>销售判断、精确供应SKU、成本和包装资料一次确认；不会连续弹出重复问题。</p>
        </div>
        <strong>{card.targetPlatform.toUpperCase()} · {card.targetStore}</strong>
      </header>

      <div className="real-a-sales-proof">
        <b>A销售快照</b>
        {sales ? (
          <>
            <span>{sales.title}</span>
            <span>当前价格 {sales.currentPrice} {sales.currency} · {SELLER_LABELS[sales.sellerType] || sales.sellerType}</span>
            <span>采集于 {new Date(sales.collectedAt).toLocaleString("zh-CN")} · 身份证据 {sales.sellerIdentityStatus}</span>
          </>
        ) : <span>没有有效销售快照，不能确认进入B。</span>}
      </div>

      <section className="real-a-ai-assist" aria-label="A阶段AI辅助判断">
        <b>Terra辅助整理</b>
        {sales?.terraAssist ? (
          <>
            <span>{sales.terraAssist.output?.summary || "已生成结构化辅助草稿"}</span>
            <small>模型 {sales.terraAssist.modelVersion} · 仅供参考，不覆盖页面价格、标题、类目或卖家身份。</small>
          </>
        ) : card.aiAssist?.status === "failed" ? (
          <>
            <span>AI整理已停止：{card.aiAssist.failure?.message || "技术失败"}</span>
            <small>商品业务结论未改变；没有换Sol，也没有自动重试。</small>
          </>
        ) : (
          <span>销售快照保存后由软件调用Terra一次；尚未生成辅助草稿。</span>
        )}
      </section>

      <section className="real-a-supplier-capture" aria-label="A阶段1688供应采集">
        <header>
          <div>
            <b>1688供应SKU只读采集</b>
            <span>短链由插件只打开一次；采集后只列出全部真实SKU，不自动选择或进入B。</span>
          </div>
          {supplierCapture?.status === "waiting_extension" ? <strong>等待插件后台领取</strong> : null}
          {supplierCapture?.status === "capturing" ? <strong>插件已领取 · 第1次采集</strong> : null}
          {supplierCapture?.status === "extension_version_mismatch" ? <strong>插件版本不匹配</strong> : null}
        </header>
        {supplierCapture?.status === "captured_waiting_owner_selection" ? (
          <>
            <p>已取得 offer {supplierCapture.offerId}，共 {supplierCapture.skuChoices.length} 个SKU；当前本地勾选 {localSelectedSkuIds.length} 个，尚未保存或确认供应方案。</p>
            <details>
              <summary>查看并临时多选全部SKU、页面直接价格和库存</summary>
              <div className="real-a-supplier-skus">
                {supplierCapture.skuChoices.map((sku) => (
                  <label key={sku.sourceSkuId}>
                    <input
                      type="checkbox"
                      checked={localSelectedSkuIds.includes(String(sku.sourceSkuId))}
                      onChange={(event) => setLocalSelectedSkuIds((current) => toggleLocalSupplierSkuSelection(current, sku.sourceSkuId, event.target.checked))}
                    />
                    <span>
                      <b>{sku.sourceSkuId}</b>
                      <em>{Object.entries(sku.attributes || {}).map(([key, value]) => `${key}：${value}`).join(" · ") || sku.propPath || "规格名称未取得"}</em>
                      <small>直接价格：{sku.priceCny ?? "未取得"}{sku.priceCny !== null ? " CNY" : ""} · 库存：{sku.stock ?? "未取得"}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
            <small>本地勾选只帮助你比较规格；本轮不会调用接口、保存选择、确认供应方案或进入B/C1。</small>
          </>
        ) : supplierCapture?.status === "capturing" ? (
          <p>插件后台已经领取当前单候选作业，正在执行唯一一次只读采集；无需主人或Codex继续点击。</p>
        ) : supplierCapture?.status === "extension_version_mismatch" ? (
          <p>{supplierCapture.reason || "当前插件版本与作业要求不一致；作业不会被领取，也不会打开1688。"}</p>
        ) : ["failed", "unknown_outcome"].includes(supplierCapture?.status) ? (
          <div className="real-a-capture-failure">
            <strong>{supplierCapture.failureDestinationLabel ? `采集停在：${supplierCapture.failureDestinationLabel}` : "本次采集已停止"}</strong>
            <p>{supplierCapture.reason || "上次采集已停止；A阶段业务状态未改变。"}</p>
            <small>登录页／人机验证页／移动页／中间跳转页／详情页加载超时／标签不可读取／地址未就绪／其他非白名单页面／不同商品会分别显示；不会保存完整跳转地址、查询参数或页面内容。</small>
          </div>
        ) : (
          <p>在本卡保存或确认1688供应链接后，服务端会自动建立单候选作业；插件后台领取，无需额外点击采集。</p>
        )}
      </section>

      <div className="real-a-form-grid">
        <Field label="商品可比性">
          <select value={form.salesReview.comparability} onChange={(event) => setForm((current) => ({ ...current, salesReview: { ...current.salesReview, comparability: event.target.value } }))}>
            <option value="unknown">尚未判断</option>
            <option value="comparable">确认合理可比</option>
            <option value="not_comparable">确认不可比</option>
          </select>
        </Field>
        <Field label="销售快照时效">
          <select value={form.salesReview.validityStatus} onChange={(event) => setForm((current) => ({ ...current, salesReview: { ...current.salesReview, validityStatus: event.target.value } }))}>
            <option value="unknown">尚未核验</option>
            <option value="current">当前有效</option>
            <option value="stale">已经过期</option>
          </select>
        </Field>
        <Field label="1688供应链接" wide hint="可先保存qr短链；插件采集成功后必须回填并锁定准确detail链接。">
          <input value={form.supplierConfirmation.productUrl} onChange={(event) => updateSupplier("productUrl", event.target.value)} />
        </Field>
        <Field label="具体供应SKU">
          <input value={form.supplierConfirmation.supplierSkuId} onChange={(event) => updateSupplier("supplierSkuId", event.target.value)} />
        </Field>
        <Field label="规格/变体">
          <input value={form.supplierConfirmation.variantKey} onChange={(event) => updateSupplier("variantKey", event.target.value)} />
        </Field>
        <Field label="商品价（元/件）">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.unitProductPrice} onChange={(event) => updateSupplier("unitProductPrice", event.target.value)} />
        </Field>
        <Field label="国内运费（元/件）" hint="未知保持空白；确认免运费时才填0。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.unitDomesticFreight} onChange={(event) => updateSupplier("unitDomesticFreight", event.target.value)} />
        </Field>
        <Field label="其他采购费用（元/件）" hint="没有其他费用时明确填0。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.otherPurchaseCosts} onChange={(event) => updateSupplier("otherPurchaseCosts", event.target.value)} />
        </Field>
        <Field label="实际采购成本（元/件）" hint="必须等于商品价＋国内运费＋其他采购费用。">
          <input type="number" min="0" step="0.01" value={form.supplierConfirmation.actualPurchaseCost} onChange={(event) => updateSupplier("actualPurchaseCost", event.target.value)} />
        </Field>
        <Field label="实际打包重量（kg）">
          <input type="number" min="0" step="0.001" value={form.supplierConfirmation.weightKg} onChange={(event) => updateSupplier("weightKg", event.target.value)} />
        </Field>
        {[["length", "长（cm）"], ["width", "宽（cm）"], ["height", "高（cm）"]].map(([key, label]) => (
          <Field key={key} label={label}>
            <input type="number" min="0" step="0.1" value={form.supplierConfirmation.dimensionsCm[key]} onChange={(event) => updateDimension(key, event.target.value)} />
          </Field>
        ))}
      </div>

      <label className="real-a-owner-confirmation">
        <input type="checkbox" checked={form.supplierConfirmation.ownerSupplyConfirmed} onChange={(event) => updateSupplier("ownerSupplyConfirmed", event.target.checked)} />
        <span>我确认以上链接、供应SKU、价格、费用、重量和尺寸属于同一个采购方案。</span>
      </label>

      <section className={`real-a-evidence-panel ${systemReady ? "is-ready" : "has-gap"}`} aria-label="B阶段系统证据准备情况">
        <header>
          <div>
            <strong>{systemReady ? "系统B证据已齐" : "确认后由系统准备B证据"}</strong>
            <span>{systemReady ? "确认供应方案后自动计算B，达标即创建C1。" : "同一次确认会只读准备佣金、物流、汇率和Schema，不要求主人另点一次。"}</span>
          </div>
          <b>{systemReady ? "可直接进入B" : "确认后自动准备"}</b>
        </header>

        {preparationPlan ? (
          <div className="real-a-evidence-plan">
            <strong>系统准备方式</strong>
            <span>沿用当前证据 {reuseCount} 类 · 需要只读准备 {prepareCount} 类</span>
            <small>{preparationPlan.status === "blocked_context" ? "先锁定适用范围，当前不会调用提供器。" : "每类缺口最多调用一次；任何失败立即停止，不自动重试，也不提交半套证据。"}</small>
          </div>
        ) : null}

        <div className="real-a-evidence-context">
          <strong>证据适用范围</strong>
          <div>
            {(readiness?.context?.fields || []).map((field) => (
              <span key={field.key} className={`status-${field.status}`}>
                <small>{field.label}</small>
                <b>{field.value || CONTEXT_STATUS_LABELS[field.status] || "待确定"}</b>
                <em>{CONTEXT_STATUS_LABELS[field.status] || field.status}</em>
              </span>
            ))}
          </div>
        </div>

        <div className="real-a-evidence-list">
          {(readiness?.fields || []).map((field) => (
            <article key={field.key} className={`evidence-${field.status}`}>
              <div>
                <strong>{field.label}</strong>
                <span>{field.message}</span>
              </div>
              <b>{EVIDENCE_STATUS_LABELS[field.status] || field.status}</b>
              {field.available ? (
                <small>取得 {dateTime(field.checkedAt)} · 有效至 {dateTime(field.expiresAt)}</small>
              ) : null}
            </article>
          ))}
        </div>

        {!systemReady ? (
          <footer>
            <span>当前需由系统准备：{readiness?.missing?.join("、") || "结构化系统证据"}。</span>
            <small>确认后每类只读一次；任一来源失败立即停止，不改变商品状态，也不保存半套证据。</small>
          </footer>
        ) : null}
      </section>

      <div className="real-a-actions">
        <button className="button secondary" type="button" disabled={disabled || !onSubmit || captureInProgress} onClick={() => submit("reject")}>淘汰商品</button>
        <button className="button primary" type="button" disabled={disabled || !onSubmit || captureInProgress || card.blockedByException} onClick={() => submit("confirm")}>
          {captureReady ? "一次确认并进入B" : "保存A卡并等待插件自动采集"}
        </button>
      </div>
      {!onSubmit ? <p className="real-a-not-live">当前确认服务不可用；不会改变商品状态。</p> : null}
    </section>
  );
}
