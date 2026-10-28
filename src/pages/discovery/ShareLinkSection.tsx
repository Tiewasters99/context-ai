import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, Copy, Check, Lock, Users, Globe, Ban } from 'lucide-react';
import { isSealedMatter, isStepUpRequired } from '@/lib/vault-object';
import {
  listShareLinks, listShareEvents, createShareLink, revokeShareLink, describeShareEvent,
  type ShareAudience, type ShareLink, type ShareEvent, type CreatedLink,
} from '@/lib/production-share';
import type { Production } from '@/lib/discovery';

// "Send a link" — the production's package ZIP, by link, OneDrive style
// (migration 115). Who can open it (anyone with the link, or only people you
// name, who prove it with an emailed code), an optional password, and how
// long it works. A sealed matter offers only the named-people link; the
// server holds the same rule.

const EXPIRY_OPTIONS: { label: string; hours: number }[] = [
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];

const inputCls =
  'w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60 transition-colors';

export default function ShareLinkSection({ production, onSent }: { production: Production; onSent: () => void }) {
  const [sealed, setSealed] = useState<boolean | null>(null);
  const [links, setLinks] = useState<ShareLink[] | null | undefined>(undefined);
  const [events, setEvents] = useState<ShareEvent[]>([]);
  // When the list was last read: a link's Active/Expired is judged against it.
  const [readAt, setReadAt] = useState(() => Date.now());

  const [recipientName, setRecipientName] = useState('');
  const [audience, setAudience] = useState<ShareAudience>('people');
  const [emails, setEmails] = useState('');
  const [password, setPassword] = useState('');
  const [expiryChoice, setExpiryChoice] = useState<string>('');
  const [expiryDate, setExpiryDate] = useState('');
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isSealedMatter(production.matterspace_id).then((s) => {
      if (cancelled) return;
      setSealed(s);
      if (s) setAudience('people');
    });
    return () => { cancelled = true; };
  }, [production.matterspace_id]);

  const reload = useCallback(async () => {
    try {
      const l = await listShareLinks(production.id);
      setReadAt(Date.now());
      setLinks(l);
      if (l) setEvents(await listShareEvents(l.map((x) => x.id)));
    } catch {
      setLinks([]);
    }
  }, [production.id]);

  useEffect(() => { void reload(); }, [reload]);

  // The default life: 48 hours sealed (or not yet known), 7 days otherwise.
  // "Anyone" is offered only once the matter is known to be unsealed.
  const expiryValue = expiryChoice || (sealed !== false ? '48' : '168');

  const handleCreate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMade(null);
    setCopied(false);
    try {
      const out = await createShareLink({
        productionId: production.id,
        recipientName: recipientName.trim(),
        audience,
        emails,
        password,
        expiry: expiryValue === 'date' ? { date: expiryDate } : { hours: Number(expiryValue) },
        send,
      });
      setMade(out);
      setPassword('');
      onSent();
      await reload();
    } catch (e) {
      setError(isStepUpRequired(e) ? e.message : e instanceof Error ? e.message : 'The link could not be made.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeShareLink(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The link could not be turned off.');
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the field is selectable; copying by hand still works */ }
  };

  const eventsByLink = useMemo(() => {
    const m = new Map<string, ShareEvent[]>();
    for (const ev of events) {
      const arr = m.get(ev.link_id) ?? [];
      arr.push(ev);
      m.set(ev.link_id, arr);
    }
    return m;
  }, [events]);

  if (links === null) {
    return (
      <p className="text-[11px] text-[#e8b84a]/85 leading-relaxed rounded-md border border-[#e8b84a]/25 bg-[#e8b84a]/6 px-2.5 py-2">
        Sending by link needs one database update (migration 115) that has not been run yet.
      </p>
    );
  }

  const canCreate = recipientName.trim() && (audience === 'anyone' || emails.trim()) && (expiryValue !== 'date' || expiryDate) && !busy;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Going to (e.g. Defendants' counsel)" className={inputCls} />

        <div>
          <p className="text-[10.5px] text-white/45 mb-1">Who can open it</p>
          <div className="flex rounded-md border border-[rgba(255,255,255,0.1)] overflow-hidden" role="radiogroup" aria-label="Who can open it">
            <AudienceButton on={audience === 'people'} onClick={() => setAudience('people')} icon={<Users size={11} />} label="Only people I name" />
            {sealed === false && (
              <AudienceButton on={audience === 'anyone'} onClick={() => setAudience('anyone')} icon={<Globe size={11} />} label="Anyone with the link" />
            )}
          </div>
          {sealed === true && (
            <p className="mt-1 text-[10.5px] text-white/45">This matter is sealed, so only the people you name can open the link, each with a code sent to their email.</p>
          )}
        </div>

        <textarea
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={audience === 'people' ? 'Their email addresses (one per line, or separated by commas)' : 'Email addresses to send it to (optional)'}
          rows={2}
          className={`${inputCls} resize-none`}
        />

        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-[10.5px] text-white/45 mb-1">Works for</p>
            <select value={expiryValue} onChange={(e) => setExpiryChoice(e.target.value)} className={`${inputCls} [color-scheme:dark]`}>
              {EXPIRY_OPTIONS.map((o) => <option key={o.hours} value={String(o.hours)}>{o.label}</option>)}
              <option value="date">Until a date…</option>
            </select>
          </div>
          <div>
            <p className="text-[10.5px] text-white/45 mb-1">Password (optional)</p>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder="At least 8 characters" className={inputCls} />
          </div>
        </div>
        {expiryValue === 'date' && (
          <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={`${inputCls} [color-scheme:dark]`} />
        )}
        {password && (
          <p className="text-[10.5px] text-white/45">The password is not put in the email. Give it to them another way (a call, a text).</p>
        )}

        <label className="flex items-center gap-2 text-[11.5px] text-white/70 cursor-pointer">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} className="accent-[#d4a054]" />
          Email the link to them
        </label>

        {error && <p className="text-[11px] text-red-300">{error}</p>}
        <button
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-40"
        >
          <Link2 size={12} strokeWidth={1.75} />
          {busy ? 'Making the link…' : send && emails.trim() ? 'Make the link and email it' : 'Make the link'}
        </button>
      </div>

      {made && (
        <div className="rounded-lg border border-[#4ade80]/25 bg-[#4ade80]/6 px-3 py-2.5 space-y-1.5">
          <p className="text-[11.5px] text-[#4ade80]">
            {made.emailed.length > 0
              ? `Link made and emailed to ${made.emailed.join(', ')}.`
              : 'Link made.'}
          </p>
          {made.email_error === 'email_not_configured' && (
            <p className="text-[11px] text-[#e8b84a]">Email is not set up on this site yet, so nothing was sent. Copy the link and send it yourself.</p>
          )}
          {made.email_error === 'send_failed' && (
            <p className="text-[11px] text-[#e8b84a]">The email could not be sent{made.email_detail ? ` (${made.email_detail})` : ''}. Copy the link and send it yourself.</p>
          )}
          <div className="flex items-center gap-1.5">
            <input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono text-[10.5px]`} />
            <button onClick={() => void copy(made.url)} className="shrink-0 px-2 py-1.5 rounded-md border border-white/15 text-white/70 hover:text-white" title="Copy the link">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      )}

      {links && links.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-white/45 uppercase tracking-wider mb-1.5">Links</p>
          <div className="rounded-md border border-[rgba(255,255,255,0.08)] divide-y divide-[rgba(255,255,255,0.05)]">
            {links.map((l) => (
              <LinkRow key={l.id} link={l} now={readAt} events={eventsByLink.get(l.id) ?? []} onRevoke={() => void handleRevoke(l.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AudienceButton({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium transition-colors ${
        on ? 'bg-[#d4a054]/20 text-[#e8b84a]' : 'text-white/55 hover:text-white hover:bg-[rgba(255,255,255,0.04)]'
      }`}
    >
      {icon}{label}
    </button>
  );
}

function LinkRow({ link, now, events, onRevoke }: { link: ShareLink; now: number; events: ShareEvent[]; onRevoke: () => void }) {
  const [open, setOpen] = useState(false);
  const expired = new Date(link.expires_at).getTime() <= now;
  const state = link.revoked_at ? 'Turned off' : expired ? 'Expired' : 'Active';
  const color = link.revoked_at || expired ? 'text-white/35' : 'text-[#4ade80]';
  const fmt = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const failures = events.filter((e) => e.kind.startsWith('refused_')).length;

  return (
    <div className="px-2.5 py-2">
      <div className="flex items-center gap-2">
        {link.audience === 'people' ? <Users size={11} className="text-white/45 shrink-0" /> : <Globe size={11} className="text-white/45 shrink-0" />}
        {link.has_password && <Lock size={10} className="text-white/45 shrink-0" />}
        <span className="text-[11.5px] text-[#f5f1e8] truncate">{link.recipient_name ?? 'Link'}</span>
        <span className={`text-[9.5px] uppercase tracking-wider ${color} shrink-0`}>{state}</span>
        {!link.revoked_at && !expired && (
          <button onClick={onRevoke} className="ml-auto flex items-center gap-1 text-[10.5px] text-red-300/80 hover:text-red-300 shrink-0" title="Turn this link off now">
            <Ban size={10} /> Turn off
          </button>
        )}
      </div>
      <p className="text-[10px] text-white/40 mt-0.5">
        {link.audience === 'people' ? link.allowed_emails.join(', ') : 'Anyone with the link'}
        {' · '}{link.revoked_at ? `turned off ${fmt(link.revoked_at)}` : `${expired ? 'expired' : 'works until'} ${fmt(link.expires_at)}`}
        {' · '}{link.download_count} download{link.download_count === 1 ? '' : 's'}
        {failures > 0 ? ` · ${failures} refused` : ''}
      </p>
      {events.length > 0 && (
        <button onClick={() => setOpen((v) => !v)} className="text-[10px] text-[#d4a054]/80 hover:text-[#d4a054] mt-0.5">
          {open ? 'Hide activity' : 'Show activity'}
        </button>
      )}
      {open && (
        <ul className="mt-1 space-y-0.5">
          {events.map((ev) => (
            <li key={ev.id} className="text-[10px] text-white/50 flex gap-2">
              <span className="tabular-nums text-white/35 shrink-0">{fmt(ev.created_at)}</span>
              <span className={ev.kind.startsWith('refused_') ? 'text-red-300/80' : ''}>{describeShareEvent(ev.kind)}</span>
              {ev.email && <span className="truncate">{ev.email}</span>}
              {ev.ip && <span className="text-white/30 shrink-0">{ev.ip}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
