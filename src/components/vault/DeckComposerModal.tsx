import { useState } from 'react';
import { X, Loader2, Presentation, ChevronLeft, Check, FileText } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { sandboxApi } from '@/lib/sandbox-api';
import { generateStructured } from '@/lib/llm/structured';

// Deck composer: instruction + selected sandbox documents -> the LLM
// drafts a slide outline (structured output) -> the user reviews it ->
// create_deck renders a real .pptx server-side and files it in the box.

interface DeckDoc {
  id: string;
  title: string;
}

interface SlideSpec {
  title?: string;
  bullets?: (string | { text: string; indent?: number })[];
  table?: { headers: string[]; rows: string[][] };
  chart?: {
    type: 'bar' | 'line' | 'pie' | 'doughnut';
    title?: string;
    categories: string[];
    series: { name: string; values: number[] }[];
  };
  notes?: string;
}

interface DeckSpec {
  title: string;
  subtitle?: string;
  slides: SlideSpec[];
}

const DECK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Deck title for the cover slide.' },
    subtitle: { type: 'string', description: 'Cover subtitle, e.g. matter and date.' },
    slides: {
      type: 'array',
      minItems: 2,
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          bullets: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: { text: { type: 'string' }, indent: { type: 'number' } },
                  required: ['text'],
                },
              ],
            },
          },
          table: {
            type: 'object',
            properties: {
              headers: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
            required: ['headers', 'rows'],
          },
          chart: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
              title: { type: 'string' },
              categories: { type: 'array', items: { type: 'string' } },
              series: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    values: { type: 'array', items: { type: 'number' } },
                  },
                  required: ['name', 'values'],
                },
              },
            },
            required: ['type', 'categories', 'series'],
          },
          notes: { type: 'string' },
        },
      },
    },
  },
  required: ['title', 'slides'],
} as const;

const SYSTEM = [
  'You compose presentation decks for a litigator from source documents.',
  'Rules: bullets are short fragments (max ~12 words, no full sentences);',
  'prose, reasoning, and citations go in the notes field of each slide.',
  'Use a table slide for figures; use a chart slide only when the source',
  'material contains real numeric data worth visualizing (never invent',
  'numbers). 3-10 content slides. Ground every claim in the source',
  'material provided.',
].join(' ');

interface Props {
  box: { id: string; name: string };
  docs: DeckDoc[];
  preselectedIds: string[];
  onClose: () => void;
  onCreated: (result: { filename: string; downloadUrl?: string }) => void;
}

export default function DeckComposerModal({ box, docs, preselectedIds, onClose, onCreated }: Props) {
  const [instruction, setInstruction] = useState('');
  const [checked, setChecked] = useState<Set<string>>(
    new Set(preselectedIds.length ? preselectedIds : docs.map((d) => d.id)),
  );
  const [phase, setPhase] = useState<'compose' | 'generating' | 'review' | 'creating'>('compose');
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckSpec | null>(null);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleGenerate = async () => {
    if (!instruction.trim() || checked.size === 0) return;
    setPhase('generating');
    setError(null);
    try {
      // Pull raw passage text for the chosen documents, budgeted per doc.
      const ids = [...checked];
      const perDoc = Math.max(4000, Math.floor(60000 / ids.length));
      const sections: string[] = [];
      for (const id of ids) {
        const d = docs.find((x) => x.id === id);
        const { data } = await supabase
          .from('passages')
          .select('text')
          .eq('document_id', id)
          .eq('summary_level', 0)
          .order('sequence_number', { ascending: true })
          .limit(120);
        const text = (data ?? []).map((p) => p.text).join('\n').slice(0, perDoc);
        sections.push(`=== ${d?.title ?? id} ===\n${text || '(no extracted text)'}`);
      }
      const spec = await generateStructured<DeckSpec>({
        modelId: 'claude-opus',
        system: SYSTEM,
        userContent: `Instruction: ${instruction.trim()}\n\nSource material:\n\n${sections.join('\n\n')}`,
        toolName: 'compose_deck',
        toolDescription: 'Return the finished deck outline as structured slides.',
        inputSchema: DECK_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 8000,
      });
      if (!spec?.slides?.length) throw new Error('The model returned no slides — try rephrasing the instruction.');
      setDeck(spec);
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('compose');
    }
  };

  const handleCreate = async () => {
    if (!deck) return;
    setPhase('creating');
    setError(null);
    try {
      const out = await sandboxApi<{ filename: string; download_url?: string | null }>('create_deck', {
        matter: box.id,
        title: deck.title,
        ...(deck.subtitle ? { subtitle: deck.subtitle } : {}),
        slides: deck.slides,
      });
      onCreated({ filename: out.filename, downloadUrl: out.download_url ?? undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('review');
    }
  };

  const slideSummary = (s: SlideSpec) => {
    const parts: string[] = [];
    if (s.bullets?.length) parts.push(`${s.bullets.length} bullets`);
    if (s.table) parts.push(`table ${s.table.rows.length}×${s.table.headers.length}`);
    if (s.chart) parts.push(`${s.chart.type} chart`);
    if (s.notes) parts.push('notes');
    return parts.join(' · ') || 'title only';
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-lg max-h-[85vh] rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#12121a] p-6 flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
            <Presentation size={15} className="text-[#e8b84a]" /> Generate deck
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white"><X size={16} /></button>
        </div>
        <p className="text-[11px] text-white/50 mb-4">
          From documents in “{box.name}” — drafted by AI, rendered as a real .pptx you can edit.
        </p>

        {(phase === 'compose' || phase === 'generating') && (
          <>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder='e.g., "Mediation deck: liability themes, damages summary table, and a timeline chart of the key filings."'
              disabled={phase === 'generating'}
              className="w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)] text-[13px] text-white placeholder-white/30 resize-none focus:outline-none focus:ring-1 focus:ring-[#e8b84a] mb-3"
            />
            <p className="text-[10px] font-semibold text-white/60 uppercase tracking-wider mb-1.5">Source documents</p>
            <div className="flex-1 overflow-y-auto space-y-0.5 min-h-[80px] mb-3">
              {docs.map((d) => (
                <button key={d.id} onClick={() => toggle(d.id)} disabled={phase === 'generating'}
                  className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.04)] text-left">
                  <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked.has(d.id) ? 'bg-[#e8b84a] border-[#e8b84a]' : 'border-white/20'}`}>
                    {checked.has(d.id) && <Check size={10} className="text-black" strokeWidth={3} />}
                  </div>
                  <FileText size={12} className="text-white/50 shrink-0" />
                  <span className="text-[12px] text-white/80 truncate">{d.title}</span>
                </button>
              ))}
            </div>
            {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
            <button
              onClick={handleGenerate}
              disabled={!instruction.trim() || checked.size === 0 || phase === 'generating'}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40"
            >
              {phase === 'generating' ? <><Loader2 size={14} className="animate-spin" /> Drafting slides…</> : 'Draft slides'}
            </button>
          </>
        )}

        {(phase === 'review' || phase === 'creating') && deck && (
          <>
            <div className="flex-1 overflow-y-auto mb-3">
              <p className="text-[14px] text-white font-semibold">{deck.title}</p>
              {deck.subtitle && <p className="text-[11px] text-white/50 mb-2">{deck.subtitle}</p>}
              <div className="space-y-1 mt-2">
                {deck.slides.map((s, i) => (
                  <div key={i} className="px-3 py-2 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)]">
                    <span className="text-[12px] text-white/85 block">{i + 1}. {s.title ?? '(untitled)'}</span>
                    <span className="text-[10px] text-white/40">{slideSummary(s)}</span>
                  </div>
                ))}
              </div>
            </div>
            {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
            <div className="flex items-center gap-2">
              <button onClick={() => setPhase('compose')} disabled={phase === 'creating'}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.1)] text-white/80 text-[12px] font-medium transition-colors">
                <ChevronLeft size={13} /> Revise
              </button>
              <button onClick={handleCreate} disabled={phase === 'creating'}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-50">
                {phase === 'creating' ? <><Loader2 size={14} className="animate-spin" /> Rendering…</> : 'Create PPTX'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
