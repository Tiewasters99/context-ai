import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { medApi, mediatorMonogram } from '@/lib/mediation';
import type { MediatorModelInfo } from '@/lib/mediation';
import { GoldButton, QuietButton, Notice, Working, PageHead, INPUT_CLASS, FieldLabel } from '@/components/mediation/ui';

// Register a new mediation. The registering party becomes Party A and receives
// the CM-XXXX-XXXX invite code to send to the other side.

export default function MediationRegister() {
  const [title, setTitle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [models, setModels] = useState<MediatorModelInfo[] | null>(null);
  const [mediatorModel, setMediatorModel] = useState('claude-opus-4-8');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; inviteCode: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    medApi<{ models: MediatorModelInfo[] }>('models.list')
      .then((d) => { if (!cancelled) setModels(d.models); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const d = await medApi<{ id: string; inviteCode: string }>('cases.create', {
        title: title.trim(),
        displayName: displayName.trim(),
        mediatorModel,
      });
      setDone(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-12">
        <PageHead kicker="Contextspaces Mediation" title="The matter is registered" />
        <p className="text-[14px] text-white/70 leading-relaxed max-w-xl">
          Send the other side this invite code — the mediation begins the moment they appear:
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <span
            className="text-[26px] tracking-[0.08em] text-[#d4a054] select-all"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          >
            {done.inviteCode}
          </span>
          <QuietButton onClick={() => navigator.clipboard?.writeText(done.inviteCode).catch(() => {})}>
            Copy the code
          </QuietButton>
        </div>
        <p className="text-[12.5px] text-white/45 mt-4">
          They join from the Mediation Center — <span className="text-white/70">Join with an invite code</span> — after
          signing in to their own Contextspaces account.
        </p>
        <div className="mt-8">
          <Link to={`/app/mediation/case/${done.id}`}>
            <GoldButton>Open the case room</GoldButton>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <PageHead
        kicker="Contextspaces Mediation"
        title="Register a mediation"
        lede="Open the matter, choose your mediator, and receive an invite code for the other side."
      />

      <div className="space-y-6 max-w-xl">
        <div>
          <FieldLabel htmlFor="med-title">Matter title</FieldLabel>
          <input
            id="med-title"
            className={INPUT_CLASS}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="A short, neutral name for the dispute"
          />
        </div>
        <div>
          <FieldLabel htmlFor="med-name">Your name (or your company’s)</FieldLabel>
          <input
            id="med-name"
            className={INPUT_CLASS}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder="How you appear in the mediation"
          />
        </div>

        <div>
          <FieldLabel htmlFor="med-model">Your mediator</FieldLabel>
          {!models && <Working>Convening the panel…</Working>}
          {models && (
            <div className="space-y-2" role="radiogroup" id="med-model">
              {models.map((m) => (
                <label
                  key={m.id}
                  className={`flex items-start gap-3.5 rounded-lg border px-4 py-3 cursor-pointer transition-colors ${
                    mediatorModel === m.id
                      ? 'border-[rgba(212,160,84,0.6)]'
                      : 'border-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.2)]'
                  } ${!m.available ? 'opacity-50 cursor-not-allowed' : ''}`}
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  <input
                    type="radio"
                    name="mediator"
                    className="mt-1 accent-[#d4a054]"
                    checked={mediatorModel === m.id}
                    disabled={!m.available}
                    onChange={() => setMediatorModel(m.id)}
                  />
                  <span
                    className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full border border-[rgba(212,160,84,0.45)] text-[11px] text-[#d4a054]"
                    style={{ fontFamily: '"Playfair Display Variable", serif' }}
                    aria-hidden="true"
                  >
                    {mediatorMonogram(m.label)}
                  </span>
                  <span>
                    <span className="block text-[13.5px] text-white font-medium">
                      {m.label}
                      {!m.available && <span className="ml-2 text-[10px] uppercase tracking-wider text-[#d4a054]">soon</span>}
                    </span>
                    <span className="block text-[12px] text-white/45 mt-0.5 leading-snug">{m.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <GoldButton onClick={submit} disabled={busy || !title.trim() || !displayName.trim()}>
            {busy ? 'Registering…' : 'Register the mediation'}
          </GoldButton>
          <Link to="/app/mediation">
            <QuietButton>Back</QuietButton>
          </Link>
        </div>
        {error && <Notice>{error}</Notice>}
      </div>
    </div>
  );
}
