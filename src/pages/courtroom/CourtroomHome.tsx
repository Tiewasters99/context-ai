import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gavel, Trash2 } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { GoldButton, Notice, FieldLabel, INPUT_CLASS, PageHead } from '@/components/mediation/ui';
import { DEFAULT_VENUE_MIX } from '@/lib/courtroom/sampler.ts';
import { NOT_FOR_JURY_SELECTION } from '@/lib/courtroom/prompts.ts';
import { DEFAULT_JUROR_MODEL, ECONOMY_JUROR_MODEL } from '@/lib/courtroom/live.ts';
import { createTrial, deleteTrial, listTrials, saveJurors, type TrialListRow } from '@/lib/courtroom/persist.ts';
import { samplePanel } from '@/lib/courtroom/sampler.ts';
import { formatUsage } from '@/lib/courtroom/meter.ts';
import type { PanelSize, TrialMode, UsageRecord, VenueMix } from '@/lib/courtroom/types.ts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// The Courtroom — a rehearsal instrument, not an oracle (spec §1). This is
// the front door: name the rehearsal, pick the matter and the panel model,
// set the venue mix, empanel. A WORK surface: linear and lawyerly.

const MODEL_OPTIONS = [
  { id: DEFAULT_JUROR_MODEL, label: 'Claude Fable 5 — the full-depth panel (default)' },
  { id: ECONOMY_JUROR_MODEL, label: 'Claude Opus 4.8 — economy panel' },
];

// Human labels for the venue-mix dimensions (keys are the sampler's).
const DIMENSIONS: {
  key: keyof VenueMix; label: string; options: { value: string; label: string }[];
}[] = [
  {
    key: 'age', label: 'Age',
    options: ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'].map((v) => ({ value: v, label: v })),
  },
  {
    key: 'gender', label: 'Gender',
    options: [
      { value: 'F', label: 'Women' }, { value: 'M', label: 'Men' }, { value: 'NB', label: 'Nonbinary' },
    ],
  },
  {
    key: 'race_ethnicity', label: 'Race / ethnicity',
    options: ['White', 'Black', 'Hispanic', 'Asian', 'Native American', 'Multiracial/Other']
      .map((v) => ({ value: v, label: v })),
  },
  {
    key: 'education', label: 'Education',
    options: [
      { value: 'HS or less', label: 'High school or less' },
      { value: 'HS+some college', label: 'HS + some college' },
      { value: 'College degree', label: 'College degree' },
      { value: 'Postgraduate', label: 'Postgraduate' },
    ],
  },
  {
    key: 'occupation', label: 'Occupation',
    options: [
      { value: 'healthcare', label: 'Healthcare' }, { value: 'trades', label: 'Trades' },
      { value: 'office_admin', label: 'Office / admin' }, { value: 'small_business', label: 'Small business' },
      { value: 'education', label: 'Education' }, { value: 'tech', label: 'Tech' },
      { value: 'retail_service', label: 'Retail / service' }, { value: 'finance', label: 'Finance' },
      { value: 'government', label: 'Government' }, { value: 'transport', label: 'Transport' },
      { value: 'retired', label: 'Retired' },
    ],
  },
];

const STATUS_LABEL: Record<string, string> = {
  empanel: 'Empaneling', segments: 'Building the record', running: 'In session',
  complete: 'Report filed', error: 'Errored',
};

export default function CourtroomHome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: trials, error: trialsError } = useQuery({
    queryKey: ['courtroom-trials'],
    queryFn: listTrials,
  });

  const { data: serverspaces = [] } = useServerspaces();
  const matterOptions = useMemo(
    () => serverspaces.flatMap((s) =>
      s.matterspaces.map((m) => ({ id: m.id, label: `${s.name} / ${m.name}` })),
    ),
    [serverspaces],
  );

  const [title, setTitle] = useState('');
  const [matterId, setMatterId] = useState('');
  const [modelId, setModelId] = useState<string>(DEFAULT_JUROR_MODEL);
  const [panelSize, setPanelSize] = useState<PanelSize>(12);
  const [mode, setMode] = useState<TrialMode>('quick');
  const [mix, setMix] = useState<VenueMix>(() => structuredClone(DEFAULT_VENUE_MIX));
  const [mixOpen, setMixOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const setWeight = (dim: keyof VenueMix, option: string, value: number) => {
    setMix((prev) => {
      const next = structuredClone(prev);
      (next[dim] as Record<string, number>)[option] = value;
      return next;
    });
  };

  const empanel = async () => {
    const clean = title.trim();
    if (!clean || !matterId || creating) return;
    setCreating(true);
    setFormError('');
    try {
      const seed = Math.floor(Math.random() * 2 ** 31);
      const trial = await createTrial({
        matterspaceId: matterId,
        title: clean,
        modelId,
        venueMix: { ...mix, panel_size: panelSize },
        seed,
        mode,
      });
      // Same seed + same mix ⇒ this exact panel is reproducible from the row.
      await saveJurors(trial, samplePanel(mix, seed, panelSize));
      navigate(`/app/courtroom/${trial.id}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The trial could not be created.');
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteTrial(id);
      void queryClient.invalidateQueries({ queryKey: ['courtroom-trials'] });
    } catch {
      /* surfaced on next load */
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
      <PageHead
        kicker="Productivity Suite"
        title="The Courtroom"
        lede="Perform your case — opening, examinations, closing — before a panel of AI jurors, then read what the performance actually did: what landed, what confused, what provoked pushback, and how the panel moved. A rehearsal instrument, not an oracle."
      />

      <p className="text-[11.5px] text-white/40 leading-relaxed border-l-2 border-[rgba(212,160,84,0.4)] pl-3 mb-8">
        {NOT_FOR_JURY_SELECTION}
      </p>

      {/* ---- New rehearsal ---- */}
      <section
        className="rounded-xl border border-[rgba(255,255,255,0.08)] p-5 sm:p-6 mb-10"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-4">New rehearsal</h2>
        <div className="space-y-4">
          <div>
            <FieldLabel htmlFor="ct-title">Rehearsal</FieldLabel>
            <input
              id="ct-title"
              className={INPUT_CLASS}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Anlauf v. UKC — opening and cross, first pass"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="ct-matter">Matter</FieldLabel>
              <select id="ct-matter" className={INPUT_CLASS} value={matterId} onChange={(e) => setMatterId(e.target.value)}>
                <option value="">Choose the matter…</option>
                {matterOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <p className="text-[11px] text-white/30 mt-1">Everything — panel, record, report — stays inside this matter.</p>
            </div>
            <div>
              <FieldLabel htmlFor="ct-model">The panel</FieldLabel>
              <select id="ct-model" className={INPUT_CLASS} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Panel size — 12 is the box; 6 is the fast read. */}
          <div>
            <FieldLabel htmlFor="ct-size">Jurors in the box</FieldLabel>
            <div id="ct-size" className="flex gap-3" role="radiogroup" aria-label="Panel size">
              {([12, 6] as PanelSize[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={panelSize === n}
                  onClick={() => setPanelSize(n)}
                  className={`px-4 py-2 rounded-md border text-[13px] transition-colors ${
                    panelSize === n
                      ? 'border-[#d4a054] text-[#e8b84a] bg-[rgba(212,160,84,0.06)]'
                      : 'border-[rgba(255,255,255,0.12)] text-white/60 hover:border-[rgba(255,255,255,0.3)]'
                  }`}
                >
                  {n === 12 ? 'Twelve — the full box' : 'Six — quick read'}
                </button>
              ))}
            </div>
          </div>

          {/* Session type — Quick Panel or the full adversarial procedure. */}
          <div>
            <FieldLabel htmlFor="ct-mode">Session type</FieldLabel>
            <div id="ct-mode" className="flex gap-3" role="radiogroup" aria-label="Session type">
              {([
                ['quick', 'Quick Panel', 'Reactions, deliberation, report'],
                ['full', 'Full Trial', 'Adds objections, rulings, and strike-leakage measurement'],
              ] as [TrialMode, string, string][]).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  title={hint}
                  className={`px-4 py-2 rounded-md border text-[13px] transition-colors ${
                    mode === m
                      ? 'border-[#d4a054] text-[#e8b84a] bg-[rgba(212,160,84,0.06)]'
                      : 'border-[rgba(255,255,255,0.12)] text-white/60 hover:border-[rgba(255,255,255,0.3)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-white/30 mt-1">
              {mode === 'full'
                ? 'Opposing counsel objects to your advocacy; the Court rules; sustained strikes stay in juror memory — the session measures whether the disregard instruction actually held.'
                : 'The panel hears the record as delivered, deliberates, and reports.'}
            </p>
          </div>

          {/* Venue mix — manual sliders v1 (census presets later). */}
          <div>
            <button
              type="button"
              onClick={() => setMixOpen((v) => !v)}
              className="text-[11px] uppercase tracking-wider text-white/50 hover:text-white/80 transition-colors"
              aria-expanded={mixOpen}
            >
              Venue mix {mixOpen ? '▾' : '▸'}
            </button>
            <p className="text-[11px] text-white/30 mt-1">
              Relative weights for who ends up in the box — the same dial a consultant turns when recruiting
              human mock jurors. Composition shapes the panel sheet only; juror reasoning is sampled from
              occupation and life experience, never from demographics.
            </p>
            {mixOpen && (
              <div className="mt-3 space-y-4">
                {DIMENSIONS.map((dim) => (
                  <div key={dim.key} className="rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-wider text-[#d4a054] mb-2">{dim.label}</div>
                    <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                      {dim.options.map((opt) => (
                        <label key={opt.value} className="flex items-center gap-2.5 text-[12px] text-white/65">
                          <span className="w-32 shrink-0 truncate">{opt.label}</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={(mix[dim.key] as Record<string, number>)[opt.value] ?? 0}
                            onChange={(e) => setWeight(dim.key, opt.value, Number(e.target.value))}
                            className="flex-1 accent-[#d4a054]"
                            aria-label={`${dim.label}: ${opt.label}`}
                          />
                          <span className="w-7 text-right text-white/40 tabular-nums">
                            {(mix[dim.key] as Record<string, number>)[opt.value] ?? 0}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {formError && <Notice>{formError}</Notice>}

          <GoldButton onClick={() => void empanel()} disabled={!title.trim() || !matterId || creating}>
            <Gavel size={14} />
            {creating ? 'Summoning the venire…' : 'Draw the panel'}
          </GoldButton>
        </div>
      </section>

      {/* ---- Past rehearsals ---- */}
      <section aria-label="Your rehearsals">
        <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-2.5">Your rehearsals</h2>
        {trialsError && <Notice>{trialsError instanceof Error ? trialsError.message : 'Could not load rehearsals.'}</Notice>}
        {trials && trials.length === 0 && (
          <p className="text-[13px] text-white/40">No rehearsals yet — your first panel is drawn above.</p>
        )}
        {trials && trials.length > 0 && (
          <ol className="space-y-2">
            {trials.map((t: TrialListRow) => (
              <li key={t.id} className="flex items-center gap-2">
                <Link
                  to={`/app/courtroom/${t.id}`}
                  className="flex items-center justify-between gap-4 flex-1 min-w-0 rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-3 hover:border-[rgba(212,160,84,0.4)] transition-colors"
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  <span className="min-w-0">
                    <span className="block text-[13.5px] text-white truncate">{t.title}</span>
                    <span className="block text-[11px] text-white/35 truncate">
                      {t.matterspace?.name ?? 'matter'} · {(t.venue_mix?.panel_size as number) ?? 12} jurors
                      {(t.usage as UsageRecord)?.calls ? ` · ${formatUsage(t.usage as UsageRecord)}` : ''}
                    </span>
                  </span>
                  <span className="text-[11.5px] text-[#d4a054] shrink-0">{STATUS_LABEL[t.status] ?? t.status}</span>
                </Link>
                <button
                  type="button"
                  onClick={() => void remove(t.id)}
                  className="p-2 rounded-md text-white/30 hover:text-[#f0b9b9] hover:bg-[rgba(240,120,120,0.08)] transition-colors shrink-0"
                  title="Delete rehearsal"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
