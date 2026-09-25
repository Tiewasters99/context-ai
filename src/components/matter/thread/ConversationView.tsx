// One conversation: who can read it, its messages (typed or pasted emails),
// and the composer. Replies stay one level deep, as the thread always was.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as LinkRouter } from 'react-router-dom';
import {
  Archive, Bot, BotOff, ClipboardPaste, CornerDownRight, FileText, Lock, LogOut, Mail,
  Paperclip, Send, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import DocumentPicker from '../DocumentPicker';
import {
  AUDIENCE_LABEL, HISTORY_NOTE, audienceLine, personName, type ConversationRow, type Person,
} from '@/lib/conversations';
import {
  addPeople, deleteMessage, documentTitles, listMessages, markRead, postMessage, removePerson,
  updateConversation, type MessageRow,
} from './api';

export default function ConversationView({
  matterId,
  conversation,
  people,
  viewerId,
  refreshKey,
  highlightMessageId,
  onChanged,
  onPasteEmail,
  onLeft,
}: {
  matterId: string;
  conversation: ConversationRow;
  people: Person[];
  viewerId: string;
  refreshKey: number;
  highlightMessageId: string | null;
  onChanged: () => void;
  onPasteEmail: () => void;
  onLeft: () => void;
}) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<MessageRow | null>(null);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; title: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [docTitles, setDocTitles] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const feedRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);
  const isPrivate = conversation.audience === 'members';
  const archived = !!conversation.archived_at;
  const line = audienceLine(conversation, peopleById, viewerId);
  const inIt = new Set([...(conversation.created_by ? [conversation.created_by] : []), ...conversation.member_ids]);
  const addable = people.filter((p) => !inIt.has(p.user_id));

  const load = useCallback(async () => {
    try {
      const rows = await listMessages(conversation.id);
      setMessages(rows);
      setError(null);
      const ids = [...new Set(rows.flatMap((r) => r.attachment_document_ids ?? []))];
      if (ids.length) setDocTitles(await documentTitles(ids));
      void markRead(conversation.id, viewerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conversation.id, viewerId]);

  useEffect(() => { setLoading(true); setReplyTo(null); setNotice(null); void load(); }, [load, refreshKey]);

  // Land on the message a link or a search hit pointed at; otherwise the end.
  useEffect(() => {
    if (loading) return;
    if (highlightMessageId) {
      document.getElementById(`msg-${highlightMessageId}`)?.scrollIntoView({ block: 'center' });
      return;
    }
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [loading, highlightMessageId, messages.length]);

  const threaded = useMemo(() => {
    const tops = messages.filter((m) => !m.parent_id);
    const byParent = new Map<string, MessageRow[]>();
    for (const m of messages) {
      if (!m.parent_id) continue;
      byParent.set(m.parent_id, [...(byParent.get(m.parent_id) ?? []), m]);
    }
    return tops.map((t) => ({ top: t, replies: byParent.get(t.id) ?? [] }));
  }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || sending || archived) return;
    setSending(true);
    setError(null);
    try {
      await postMessage({
        matterId,
        conversationId: conversation.id,
        userId: viewerId,
        body: body || '(attached)',
        parentId: replyTo ? (replyTo.parent_id ?? replyTo.id) : null,
        attachmentIds: attachments.map((a) => a.id),
      });
      setDocTitles((prev) => ({ ...prev, ...Object.fromEntries(attachments.map((a) => [a.id, a.title])) }));
      setDraft('');
      setReplyTo(null);
      setAttachments([]);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const act = async (fn: () => Promise<boolean | void>, refused: string) => {
    setNotice(null);
    setError(null);
    try {
      const ok = await fn();
      if (ok === false) setNotice(refused);
      else onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const NOT_YOURS = 'Only the person who started this conversation, or an owner or admin of the matter, can change that.';

  const toggleAi = () => act(
    () => updateConversation(conversation.id, { ai_readable: !conversation.ai_readable }), NOT_YOURS);
  const archive = () => {
    if (!confirm(`Archive “${conversation.title}”? It stays readable, and nobody can post in it.`)) return;
    void act(() => updateConversation(conversation.id, { archived_at: new Date().toISOString() }), NOT_YOURS);
  };
  const leave = () => {
    if (!confirm(`Leave “${conversation.title}”? You will no longer be able to read it unless someone adds you back.`)) return;
    void act(async () => {
      const ok = await removePerson(conversation.id, viewerId);
      if (ok) onLeft();
      return ok;
    }, 'You could not be removed.');
  };
  const confirmAdd = () => act(async () => {
    await addPeople(conversation.id, [...toAdd], viewerId);
    setAdding(false);
    setToAdd(new Set());
  }, '');

  const composer = (inline: boolean) => (
    <div className={inline
      ? 'mt-2 rounded-lg border border-[rgba(232,184,74,0.18)] bg-[rgba(232,184,74,0.04)] p-3'
      : 'mt-3 border-t border-white/[0.06] pt-3'}
    >
      {inline && replyTo && (
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-[#e8b84a]">Replying to {displayName(replyTo)}</span>
          <button onClick={() => setReplyTo(null)} className="text-white/40 hover:text-white/80" title="Cancel reply"><X size={12} /></button>
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
            if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReplyTo(null); }
          }}
          placeholder={inline ? 'Write a reply…' : `Write to ${isPrivate ? line.replace(/^Only /, '') : 'everyone on this matter'}…`}
          rows={2}
          maxLength={10000}
          className="flex-1 min-w-0 rounded-lg bg-[rgba(10,10,16,0.6)] border border-white/[0.08] px-3 py-2 text-[13px] text-[#f5f1e8] placeholder-white/30 resize-none focus:outline-none focus:border-[#e8b84a]/40"
        />
        <button onClick={() => setPickerOpen(true)} type="button" title="Attach documents already in this matter"
          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg border border-white/[0.08] text-white/55 hover:text-[#e8b84a] hover:border-[#e8b84a]/30">
          <Paperclip size={14} />
        </button>
        <button onClick={() => void send()} disabled={(!draft.trim() && attachments.length === 0) || sending}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[12px] font-medium disabled:opacity-30 disabled:cursor-not-allowed">
          <Send size={13} /> {sending ? 'Sending…' : inline ? 'Reply' : 'Send'}
        </button>
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {attachments.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-[#e8b84a]/10 border border-[#e8b84a]/25 text-[#e8b84a] text-[11px]">
              <FileText size={11} /> <span className="max-w-[180px] truncate">{a.title}</span>
              <button onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-white/10 text-white/55" title="Remove"><X size={9} /></button>
            </span>
          ))}
        </div>
      )}
      <p className="text-[10.5px] text-white/35 mt-1.5">
        {isPrivate ? `${line}. ` : 'Visible to everyone on this matter. '}
        {conversation.ai_readable ? 'AI may read this conversation.' : 'Closed to AI.'} Cmd/Ctrl+Enter to send.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col min-w-0 h-full">
      {/* Header: title, who can read it, the AI switch, actions */}
      <div className="pb-3 border-b border-white/[0.07]">
        <div className="flex items-start gap-2 flex-wrap">
          <h3 className="text-[15px] font-semibold text-[#f5f1e8] break-words min-w-0">{conversation.title}</h3>
          {archived && <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/50">Archived</span>}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-white/60">
          {isPrivate ? <Lock size={12} className="shrink-0" /> : <Users size={12} className="shrink-0" />}
          <span className="break-words">{isPrivate ? line : AUDIENCE_LABEL.matter}</span>
          <span className="text-white/25">·</span>
          {conversation.ai_readable
            ? <span className="inline-flex items-center gap-1"><Bot size={12} /> AI may read this</span>
            : <span className="inline-flex items-center gap-1"><BotOff size={12} /> Closed to AI</span>}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-[11.5px]">
          {!archived && (
            <button onClick={onPasteEmail} className="inline-flex items-center gap-1 text-[#e8b84a] hover:text-[#f0c865]">
              <ClipboardPaste size={12} /> Paste an email
            </button>
          )}
          <button onClick={() => void toggleAi()} className="inline-flex items-center gap-1 text-white/55 hover:text-white">
            {conversation.ai_readable ? <BotOff size={12} /> : <Bot size={12} />}
            {conversation.ai_readable ? 'Close to AI' : 'Let AI read this'}
          </button>
          {isPrivate && !archived && (
            <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1 text-white/55 hover:text-white">
              <UserPlus size={12} /> Add people
            </button>
          )}
          {isPrivate && conversation.created_by !== viewerId && (
            <button onClick={leave} className="inline-flex items-center gap-1 text-white/55 hover:text-white">
              <LogOut size={12} /> Leave
            </button>
          )}
          {!conversation.is_general && !archived && (
            <button onClick={archive} className="inline-flex items-center gap-1 text-white/55 hover:text-white">
              <Archive size={12} /> Archive
            </button>
          )}
        </div>
        {adding && (
          <div className="mt-3 rounded-lg border border-white/10 p-3">
            <p className="text-[11.5px] text-white/55 mb-2">
              Only people who can open this matter are listed. {HISTORY_NOTE}
            </p>
            {addable.length === 0 ? (
              <p className="text-[12px] text-white/45">Everyone who can open this matter is already in it.</p>
            ) : (
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {addable.map((p) => (
                  <li key={p.user_id}>
                    <label className="flex items-center gap-2 text-[12.5px] text-white/85 cursor-pointer">
                      <input type="checkbox" className="accent-[#e8b84a]" checked={toAdd.has(p.user_id)}
                        onChange={(e) => setToAdd((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.user_id); else next.delete(p.user_id);
                          return next;
                        })} />
                      {personName(p)}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <button disabled={toAdd.size === 0} onClick={() => void confirmAdd()}
                className="px-2.5 py-1 rounded-md text-[12px] border border-[#e8b84a]/35 text-[#e8b84a] disabled:opacity-35">Add</button>
              <button onClick={() => { setAdding(false); setToAdd(new Set()); }} className="px-2.5 py-1 rounded-md text-[12px] text-white/55 hover:text-white">Cancel</button>
            </div>
          </div>
        )}
        {notice && <p className="mt-2 text-[11.5px] text-amber-300/85">{notice}</p>}
      </div>

      {/* Messages */}
      <div ref={feedRef} className="flex-1 overflow-y-auto pr-1 py-3" style={{ maxHeight: '60vh' }}>
        {loading && <p className="text-[12px] text-white/40 py-6 text-center">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-[12px] text-white/40 py-8 text-center max-w-sm mx-auto leading-relaxed">
            No messages yet. {isPrivate ? `${line} can read what is written here.` : 'Everyone on this matter can read what is written here.'}
          </p>
        )}
        {!loading && threaded.length > 0 && (
          <ul className="space-y-4">
            {threaded.map(({ top, replies }) => (
              <li key={top.id} className="space-y-2">
                <MessageItem m={top} viewerId={viewerId} docTitles={docTitles} highlighted={top.id === highlightMessageId}
                  onReply={archived ? null : () => { setReplyTo(top); setTimeout(() => composerRef.current?.focus(), 0); }}
                  onDelete={() => { if (confirm('Delete this message? Replies will remain.')) void deleteMessage(top.id).then(load); }} />
                {replyTo?.id === top.id && <div className="ml-10">{composer(true)}</div>}
                {replies.length > 0 && (
                  <ul className="pl-6 space-y-2 border-l border-white/[0.06] ml-3">
                    {replies.map((r) => (
                      <li key={r.id} className="space-y-2">
                        <MessageItem m={r} viewerId={viewerId} docTitles={docTitles} highlighted={r.id === highlightMessageId} isReply
                          onReply={archived ? null : () => { setReplyTo(r); setTimeout(() => composerRef.current?.focus(), 0); }}
                          onDelete={() => { if (confirm('Delete this message?')) void deleteMessage(r.id).then(load); }} />
                        {replyTo?.id === r.id && <div className="ml-8">{composer(true)}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-[11.5px] text-red-300 mt-1">{error}</p>}
      {archived
        ? <p className="mt-3 border-t border-white/[0.06] pt-3 text-[12px] text-white/45">Archived — read only.</p>
        : !replyTo && composer(false)}

      {pickerOpen && (
        <DocumentPicker
          matterId={matterId}
          initiallySelected={attachments.map((a) => a.id)}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(picked) => { setAttachments(picked); setPickerOpen(false); }}
        />
      )}
    </div>
  );
}

function displayName(m: MessageRow): string {
  const p = m.author;
  return (p?.display_name ?? '').trim() || p?.email || 'Unknown';
}

function when(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function MessageItem({
  m, viewerId, docTitles, highlighted, isReply = false, onReply, onDelete,
}: {
  m: MessageRow;
  viewerId: string;
  docTitles: Record<string, string>;
  highlighted: boolean;
  isReply?: boolean;
  onReply: (() => void) | null;
  onDelete: () => void;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const own = m.user_id === viewerId;
  const size = isReply ? 'text-[12px]' : 'text-[13px]';
  return (
    <div id={`msg-${m.id}`} className={`group rounded-lg ${highlighted ? 'ring-1 ring-[#e8b84a]/50 bg-[#e8b84a]/[0.04] p-2 -m-2' : ''}`}>
      <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
        <span className={`font-medium text-[#f5f1e8] ${size}`}>{displayName(m)}</span>
        {m.kind === 'email' && <span className="inline-flex items-center gap-1 text-[10.5px] text-white/45"><Mail size={10} /> pasted an email</span>}
        <span className="text-[10px] text-white/40" title={m.created_at}>{when(m.created_at)}</span>
        {m.updated_at && <span className="text-[10px] text-white/30 italic">edited</span>}
      </div>
      {m.kind === 'email' && (
        <dl className="mt-1 mb-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
          {([['From', m.email_from], ['To', m.email_to], ['Cc', m.email_cc],
            ['Date', m.email_date ? new Date(m.email_date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null],
            ['Subject', m.email_subject]] as const)
            .filter(([, v]) => !!v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-white/40">{k}</dt>
                <dd className="text-white/80 break-words min-w-0">{v}</dd>
              </div>
            ))}
        </dl>
      )}
      <p className={`text-[#e8e5dc] whitespace-pre-wrap break-words ${size}`}>{m.body}</p>
      {m.kind === 'email' && m.email_quoted && (
        <div className="mt-1.5">
          <button onClick={() => setShowQuoted((v) => !v)} className="text-[11px] text-white/45 hover:text-white/80">
            {showQuoted ? 'Hide quoted history' : 'Show quoted history'}
          </button>
          {showQuoted && (
            <pre className="mt-1 pl-3 border-l border-white/10 text-[11.5px] text-white/55 whitespace-pre-wrap break-words">{m.email_quoted}</pre>
          )}
        </div>
      )}
      {m.attachment_document_ids?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {m.attachment_document_ids.map((id) => (
            <LinkRouter key={id} to={`/app/document/${id}`}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[rgba(232,184,74,0.08)] border border-[#e8b84a]/25 text-[#e8b84a] hover:bg-[rgba(232,184,74,0.15)] text-[11px]">
              <FileText size={11} /> <span className="max-w-[220px] truncate">{docTitles[id] || 'Document'}</span>
            </LinkRouter>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 mt-1">
        {onReply && (
          <button onClick={onReply} className="flex items-center gap-1 text-[10px] text-white/50 hover:text-[#e8b84a]">
            <CornerDownRight size={10} /> Reply
          </button>
        )}
        {own && (
          <button onClick={onDelete} className="flex items-center gap-1 text-[10px] text-white/30 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100" title="Delete">
            <Trash2 size={10} /> Delete
          </button>
        )}
      </div>
    </div>
  );
}
