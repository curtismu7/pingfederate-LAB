import { forwardRef, useState } from 'react';

// A password field with a Show button. While a password field has focus, macOS turns on Secure Input, which blocks
// clipboard managers and other tools that paste by sending keystrokes; Show makes it a plain text field so they
// can paste. The field stays uncontrolled: its value is never in React state or in a value attribute.
const SecretInput = forwardRef(function SecretInput({ id, ...props }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-input">
      <input id={id} ref={ref} type={shown ? 'text' : 'password'} spellCheck={false} {...props} />
      <button type="button" aria-controls={id} aria-pressed={shown} onClick={() => setShown((s) => !s)} disabled={props.disabled}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
});

export default SecretInput;
