import { useEffect, useId, useRef, useState } from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 'current-password' on sign-in, 'new-password' everywhere a password is being set. */
  autoComplete: 'current-password' | 'new-password';
  id?: string;
  required?: boolean;
  minLength?: number;
  disabled?: boolean;
  hint?: React.ReactNode;
}

/**
 * How long a revealed password stays revealed.
 *
 * Every other application can leave this to the user. This one cannot: it is a screen
 * recorder, and a password left in plain text on screen is a password that gets captured,
 * encoded and stored for seven days. Reverting on a timer bounds that window without
 * taking the feature away — the reason to reveal is to check what you typed, which takes
 * seconds, not minutes.
 */
const REVEAL_MS = 20_000;

export function PasswordField({
  label, value, onChange, autoComplete, id, required, minLength, disabled, hint,
}: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  function toggle() {
    setShown((v) => !v);
    // Focus goes back to the field: the point of revealing is to read or fix what is
    // there, and leaving focus on the button means the next keystroke goes nowhere.
    // preventScroll keeps a long form from jumping under the user.
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="password-field">
        <input
          ref={inputRef}
          id={inputId}
          // Swapping the type is what actually reveals the characters. It also drops the
          // browser's own reveal control in Edge and Safari, which is why this one exists.
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          disabled={disabled}
          // A revealed password must not be offered to spellcheck or autocorrect, both of
          // which send text off the device on some platforms.
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button
          type="button"
          className="reveal"
          onClick={toggle}
          disabled={disabled}
          // The accessible name states the action, and it changes with the state, so a
          // screen reader hears what pressing it will do rather than a bare "toggle".
          // aria-pressed is deliberately absent: with a label that already changes it
          // announces as "pressed, hide password", which reads as the opposite of the truth.
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          title={shown ? 'Hide' : 'Show'}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {shown && (
        <div className="hint">
          Visible on screen — and this app records the screen. Hiding again in a few seconds.
        </div>
      )}
      {hint}
    </div>
  );
}
