// Shared UI primitives for the Mediation Center pages — Contextspaces dark
// glassmorphic surfaces with the house gold accent.

import type { ReactNode, ButtonHTMLAttributes } from 'react';
import { countWords } from '@/lib/mediation';

export const GOLD = '#d4a054';

export function GoldButton({ children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold text-[#12100a] bg-[#d4a054] hover:bg-[#e8b84a] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function QuietButton({ children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-[13px] text-white/80 border border-[rgba(255,255,255,0.14)] hover:border-[rgba(255,255,255,0.3)] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

/** Quiet in-progress line with a pulsing gold orb. */
export function Working({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-white/60 py-2">
      <span className="inline-block w-2 h-2 rounded-full bg-[#d4a054] animate-pulse shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function Notice({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return (
    <p
      className={`mt-3 text-[13px] rounded-md px-3.5 py-2.5 border ${
        quiet
          ? 'text-white/60 border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)]'
          : 'text-[#f0b9b9] border-[rgba(240,120,120,0.25)] bg-[rgba(240,120,120,0.06)]'
      }`}
    >
      {children}
    </p>
  );
}

/** A formal document surface (framework, settlement draft). */
export function Parchment({ head, body }: { head: string; body: string }) {
  return (
    <div className="mt-3 rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[rgba(212,160,84,0.2)] text-[11px] uppercase tracking-wider text-[#d4a054]">
        <span>{head}</span>
        <span>Contextspaces Mediation</span>
      </div>
      <div className="px-5 py-4 text-[13.5px] leading-relaxed text-white/85 whitespace-pre-wrap max-h-[32rem] overflow-y-auto">
        {body}
      </div>
    </div>
  );
}

export function WordCounter({ text, limit }: { text: string; limit: number }) {
  const words = countWords(text);
  const over = words > limit;
  return (
    <span className={`text-[11.5px] mt-1 inline-block ${over ? 'text-[#f0b9b9]' : 'text-white/40'}`}>
      {words.toLocaleString()} / {limit.toLocaleString()} words
    </span>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-[11px] uppercase tracking-wider text-white/50 mb-1.5">
      {children}
    </label>
  );
}

export const TEXTAREA_CLASS =
  'w-full rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(8,8,14,0.6)] px-3.5 py-3 text-[13.5px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-[rgba(212,160,84,0.5)] leading-relaxed min-h-[10rem] resize-y';

export const INPUT_CLASS =
  'w-full rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(8,8,14,0.6)] px-3.5 py-2.5 text-[13.5px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-[rgba(212,160,84,0.5)]';

/** The kicker + display-serif title used at the head of every mediation page. */
export function PageHead({ kicker, title, lede }: { kicker: string; title: string; lede?: string }) {
  return (
    <header className="mb-8">
      <p className="text-[11px] uppercase tracking-[0.18em] text-[#d4a054] mb-2">{kicker}</p>
      <h1
        className="text-[32px] font-semibold tracking-tight text-white"
        style={{ fontFamily: '"Playfair Display Variable", serif' }}
      >
        {title}
      </h1>
      {lede && <p className="text-[14px] text-white/50 mt-2 max-w-xl leading-relaxed">{lede}</p>}
      <div className="mt-5 h-px w-24 bg-gradient-to-r from-[#d4a054] to-transparent" />
    </header>
  );
}
