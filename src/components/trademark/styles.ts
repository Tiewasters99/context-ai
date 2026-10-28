// Class names and small helpers for the Trademark tab (kept out of the .tsx
// files so they export components only).

export const field =
  'w-full bg-[rgba(20,20,30,0.8)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/25 outline-none focus:border-[rgba(232,184,74,0.45)] transition-colors';
export const label = 'block text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1';
export const btn =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.14)] text-[12.5px] text-white/85 hover:text-white hover:border-[rgba(232,184,74,0.45)] disabled:opacity-40 disabled:cursor-not-allowed';
export const btnPrimary =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[12.5px] font-semibold hover:bg-[var(--color-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed';
export const th = 'text-left text-[10.5px] font-semibold uppercase tracking-wider text-[#8a8693] px-2 py-1.5 whitespace-nowrap';
export const td = 'px-2 py-1.5 align-top text-[12.5px] text-white/85';
export const mono = 'font-mono text-[12px]';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '');
