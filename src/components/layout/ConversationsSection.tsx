// The sidebar's Conversations list — every Orchestrator conversation the user
// has had, newest first, grouped the way a chat app groups them. A click
// reopens it in the Orchestrator panel, where the next question carries on in
// the same saved conversation (Eden, 2026-11-05: "every conversation needs to
// be saved in the sidebar, just as with Claude").
//
// Read-only. The record is written by the server (ai_sessions / ai_messages);
// this lists the user's own rows under their own RLS.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, MessageSquare } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  CONVERSATIONS_CHANGED_EVENT,
  conversationLabel,
  isSealedTier,
  listConversations,
  openConversation,
  recencyGroup,
  type ConversationSummary,
} from '@/lib/orchestrator-conversations';

const SHOWN_FOLDED = 8;
const OPEN_KEY = 'cs.sidebar.conversations.open';

export default function ConversationsSection({ collapsed }: { collapsed: boolean }) {
  const { user } = useAuth();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  // `tick` moves whenever a turn opens or extends a saved conversation; the
  // list re-reads then. State is set only in the read's own callbacks.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, on);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, on);
  }, []);
  useEffect(() => {
    if (!user?.id) return;
    let live = true;
    listConversations(user.id, 100).then(
      (rows) => { if (live) { setItems(rows); setError(null); } },
      (err) => { if (live) setError(err instanceof Error ? err.message : 'Conversations could not be loaded.'); },
    );
    return () => { live = false; };
  }, [user?.id, tick]);

  const toggle = () => {
    setOpen((o) => {
      try { localStorage.setItem(OPEN_KEY, o ? '0' : '1'); } catch { /* remembered or not, it still toggles */ }
      return !o;
    });
  };

  const shown = useMemo(
    () => (items ?? []).slice(0, showAll ? items?.length : SHOWN_FOLDED),
    [items, showAll],
  );
  const groups = useMemo(() => {
    const out: Array<{ label: string; rows: ConversationSummary[] }> = [];
    for (const c of shown) {
      const label = recencyGroup(c.updatedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(c);
      else out.push({ label, rows: [c] });
    }
    return out;
  }, [shown]);

  // A collapsed rail has no room for titles; the Orchestrator button above
  // is the door, and the list is there when the rail is opened.
  if (collapsed) return null;

  return (
    <div className="mt-5">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between mb-1 px-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/70 uppercase tracking-wider">
          Conversations
        </span>
        {open
          ? <ChevronDown size={13} className="text-white/50" strokeWidth={1.75} />
          : <ChevronRight size={13} className="text-white/50" strokeWidth={1.75} />}
      </button>

      {open && (
        <div>
          {error && (
            <div className="mx-2 px-2 py-1.5 text-[11px] text-red-300 leading-snug">{error}</div>
          )}
          {items && items.length === 0 && !error && (
            <div className="px-3 py-1 text-[11.5px] text-white/45 leading-snug">
              Your Orchestrator conversations will be listed here.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-3 pt-1.5 pb-0.5 text-[10.5px] text-white/40">{g.label}</div>
              {g.rows.map((c) => {
                const sealed = isSealedTier(c.tier);
                const label = conversationLabel(c);
                return (
                  <button
                    key={c.id}
                    onClick={() => { setActiveId(c.id); openConversation(c.id); }}
                    title={sealed ? label : `${label}${c.matterName ? `\n${c.matterName}` : ''}`}
                    className={`w-full flex items-start gap-2 px-3 py-1.5 rounded-md text-left transition-colors ${
                      activeId === c.id
                        ? 'bg-[rgba(212,160,84,0.08)] text-[#e8b84a]'
                        : 'text-white/85 hover:bg-[rgba(255,255,255,0.04)]'
                    }`}
                  >
                    {sealed
                      ? <Lock size={12} className="shrink-0 mt-[3px] text-[#5aa88f]" strokeWidth={1.75} />
                      : <MessageSquare size={12} className="shrink-0 mt-[3px] text-white/45" strokeWidth={1.75} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] leading-snug">{label}</span>
                      {!sealed && c.matterName && (
                        <span className="block truncate text-[10.5px] text-white/40 leading-snug">{c.matterName}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {items && items.length > SHOWN_FOLDED && (
            <button
              onClick={() => setShowAll((s) => !s)}
              className="px-3 py-1 text-[11.5px] text-white/50 hover:text-[#e8b84a] transition-colors"
            >
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
