import { useRef, useState } from "react";
import { newDraft, receiveDraft, createSubmitLock } from "../formState.js";

export function useCandidateForm(record, initial) {
  const [draft, setDraft] = useState(() => newDraft(record, initial));
  const current = receiveDraft(draft, record, initial);
  if (current !== draft) setDraft(current);
  const conflict = current.id === record.id && current.revision !== record.dataRevision;
  function setValue(update) {
    setDraft(previous => ({ ...previous, dirty: true, value: typeof update === "function" ? update(previous.value) : update }));
  }
  return [current.value, setValue, {
    conflict,
    sourceRevision: current.revision,
    reload: () => setDraft(newDraft(record, initial)),
    assertCurrent() { if (conflict) throw new Error("数据已更新。当前编辑已保留，请核对并载入新版后重新确认；未提交旧内容。"); }
  }];
}

export function useSubmit() {
  const lock = useRef(createSubmitLock());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function run(action) {
    return lock.current(async () => {
    setSaving(true);
    setError("");
    try { return await action(); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
    });
  }
  return { saving, error, run };
}

export default function FormRevisionNotice({ guard, disabled = false }) {
  if (!guard.conflict) return null;
  return <div className="form-error" role="alert">
    数据已更新，当前编辑仍保留在旧修订 {guard.sourceRevision}。提交已暂停，请先核对新版。
    <button type="button" disabled={disabled} onClick={guard.reload}>放弃当前编辑并载入新版</button>
  </div>;
}
