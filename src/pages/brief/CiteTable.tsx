// The cite table (slice D3; docs/specs/BRIEF-DESK-2026-09-26.md §3.3, B3, B4).
//
// A projection of the marks in the brief, in document order — never a second
// list. Each row: flag · citation + pin · in corpus · pin · my note (inline,
// 280 characters, cite_notes) · a click that scrolls the brief to the words.
// The rows the marks do not account for come last: entries of the run that
// were not located in the text, said in those words. A cite whose words
// changed since the check reads "changed since check", and its flag is shown
// as not checked. CiteDetail (the Cite-Check tab's own expander) opens from a
// row for the model's justification, source and sub-flags.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, MapPin } from 'lucide-react';
import { CiteDetail } from '@/components/matter/CiteCheckSurface';
import { FLAG_GLYPH, FLAG_LABEL, type CiteFlag } from '@/lib/cite-check/types';
import type { TableRow } from '@/lib/brief/anchor';
import { corpusText, pinText, rowFlag, rowKey } from '@/lib/brief/cite-words';
import type { CiteNote } from '@/lib/brief/confirm';

const FLAG_TINT: Record<CiteFlag, string> = {
  green: 'text-emerald-400',
  'lean-green': 'text-[#d4a054]',
  'lean-red': 'text-orange-400',
  red: 'text-red-400',
  blue: 'text-sky-400/70',
  unchecked: 'text-white/45',
};

type Filter = 'all' | CiteFlag | 'changed' | 'unlocated';

export interface CiteTableProps {
  rows: TableRow[];
  notes: CiteNote[];
  me: string | null;
  canEditNotes: boolean;
  selectedKey: string | null;
  onOpen: (row: TableRow) => void;
  onLocate: (row: TableRow) => void;
  onSaveNote: (citeKey: string, text: string) => Promise<void>;
  /** 'column' (the right column; collapses to a strip), 'row' (the bottom row), 'sheet' (full screen). */
  variant: 'column' | 'row' | 'sheet';
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  header?: React.ReactNode;
}


export default function CiteTable(p: CiteTableProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = new Map<Filter, number>();
    for (const r of p.rows) {
      const f = rowFlag(r);
      c.set(f, (c.get(f) ?? 0) + 1);
      if (r.stale) c.set('changed', (c.get('changed') ?? 0) + 1);
      if (r.from === null) c.set('unlocated', (c.get('unlocated') ?? 0) + 1);
    }
    return c;
  }, [p.rows]);

  const shown = p.rows.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'changed') return r.stale;
    if (filter === 'unlocated') return r.from === null;
    return rowFlag(r) === filter;
  });

  if (p.variant === 'column' && p.collapsed) {
    return (
      <aside className="w-10 shrink-0 border-l border-white/[0.06] bg-[#12121a] flex flex-col items-center py-2 gap-2">
        <button onClick={p.onToggleCollapsed} className="text-white/50 hover:text-white" title="Show the cite table">
          <PanelRightOpen size={15} />
        </button>
        {(['green', 'lean-green', 'lean-red', 'red', 'blue', 'unchecked'] as CiteFlag[]).map((f) => (counts.get(f) ?? 0) > 0 && (
          <span key={f} className={`text-[11px] leading-none ${FLAG_TINT[f]}`} title={FLAG_LABEL[f]}>
            {FLAG_GLYPH[f]}<br />{counts.get(f)}
          </span>
        ))}
      </aside>
    );
  }

  const chip = (f: Filter, label: React.ReactNode, title: string, tint = '') => (
    <button
      key={String(f)}
      onClick={() => setFilter(filter === f ? 'all' : f)}
      title={title}
      className={`px-1.5 py-0.5 rounded text-[11px] ${filter === f ? 'bg-white/[0.1]' : 'hover:bg-white/[0.05]'} ${tint}`}
    >
      {label}
    </button>
  );

  const frame = p.variant === 'column'
    ? 'w-[360px] shrink-0 border-l border-white/[0.06] bg-[#12121a] flex flex-col min-h-0'
    : p.variant === 'row'
      ? 'h-full flex flex-col min-h-0 bg-[#12121a]'
      : 'flex-1 flex flex-col min-h-0 bg-[#12121a]';

  return (
    <aside className={frame} aria-label="Cites in this brief">
      <div className="flex items-center gap-1 px-2 min-h-10 py-1 border-b border-white/[0.06] flex-wrap">
        {p.header}
        <span className="text-[12px] text-white/70 mr-1">Cites</span>
        {chip('all', `All ${p.rows.length}`, 'Every cite')}
        {(['green', 'lean-green', 'lean-red', 'red', 'blue', 'unchecked'] as CiteFlag[]).map((f) => (counts.get(f) ?? 0) > 0
          && chip(f, `${FLAG_GLYPH[f]} ${counts.get(f)}`, f === 'unchecked' ? 'Not checked, or changed since the check' : FLAG_LABEL[f], FLAG_TINT[f]))}
        {(counts.get('changed') ?? 0) > 0 && chip('changed', `changed ${counts.get('changed')}`, 'Changed since the check', 'text-[#e8b84a]')}
        {(counts.get('unlocated') ?? 0) > 0 && chip('unlocated', `not located ${counts.get('unlocated')}`, 'In the run, but not found in the text', 'text-white/50')}
        <span className="flex-1" />
        {p.variant === 'column' && (
          <button onClick={p.onToggleCollapsed} className="text-white/40 hover:text-white" title="Collapse the table">
            <PanelRightClose size={14} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/[0.05]">
        {p.rows.length === 0 && (
          <p className="text-[12px] text-white/40 p-3 leading-relaxed">
            No cites yet. <span className="text-white/60">Confirm this brief</span> reads every citation, checks it, and marks it in the text.
          </p>
        )}
        {p.rows.length > 0 && shown.length === 0 && <p className="text-[12px] text-white/40 p-3">No cites with that flag.</p>}
        {shown.map((r) => {
          const k = rowKey(r);
          return (
            <Row
              key={k}
              row={r}
              selected={p.selectedKey === k}
              expanded={open === k}
              onExpand={() => setOpen(open === k ? null : k)}
              notes={p.notes}
              me={p.me}
              canEditNotes={p.canEditNotes}
              onOpen={() => p.onOpen(r)}
              onLocate={() => p.onLocate(r)}
              onSaveNote={p.onSaveNote}
            />
          );
        })}
      </div>
    </aside>
  );
}

function Row({ row, selected, expanded, onExpand, notes, me, canEditNotes, onOpen, onLocate, onSaveNote }: {
  row: TableRow;
  selected: boolean;
  expanded: boolean;
  onExpand: () => void;
  notes: CiteNote[];
  me: string | null;
  canEditNotes: boolean;
  onOpen: () => void;
  onLocate: () => void;
  onSaveNote: (citeKey: string, text: string) => Promise<void>;
}) {
  const e = row.entry;
  const flag = rowFlag(row);
  const key = e?.cite_key ?? row.attrs?.cite_key ?? '';
  const citation = e?.citation ?? row.attrs?.raw ?? '';
  const pin = e?.pin ?? row.attrs?.pin ?? null;
  const corpus = corpusText(e?.resolution);
  const pinWords = pinText(e?.resolution);
  const mine = notes.find((n) => n.cite_key === key && n.user_id === me) ?? null;
  const theirs = notes.filter((n) => n.cite_key === key && n.user_id !== me);

  const status = row.from === null
    ? 'not located in the text'
    : row.stale
      ? 'changed since check'
      : null;

  return (
    <div className={`px-2.5 py-2 text-[12px] ${selected ? 'bg-[#e8b84a]/[0.08]' : ''}`}>
      <div className="flex items-start gap-2">
        <span className={`w-4 text-center shrink-0 text-[14px] leading-5 ${FLAG_TINT[flag]}`} title={status ?? FLAG_LABEL[flag]}>
          {FLAG_GLYPH[flag]}
        </span>
        <button
          onClick={row.from === null ? onOpen : onLocate}
          className="flex-1 min-w-0 text-left text-white/90 hover:text-white leading-5"
          title={row.from === null ? 'Open the authority' : 'Show it in the brief'}
        >
          <span className="line-clamp-2">{citation}{pin && !citation.includes(pin) ? <span className="text-white/45">, {pin}</span> : null}</span>
        </button>
        {e && (
          <button onClick={onExpand} className="text-white/30 hover:text-[#e8b84a] shrink-0 mt-0.5" title="The check's reasons and source">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      <div className="pl-6 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {status && <span className="text-[#e8b84a]">{status}</span>}
        <span className={corpus.tone === 'ok' ? 'text-white/60' : corpus.tone === 'warn' ? 'text-orange-300/80' : 'text-white/35'}>
          {corpus.tone === 'ok' ? 'in corpus: ' : ''}{corpus.text}
        </span>
        {e?.resolution?.status === 'resolved' && (
          <button onClick={onOpen} className="inline-flex items-center gap-0.5 text-[#e8b84a]/85 hover:text-[#e8b84a]" title={pinWords.caveat ?? 'Open the case beside the brief at this page'}>
            <MapPin size={10} />{pinWords.text}
          </button>
        )}
        {(e?.resolution?.status === 'two_copies' || e?.resolution?.status === 'not_in_corpus') && (
          <button onClick={onOpen} className="text-[#e8b84a]/85 hover:text-[#e8b84a]">{e.resolution.status === 'two_copies' ? 'choose' : 'search the matter'}</button>
        )}
        {e?.carried_from && <span className="text-white/30" title="Unchanged since the last check; its flag came forward without a new model call">carried</span>}
      </div>
      <div className="pl-6 mt-1">
        {canEditNotes && key ? (
          <NoteInput key={`${key}:${mine?.updated_at ?? ''}`} initial={mine?.note ?? ''} onSave={(t) => onSaveNote(key, t)} />
        ) : mine ? (
          <p className="text-[11px] text-white/70 italic">{mine.note}</p>
        ) : null}
        {theirs.map((n) => (
          <p key={n.id} className="text-[11px] text-white/50 italic mt-0.5" title="A colleague's note">{n.note}</p>
        ))}
      </div>
      {expanded && e && <div className="-mx-2.5 mt-1"><CiteDetail e={e} /></div>}
    </div>
  );
}

function NoteInput({ initial, onSave }: { initial: string; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  useEffect(() => { setText(initial); }, [initial]);
  const commit = async () => {
    if (text.trim() === initial.trim()) return;
    setState('saving');
    try { await onSave(text); setState('idle'); } catch { setState('error'); }
  };
  return (
    <div className="flex items-center gap-1">
      <input
        value={text}
        maxLength={280}
        onChange={(ev) => setText(ev.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setText(initial); }}
        placeholder="a note on this cite…"
        className="flex-1 min-w-0 bg-white/[0.03] hover:bg-white/[0.05] focus:bg-white/[0.07] rounded px-1.5 py-0.5 text-[11px] text-white/85 placeholder:text-white/25 outline-none"
        aria-label="Your note on this cite"
      />
      {state === 'saving' && <span className="text-[10px] text-white/35">saving</span>}
      {state === 'error' && <span className="text-[10px] text-red-300" title="The note was not saved">not saved</span>}
      {text.length > 240 && <span className="text-[10px] text-white/35">{280 - text.length}</span>}
    </div>
  );
}
