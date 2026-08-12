import { useEffect, useMemo, useState } from 'react';
import { Gavel, Plus, Trash2 } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import { listMatterDocumentsRecursive } from '@/lib/vault-persist';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import type { VaultFile } from '@/lib/vault-types';
import { GoldButton, Notice, FieldLabel, INPUT_CLASS, TEXTAREA_CLASS } from '@/components/mediation/ui';
import { addSegment, deleteSegment } from '@/lib/courtroom/persist.ts';
import { segmentLabel } from '@/lib/courtroom/prompts.ts';
import type { MockTrial, Segment, SegmentKind, Side } from '@/lib/courtroom/types.ts';

// Building the record — one unit of advocacy at a time (spec §5 SEGMENT).
// Input is pasted/typed text or a document already in the matter. Counsel
// performs BOTH sides if they want the opposing argument tested; the
// opposing-counsel agent is Phase 2.

const KINDS: { value: SegmentKind; label: string }[] = [
  { value: 'opening', label: 'Opening statement' },
  { value: 'direct', label: 'Direct examination' },
  { value: 'cross', label: 'Cross-examination' },
  { value: 'closing', label: 'Closing argument' },
  { value: 'exhibit', label: 'Exhibit published' },
];

export default function SegmentComposer({
  trial, segments, onSegmentsChanged, onBegin, busy,
}: {
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>;
  segments: Segment[];
  onSegmentsChanged: (segments: Segment[]) => void;
  onBegin: () => void;
  busy: boolean;
}) {
  const [kind, setKind] = useState<SegmentKind>('opening');
  const [side, setSide] = useState<Side>('ours');
  const [text, setText] = useState('');
  const [docId, setDocId] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  // Documents already in this matter (and sub-matters) — preferred source.
  const { data: serverspaces = [] } = useServerspaces();
  const matterIds = useMemo(() => {
    const ids = collectDescendantIds(serverspaces, trial.matterspace_id);
    return ids.length ? ids : [trial.matterspace_id];
  }, [serverspaces, trial.matterspace_id]);
  const [docs, setDocs] = useState<VaultFile[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const nameById = new Map(
      serverspaces.flatMap((s) => s.matterspaces.map((m) => [m.id, m.name] as const)),
    );
    listMatterDocumentsRecursive(matterIds, nameById)
      .then((d) => { if (!cancelled) setDocs(d); })
      .catch(() => { if (!cancelled) setDocs([]); });
    return () => { cancelled = true; };
  }, [matterIds, serverspaces]);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setError('');
    try {
      let transcript = text.trim();
      let sourceDocumentId: string | null = null;
      if (!transcript && docId) {
        const doc = await loadCorpusDocumentText(docId);
        transcript = doc.text;
        sourceDocumentId = docId;
      }
      if (!transcript) {
        setError('Paste the segment text or pick a matter document.');
        return;
      }
      const seg = await addSegment(trial, {
        kind, side, transcript, position: segments.length, sourceDocumentId,
      });
      onSegmentsChanged([...segments, seg]);
      setText('');
      setDocId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The segment could not be added.');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (seg: Segment) => {
    try {
      await deleteSegment(seg.id);
      onSegmentsChanged(segments.filter((s) => s.id !== seg.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The segment could not be removed.');
    }
  };

  return (
    <section aria-label="The record">
      <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-3">The record — your performance</h2>

      {/* What the panel has heard so far */}
      {segments.length > 0 && (
        <ol className="space-y-2 mb-5">
          {segments.map((seg) => (
            <li
              key={seg.id}
              className="flex items-center gap-3 rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-2.5"
              style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
            >
              <span className={`shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                seg.side === 'ours'
                  ? 'text-[#8fd4a0] border-[rgba(120,210,150,0.35)]'
                  : 'text-[#e0a9a9] border-[rgba(224,169,169,0.35)]'
              }`}>
                {seg.side}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] text-white/85">{segmentLabel(seg)}</span>
                <span className="block text-[11px] text-white/35 truncate">
                  {seg.transcript.slice(0, 120)}{seg.transcript.length > 120 ? '…' : ''}
                </span>
              </span>
              <span className="text-[10.5px] text-white/30 shrink-0">
                {Math.round(seg.transcript.length / 1000).toLocaleString()}k chars
              </span>
              <button
                type="button"
                onClick={() => void remove(seg)}
                className="p-1.5 rounded-md text-white/30 hover:text-[#f0b9b9] hover:bg-[rgba(240,120,120,0.08)] transition-colors shrink-0"
                title="Remove segment"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}

      {/* Compose the next segment */}
      <div
        className="rounded-xl border border-[rgba(255,255,255,0.08)] p-5"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <div className="grid gap-4 sm:grid-cols-2 mb-4">
          <div>
            <FieldLabel htmlFor="sc-kind">Segment</FieldLabel>
            <select id="sc-kind" className={INPUT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as SegmentKind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="sc-side">Presented by</FieldLabel>
            <div id="sc-side" className="flex gap-2" role="radiogroup" aria-label="Side">
              {(['ours', 'theirs'] as Side[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  onClick={() => setSide(s)}
                  className={`flex-1 px-3 py-2.5 rounded-md border text-[13px] transition-colors ${
                    side === s
                      ? 'border-[#d4a054] text-[#e8b84a] bg-[rgba(212,160,84,0.06)]'
                      : 'border-[rgba(255,255,255,0.12)] text-white/60 hover:border-[rgba(255,255,255,0.3)]'
                  }`}
                >
                  {s === 'ours' ? 'Us' : 'Opposing side'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-4">
          <FieldLabel htmlFor="sc-text">Perform it — paste or type the segment</FieldLabel>
          <textarea
            id="sc-text"
            className={TEXTAREA_CLASS}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'"May it please the court. On the morning of March 4th, …"'}
          />
        </div>

        <div className="mb-4">
          <FieldLabel htmlFor="sc-doc">…or read it from the matter</FieldLabel>
          <select id="sc-doc" className={INPUT_CLASS} value={docId} onChange={(e) => setDocId(e.target.value)} disabled={!!text.trim()}>
            <option value="">{docs === null ? 'Loading documents…' : docs.length === 0 ? 'No documents in this matter yet' : 'Pick a document (used only if the box above is empty)'}</option>
            {(docs ?? []).filter((d) => d.status === 'indexed').map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.matterspace_name ? ` — ${d.matterspace_name}` : ''}</option>
            ))}
          </select>
        </div>

        {error && <Notice>{error}</Notice>}

        <GoldButton onClick={() => void add()} disabled={adding || (!text.trim() && !docId)}>
          <Plus size={14} /> {adding ? 'Reading it in…' : 'Read it into the record'}
        </GoldButton>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <GoldButton onClick={onBegin} disabled={busy || segments.length === 0}>
          <Gavel size={14} /> Send the panel to react and deliberate
        </GoldButton>
        <span className="text-[11.5px] text-white/35">
          Each juror reacts privately to every segment, casts a secret ballot, then the panel deliberates.
        </span>
      </div>
    </section>
  );
}
