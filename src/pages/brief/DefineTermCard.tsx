// "Define": say once what a short form in this brief means — "Op." is the
// Fifth Circuit Opinion, "ROA" is the record on appeal folder — and every cite
// that starts with it opens there. Search your documents and folders by your
// own words (Eden, 10-16: "you should be able to type in the words you want").
import { useEffect, useRef, useState } from 'react';
import { FileText, Folder, X } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import type { DefinedTerm } from '@/lib/brief/defined-terms';

export type DefineHit = { kind: 'document' | 'folder'; id: string; title: string; where: string | null };

export default function DefineTermCard({ initialTerm, terms, search, onSave, onRemove, onClose }: {
  initialTerm: string;
  terms: DefinedTerm[];
  /** Documents and folders whose names carry every word of the query. */
  search: (query: string) => Promise<DefineHit[]>;
  onSave: (def: DefinedTerm) => Promise<void> | void;
  onRemove: (term: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState(initialTerm);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DefineHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<DefineHit | null>(null);
  const [stamped, setStamped] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); return; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      search(q).then(
        (r) => { if (n === seq.current) { setHits(r); setErr(null); } },
        (e) => { if (n === seq.current) setErr((e as Error).message); },
      );
    }, 250);
    return () => clearTimeout(t);
  }, [query, search]);

  const pick = (h: DefineHit) => { setPicked(h); setStamped(h.kind === 'folder'); };
  const save = async () => {
    if (!picked || !term.trim()) return;
    setBusy(true);
    try {
      await onSave({
        term: term.trim(),
        kind: stamped ? 'stamped' : 'document',
        ...(picked.kind === 'folder' ? { matterId: picked.id } : { documentId: picked.id }),
        title: picked.title,
      });
      onClose();
    } finally { setBusy(false); }
  };
  const t = term.trim() || 'the term';

  return (
    <CardDialog
      storageKey="cs.brief.define-term"
      title="Define a term in this brief"
      subtitle="Say once what a short form means. Every cite that starts with it then opens there: “Op. 13” at page 13 of the document you pick, “TAC ¶ 55” at paragraph 55, “ROA.583” at the page stamped 583."
      onClose={onClose}
      maxWidth={620}
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-[12px] text-white/60">
          <span className="w-28 shrink-0">The brief writes</span>
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Op.  ·  TAC  ·  ROA  ·  Pet. App."
            className="flex-1 min-w-0 h-8 bg-white/[0.04] border border-white/[0.12] rounded px-2 text-[13px] text-white/90 outline-none focus:border-[#e8b84a]/60"
            data-testid="define-term"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-white/60">
          <span className="w-28 shrink-0">It means</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
            placeholder="Type words from its name: fifth circuit opinion · record on appeal · third amended"
            className="flex-1 min-w-0 h-8 bg-white/[0.04] border border-white/[0.12] rounded px-2 text-[13px] text-white/90 outline-none focus:border-[#e8b84a]/60"
            data-testid="define-search"
          />
        </label>

        {err && <p className="text-[12px] text-red-300">{err}</p>}
        {hits && !picked && (
          <div className="max-h-[42vh] overflow-y-auto rounded-md border border-white/[0.08] divide-y divide-white/[0.06]">
            {hits.length === 0 && <p className="px-3 py-2 text-[12px] text-white/45">Nothing is named with all of those words. Try fewer words, or part of a word (“opinion”, “eroa”).</p>}
            {hits.map((h) => (
              <button key={`${h.kind}:${h.id}`} onClick={() => pick(h)} className="w-full text-left px-3 py-2 hover:bg-white/[0.04] flex items-baseline gap-2">
                {h.kind === 'folder' ? <Folder size={13} className="shrink-0 text-[#e8b84a]/80 translate-y-0.5" /> : <FileText size={13} className="shrink-0 text-white/40 translate-y-0.5" />}
                <span className="flex-1 min-w-0 truncate text-[13px] text-white/90">{h.title}</span>
                {h.where && <span className="max-w-[40%] truncate text-[11px] text-white/40">{h.where}</span>}
              </button>
            ))}
          </div>
        )}

        {picked && (
          <div className="rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/[0.06] p-3 space-y-2">
            <p className="text-[13px] text-white/85">
              “{t}” means <span className="text-white">{picked.title}</span>{picked.where ? <span className="text-white/45"> ({picked.where})</span> : null}.
              <button onClick={() => setPicked(null)} className="ml-2 text-[12px] text-[#e8b84a]/80 hover:underline">change</button>
            </p>
            {picked.kind === 'document' ? (
              <div className="space-y-1 text-[12.5px] text-white/75">
                <label className="flex items-start gap-2"><input type="radio" checked={!stamped} onChange={() => setStamped(false)} className="mt-1" /> <span>The number after it is a <b>page</b> of this document (“{t} 13” = page 13), or a paragraph when it has ¶.</span></label>
                <label className="flex items-start gap-2"><input type="radio" checked={stamped} onChange={() => setStamped(true)} className="mt-1" /> <span>The number is a <b>page stamp</b> printed on its pages (a record or Bates number: “{t} 583” = the page stamped 583).</span></label>
              </div>
            ) : (
              <p className="text-[12.5px] text-white/75">The number after it is a <b>page stamp</b> printed on the pages of the documents in this folder: “{t}.583” opens the page stamped 583, whichever volume it is in.</p>
            )}
            <div className="flex justify-end">
              <button onClick={() => void save()} disabled={busy || !term.trim()} className="h-8 px-3 rounded-md border border-[#e8b84a]/40 bg-[#e8b84a]/15 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/25 disabled:opacity-40" data-testid="define-save">
                Define “{t}”
              </button>
            </div>
          </div>
        )}

        {terms.length > 0 && (
          <div className="pt-1">
            <p className="text-[11px] uppercase tracking-wide text-white/35 mb-1">Defined in this brief</p>
            <ul className="space-y-1">
              {terms.map((d) => (
                <li key={d.term} className="flex items-baseline gap-2 text-[12.5px] text-white/75">
                  <span className="text-white/90 font-medium">{d.term}</span>
                  <span className="flex-1 min-w-0 truncate">→ {d.title}{d.kind === 'stamped' ? ' (page stamps)' : ' (pages)'}</span>
                  <button onClick={() => void onRemove(d.term)} className="text-white/35 hover:text-red-300" title={`Forget what “${d.term}” means`} aria-label={`Remove ${d.term}`}><X size={13} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </CardDialog>
  );
}
