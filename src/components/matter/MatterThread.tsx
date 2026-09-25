// The matter's Thread tab: named conversations (migration 091).
//
// A matter used to have one thread that everyone on it read. Now it has
// conversations, each for "Everyone on this matter" or "Only these people"
// (chosen from the people who can open the matter), each with its own
// "AI may read this" switch. Who can read what is decided by the database's
// row-level security, not here: this component only ever receives the
// conversations the signed-in person is allowed to see.
//
// Layout: a conversation list on the left (a drop-down on a phone), newest
// activity first with unread counts; the open conversation on the right; a
// search box over every conversation the person can read.
//
// Until 091 is applied the conversation functions do not exist, and the tab
// shows the one thread exactly as before (MatterThreadLegacy).
//
// Realtime: postgres_changes on matter_comments and matter_conversations for
// this matter; RLS filters the payloads on the receive side (as in 017), and
// every change simply re-reads through the same RLS-bound queries.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Plus, Search, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { conversationCitation } from '../../../lib/conversation-cite.mjs';
import type { ConversationRow, Person } from '@/lib/conversations';
import MatterThreadLegacy from './MatterThreadLegacy';
import ConversationView from './thread/ConversationView';
import NewConversationCard from './thread/NewConversationCard';
import PasteEmailCard from './thread/PasteEmailCard';
import {
  NotDeployedError, conversationOfMessage, ensureGeneral, listConversations, listPeople, searchThreads,
  type ThreadSearchHit,
} from './thread/api';

const SELECTED_KEY = (matterId: string) => `cs.thread.selected:${matterId}`;

function readSelected(matterId: string): string | null {
  try { return localStorage.getItem(SELECTED_KEY(matterId)); } catch { return null; }
}
function writeSelected(matterId: string, id: string) {
  try { localStorage.setItem(SELECTED_KEY(matterId), id); } catch { /* per-viewer convenience only */ }
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** ts_headline marks hits with « »; show them as marks, safely (no HTML). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('«') && p.endsWith('»')
        ? <mark key={i} className="bg-[#e8b84a]/25 text-[#f5f1e8] rounded px-0.5">{p.slice(1, -1)}</mark>
        : <span key={i}>{p}</span>))}
    </>
  );
}

export default function MatterThread({ matterId }: { matterId: string }) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'ready' | 'legacy' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ThreadSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const reload = useCallback(async () => {
    try {
      const rows = await listConversations(matterId);
      setConversations(rows);
      setStatus('ready');
      return rows;
    } catch (e) {
      if (e instanceof NotDeployedError) setStatus('legacy');
      else { setError(e instanceof Error ? e.message : String(e)); setStatus('error'); }
      return null;
    }
  }, [matterId]);

  // First load: make sure General exists, then the list and the people.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setSelectedId(null);
    setHits(null);
    (async () => {
      try {
        await ensureGeneral(matterId);
      } catch (e) {
        if (e instanceof NotDeployedError) { if (!cancelled) setStatus('legacy'); return; }
      }
      const rows = await reload();
      if (cancelled || !rows) return;
      listPeople(matterId).then((p) => { if (!cancelled) setPeople(p); }).catch(() => {});
      // Where to land: a linked message, a linked conversation, the last one
      // opened here, or General.
      const linkedMessage = searchParams.get('message');
      const linkedConversation = searchParams.get('conversation');
      let target: string | null = null;
      if (linkedMessage) {
        target = await conversationOfMessage(linkedMessage);
        if (target) setHighlight(linkedMessage);
      }
      if (!target && linkedConversation && rows.some((c) => c.id === linkedConversation)) target = linkedConversation;
      const remembered = readSelected(matterId);
      if (!target && remembered && rows.some((c) => c.id === remembered)) target = remembered;
      if (!target) target = rows.find((c) => c.is_general)?.id ?? rows[0]?.id ?? null;
      if (!cancelled) setSelectedId(target);
    })();
    return () => { cancelled = true; };
    // searchParams is read once per matter on purpose: later URL edits by this
    // component must not re-run the landing logic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId, reload]);

  // Realtime: any change to this matter's messages or conversations re-reads.
  useEffect(() => {
    if (status !== 'ready') return;
    const bump = () => { void reload(); setRefreshKey((k) => k + 1); };
    let channel = supabase
      .channel(`matter-conversations-${matterId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matter_comments', filter: `matterspace_id=eq.${matterId}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matter_conversations', filter: `matterspace_id=eq.${matterId}` }, bump);
    // Being added to a private conversation while this tab is open.
    if (user?.id) {
      channel = channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'matter_conversation_members', filter: `user_id=eq.${user.id}` }, bump);
    }
    channel.subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [matterId, status, reload, user?.id]);

  const select = (id: string, messageId: string | null = null) => {
    setSelectedId(id);
    setHighlight(messageId);
    writeSelected(matterId, id);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
    if (searchParams.get('message') || searchParams.get('conversation')) {
      const next = new URLSearchParams(searchParams);
      next.delete('message');
      next.delete('conversation');
      setSearchParams(next, { replace: true });
    }
  };

  const runSearch = async () => {
    const query = q.trim();
    if (!query || searching) return;
    setSearching(true);
    try {
      setHits(await searchThreads([matterId], query, 30));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };
  const clearSearch = () => { setQ(''); setHits(null); };

  const visible = useMemo(
    () => conversations.filter((c) => showArchived || !c.archived_at || c.id === selectedId),
    [conversations, showArchived, selectedId],
  );
  const archivedCount = conversations.filter((c) => c.archived_at).length;
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  if (status === 'legacy') return <MatterThreadLegacy matterId={matterId} />;
  if (status === 'loading') return <p className="text-[12px] text-white/40 py-6 text-center">Loading conversations…</p>;
  if (status === 'error') return <p className="text-[12px] text-red-300 py-6">{error}</p>;
  if (!user) return null;

  const searchBox = (
    <div className="relative">
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); if (e.key === 'Escape') clearSearch(); }}
        placeholder={searching ? 'Searching…' : 'Search conversations (Enter)'}
        className="w-full pl-8 pr-7 py-2 rounded-lg border border-white/10 bg-white/[0.03] text-[12.5px] text-white placeholder-white/35 focus:outline-none focus:border-[#e8b84a]/40"
      />
      {(q || hits) && (
        <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white" aria-label="Clear search"><X size={12} /></button>
      )}
    </div>
  );

  const newButton = (
    <button
      onClick={() => setNewOpen(true)}
      className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[#e8b84a] text-[12px] font-medium hover:bg-[#e8b84a]/20"
    >
      <Plus size={13} /> New conversation
    </button>
  );

  const list = (
    <ul className="space-y-0.5">
      {visible.map((c) => {
        const active = c.id === selectedId && !hits;
        return (
          <li key={c.id}>
            <button
              onClick={() => { clearSearch(); select(c.id); }}
              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${active ? 'bg-[#e8b84a]/10 border border-[#e8b84a]/25' : 'border border-transparent hover:bg-white/[0.04]'}`}
            >
              <div className="flex items-center gap-1.5">
                {c.audience === 'members' && <Lock size={11} className="shrink-0 text-white/50" aria-label="Private" />}
                <span className={`truncate text-[12.5px] ${c.unread_count ? 'text-white font-semibold' : 'text-white/80'} ${c.archived_at ? 'italic text-white/45' : ''}`}>
                  {c.title}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-white/35">{ago(c.last_message_at ?? c.created_at)}</span>
                {c.unread_count > 0 && (
                  <span className="shrink-0 min-w-[18px] text-center px-1 rounded-full bg-[#e8b84a] text-[#14110a] text-[10px] font-semibold">
                    {c.unread_count}
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const results = hits && (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[12px] text-white/55">
          {hits.length === 0 ? 'No messages matched.' : `${hits.length} message${hits.length === 1 ? '' : 's'} in conversations you can read`}
        </p>
        <button onClick={clearSearch} className="text-[11.5px] text-white/50 hover:text-white">Back to the conversation</button>
      </div>
      <ul className="space-y-1.5">
        {hits.map((h) => (
          <li key={h.comment_id}>
            <button
              onClick={() => { clearSearch(); select(h.conversation_id, h.comment_id); }}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-white/[0.07] hover:border-[#e8b84a]/35 hover:bg-[#e8b84a]/[0.04]"
            >
              <div className="flex items-center gap-1.5 mb-1">
                {h.audience === 'members' && <Lock size={11} className="shrink-0 text-white/50" />}
                <span className="text-[12px] text-[#e8b84a]/90 font-medium break-words">{conversationCitation(h)}</span>
              </div>
              {h.email_subject && <p className="text-[11.5px] text-white/70 mb-0.5">Subject: {h.email_subject}</p>}
              <p className="text-[11.5px] text-white/60 leading-relaxed line-clamp-3"><Snippet text={h.snippet ?? h.body.slice(0, 280)} /></p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const view = selected && user && (
    <ConversationView
      key={selected.id}
      matterId={matterId}
      conversation={selected}
      people={people}
      viewerId={user.id}
      refreshKey={refreshKey}
      highlightMessageId={highlight}
      onChanged={() => { void reload(); }}
      onPasteEmail={() => setPasteOpen(true)}
      onLeft={() => {
        void reload().then((rows) => {
          const general = rows?.find((c) => c.is_general);
          if (general) select(general.id);
        });
      }}
    />
  );

  return (
    <div className="min-w-0" style={{ minHeight: 480 }}>
      {isMobile ? (
        // Phone: one column. The conversation list becomes a drop-down.
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <select
              value={selectedId ?? ''}
              onChange={(e) => { clearSearch(); select(e.target.value); }}
              className="flex-1 min-w-0 rounded-lg border border-white/10 bg-[rgba(20,20,30,0.9)] px-2.5 py-2 text-[13px] text-white"
              aria-label="Conversation"
            >
              {visible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.audience === 'members' ? 'Private · ' : ''}{c.title}{c.unread_count ? ` (${c.unread_count} new)` : ''}{c.archived_at ? ' — archived' : ''}
                </option>
              ))}
            </select>
            <button onClick={() => setNewOpen(true)} className="shrink-0 p-2 rounded-lg border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[#e8b84a]" aria-label="New conversation">
              <Plus size={15} />
            </button>
          </div>
          {searchBox}
          {results ?? view}
        </div>
      ) : (
        <div className="flex gap-5 min-w-0">
          <aside className="w-64 shrink-0 space-y-2.5">
            {newButton}
            {searchBox}
            {list}
            {archivedCount > 0 && (
              <button onClick={() => setShowArchived((v) => !v)} className="text-[11px] text-white/40 hover:text-white/70 px-2.5">
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </button>
            )}
          </aside>
          <section className="flex-1 min-w-0">{results ?? view}</section>
        </div>
      )}

      {newOpen && (
        <NewConversationCard
          matterId={matterId}
          people={people}
          viewerId={user.id}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            void reload().then(() => select(id));
          }}
        />
      )}
      {pasteOpen && selected && (
        <PasteEmailCard
          matterId={matterId}
          conversation={selected}
          viewerId={user.id}
          onClose={() => setPasteOpen(false)}
          onSaved={() => { setPasteOpen(false); void reload(); setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}
