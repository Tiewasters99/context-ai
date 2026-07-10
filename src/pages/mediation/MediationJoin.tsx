import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { medApi } from '@/lib/mediation';
import { GoldButton, QuietButton, Notice, PageHead, INPUT_CLASS, FieldLabel } from '@/components/mediation/ui';

// Join a mediation with the CM-XXXX-XXXX invite code the registering party
// sent. The joiner becomes Party B and the matter moves to intake.

export default function MediationJoin() {
  const navigate = useNavigate();
  const [inviteCode, setInviteCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const d = await medApi<{ id: string }>('join', {
        inviteCode: inviteCode.trim(),
        displayName: displayName.trim(),
      });
      navigate(`/app/mediation/case/${d.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Joining failed.');
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <PageHead
        kicker="Contextspaces Mediation"
        title="Join a mediation"
        lede="Enter the invite code the other side sent you to take your seat in the case room."
      />

      <div className="space-y-6 max-w-xl">
        <div>
          <FieldLabel htmlFor="join-code">Invite code</FieldLabel>
          <input
            id="join-code"
            className={INPUT_CLASS}
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            placeholder="CM-XXXX-XXXX"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
          />
        </div>
        <div>
          <FieldLabel htmlFor="join-name">Your name (or your company’s)</FieldLabel>
          <input
            id="join-name"
            className={INPUT_CLASS}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder="How you appear in the mediation"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <GoldButton onClick={submit} disabled={busy || !inviteCode.trim() || !displayName.trim()}>
            {busy ? 'Joining…' : 'Join the mediation'}
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
