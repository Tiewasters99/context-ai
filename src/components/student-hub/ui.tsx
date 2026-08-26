// Student Hub shared UI — the "law library" design system.
// Source of truth: docs/student-hub/student-hub-design.md. Flat colors,
// 2px radii, hairline rules, no shadows, no gradients; serif for content,
// letterspaced sans for chrome, mono for transcript apparatus.

import { useState } from 'react';
import type { ReactNode, CSSProperties, ButtonHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { T } from './theme';

/** Pulse for the live mic; disabled wholesale under prefers-reduced-motion.
 *  The caption band's cover steps aside on a phone, where the title needs
 *  the whole width. */
export function HubStyles() {
  return (
    <style>{`
      @keyframes hubPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(122,46,46,0.45); } 50% { box-shadow: 0 0 0 8px rgba(122,46,46,0); } }
      @media (prefers-reduced-motion: reduce) { .student-hub-root * { animation: none !important; } }
      @media (max-width: 480px) { .student-hub-root .hub-caption-cover { display: none !important; } }
    `}</style>
  );
}

/** A book's cover at thumbnail size: 2:3, as a bound book stands. If the
 *  image never arrives — no cover yet, or one that fails to load — whatever
 *  stood there before takes its place, and the box keeps its size. */
export function BookCover({ src, width, alt = '', className, fallback = null, style }: {
  src?: string;
  width: number;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
  style?: CSSProperties;
}) {
  // Remember which image failed, not merely that one did, so a new cover on
  // the same card is given its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(src)}
      style={{
        width, height: Math.round(width * 1.5), objectFit: 'cover',
        display: 'block', borderRadius: 2, ...style,
      }}
    />
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

/** One segment of the caption's crumb trail; `to` makes it a link. */
export interface Crumb {
  label: string;
  to?: string;
}

/** Case-caption header band: greenDark, brass 3px rule, italic serif title.
 *  `backTo` puts the persistent paper back-arrow at the head of the kicker.
 *  `crumbs` replaces the flat `kicker` string with a walkable trail — same
 *  type, same size, same tracking, so the band reads exactly as before. */
export function CaseCaption({ kicker, crumbs, title, citation, backTo, onTitleClick }: {
  kicker: string;
  crumbs?: Crumb[];
  title: string;
  citation?: string;
  backTo?: string;
  /** When set, the title itself is a control (e.g. the shelf opens from it). */
  onTitleClick?: () => void;
}) {
  // Set the "v." small and non-italic, as in a printed caption.
  const parts = title.split(/ v\.? /);
  const titleBody = parts.length === 2 ? (
    <>{parts[0]} <span style={{ fontStyle: 'normal', fontSize: '0.7em', opacity: 0.7 }}>v.</span> {parts[1]}</>
  ) : title;
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
          {crumbs
            ? crumbs.map((c, i) => (
                <span key={i}>
                  {i > 0 && ' · '}
                  {c.to ? (
                    <Link
                      to={c.to}
                      style={{ color: 'inherit', textDecoration: 'none', font: 'inherit', letterSpacing: 'inherit' }}
                    >
                      {c.label}
                    </Link>
                  ) : c.label}
                </span>
              ))
            : kicker}
        </Kicker>
        <h1 style={{
          fontFamily: T.serif, fontSize: 'clamp(22px, 4vw, 30px)', color: T.paper,
          fontStyle: 'italic', fontWeight: 400, margin: '0.2em 0 0',
        }}>
          {onTitleClick ? (
            <button
              type="button"
              onClick={onTitleClick}
              style={{
                appearance: 'none', border: 'none', background: 'none', padding: 0,
                cursor: 'pointer', font: 'inherit', color: 'inherit',
              }}
            >
              {titleBody}
            </button>
          ) : titleBody}
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
        fontFamily: T.sans, fontSize: 13, fontWeight: 600,
        letterSpacing: '0.05em', textTransform: 'uppercase',
        padding: '10px 14px', borderRadius: 2,
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
