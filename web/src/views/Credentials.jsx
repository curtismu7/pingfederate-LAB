import { useEffect, useRef, useState } from 'react';
import SecretInput from './SecretInput.jsx';
import { api } from '../api.js';
import FloatingDialog from '../floating-dialog/FloatingDialog';

const IDP = 'PingFederate';

// The lab's sign-in dialog, in the shape of the family's standard pi.flow sign-in modal (title bar "Sign in", a hero
// with the welcome line, Username and Password, Sign in and Cancel at the foot). The username and password go to the
// lab server, which posts them to PingFederate's Authentication API (checkUsernamePassword); nothing redirects. The password field is uncontrolled and emptied on every submit.
// initialUsername: the login_hint the run sent, so the person types only the password. Cancel closes the dialog;
// the run keeps waiting and a "Sign in" button reopens it. The frame is the shared FloatingDialog (owner 2026-11-09): drag
// it by its title bar, resize it or pop it out. It does not block the page (noBackdrop): the trace behind it stays readable.
// mock: the run is on the lab's mock PingFederate; the dialog then shows the mock's demo user (it exists only there).
export default function Credentials({ onSubmit, busy, refused, idPrefix = 'cred', initialUsername = '', mock = false }) {
  const [demo, setDemo] = useState(null);
  useEffect(() => {
    if (!mock) return;
    api.mode().then((r) => setDemo(r.ok ? r.data?.mockSignIn : null));
  }, [mock]);
  const [open, setOpen] = useState(true);
  const [username, setUsername] = useState(initialUsername);
  const [hasPassword, setHasPassword] = useState(false);
  const passwordRef = useRef(null);
  const userRef = useRef(null);
  const reopenRef = useRef(null);
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const close = () => { setOpen(false); };
  useEffect(() => {
    if (!open) { reopenRef.current?.focus(); return undefined; }
    (initialUsername ? passwordRef.current : userRef.current)?.focus();
    // Escape cancels. The dialog is not modal: Tab can leave it to read the trace behind it.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => opener.current?.focus?.(), []);
  // A refused password: back to the password field.
  useEffect(() => { if (refused && open) passwordRef.current?.focus(); }, [refused]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event) => {
    event.preventDefault();
    const typed = passwordRef.current?.value ?? '';
    if (passwordRef.current) passwordRef.current.value = '';
    setHasPassword(false);
    await onSubmit({ username, password: typed });
  };

  if (!open) {
    return (
      <p className="creds-reopen" role="status">
        {IDP} is waiting for a username and password.{' '}
        <button type="button" className="primary" ref={reopenRef} onClick={() => setOpen(true)}>Sign in</button>
      </p>
    );
  }
  return (
    <FloatingDialog isOpen noBackdrop onClose={close} title="Sign in" closeAriaLabel="Close sign-in" footer={null}
      className="signin-modal" defaultWidth={440} defaultHeight={null} defaultY={72} minHeight={240}>
        <div className="signin-modal__hero">
          <p className="signin-modal__welcome">Welcome back</p>
          <p className="signin-modal__brand">{IDP} <span>pi.flow</span></p>
        </div>
        <form id={`${idPrefix}-form`} className="signin-modal__form" onSubmit={submit} aria-label="Sign-in form">
          <label htmlFor={`${idPrefix}-user`}>Username</label>
          <input id={`${idPrefix}-user`} ref={userRef} type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={256} />
          <label htmlFor={`${idPrefix}-pass`}>Password</label>
          <SecretInput id={`${idPrefix}-pass`} ref={passwordRef} autoComplete="current-password" defaultValue="" required maxLength={1024} onInput={(e) => setHasPassword(Boolean(e.currentTarget.value))} />
          {demo && <p className="signin-modal__mock" data-testid="mock-user">{demo.allowed
            ? <>Mock PingFederate: sign in as <strong className="mono">{demo.username}</strong> with password <strong className="mono">{demo.password}</strong>. This user exists only in the mock.</>
            : demo.refusal}</p>}
          {refused && <p className="signin-modal__error" role="alert">❌ {IDP} refused the username or password. Try again.</p>}
          <p className="hint">This dialog is the lab&apos;s own: it posts to {IDP}&apos;s Authentication API. Nothing redirects to {IDP}.</p>
        </form>
        <div className="signin-modal__actions">
          <button type="submit" form={`${idPrefix}-form`} className="primary" disabled={busy || !username || !hasPassword}>{busy ? 'Signing in' : 'Sign in'}</button>
          <button type="button" onClick={close}>Cancel</button>
        </div>
    </FloatingDialog>
  );
}
