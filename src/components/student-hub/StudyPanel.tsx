import { useCallback, useEffect, useRef, useState } from 'react';
import { converse } from '@/lib/llm';
import {
  listMessages, addMessage, aideSystem,
  type StudySession, type StudyMessage,
} from '@/lib/student-hub';
import {
  getGroupForText, createGroup, listMembers, claimAndAttest,
  addMember, removeMember, sendInvitation,
  listGroupMessages, sendGroupMessage, subscribeGroupMessages, videoRoomUrl,
  ATTESTATION, GROUP_CAP,
  type StudyGroup, type GroupMember, type GroupMessage, type GroupAnchor,
} from '@/lib/student-hub-groups';
import { supabase } from '@/lib/supabase';
import { QuietControl } from './ui';
import { T } from './theme';

// The study panel — floating at mid-page right, draggable by its ribbon,
// resizable from the corner. Two tabs: ASSISTANT (direct answers grounded
// in the reading, private — the same assistant the shelf floats, standing
// closer to the text) and YOUR GROUP (chat over this text, passage-anchored
// questions, group video).
//
// A group seats five people counting whoever formed it, and that person is
// its whole administration: they add an address, the invitation goes out,
// and they can take the seat back. The roster below spells that out rather
// than leaving it to be discovered.

export interface GroupSeed {
  content: string;
  anchor?: GroupAnchor;
  nonce: number;
}

const label: React.CSSProperties = {
  fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', marginBottom: 3,
};

/** What happened to an invitation while this panel has been open. */
type InviteNote = 'sending' | 'sent' | 'email_not_configured' | 'error';

const INVITE_NOTE: Record<InviteNote, string> = {
  sending: 'sending the invitation…',
  sent: 'invitation sent',
  email_not_configured:
    'Email sending isn’t set up yet — ask them to create a Contextspaces account with this address and their seat will be waiting.',
  error: 'the invitation didn’t go out — the seat is still theirs',
};

function PanelTab({ active, children, onClick }: {
  active: boolean; children: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none', border: 'none', cursor: 'pointer', flex: 1,
        background: active ? T.paper : 'transparent',
        color: active ? T.green : 'rgba(250,248,242,0.75)',
        fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', padding: '7px 0',
        borderBottom: active ? 'none' : `1px solid ${T.rule}`,
      }}
    >
      {children}
    </button>
  );
}

export function StudyPanel({ session, seed, onSeedConsumed, askSeed, onAskSeedConsumed }: {
  session: StudySession;
  seed: GroupSeed | null;
  onSeedConsumed: () => void;
  /** A nonce from outside — the reading's own "ask your assistant" control. */
  askSeed?: number | null;
  onAskSeedConsumed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'aide' | 'group'>('aide');
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  /* ---------------- assistant ---------------- */
  const [aideMsgs, setAideMsgs] = useState<StudyMessage[] | null>(null);
  const [aideLive, setAideLive] = useState('');
  const [aideBusy, setAideBusy] = useState(false);
  const [aideInput, setAideInput] = useState('');

  /* ---------------- group ---------------- */
  const [group, setGroup] = useState<StudyGroup | null | 'loading'>('loading');
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [gMsgs, setGMsgs] = useState<GroupMessage[]>([]);
  const [gInput, setGInput] = useState('');
  const [myEmail, setMyEmail] = useState('');
  const [myUid, setMyUid] = useState('');
  const [newName, setNewName] = useState('Study group');
  const [newEmails, setNewEmails] = useState('');
  const [attestChecked, setAttestChecked] = useState(false);
  const [creating, setCreating] = useState(false);

  /* ---------------- the roster (seats) ---------------- */
  const [rosterOpen, setRosterOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [adding, setAdding] = useState(false);
  /* What became of each invitation this sitting. Nothing in the schema
     records it, so a reload leaves a row showing only claimed/unclaimed. */
  const [inviteState, setInviteState] = useState<Record<string, InviteNote>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const rosterShown = useRef(false);

  const [err, setErr] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Trouble adding someone clears itself; the row keeps the outcome. */
  const flashErr = useCallback((message: string) => {
    setErr(message);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setErr(''), 6000);
  }, []);

  /* A passage question arrives from the annotation card. */
  useEffect(() => {
    if (!seed) return;
    setOpen(true);
    setTab('group');
    setGInput(seed.content);
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  /* The reading's toolbar asks for the assistant. */
  useEffect(() => {
    if (askSeed == null) return;
    setOpen(true);
    setTab('aide');
    onAskSeedConsumed?.();
  }, [askSeed, onAskSeedConsumed]);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setMyEmail(data.user?.email ?? '');
      setMyUid(data.user?.id ?? '');
    });
  }, []);

  /* Load the assistant thread once opened. */
  useEffect(() => {
    if (!open || tab !== 'aide' || aideMsgs !== null) return;
    listMessages(session.id, 'ask')
      .then(setAideMsgs)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not open the assistant.'));
  }, [open, tab, aideMsgs, session.id]);

  /* Load the group once opened; subscribe while ready. */
  useEffect(() => {
    if (!open || tab !== 'group' || !session.text_id) return;
    let stale = false;
    getGroupForText(session.text_id)
      .then(async (g) => {
        if (stale) return;
        setGroup(g);
        if (!g) return;
        const [ms, msgs] = await Promise.all([listMembers(g.id), listGroupMessages(g.id)]);
        if (stale) return;
        setMembers(ms);
        msgs.forEach((m) => seenIds.current.add(m.id));
        setGMsgs(msgs);
      })
      .catch((e) => { if (!stale) setErr(e instanceof Error ? e.message : 'Could not open the group.'); });
    return () => { stale = true; };
  }, [open, tab, session.text_id]);

  useEffect(() => {
    if (!open || tab !== 'group' || group === 'loading' || !group) return;
    return subscribeGroupMessages(group.id, (m) => {
      if (seenIds.current.has(m.id)) return;
      seenIds.current.add(m.id);
      setGMsgs((prev) => [...prev, m]);
    });
  }, [open, tab, group]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [aideMsgs, aideLive, gMsgs, tab]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (errTimer.current) clearTimeout(errTimer.current);
  }, []);

  /* A group with an empty seat opens its roster once, for its owner: the
     first thing they should see is that filling it is theirs to do. */
  useEffect(() => {
    if (rosterShown.current || group === 'loading' || !group || !myUid) return;
    if (group.created_by !== myUid || !members.length) return;
    rosterShown.current = true;
    if (members.length < GROUP_CAP) setRosterOpen(true);
  }, [group, members, myUid]);

  /* ---------------- actions ---------------- */

  const askAide = useCallback(async () => {
    const q = aideInput.trim();
    if (!q || aideBusy || aideMsgs === null) return;
    setAideInput('');
    setErr('');
    let mine: StudyMessage;
    try {
      mine = await addMessage(session.id, 'student', q, 'ask');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Your question could not be saved.');
      setAideInput(q);
      return;
    }
    const history = [...aideMsgs, mine];
    setAideMsgs(history);
    setAideBusy(true);
    setAideLive('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = '';
    await converse({
      modelId: session.model_id,
      system: aideSystem(session),
      messages: history.map((m) => ({
        role: m.role === 'professor' ? 'assistant' as const : 'user' as const,
        content: m.content,
      })),
      maxTokens: 1500,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setAideLive(text); },
        onDone: () => { /* persisted below */ },
        onError: (e) => setErr(e),
      },
    });
    setAideBusy(false);
    setAideLive('');
    if (!text) return;
    try {
      const saved = await addMessage(session.id, 'professor', text, 'ask');
      setAideMsgs((prev) => (prev ? [...prev, saved] : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The answer could not be saved.');
    }
  }, [aideInput, aideBusy, aideMsgs, session]);

  const create = useCallback(async () => {
    if (!session.text_id || !attestChecked || creating) return;
    setCreating(true);
    setErr('');
    try {
      const g = await createGroup(session.text_id, newName.trim() || 'Study group', newEmails.split(','));
      setGroup(g);
      const seated = await listMembers(g.id);
      setMembers(seated);
      setRosterOpen(true);
      rosterShown.current = true;
      // Everyone named on the form is invited straight away — same mail, same
      // graceful failure, as when a seat is handed out one at a time.
      for (const m of seated.filter((s) => !s.user_id)) {
        setInviteState((prev) => ({ ...prev, [m.email.toLowerCase()]: 'sending' }));
        try {
          const outcome = await sendInvitation(g.id, m.email);
          setInviteState((prev) => ({ ...prev, [m.email.toLowerCase()]: outcome }));
        } catch {
          setInviteState((prev) => ({ ...prev, [m.email.toLowerCase()]: 'error' }));
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The group could not be created.');
    } finally {
      setCreating(false);
    }
  }, [session.text_id, attestChecked, creating, newName, newEmails]);

  const attest = useCallback(async () => {
    if (group === 'loading' || !group) return;
    try {
      await claimAndAttest(group.id);
      setMembers(await listMembers(group.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The attestation could not be recorded.');
    }
  }, [group]);

  /* Admit one person: the seat is written first and kept whatever the
     mailer does, because the seat is the thing that matters — anyone who
     creates an account with that address finds it waiting. */
  const admit = useCallback(async () => {
    if (group === 'loading' || !group || adding) return;
    const addr = inviteEmail.trim().toLowerCase();
    if (!addr) return;
    setAdding(true);
    setErr('');
    try {
      await addMember(group.id, addr);
    } catch (e) {
      setAdding(false);
      flashErr(e instanceof Error ? e.message : 'That seat could not be given.');
      return;
    }
    setInviteEmail('');
    setInviteState((prev) => ({ ...prev, [addr]: 'sending' }));
    try {
      setMembers(await listMembers(group.id));
    } catch { /* the insert stood; the list refreshes on the next open */ }
    try {
      const outcome = await sendInvitation(group.id, addr);
      setInviteState((prev) => ({ ...prev, [addr]: outcome }));
    } catch (e) {
      setInviteState((prev) => ({ ...prev, [addr]: 'error' }));
      flashErr(e instanceof Error ? e.message : 'The invitation could not be sent.');
    } finally {
      setAdding(false);
    }
  }, [group, adding, inviteEmail, flashErr]);

  const evict = useCallback(async (email: string) => {
    if (group === 'loading' || !group) return;
    setConfirmRemove(null);
    try {
      await removeMember(group.id, email);
      setMembers(await listMembers(group.id));
      setInviteState((prev) => {
        const next = { ...prev };
        delete next[email.toLowerCase()];
        return next;
      });
    } catch (e) {
      flashErr(e instanceof Error ? e.message : 'That seat could not be taken back.');
    }
  }, [group, flashErr]);

  const sendToGroup = useCallback(async (content: string, anchor?: GroupAnchor) => {
    if (group === 'loading' || !group || !content.trim()) return;
    setErr('');
    try {
      const m = await sendGroupMessage(group.id, content.trim(), { sessionId: session.id, anchor });
      if (!seenIds.current.has(m.id)) {
        seenIds.current.add(m.id);
        setGMsgs((prev) => [...prev, m]);
      }
      setGInput('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The message could not be sent.');
    }
  }, [group, session.id]);

  const startVideo = useCallback(async () => {
    if (group === 'loading' || !group) return;
    const url = videoRoomUrl(group);
    window.open(url, '_blank', 'noopener');
    await sendToGroup(`Join me on video: ${url}`);
  }, [group, sendToGroup]);

  const onRibbonDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY, x: drag.x, y: drag.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onRibbonMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) });
  };
  const onRibbonUp = () => { dragRef.current = null; };

  /* ---------------- render ---------------- */

  if (!open) {
    // Two slim index tabs on the right edge — like tabs on a binder.
    // Quieter than a floating pill, and clear of the corner controls.
    const edgeTab = (top: string, label: string, target: 'aide' | 'group') => (
      <button
        key={target}
        type="button"
        onClick={() => { setTab(target); setOpen(true); }}
        style={{
          position: 'fixed', right: 0, top, transform: 'translateY(-50%)', zIndex: 40,
          appearance: 'none', cursor: 'pointer',
          writingMode: 'vertical-rl',
          background: T.greenDark, color: T.paper,
          border: 'none', borderLeft: `2px solid ${T.brass}`,
          borderRadius: '6px 0 0 6px',
          fontFamily: T.sans, fontSize: 10.5, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          padding: '14px 7px',
        }}
      >
        {label}
      </button>
    );
    return (
      <>
        {edgeTab('30%', 'Assistant', 'aide')}
        {edgeTab('56%', 'Group', 'group')}
      </>
    );
  }

  const myRow = members.find((m) => m.email.toLowerCase() === myEmail.toLowerCase());
  const needsAttest = group !== 'loading' && group && myRow && !myRow.attested_at;
  const theGroup = group === 'loading' ? null : group;
  // Whoever formed the group is its whole administration.
  const isOwner = !!theGroup && !!myUid && theGroup.created_by === myUid;
  const ownerEmail = theGroup
    ? members.find((m) => m.user_id === theGroup.created_by)?.email ?? ''
    : '';
  const seatsOpen = Math.max(0, GROUP_CAP - members.length);

  return (
    <div
      style={{
        position: 'fixed', right: 14, top: '50%', zIndex: 40,
        transform: `translate(${drag.x}px, calc(-50% + ${drag.y}px))`,
        width: 'min(430px, calc(100vw - 36px))', height: 'min(520px, calc(100vh - 80px))',
        minWidth: 300, minHeight: 280, resize: 'both', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 2,
      }}
    >
      {/* Ribbon header — the drag handle */}
      <div
        onPointerDown={onRibbonDown}
        onPointerMove={onRibbonMove}
        onPointerUp={onRibbonUp}
        style={{
          background: T.greenDark, borderBottom: `2px solid ${T.brass}`, cursor: 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', touchAction: 'none', userSelect: 'none', flexShrink: 0,
        }}
      >
        <span style={{
          fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.brass,
        }}>
          Study panel
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close the panel"
          style={{
            appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
            color: T.paper, fontSize: 14, lineHeight: 1, padding: 2,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', flexShrink: 0, background: T.greenDark }}>
        <PanelTab active={tab === 'aide'} onClick={() => setTab('aide')}>Assistant</PanelTab>
        <PanelTab active={tab === 'group'} onClick={() => setTab('group')}>Your group</PanelTab>
      </div>

      {/* ---------------- assistant tab ---------------- */}
      {tab === 'aide' && (
        <>
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {(aideMsgs ?? []).length === 0 && !aideBusy && (
              <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, lineHeight: 1.55 }}>
                The assistant has read this reading, and it is limited mostly by your
                imagination. Try: AP study questions on tonight&rsquo;s reading &middot; SAT
                vocabulary lists and a prep session &middot; an interactive book report &middot;
                a multimedia class presentation &middot; &ldquo;What does a nonsuit correspond
                to today?&rdquo; And soon: build your own Miniverse&trade; from what you&rsquo;re
                reading &mdash; a Fitzgerald Riviera to walk through with your study group.
                <span style={{ color: T.brass }}> (coming)</span>
              </p>
            )}
            {(aideMsgs ?? []).map((m) => (
              <div key={m.id} style={{ margin: '10px 0' }}>
                <div style={{ ...label, color: m.role === 'professor' ? T.green : T.faint }}>
                  {m.role === 'professor' ? 'THE ASSISTANT:' : 'YOU:'}
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
                  {m.content}
                </div>
              </div>
            ))}
            {aideBusy && (
              <div style={{ margin: '10px 0' }}>
                <div style={{ ...label, color: T.green }}>THE ASSISTANT:</div>
                <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
                  {aideLive || <span style={{ color: T.faint, fontStyle: 'italic' }}>…</span>}
                </div>
              </div>
            )}
            {err && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood }}>{err}</div>}
          </div>
          <div style={{ borderTop: `1px solid ${T.rule}`, padding: 10, display: 'flex', gap: 8, flexShrink: 0 }}>
            <textarea
              value={aideInput}
              onChange={(e) => setAideInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void askAide(); } }}
              rows={1}
              placeholder="Ask your assistant…"
              style={{
                flex: 1, resize: 'none', fontFamily: T.serif, fontSize: 14, lineHeight: 1.5,
                padding: '8px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
                background: '#FFFFFF', color: T.ink, outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => void askAide()}
              disabled={aideBusy || !aideInput.trim()}
              style={{
                appearance: 'none', cursor: aideBusy ? 'wait' : 'pointer', border: 'none', borderRadius: 2,
                background: aideBusy || !aideInput.trim() ? T.rule : T.green, color: T.paper,
                fontFamily: T.sans, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', padding: '0 16px',
              }}
            >
              Ask
            </button>
          </div>
        </>
      )}

      {/* ---------------- group tab ---------------- */}
      {tab === 'group' && (
        <>
          {!session.text_id ? (
            <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, lineHeight: 1.55, padding: '14px 16px' }}>
              A study group forms around a text. Open a reading that belongs to
              one of your texts and the group meets there.
            </p>
          ) : group === 'loading' ? (
            <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, padding: '14px 16px' }}>
              Opening your group…
            </p>
          ) : !group ? (
            /* ---- create ---- */
            <div style={{ padding: '14px 16px', overflowY: 'auto' }}>
              <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.ink, lineHeight: 1.55, marginTop: 0 }}>
                Up to {GROUP_CAP} of you, over this text. Classmates you name here can
                join once they affirm the same thing you do below.
              </p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Group name"
                style={{
                  width: '100%', boxSizing: 'border-box', margin: '4px 0 8px', padding: '8px 10px',
                  border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
                  outline: 'none', fontFamily: T.serif, fontSize: 14, color: T.ink,
                }}
              />
              <input
                value={newEmails}
                onChange={(e) => setNewEmails(e.target.value)}
                placeholder="Classmates' emails, comma-separated (up to 4)"
                style={{
                  width: '100%', boxSizing: 'border-box', margin: '0 0 10px', padding: '8px 10px',
                  border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
                  outline: 'none', fontFamily: T.mono, fontSize: 12.5, color: T.ink,
                }}
              />
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontFamily: T.sans, fontSize: 12.5, color: T.ink, lineHeight: 1.45 }}>
                <input
                  type="checkbox"
                  checked={attestChecked}
                  onChange={(e) => setAttestChecked(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>{ATTESTATION}</span>
              </label>
              <button
                type="button"
                onClick={() => void create()}
                disabled={!attestChecked || creating}
                style={{
                  appearance: 'none', cursor: 'pointer', border: 'none', borderRadius: 2, marginTop: 12,
                  background: !attestChecked || creating ? T.rule : T.green, color: T.paper,
                  fontFamily: T.sans, fontSize: 13, fontWeight: 600, letterSpacing: '0.04em', padding: '10px 20px',
                }}
              >
                {creating ? 'Forming the group…' : 'Form the group'}
              </button>
              {err && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood, marginTop: 8 }}>{err}</div>}
            </div>
          ) : needsAttest ? (
            /* ---- attest ---- */
            <div style={{ padding: '14px 16px' }}>
              <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.ink, lineHeight: 1.55, marginTop: 0 }}>
                You&rsquo;ve been invited to <strong>{group.name}</strong>. One affirmation
                and you&rsquo;re in:
              </p>
              <p style={{ fontFamily: T.sans, fontSize: 12.5, color: T.faint, lineHeight: 1.45 }}>{ATTESTATION}</p>
              <button
                type="button"
                onClick={() => void attest()}
                style={{
                  appearance: 'none', cursor: 'pointer', border: 'none', borderRadius: 2,
                  background: T.green, color: T.paper, fontFamily: T.sans, fontSize: 13,
                  fontWeight: 600, letterSpacing: '0.04em', padding: '10px 20px',
                }}
              >
                I affirm — take my seat
              </button>
              {err && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood, marginTop: 8 }}>{err}</div>}
            </div>
          ) : (
            /* ---- chat ---- */
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
                borderBottom: `1px solid ${T.rule}`, flexShrink: 0,
              }}>
                <span style={{ fontFamily: T.sans, fontSize: 11, color: T.faint, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {group.name} · {members.map((m) => m.email.split('@')[0]).join(', ')}
                </span>
                <QuietControl
                  onClick={() => setRosterOpen((v) => !v)}
                  aria-expanded={rosterOpen}
                  title={isOwner ? 'Who holds a seat — and add or remove people' : 'Who holds a seat'}
                  style={{ flexShrink: 0, color: rosterOpen ? T.green : T.faint }}
                >
                  seats {members.length}/{GROUP_CAP}
                </QuietControl>
                <button
                  type="button"
                  onClick={() => void startVideo()}
                  title="Opens the group's video room and posts the link"
                  style={{
                    appearance: 'none', border: `1px solid ${T.rule}`, borderRadius: 999,
                    background: 'transparent', cursor: 'pointer', color: T.oxblood,
                    fontFamily: T.sans, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
                    padding: '4px 12px', flexShrink: 0,
                  }}
                >
                  ▶ group video
                </button>
              </div>

              {/* ---- the roster: who holds a seat, and who hands them out ---- */}
              {rosterOpen && (
                <div style={{
                  borderBottom: `1px solid ${T.rule}`, background: '#FFFFFF',
                  padding: '9px 12px 11px', flexShrink: 0, maxHeight: 250, overflowY: 'auto',
                }}>
                  <p style={{
                    fontFamily: T.sans, fontSize: 11.5, color: T.faint,
                    lineHeight: 1.45, margin: '0 0 8px',
                  }}>
                    {isOwner
                      ? 'You admit and remove people here — no site admin involved. Five seats, yours included.'
                      : `${ownerEmail || 'The person who formed this group'} admits and removes people here — five seats, theirs included.`}
                  </p>

                  {members.map((m) => {
                    const note = inviteState[m.email.toLowerCase()];
                    const mine = m.user_id === group.created_by;
                    return (
                      <div key={m.email} style={{ margin: '0 0 5px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            fontFamily: T.mono, fontSize: 11.5, color: T.ink, flex: 1,
                            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {m.email}
                          </span>
                          <span style={{
                            fontFamily: T.sans, fontSize: 10, letterSpacing: '0.06em',
                            textTransform: 'uppercase', flexShrink: 0,
                            color: m.user_id ? T.green : T.brass,
                          }}>
                            {mine ? 'formed the group' : m.user_id ? 'seat claimed' : 'seat unclaimed'}
                          </span>
                          {isOwner && !mine && (
                            confirmRemove === m.email ? (
                              <QuietControl
                                onClick={() => void evict(m.email)}
                                style={{ flexShrink: 0, color: T.paper, background: T.oxblood, borderColor: T.oxblood }}
                              >
                                remove?
                              </QuietControl>
                            ) : (
                              <QuietControl
                                onClick={() => setConfirmRemove(m.email)}
                                aria-label={`Take back ${m.email}'s seat`}
                                style={{ flexShrink: 0 }}
                              >
                                ×
                              </QuietControl>
                            )
                          )}
                        </div>
                        {note && (
                          <div style={{
                            fontFamily: T.sans, fontSize: 11, lineHeight: 1.4, marginTop: 1,
                            color: note === 'error' ? T.oxblood : T.faint,
                          }}>
                            {INVITE_NOTE[note]}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {isOwner && (seatsOpen > 0 ? (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ ...label, color: T.faint, textTransform: 'uppercase' }}>
                        Add up to four people by email address
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void admit(); } }}
                          type="email"
                          placeholder="their email address"
                          style={{
                            flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '7px 9px',
                            border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
                            outline: 'none', fontFamily: T.mono, fontSize: 12, color: T.ink,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void admit()}
                          disabled={adding || !inviteEmail.trim()}
                          style={{
                            appearance: 'none', border: 'none', borderRadius: 2, flexShrink: 0,
                            cursor: adding || !inviteEmail.trim() ? 'default' : 'pointer',
                            background: adding || !inviteEmail.trim() ? T.rule : T.green, color: T.paper,
                            fontFamily: T.sans, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
                            padding: '0 15px',
                          }}
                        >
                          {adding ? 'Adding…' : 'Add'}
                        </button>
                      </div>
                      <p style={{ fontFamily: T.sans, fontSize: 11, color: T.faint, lineHeight: 1.45, margin: '6px 0 0' }}>
                        {seatsOpen === 1 ? 'One seat is open.' : `${seatsOpen} seats are open.`} An
                        invitation goes to the address you give; they create a Contextspaces account
                        with that same address and the seat is theirs.
                      </p>
                    </div>
                  ) : (
                    <p style={{ fontFamily: T.sans, fontSize: 11, color: T.faint, lineHeight: 1.45, margin: '10px 0 0' }}>
                      Every seat is taken. Take one back above to make room for someone else.
                    </p>
                  ))}
                </div>
              )}

              <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
                {gMsgs.length === 0 && (
                  <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, lineHeight: 1.55 }}>
                    Nobody has spoken yet. Ask something — or highlight a passage in the
                    reading and use &ldquo;ask the group&rdquo; to bring it here.
                  </p>
                )}
                {gMsgs.map((m) => (
                  <div key={m.id} style={{ margin: '10px 0' }}>
                    <div style={{ ...label, color: m.author_email.toLowerCase() === myEmail.toLowerCase() ? T.green : T.oxblood }}>
                      {(m.author_email.split('@')[0] || 'CLASSMATE').toUpperCase()}:
                    </div>
                    {m.anchor && (
                      <div style={{
                        fontFamily: T.serif, fontSize: 12.5, fontStyle: 'italic', color: T.faint,
                        borderLeft: `2px solid ${T.brass}`, padding: '1px 8px', margin: '2px 0 4px',
                      }}>
                        {m.anchor.reading_title}{m.anchor.page != null ? `, p. ${m.anchor.page + 1}` : ''}
                        {m.anchor.note ? ` — “${m.anchor.note}”` : ''}
                      </div>
                    )}
                    <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {err && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood }}>{err}</div>}
              </div>
              <div style={{ borderTop: `1px solid ${T.rule}`, padding: 10, display: 'flex', gap: 8, flexShrink: 0 }}>
                <textarea
                  value={gInput}
                  onChange={(e) => setGInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendToGroup(gInput); } }}
                  rows={1}
                  placeholder="Ask your group…"
                  style={{
                    flex: 1, resize: 'none', fontFamily: T.serif, fontSize: 14, lineHeight: 1.5,
                    padding: '8px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
                    background: '#FFFFFF', color: T.ink, outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => void sendToGroup(gInput)}
                  disabled={!gInput.trim()}
                  style={{
                    appearance: 'none', cursor: 'pointer', border: 'none', borderRadius: 2,
                    background: !gInput.trim() ? T.rule : T.oxblood, color: T.paper,
                    fontFamily: T.sans, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', padding: '0 16px',
                  }}
                >
                  Send
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
