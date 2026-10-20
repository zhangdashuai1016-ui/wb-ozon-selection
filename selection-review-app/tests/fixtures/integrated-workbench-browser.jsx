import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { api } from '../../src/api.js';
import '../../src/styles.css';

const syntheticPassword = 'synthetic password for bounded saved DE HTTP tests';

/** The application and its APIs are unchanged; this bar only controls the isolated test session. */
function IntegratedWorkbenchBrowser() {
  const [sessionRevision, setSessionRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState(null);
  const submitLock = useRef(false);

  async function login() {
    if (submitLock.current) return;
    submitLock.current = true;
    setSaving(true); setError('');
    try {
      const access = await api.loginOwnerAccess({ password: syntheticPassword });
      if (access.providerType !== 'local_owner_password' || access.status !== 'authenticated') {
        throw new Error('合成登录没有返回已认证身份。');
      }
      setSessionRevision(value => value + 1);
    } catch (cause) { setError(cause.message); }
    finally { submitLock.current = false; setSaving(false); }
  }

  async function readEvidence() {
    setError('');
    try {
      const response = await fetch('/__integrated-fixture/evidence', { cache: 'no-store' });
      if (!response.ok) throw new Error(`隔离证据读取失败（${response.status}）。`);
      const next = await response.json();
      if (next.schemaVersion !== 'integrated-workbench-browser-evidence-v1') {
        throw new Error('隔离证据格式不符。');
      }
      setEvidence(next);
    } catch (cause) { setError(cause.message); }
  }

  function keepExternalLinksClosed(event) {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    const target = new URL(anchor.href, window.location.href);
    if (target.origin !== window.location.origin) {
      event.preventDefault();
      setError('隔离验收不打开外部网站；该商品来源链接仍由实际应用显示。');
    }
  }

  return <div onClickCapture={keepExternalLinksClosed}>
    <aside aria-label="隔离合成验收控制" style={{ padding: '12px 20px', borderBottom: '1px solid #cfd8d3' }}>
      <strong>整合工作台 · 隔离合成验收</strong>
      <p>下方是完整应用与真实本地 API，只使用合成记录。先登录合成账户；查看三色时切换到蛋蛋鼠店，再进入「进行中」。</p>
      <p>生产绑定、外部凭据和付费服务均为空；服务进程受操作系统沙箱约束。没有模拟店铺回执，也没有真实上架结果。</p>
      <button type="button" className="button secondary" disabled={saving} onClick={login}>
        {saving ? '正在登录…' : '登录合成账户'}
      </button>{' '}
      <button type="button" className="button secondary" onClick={readEvidence}>核对隔离证据</button>
      {error ? <p role="alert">{error}</p> : null}
      {evidence ? <pre aria-label="隔离运行证据">{JSON.stringify(evidence, null, 2)}</pre> : null}
    </aside>
    <App key={sessionRevision} />
  </div>;
}

const root = document.getElementById('root');
if (root === null) throw new Error('INTEGRATED_BROWSER_ROOT_MISSING');
createRoot(root).render(<React.StrictMode><IntegratedWorkbenchBrowser /></React.StrictMode>);
