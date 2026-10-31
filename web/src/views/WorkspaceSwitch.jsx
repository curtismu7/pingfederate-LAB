import { useEffect, useState } from 'react';
import { WORKSPACE_RE } from '../api.js';

// Rule 13: the header names the current workspace and lets the presenter switch to another (or start a new one).
// Each workspace has its own sign-in, runs and trace; Reset clears the current one only. Enter or leaving the field
// switches; the page reloads so nothing from the old workspace stays on screen.
export default function WorkspaceSwitch({ current, known = [], onChoose }) {
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  const valid = WORKSPACE_RE.test(draft);
  const commit = () => {
    if (draft === current) return;
    if (valid) onChoose(draft); else setDraft(current);
  };
  return (
    <label className="workspace-switch">Workspace
      <input className="workspace-switch__input" list="workspace-names" value={draft} maxLength={32} spellCheck={false} aria-invalid={!valid}
        aria-describedby="workspace-hint" onChange={(e) => setDraft(e.target.value.toLowerCase())} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      <datalist id="workspace-names">{known.map((w) => <option key={w} value={w} />)}</datalist>
      <span id="workspace-hint" className="workspace-switch__hint">Lowercase letters, digits and hyphens. Each workspace has its own sign-in and runs.</span>
    </label>
  );
}
