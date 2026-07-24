// Student Hub shared UI — the "law library" design system.
// Source of truth: docs/student-hub/student-hub-design.md. Flat colors,
// 2px radii, hairline rules, no shadows, no gradients; serif for content,
// letterspaced sans for chrome, mono for transcript apparatus.

import type { ReactNode, CSSProperties, ButtonHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { T } from './theme';

/** Pulse for the live mic; disabled wholesale under prefers-reduced-motion. */
export function HubStyles() {
  return (
    <style>{`
      @keyframes hubPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(122,46,46,0.45); } 50% { box-shadow: 0 0 0 8px rgba(122,46,46,0); } }
      @media (prefers-reduced-motion: reduce) { .student-hub-root * { animation: none !important; } }
    `}</style>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontFamily: T.sans, fontSize: 11, fontWeight: 700,
      letterSpacing: '0.14em', textTransform: 'uppercase', color: T.brass,
    }}>
      {children}
    </div>
  );
}

/** Case-caption header band: greenDark, brass 3px rule, italic serif title.
 *  `backTo` puts the persistent paper back-arrow at the head of the kicker. */
export function CaseCaption({ kicker, title, citation, backTo }: {
  kicker: string;
  title: string;
  citation?: string;
  backTo?: string;
}) {
  // Set the "v." small and non-italic, as in a printed caption.
  const parts = title.split(/ v\.? /);
  return (
    <header style={{ background: T.greenDark, borderBottom: `3px solid ${T.brass}`, padding: '24px 24px 18px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        <Kicker>
          {backTo && (
            <Link
              to={backTo}
              aria-label="Back"
              style={{ color: T.paper, textDecoration: 'none', marginRight: 14, fontSize: 14 }}
            >
              ←
            </Link>
          )}
          {kicker}
        </Kicker>
        <h1 style={{
          fontFamily: T.serif, fontSize: 'clamp(22px, 4vw, 30px)', color: T.paper,
          fontStyle: 'italic', fontWeight: 400, margin: '0.2em 0 0',
        }}>
          {parts.length === 2 ? (
            <>{parts[0]} <span style={{ fontStyle: 'normal', fontSize: '0.7em', opacity: 0.7 }}>v.</span> {parts[1]}</>
          ) : title}
        </h1>
        {citation && (
          <div style={{ fontFamily: T.serif, fontSize: 13, color: 'rgba(250,248,242,0.65)', marginTop: 4 }}>
            {citation}
          </div>
        )}
      </div>
    </header>
  );
}

export function HubTab({ label, active, onClick }: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none', border: 'none', cursor: 'pointer',
        background: active ? T.green : 'transparent',
        color: active ? T.paper : T.green,
        fontFamily: T.sans, fontSize: 14, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: '11px 20px', borderRadius: 2,
        borderBottom: active ? `2px solid ${T.brass}` : '2px solid transparent',
        transition: 'background 120ms ease',
      }}
    >
      {label}
    </button>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode };

const btnBase: CSSProperties = {
  appearance: 'none', cursor: 'pointer', border: 'none', borderRadius: 2,
  fontFamily: T.sans, fontWeight: 600, letterSpacing: '0.04em',
};

/** Primary action — green (begin, generate). */
export function GreenButton({ children, style, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...btnBase, fontSize: 14, padding: '12px 26px',
        background: disabled ? T.rule : T.green, color: T.paper,
        cursor: disabled ? 'default' : 'pointer', ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Speaking action — oxblood (Answer). */
export function OxButton({ children, style, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...btnBase, fontSize: 13, padding: '0 22px', letterSpacing: '0.05em',
        background: disabled ? T.rule : T.oxblood, color: T.paper,
        cursor: disabled ? 'default' : 'pointer', ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Quiet inline control — hairline border, faint text. */
export function QuietControl({ children, style, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      style={{
        ...btnBase, fontSize: 11, letterSpacing: '0.05em', padding: '5px 12px',
        border: `1px solid ${T.rule}`, background: 'transparent', color: T.faint,
        borderRadius: 999, ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: T.sans, fontSize: 13, color: T.oxblood, padding: '6px 0' }}>
      {children}
    </div>
  );
}

/* ---------------------- Transcript rendering ---------------------- */
// Every conversation renders as a court transcript: mono uppercase speaker
// labels, continuous line numbers in the left gutter, serif body. This is
// the identity of the product (design doc, "Signature elements").

export interface TranscriptTurn {
  role: 'professor' | 'student';
  content: string;
}

export function Transcript({ turns, live }: {
  turns: TranscriptTurn[];
  /** The professor's in-flight streaming text, if any. */
  live?: string | null;
}) {
  let line = 1;
  const renderTurn = (turn: TranscriptTurn, key: string) => {
    const rows = turn.content.split('\n').filter(Boolean);
    const prof = turn.role === 'professor';
    return (
      <div key={key} style={{ margin: '14px 0' }}>
        <div style={{
          fontFamily: T.mono, fontSize: 11, letterSpacing: '0.08em',
          color: prof ? T.oxblood : T.green, marginBottom: 4,
        }}>
          {prof ? 'THE PROFESSOR:' : 'THE STUDENT:'}
        </div>
        {rows.map((r, j) => (
          <div key={j} style={{ display: 'flex', gap: 12 }}>
            <div style={{
              fontFamily: T.mono, fontSize: 11, color: T.rule,
              width: 24, textAlign: 'right', flexShrink: 0, paddingTop: 4,
            }}>
              {line++}
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 15.5, lineHeight: 1.6, color: T.ink }}>{r}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      {turns.map((t, i) => renderTurn(t, String(i)))}
      {live != null && renderTurn({ role: 'professor', content: live || '…' }, 'live')}
    </div>
  );
}
