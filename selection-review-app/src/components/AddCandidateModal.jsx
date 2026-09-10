import { useCallback, useEffect, useRef, useState } from "react";
import { optionalNumber } from "../formState.js";
import { useSubmit } from "./FormRevisionNotice.jsx";
import { useDialogFocus } from "./useDialogFocus.js";
import { CloseIcon } from "./Icons";

const emptyForm = {
  targetStore: "dandanshu",
  productUrl: "",
  productName: "",
  sourceUrl: "",
  competitorUrl: "",
  purchasePriceRmb: "",
  moq: "",
  netWeightKg: "",
  packedWeightKg: "",
  length: "",
  width: "",
  height: "",
  materialsAndAge: "",
  powered: "unknown",
  expectedPriceRub: "",
  acceptedTestRisk: false,
  imageUrl: "",
  notes: ""
};

export function candidateCreateInput(form) {
  return {
    targetStore: form.targetStore,
    productUrl: form.productUrl,
    productName: form.productName,
    sourceUrl: form.sourceUrl,
    competitorUrl: form.competitorUrl,
    imageUrl: form.imageUrl,
    materialsAndAge: form.materialsAndAge,
    notes: form.notes,
    purchasePriceRmb: optionalNumber(form.purchasePriceRmb),
    domesticShippingRmb: null,
    moq: optionalNumber(form.moq),
    netWeightKg: optionalNumber(form.netWeightKg),
    packedWeightKg: optionalNumber(form.packedWeightKg),
    expectedPriceRub: optionalNumber(form.expectedPriceRub),
    acceptedTestRisk: form.acceptedTestRisk,
    powered: form.powered === "false" ? false : form.powered === "true" ? true : form.powered,
    dimensionsCm: {
      length: optionalNumber(form.length),
      width: optionalNumber(form.width),
      height: optionalNumber(form.height)
    }
  };
}

export default function AddCandidateModal({ open, onClose, onSave }) {
  const [form, setForm] = useState(emptyForm);
  const { saving, error, run } = useSubmit();
  const dialogRef = useRef(null);
  const close = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);
  useDialogFocus(dialogRef, open, close);

  useEffect(() => {
    if (open) {
      setForm(emptyForm);
    }
  }, [open]);

  if (!open) return null;

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    return run(async () => {
      await onSave(candidateCreateInput(form));
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="add-title">添加我找到的商品</h2>
            <p>只需填写目标店铺和商品链接；不知道的字段可以留空。</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭">
            <CloseIcon />
          </button>
        </header>

        <form onSubmit={submit} className="modal-form">
          <div className="required-grid">
            <label>
              目标店铺 <em>必填</em>
              <select value={form.targetStore} onChange={(e) => update("targetStore", e.target.value)}>
                <option value="dandanshu">蛋蛋鼠</option>
                <option value="miska">Miska</option>
                <option value="wb">WB</option>
              </select>
            </label>
            <label>
              商品链接 <em>必填</em>
              <input
                required
                type="url"
                value={form.productUrl}
                onChange={(e) => update("productUrl", e.target.value)}
                placeholder="1688、拼多多或俄区商品链接"
              />
            </label>
          </div>

          <details>
            <summary>可选资料</summary>
            <p className="form-defaults">合规、授权和包材成本须由正式证据与配置确认；普通资料提交不会清空风险。</p>
            <div className="form-grid">
              <label>
                商品名称
                <input value={form.productName} onChange={(e) => update("productName", e.target.value)} />
              </label>
              <label>
                1688/拼多多货源链接
                <input type="url" value={form.sourceUrl} onChange={(e) => update("sourceUrl", e.target.value)} />
              </label>
              <label className="span-2">
                俄区竞品链接
                <input type="url" value={form.competitorUrl} onChange={(e) => update("competitorUrl", e.target.value)} />
              </label>
              <label>
                采购到手总价（含国内运费，RMB）
                <input type="text" inputMode="decimal" value={form.purchasePriceRmb} onChange={(e) => update("purchasePriceRmb", e.target.value)} />
                <small>填写实际到手总成本；如果不知道货价与国内运费各是多少，两项组成保持未确认，不会把运费冒充为0，也不会重复扣费。</small>
              </label>
              <label>
                MOQ
                <input type="text" inputMode="numeric" value={form.moq} onChange={(e) => update("moq", e.target.value)} />
              </label>
              <label>
                裸重（kg）
                <input type="text" inputMode="decimal" value={form.netWeightKg} onChange={(e) => update("netWeightKg", e.target.value)} />
              </label>
              <label>
                打包重量（kg）
                <input type="text" inputMode="decimal" value={form.packedWeightKg} onChange={(e) => update("packedWeightKg", e.target.value)} />
              </label>
              <fieldset className="dimensions span-2">
                <legend>包装长宽高（cm）</legend>
                {["length", "width", "height"].map((field, index) => (
                  <input
                    key={field}
                    aria-label={["长", "宽", "高"][index]}
                    type="text"
                    inputMode="decimal"
                    placeholder={["长", "宽", "高"][index]}
                    value={form[field]}
                    onChange={(e) => update(field, e.target.value)}
                  />
                ))}
              </fieldset>
              <label className="span-2">
                材质 / 适龄
                <input value={form.materialsAndAge} onChange={(e) => update("materialsAndAge", e.target.value)} />
              </label>
              <label>
                是否带电
                <select value={form.powered} onChange={(e) => update("powered", e.target.value)}>
                  <option value="unknown">不确定</option>
                  <option value="false">否，完全非电</option>
                  <option value="true">是，需要核验平台和线路</option>
                </select>
                <small>带电不直接淘汰，由软件按正式证据核验平台与线路</small>
              </label>
              <label>
                预期俄区售价（RUB）
                <input type="text" inputMode="numeric" value={form.expectedPriceRub} onChange={(e) => update("expectedPriceRub", e.target.value)} />
              </label>
              <label className="checkbox-label span-2">
                <input type="checkbox" checked={form.acceptedTestRisk} onChange={(e) => update("acceptedTestRisk", e.target.checked)} />
                我明确接受不足5个同规格竞品的测试风险
              </label>
              <label className="span-2">
                图片链接
                <input type="url" value={form.imageUrl} onChange={(e) => update("imageUrl", e.target.value)} />
              </label>
              <label className="span-2">
                备注
                <textarea rows="3" value={form.notes} onChange={(e) => update("notes", e.target.value)} />
              </label>
            </div>
          </details>

          {error && <div className="form-error" role="alert">{error}</div>}
          <footer className="modal-actions">
            <button type="button" className="button secondary" onClick={close}>取消</button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? "保存中…" : "保存商品资料"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
