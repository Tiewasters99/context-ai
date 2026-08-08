import { useState } from 'react';
import { Dices, Gavel, UserRound } from 'lucide-react';
import FloatingPanel from '@/pages/discovery/FloatingPanel';
import { GoldButton, QuietButton, Notice, FieldLabel, INPUT_CLASS, TEXTAREA_CLASS } from '@/components/mediation/ui';
import { refreshVoice } from '@/lib/courtroom/sampler.ts';
import { updateJuror } from '@/lib/courtroom/persist.ts';
import type {
  AgeBand, CognitiveStyle, CommunicationStyle, Education, Gender,
  JurorAttitudes, JurorProfile, OccupationClass, RaceEthnicity, SalienceBias,
} from '@/lib/courtroom/types.ts';

// The panel sheet — the jury box, drawn as a box: two raked rows of seat
// plaques, not a card grid. Every field of every juror is editable before
// empanelment (transparency builds trust, and it lets counsel test a specific
// worry: "give me a panel heavy on personal-responsibility ethic"). The
// dossier opens in a draggable/resizable floating panel (house rule).

const AGE_BANDS: AgeBand[] = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const GENDERS: Gender[] = ['F', 'M', 'NB'];
const RACES: RaceEthnicity[] = ['White', 'Black', 'Hispanic', 'Asian', 'Native American', 'Multiracial/Other'];
const EDUCATIONS: Education[] = ['HS or less', 'HS+some college', 'College degree', 'Postgraduate'];
const OCCUPATIONS: OccupationClass[] = [
  'healthcare', 'trades', 'office_admin', 'small_business', 'education', 'tech',
  'retail_service', 'finance', 'government', 'transport', 'retired',
];
const COGNITIVE: CognitiveStyle[] = ['analytic', 'narrative', 'social', 'driver'];
const COMMUNICATION: CommunicationStyle[] = ['talkative', 'reserved', 'friendly', 'blunt'];
const SALIENCE: SalienceBias[] = ['numbers', 'story', 'credibility', 'fairness'];

const ATTITUDE_KEYS: (keyof JurorAttitudes)[] = [
  'institutional_trust', 'claims_consciousness', 'authority_orientation',
  'risk_tolerance', 'corporate_skepticism', 'personal_responsibility_ethic',
];

/** Six thin bars — the juror's attitude fingerprint at a glance. */
function AttitudeGlyph({ attitudes }: { attitudes: JurorAttitudes }) {
  return (
    <span className="flex items-end gap-[2px] h-3.5" aria-hidden>
      {ATTITUDE_KEYS.map((k) => (
        <span
          key={k}
          className="w-[3px] rounded-sm bg-[#d4a054]/70"
          style={{ height: `${(attitudes[k] / 7) * 100}%` }}
        />
      ))}
    </span>
  );
}

function SeatPlaque({
  juror, active, onClick,
}: { juror: JurorProfile; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-full text-left rounded-md border px-2.5 py-2 transition-colors ${
        active
          ? 'border-[#d4a054] bg-[rgba(212,160,84,0.1)]'
          : 'border-[rgba(212,160,84,0.22)] bg-[rgba(26,20,12,0.85)] hover:border-[rgba(212,160,84,0.55)]'
      }`}
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 6px rgba(0,0,0,0.4)' }}
      title={`Seat ${juror.seat} — open dossier`}
    >
      <span className="absolute -top-2 left-2 text-[9px] tracking-widest px-1.5 rounded-sm bg-[#0b0a08] border border-[rgba(212,160,84,0.35)] text-[#d4a054]">
        {juror.seat}
      </span>
      <span className="block text-[12px] text-white/90 truncate mt-0.5">{juror.display_name}</span>
      <span className="block text-[10px] text-white/40 truncate">{juror.reasoning.occupation_detail}</span>
      <span className="mt-1 flex items-center justify-between">
        <AttitudeGlyph attitudes={juror.reasoning.attitudes} />
        <UserRound size={11} className="text-white/25" />
      </span>
    </button>
  );
}

export default function PanelSheet({
  jurors, onJurorSaved, onResample, onEmpanel, busy,
}: {
  jurors: JurorProfile[];
  onJurorSaved: (j: JurorProfile) => void;
  onResample: () => void;
  onEmpanel: () => void;
  busy: boolean;
}) {
  const [openSeat, setOpenSeat] = useState<number | null>(null);
  const [error, setError] = useState('');
  const active = jurors.find((j) => j.seat === openSeat) ?? null;

  const back = jurors.filter((j) => j.seat > Math.ceil(jurors.length / 2));
  const front = jurors.filter((j) => j.seat <= Math.ceil(jurors.length / 2));

  return (
    <section aria-label="Panel sheet">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[11px] uppercase tracking-wider text-white/50">The box — your venire</h2>
        <span className="text-[11px] text-white/30">Click a seat to open the dossier. Every field is yours to edit.</span>
      </div>

      {/* The jury box: raked back row, front row, rail. */}
      <div
        className="rounded-xl border border-[rgba(212,160,84,0.2)] px-4 pt-6 pb-4"
        style={{ background: 'linear-gradient(180deg, rgba(20,15,9,0.9), rgba(10,9,7,0.95))' }}
      >
        <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.max(front.length, 1)}, minmax(0, 1fr))` }}>
          {back.map((j) => (
            <SeatPlaque key={j.id} juror={j} active={openSeat === j.seat} onClick={() => setOpenSeat(j.seat)} />
          ))}
        </div>
        <div
          className="grid gap-2.5 mt-3"
          style={{ gridTemplateColumns: `repeat(${Math.max(front.length, 1)}, minmax(0, 1fr))` }}
        >
          {front.map((j) => (
            <SeatPlaque key={j.id} juror={j} active={openSeat === j.seat} onClick={() => setOpenSeat(j.seat)} />
          ))}
        </div>
        <div className="mt-4 h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(212,160,84,0.35), rgba(212,160,84,0.12))' }} />
      </div>

      {error && <Notice>{error}</Notice>}

      <div className="flex flex-wrap gap-3 mt-5">
        <GoldButton onClick={onEmpanel} disabled={busy || jurors.length === 0}>
          <Gavel size={14} /> Empanel this panel
        </GoldButton>
        <QuietButton onClick={onResample} disabled={busy}>
          <Dices size={14} /> Resample the venire
        </QuietButton>
      </div>
      <p className="text-[11px] text-white/30 mt-2 max-w-xl">
        Attitudes are sampled from occupation and life experience only — never from demographics.
        Demographics appear on this sheet because panel composition is a fact worth seeing; they drive nothing.
      </p>

      {active && (
        <JurorDossier
          key={active.id}
          juror={active}
          onClose={() => setOpenSeat(null)}
          onSaved={(j) => { onJurorSaved(j); setError(''); }}
          onError={setError}
        />
      )}
    </section>
  );
}

/* ============================ Juror dossier =============================== */

function JurorDossier({
  juror, onClose, onSaved, onError,
}: {
  juror: JurorProfile;
  onClose: () => void;
  onSaved: (j: JurorProfile) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<JurorProfile>(() => structuredClone(juror));
  const [saving, setSaving] = useState(false);

  const patch = (fn: (d: JurorProfile) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const finished = refreshVoice(draft);
      await updateJuror(finished);
      onSaved(finished);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The juror could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const sel = (value: string, options: readonly string[], onChange: (v: string) => void, id: string) => (
    <select id={id} className={INPUT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
    </select>
  );

  return (
    <FloatingPanel
      title={`Seat ${juror.seat} — ${draft.display_name}`}
      icon={<UserRound size={14} />}
      storageKey="courtroom-dossier"
      defaultStyle={{ right: 24, top: 90, width: 420 }}
      onClose={onClose}
    >
      <div className="px-4 py-4 space-y-4 cursor-auto select-text">
        <div>
          <FieldLabel htmlFor="jd-name">Name</FieldLabel>
          <input
            id="jd-name" className={INPUT_CLASS} value={draft.display_name}
            onChange={(e) => patch((d) => { d.display_name = e.target.value; })}
          />
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-[#d4a054] mb-2">Composition — the sheet</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor="jd-age">Age band</FieldLabel>
              {sel(draft.composition.age_band, AGE_BANDS, (v) => patch((d) => { d.composition.age_band = v as AgeBand; }), 'jd-age')}
            </div>
            <div>
              <FieldLabel htmlFor="jd-gender">Gender</FieldLabel>
              {sel(draft.composition.gender, GENDERS, (v) => patch((d) => { d.composition.gender = v as Gender; }), 'jd-gender')}
            </div>
            <div>
              <FieldLabel htmlFor="jd-race">Race / ethnicity</FieldLabel>
              {sel(draft.composition.race_ethnicity, RACES, (v) => patch((d) => { d.composition.race_ethnicity = v as RaceEthnicity; }), 'jd-race')}
            </div>
            <div>
              <FieldLabel htmlFor="jd-edu">Education</FieldLabel>
              {sel(draft.composition.education, EDUCATIONS, (v) => patch((d) => { d.composition.education = v as Education; }), 'jd-edu')}
            </div>
          </div>
          <p className="text-[10.5px] text-white/30 mt-1.5">
            Composition never reaches the juror's reasoning or prompts.
          </p>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-[#d4a054] mb-2">Reasoning — what actually decides</div>
          <div className="space-y-3">
            <div>
              <FieldLabel htmlFor="jd-occclass">Occupation class</FieldLabel>
              {sel(draft.composition.occupation_class, OCCUPATIONS, (v) => patch((d) => { d.composition.occupation_class = v as OccupationClass; }), 'jd-occclass')}
            </div>
            <div>
              <FieldLabel htmlFor="jd-occ">Occupation detail</FieldLabel>
              <input
                id="jd-occ" className={INPUT_CLASS} value={draft.reasoning.occupation_detail}
                onChange={(e) => patch((d) => { d.reasoning.occupation_detail = e.target.value; })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="jd-exp">Life experiences (one per line)</FieldLabel>
              <textarea
                id="jd-exp" className={`${TEXTAREA_CLASS} min-h-[5rem]`}
                value={draft.reasoning.life_experiences.join('\n')}
                onChange={(e) => patch((d) => {
                  d.reasoning.life_experiences = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="jd-att">Attitudes (1-7 — the predictive engine)</FieldLabel>
              <div id="jd-att" className="space-y-1.5">
                {ATTITUDE_KEYS.map((k) => (
                  <label key={k} className="flex items-center gap-2.5 text-[11.5px] text-white/65">
                    <span className="w-40 shrink-0 truncate">{k.replace(/_/g, ' ')}</span>
                    <input
                      type="range" min={1} max={7}
                      value={draft.reasoning.attitudes[k]}
                      onChange={(e) => patch((d) => { d.reasoning.attitudes[k] = Number(e.target.value); })}
                      className="flex-1 accent-[#d4a054]"
                      aria-label={k.replace(/_/g, ' ')}
                    />
                    <span className="w-4 text-right text-white/40 tabular-nums">{draft.reasoning.attitudes[k]}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <FieldLabel htmlFor="jd-cog">Cognitive</FieldLabel>
                {sel(draft.reasoning.cognitive_style, COGNITIVE, (v) => patch((d) => { d.reasoning.cognitive_style = v as CognitiveStyle; }), 'jd-cog')}
              </div>
              <div>
                <FieldLabel htmlFor="jd-comm">Speaks</FieldLabel>
                {sel(draft.reasoning.communication, COMMUNICATION, (v) => patch((d) => { d.reasoning.communication = v as CommunicationStyle; }), 'jd-comm')}
              </div>
              <div>
                <FieldLabel htmlFor="jd-sal">Salience</FieldLabel>
                {sel(draft.reasoning.salience_bias, SALIENCE, (v) => patch((d) => { d.reasoning.salience_bias = v as SalienceBias; }), 'jd-sal')}
              </div>
            </div>
          </div>
        </div>

        <p className="text-[10.5px] text-white/30 leading-relaxed">
          Backstory and register regenerate from these fields on save.
        </p>

        <div className="flex gap-2.5 pb-1">
          <GoldButton onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save juror'}
          </GoldButton>
          <QuietButton onClick={onClose}>Cancel</QuietButton>
        </div>
      </div>
    </FloatingPanel>
  );
}
