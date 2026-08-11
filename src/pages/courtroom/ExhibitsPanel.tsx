import { useMemo, useState } from 'react';
import { FileImage, Plus, Trash2, UserSquare2 } from 'lucide-react';
import { GoldButton, Notice, FieldLabel, INPUT_CLASS } from '@/components/mediation/ui';
import { isImageDoc, isPdfDoc, isRenderableDoc } from '@/lib/courtroom/exhibit-render.ts';
import {
  canPublish, nextExhibitNo,
  type ExhibitStatus, type TrialExhibit, type TrialWitness,
} from '@/lib/courtroom/exhibits.ts';
import { saveExhibitConfigEvent } from '@/lib/courtroom/persist.ts';
import type { MockTrial, Side } from '@/lib/courtroom/types.ts';
import type { VaultFile } from '@/lib/vault-types';

// The exhibits drawer (spec §2.2): register real matter documents as PX-n /
// DX-n, seat a witness from a matter image, publish through the courtroom
// move. Registration and the witness are trial CONFIG (they survive session
// wipes); publication is the session's act.

const STATUS_LABEL: Record<ExhibitStatus, string> = {
  pre_admitted: 'Pre-admitted',
  to_offer: 'To offer',
  admitted: 'Admitted',
  refused: 'Refused',
};

export default function ExhibitsPanel({
  trial, docs, exhibits, witness, publishedKeys,
  onChanged, onPublish, publishingKey, theater,
}: {
  trial: Pick<MockTrial, 'id' | 'matterspace_id'>;
  /** The matter's documents (loaded by TrialRoom; shared with the composer). */
  docs: VaultFile[] | null;
  exhibits: TrialExhibit[];
  witness: TrialWitness | null;
  publishedKeys: Set<string>;
  onChanged: () => void;
  onPublish: (exhibit: TrialExhibit, doc: VaultFile) => void;
  publishingKey: string | null;
  /** True when the 3D room is up — publication ends with the click on the
   *  screen; false publishes directly to the record. */
  theater: boolean;
}) {
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [docId, setDocId] = useState('');
  const [side, setSide] = useState<Side>('ours');
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [page, setPage] = useState('1');
  const [status, setStatus] = useState<ExhibitStatus>('pre_admitted');
  const [witnessName, setWitnessName] = useState('');
  const [witnessDocId, setWitnessDocId] = useState('');

  const renderable = useMemo(
    () => (docs ?? []).filter((d) => d.status === 'indexed' && isRenderableDoc(d.name)),
    [docs],
  );
  const witnessDocs = useMemo(
    () => (docs ?? []).filter((d) => d.status === 'indexed' && isImageDoc(d.name)),
    [docs],
  );
  const chosenDoc = renderable.find((d) => d.id === docId) ?? null;
  const defaultNo = nextExhibitNo(exhibits, side);

  const register = async () => {
    if (!chosenDoc) return;
    setError('');
    try {
      const exhibit: TrialExhibit = {
        key: crypto.randomUUID(),
        exhibit_no: (number.trim() || defaultNo).toUpperCase(),
        doc_id: chosenDoc.id,
        doc_name: chosenDoc.name,
        page: isPdfDoc(chosenDoc.name) ? Math.max(1, Number(page) || 1) : null,
        title: title.trim() || chosenDoc.name.replace(/\.[a-z0-9]+$/i, ''),
        side,
        status,
      };
      await saveExhibitConfigEvent(trial, { event: 'registered', exhibit });
      setDocId('');
      setNumber('');
      setTitle('');
      setPage('1');
      setAddOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The exhibit could not be registered.');
    }
  };

  const remove = async (ex: TrialExhibit) => {
    setError('');
    try {
      await saveExhibitConfigEvent(trial, { event: 'removed', key: ex.key });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The exhibit could not be removed.');
    }
  };

  const seatWitness = async () => {
    if (!witnessName.trim()) return;
    setError('');
    try {
      await saveExhibitConfigEvent(trial, {
        event: 'witness_seated',
        witness: { name: witnessName.trim(), doc_id: witnessDocId || null },
      });
      setWitnessName('');
      setWitnessDocId('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The witness could not be seated.');
    }
  };

  const clearWitness = async () => {
    setError('');
    try {
      await saveExhibitConfigEvent(trial, { event: 'witness_cleared' });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The stand could not be cleared.');
    }
  };

  return (
    <section aria-label="Exhibits" className="mb-6">
      <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-3">
        Exhibits — the record, published
      </h2>

      {exhibits.length > 0 && (
        <ol className="space-y-2 mb-4">
          {exhibits.map((ex) => {
            const published = publishedKeys.has(ex.key);
            const doc = renderable.find((d) => d.id === ex.doc_id) ?? null;
            return (
              <li
                key={ex.key}
                className="flex items-center gap-3 rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-2.5"
                style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
              >
                <span className="shrink-0 text-[11px] font-medium tracking-wider text-[#e8b84a] w-14">
                  {ex.exhibit_no}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-white/85 truncate">{ex.title}</span>
                  <span className="block text-[11px] text-white/35 truncate">
                    {ex.doc_name}{ex.page ? ` · p.${ex.page}` : ''}
                  </span>
                </span>
                <span className={`shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${
                  published
                    ? 'text-[#8fd4a0] border-[rgba(120,210,150,0.35)]'
                    : ex.status === 'to_offer'
                      ? 'text-[#e0c9a9] border-[rgba(224,201,169,0.35)]'
                      : 'text-white/55 border-[rgba(255,255,255,0.2)]'
                }`}>
                  {published ? 'Published' : STATUS_LABEL[ex.status]}
                </span>
                {!published && canPublish(ex) && doc && (
                  <button
                    type="button"
                    onClick={() => onPublish(ex, doc)}
                    disabled={publishingKey !== null}
                    className="shrink-0 text-[10.5px] uppercase tracking-wider px-2.5 py-1.5 rounded border border-[rgba(212,160,84,0.4)] text-[#e8b84a] hover:bg-[rgba(212,160,84,0.12)] transition-colors disabled:opacity-40"
                  >
                    {publishingKey === ex.key
                      ? (theater ? 'In colloquy…' : 'Publishing…')
                      : 'Publish'}
                  </button>
                )}
                {!published && ex.status === 'to_offer' && (
                  <span className="shrink-0 text-[10px] text-white/30" title="The offer-and-objection flow is the next build.">
                    offer flow soon
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void remove(ex)}
                  className="p-1.5 rounded-md text-white/30 hover:text-[#f0b9b9] hover:bg-[rgba(240,120,120,0.08)] transition-colors shrink-0"
                  title="Remove from the exhibit list"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {theater && publishingKey === null && exhibits.some((e) => canPublish(e) && !publishedKeys.has(e.key)) && (
        <p className="text-[11px] text-white/35 mb-3">
          Publish runs the colloquy in the room, arms the screen, and the exhibit goes up when
          you click the screen.
        </p>
      )}

      {error && <div className="mb-3"><Notice>{error}</Notice></div>}

      {!addOpen ? (
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-[#d4a054]/80 hover:text-[#e8b84a] transition-colors"
          >
            <Plus size={12} /> Add an exhibit
          </button>
          {witness ? (
            <span className="inline-flex items-center gap-2 text-[11.5px] text-white/55">
              <UserSquare2 size={13} className="text-[#d4a054]/70" />
              On the stand: <span className="text-white/80">{witness.name}</span>
              <button
                type="button"
                onClick={() => void clearWitness()}
                className="text-[10.5px] uppercase tracking-wider text-white/35 hover:text-[#f0b9b9] transition-colors"
              >
                clear
              </button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-[11.5px] text-white/40">
              <UserSquare2 size={13} />
              <input
                className="bg-transparent border-b border-[rgba(255,255,255,0.15)] focus:border-[#d4a054] outline-none text-[12px] text-white/80 w-36 py-0.5"
                placeholder="Witness name"
                value={witnessName}
                onChange={(e) => setWitnessName(e.target.value)}
              />
              <select
                className="bg-transparent border-b border-[rgba(255,255,255,0.15)] text-[11.5px] text-white/60 outline-none py-0.5 max-w-44"
                value={witnessDocId}
                onChange={(e) => setWitnessDocId(e.target.value)}
              >
                <option value="">no portrait</option>
                {witnessDocs.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void seatWitness()}
                disabled={!witnessName.trim()}
                className="text-[10.5px] uppercase tracking-wider text-[#d4a054]/80 hover:text-[#e8b84a] disabled:opacity-40 transition-colors"
              >
                seat
              </button>
            </span>
          )}
        </div>
      ) : (
        <div
          className="rounded-xl border border-[rgba(255,255,255,0.08)] p-5"
          style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
        >
          <div className="mb-4">
            <FieldLabel htmlFor="ex-doc">The document (PDF or image in the matter)</FieldLabel>
            <select
              id="ex-doc"
              className={INPUT_CLASS}
              value={docId}
              onChange={(e) => {
                setDocId(e.target.value);
                const d = renderable.find((x) => x.id === e.target.value);
                if (d) setTitle(d.name.replace(/\.[a-z0-9]+$/i, ''));
              }}
            >
              <option value="">
                {docs === null
                  ? 'Loading documents…'
                  : renderable.length === 0
                    ? 'No PDF or image documents in this matter yet'
                    : 'Pick the exhibit document'}
              </option>
              {renderable.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.matterspace_name ? ` — ${d.matterspace_name}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 mb-4">
            <div>
              <FieldLabel htmlFor="ex-side">Offered by</FieldLabel>
              <div id="ex-side" className="flex gap-2" role="radiogroup" aria-label="Side">
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
                    {s === 'ours' ? 'Us (PX)' : 'Opposing (DX)'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="ex-no">Exhibit number</FieldLabel>
              <input
                id="ex-no"
                className={INPUT_CLASS}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder={defaultNo}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 mb-4">
            <div>
              <FieldLabel htmlFor="ex-title">Title (as the record knows it)</FieldLabel>
              <input
                id="ex-title"
                className={INPUT_CLASS}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Skyline photograph, August 2024"
              />
            </div>
            {chosenDoc && isPdfDoc(chosenDoc.name) && (
              <div>
                <FieldLabel htmlFor="ex-page">Page</FieldLabel>
                <input
                  id="ex-page"
                  className={INPUT_CLASS}
                  type="number"
                  min={1}
                  value={page}
                  onChange={(e) => setPage(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="mb-5">
            <FieldLabel htmlFor="ex-status">Admission</FieldLabel>
            <div id="ex-status" className="flex gap-2" role="radiogroup" aria-label="Admission status">
              {(['pre_admitted', 'to_offer'] as ExhibitStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={status === s}
                  onClick={() => setStatus(s)}
                  className={`flex-1 px-3 py-2.5 rounded-md border text-[12.5px] transition-colors ${
                    status === s
                      ? 'border-[#d4a054] text-[#e8b84a] bg-[rgba(212,160,84,0.06)]'
                      : 'border-[rgba(255,255,255,0.12)] text-white/60 hover:border-[rgba(255,255,255,0.3)]'
                  }`}
                >
                  {s === 'pre_admitted' ? 'Pre-admitted (stipulated)' : 'To offer at trial'}
                </button>
              ))}
            </div>
            {status === 'pre_admitted' && (
              <p className="text-[10.5px] text-white/30 mt-1.5">
                Publication is fully canned — no objection, ever.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <GoldButton onClick={() => void register()} disabled={!chosenDoc}>
              <FileImage size={14} /> Register {number.trim() || defaultNo}
            </GoldButton>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="text-[11px] uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
