import FormRevisionNotice, { useCandidateForm, useSubmit } from "./FormRevisionNotice.jsx";
import { buildC1RightsReviewInput, c1RightsReviewRequiresReplacement } from "../c1RightsReviewInput.js";

const RIGHTS_LABELS = { verified: "权利声明已明确", unknown: "尚未核实", blocked: "已发现权利风险", requires_authorization: "仍需取得许可", expired: "声明已过期", invalid: "声明与当前资料需要核对" };

function C1RightsReviewForm({ candidate, identity, onSave }) {
  const sku = candidate.lifecycleV11.skuPackage;
  const plan = sku.c1ProductPlan;
  const record = sku.c1RightsReviewRecord;
  const frozen = c1RightsReviewRequiresReplacement(plan);
  const [form, setForm, guard] = useCandidateForm(candidate, {
    c1PlanId: plan.c1PlanId, skuPackageId: sku.skuPackageId, brandStatus: "unknown", brandName: "",
    rightsChoice: "unknown", reviewedAt: "", expiresAt: "", confirmed: false, replaceFrozenPlan: false
  });
  const { saving, error, run } = useSubmit();
  const canSave = identity?.canSaveC1RightsReview === true && !saving && !guard.conflict && form.confirmed &&
    Boolean(form.reviewedAt) && Boolean(form.expiresAt) && (!frozen || form.replaceFrozenPlan) && Boolean(onSave);
  function field(name, value) {
    setForm(current => ({ ...current, [name]: value,
      rightsChoice: name === "brandStatus" ? "unknown" : name === "rightsChoice" ? value : current.rightsChoice,
      confirmed: name === "confirmed" ? value : false }));
  }
  function save(event) {
    event.preventDefault();
    return run(async () => {
      guard.assertCurrent();
      if (!canSave) throw new Error("请先登录主人身份，并完整核对本次声明");
      await onSave(buildC1RightsReviewInput({ candidate, form, sourceRevision: guard.sourceRevision }));
    });
  }
  return <form className="workflow-card c1-rights-review-form" onSubmit={save}>
    <h3>本件商品的品牌与权利声明</h3>
    <p>供应规格：{sku.supplierSkuId} · {sku.variantKey}。请根据这件商品的实际情况声明。</p>
    {record ? <p>最近保存：{RIGHTS_LABELS[candidate.c1ReviewPresentation?.rights?.status] || "声明待核对"}。以下新声明需要重新确认。</p> : <p>尚未保存独立声明；已有图片、类目或最终生产确认不能替代此项。</p>}
    <FormRevisionNotice guard={guard} disabled={saving} />
    {identity?.canSaveC1RightsReview !== true ? <p role="status">请先登录主人身份后保存声明。</p> : null}
    <fieldset disabled={saving || guard.conflict}>
      <label>品牌识别<select value={form.brandStatus} onChange={event => field("brandStatus", event.target.value)}>
        <option value="unknown">尚未核实</option><option value="branded">有品牌</option><option value="unbranded">明确无品牌</option>
      </select></label>
      {form.brandStatus === "branded" ? <label>品牌名称<input required maxLength={256} value={form.brandName} onChange={event => field("brandName", event.target.value)} /></label> : null}
      <label>权利情况<select value={form.rightsChoice} onChange={event => field("rightsChoice", event.target.value)}>
        <option value="unknown">尚未核实</option><option value="owned">我拥有所需权利</option><option value="licensed">我已获得所需许可</option>
        {form.brandStatus === "unbranded" ? <option value="no_third_party_rights_identified">已核对，未发现第三方权利</option> : null}
        <option value="requires_authorization">仍需取得许可</option><option value="blocked">已发现权利风险</option>
      </select></label>
      <label>核对时间（本机时区）<input type="datetime-local" required value={form.reviewedAt} onChange={event => field("reviewedAt", event.target.value)} /></label>
      <label>本次声明有效至（本机时区）<input type="datetime-local" required value={form.expiresAt} onChange={event => field("expiresAt", event.target.value)} /></label>
      <p>有效期按本件商品的实际依据填写。尚未核实、有风险或已过期的声明可保存，但不能据此继续制作或生产。</p>
      {frozen ? <label className="c2-owner-confirmation"><input type="checkbox" checked={form.replaceFrozenPlan} onChange={event => field("replaceFrozenPlan", event.target.checked)} /><span>当前C1计划已冻结。我确认生成新的替代计划，保留旧计划、证据和回执；原利润结果保持不变。</span></label> : null}
      <label className="c2-owner-confirmation"><input type="checkbox" checked={form.confirmed} onChange={event => field("confirmed", event.target.checked)} /><span>我确认以上品牌、权利情况和有效期对应当前商品及供应规格。</span></label>
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <button className="button primary" type="submit" disabled={!canSave}>{saving ? "正在保存声明…" : frozen ? "保存声明并生成替代计划" : "保存本件商品声明"}</button>
  </form>;
}

export default function C1RightsReviewPanel(props) {
  const sku = props.candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  if (!plan || typeof plan.c1PlanId !== "string" || !plan.inputSnapshots || typeof plan.inputSnapshots !== "object" || Array.isArray(plan.inputSnapshots)) {
    return <section className="workflow-card"><h3>品牌与权利声明暂不能保存</h3><p role="alert">当前C1资料不完整或已损坏，请先核对保存记录。</p></section>;
  }
  return <C1RightsReviewForm {...props} />;
}
