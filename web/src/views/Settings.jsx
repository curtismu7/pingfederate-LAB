import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import SecretInput from './SecretInput.jsx';

// Every setting by its plain name, grouped per card. Secrets are write-only: the server says only whether one is
// set; the field is never prefilled, and an empty field keeps the stored secret.
export const SECTIONS = [
  ['pf', 'Your PingFederate'], ['signin', 'Sign in'], ['dcr', 'Dynamic client registration'], ['rar', 'RAR via PAR'],
  ['rarDpop', 'RAR bound to DPoP'], ['ciba', 'CIBA'], ['dpop', 'DPoP sign-in'], ['tokenExchange', 'Token exchange'],
  ['par', 'PAR'], ['pkce', 'PKCE'], ['links', 'Sibling apps'],
];
const FIELDS = {
  issuer: 'Issuer (https)', redirectUri: 'Redirect URI registered at PingFederate (never visited under pi.flow)',
  clientId: 'Client ID', clientSecret: 'Client secret (empty for a public client)', scope: 'Scopes',
  iatClientId: 'Registering client ID (may get dcr:register)', iatClientSecret: 'Registering client secret',
  clientScope: 'Scope the new client may have', forbiddenScope: 'Scope the new client must be refused',
  agentExchangeClientId: 'Exchange 1 client ID', agentExchangeClientSecret: 'Exchange 1 client secret',
  mcpExchangeClientId: 'Exchange 2 client ID', mcpExchangeClientSecret: 'Exchange 2 client secret',
  agentActorClientId: 'AI agent actor client ID', agentActorClientSecret: 'AI agent actor client secret', agentActorScope: 'AI agent actor scope',
  mcpActorClientId: 'Tool-service actor client ID', mcpActorClientSecret: 'Tool-service actor client secret', mcpActorScope: 'Tool-service actor scope',
  intermediateAudience: 'Expected audience after exchange 1 (optional)', finalAudience: 'Expected audience after exchange 2 (optional)',
  approverSecret: 'Approval secret (shared with PingFederate\'s web approver; lets this card approve on its page)',
  sourceAccount: 'Transfer from account (one of the user\'s own)', destinationAccount: 'Transfer to account (one of the user\'s own)',
  cimdLabUrl: 'CIMD Lab address', idJagUrl: 'ID-JAG Standalone address',
};
const isSecret = (v) => v !== null && typeof v === 'object' && 'set' in v;

export default function Settings({ focus, onChanged, warnings = [] }) {
  const [view, setView] = useState(null);
  const [values, setValues] = useState({});
  const [clears, setClears] = useState({});
  const [status, setStatus] = useState(null);
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const formRef = useRef(null);
  const checkRef = useRef(null);
  // Secret fields are uncontrolled: typed secrets are read from the inputs on Save and the fields emptied after.
  const secretRefs = useRef({});
  const clearSecretFields = () => { for (const el of Object.values(secretRefs.current)) if (el) el.value = ''; };

  const load = async () => {
    const r = await api.settings();
    if (!r.ok) { setStatus({ tone: 'error', text: `${r.data?.error || 'error'}: could not read the settings` }); return; }
    setView(r.data);
    const v = {};
    for (const [section, fields] of Object.entries(r.data.settings)) for (const [f, value] of Object.entries(fields)) if (!isSecret(value)) v[`${section}.${f}`] = value;
    setValues(v); setClears({});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!view || !focus) return;
    const el = document.getElementById(`set-${focus}`);
    if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }); }
  }, [view, focus]);

  const save = async (event) => {
    event.preventDefault();
    const patch = {};
    const put = (key, value) => { const [s, f] = key.split('.'); (patch[s] ||= {})[f] = value; };
    for (const [section, fields] of Object.entries(view.settings)) {
      for (const [f, original] of Object.entries(fields)) {
        const key = `${section}.${f}`;
        if (isSecret(original)) {
          if (clears[key]) put(key, null);
          else if (secretRefs.current[key]?.value) put(key, secretRefs.current[key].value);
        } else if (values[key] !== original) put(key, values[key]);
      }
    }
    if (!Object.keys(patch).length) { setStatus({ tone: 'info', text: 'Nothing changed.' }); return; }
    const r = await api.saveSettings(patch);
    clearSecretFields();
    if (!r.ok) { setStatus({ tone: 'error', text: `${r.data?.error || 'error'}${r.data?.field ? ` (${r.data.field})` : ''}: ${r.data?.message || 'not saved'}` }); return; }
    setStatus({ tone: 'accepted', text: 'Saved.' });
    await load();
    onChanged?.();
  };

  const runCheck = async () => {
    setChecking(true);
    const r = await api.discovery();
    setChecking(false);
    setCheck(r);
  };

  // The answer renders below every setting, far off screen; take the person to it.
  useEffect(() => {
    if (!check || !checkRef.current) return;
    checkRef.current.scrollIntoView?.({ block: 'start' });
    checkRef.current.focus({ preventScroll: true });
  }, [check]);

  if (!view) return <p>{status?.text || 'Loading settings...'}</p>;
  return (
    <section aria-labelledby="settings-title" className="settings">
      <p className="crumbs"><a href="#/">Back to the shelf</a></p>
      <h2 id="settings-title">Settings</h2>
      {warnings.length > 0 && (
        <ul className="points" aria-label="customer.config warnings">
          {warnings.map((w) => <li key={w} className="pt pt-refused">customer.config: {w}</li>)}
        </ul>
      )}
      <p className="hint">Stored by the lab server in its settings file (mode 600). Secrets are write-only: this page never shows them, and an empty secret field keeps the one stored.</p>
      <form ref={formRef} onSubmit={save}>
        {SECTIONS.filter(([s]) => view.settings[s]).map(([section, label]) => (
          <fieldset key={section} className="set-group">
            <legend>{label}</legend>
            {Object.entries(view.settings[section]).map(([f, value]) => {
              const key = `${section}.${f}`;
              const id = `set-${key}`;
              if (isSecret(value)) {
                return (
                  <div key={key} className="set-row">
                    <label htmlFor={id}>{FIELDS[f] || f} <span className={`chip ${value.set ? 'chip-done' : 'chip-idle'}`}>{value.set ? 'set' : 'not set'}</span></label>
                    <SecretInput id={id} autoComplete="new-password" defaultValue="" ref={(el) => { secretRefs.current[key] = el; }} placeholder={value.set ? 'leave empty to keep the stored secret' : 'not set'}
                      disabled={Boolean(clears[key])} />
                    {value.set && <label className="check small"><input type="checkbox" checked={Boolean(clears[key])} onChange={(e) => setClears((c) => ({ ...c, [key]: e.target.checked }))} /> Clear it</label>}
                  </div>
                );
              }
              return (
                <div key={key} className="set-row">
                  <label htmlFor={id}>{FIELDS[f] || f}</label>
                  <input id={id} type="text" value={values[key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} spellCheck={false} />
                </div>
              );
            })}
          </fieldset>
        ))}
        <div className="run-actions sticky-actions">
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={runCheck} disabled={checking || !view.ready?.discovery}>{checking ? 'Checking...' : 'Check PingFederate'}</button>
          {status && <span className={`pt pt-${status.tone}`} role="status">{status.text}</span>}
        </div>
      </form>
      {check && (
        <section className="check-result" aria-label="PingFederate check" ref={checkRef} tabIndex={-1}>
          {!check.ok ? (
            <p className="pt pt-error" role="alert"><code>{check.data?.error || `HTTP ${check.status}`}</code>{check.data?.message ? `: ${check.data.message}` : ''}</p>
          ) : (
            <>
              <h3>Found at {check.data.issuer}</h3>
              <dl>
                {Object.entries(check.data.endpoints).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v || 'not advertised'}</dd></div>)}
              </dl>
              <ul className="points">
                {check.data.features.map((f) => <li key={f.id} className={`pt pt-${f.supported ? 'accepted' : 'info'}`}><span className="pt-tag">{f.supported ? 'yes' : 'no'}</span> {f.label}</li>)}
              </ul>
            </>
          )}
        </section>
      )}
    </section>
  );
}
