// Matter-level comment thread. One shared conversation per matter, not
// anchored to specific text — the matter equivalent of a Slack channel for
// a case. Used for co-counsel review, partner sign-off, status updates,
// the kind of back-and-forth that today happens in email and gets lost.
//
// Storage: public.matter_comments (migration 017). RLS lets anyone with
// matter access read + post; viewers can comment too (a client invited
// as viewer can still communicate). Authors can edit / soft-delete their
// own; matter admins can hard-delete any.
//
// Realtime: subscribes to postgres_changes on the matter_comments table
// filtered by matterspace_id. On any change we refetch the full thread —
// trivially cheap at legal-team scale (a matter rarely has > a few
// hundred comments) and keeps the component logic simple.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, X, Trash2, CornerDownRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

interface CommentRow {
  id: string;
  matterspace_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
  author: {
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
}

export default function MatterThread({ matterId }: { matterId: string }) {
  const { user } = useAuth();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<CommentRow | null>(null);
  const [sending, setSending] = useState(false);

  const feedRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const fetchComments = useCallback(async () => {
    const { data, error } = await supabase
      .from('matter_comments')
      .select(
        'id, matterspace_id, user_id, parent_id, body, created_at, updated_at, deleted_at, author:profiles(id, email, display_name, avatar_url)',
      )
      .eq('matterspace_id', matterId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setComments((data ?? []) as unknown as CommentRow[]);
    setLoading(false);
  }, [matterId]);

  // Initial fetch + realtime subscription.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchComments();

    const channel = supabase
      .channel(`matter-comments-${matterId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'matter_comments',
          filter: `matterspace_id=eq.${matterId}`,
        },
        () => {
          if (!cancelled) fetchComments();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [matterId, fetchComments]);

  // Auto-scroll to bottom when a new comment arrives — but only if the
  // user is already at the bottom (don't yank them away if they're
  // scrolled up reading older comments).
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [comments.length]);

  // First-time-empty assist: when the thread opens with no comments,
  // focus the composer so the user lands ready to type. Avoids the
  // "where do I start?" confusion when the empty-state copy reads as
  // a call to action.
  useEffect(() => {
    if (!loading && comments.length === 0) {
      composerRef.current?.focus();
    }
  }, [loading, comments.length]);

  // When the user clicks Reply on a comment, point replyTo at that
  // comment, focus the composer textarea, and scroll it into view so
  // the user can start typing immediately. Replies-to-replies flatten
  // to the same top-level parent (handled by the caller passing the
  // top's comment in).
  const startReply = useCallback((target: CommentRow) => {
    setReplyTo(target);
    // Defer focus until after the state update + re-render so the
    // textarea is the right shape (placeholder switched to "Write a
    // reply…").
    setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
  }, []);

  // Build a top-level list with their replies nested one level.
  const threaded = useMemo(() => {
    const tops = comments.filter((c) => !c.parent_id);
    const byParent = new Map<string, CommentRow[]>();
    for (const c of comments) {
      if (c.parent_id) {
        const arr = byParent.get(c.parent_id) ?? [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      }
    }
    return tops.map((t) => ({ top: t, replies: byParent.get(t.id) ?? [] }));
  }, [comments]);

  const handleSend = async () => {
    const body = draft.trim();
    if (!body || !user || sending) return;
    // Threading stays flat (one level deep): when replying to a top-level
    // comment, parent_id = that top's id; when replying to a reply,
    // parent_id = that reply's parent (i.e., still the top). The UI lets
    // you click Reply on any comment, but the data model collapses to a
    // single nesting level so the rendering stays readable.
    const parentId = replyTo
      ? (replyTo.parent_id ?? replyTo.id)
      : null;
    setSending(true);
    setError(null);
    const { error } = await supabase.from('matter_comments').insert({
      matterspace_id: matterId,
      user_id: user.id,
      parent_id: parentId,
      body,
    });
    setSending(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDraft('');
    setReplyTo(null);
    // Realtime will refetch; no manual append.
  };

  const handleDelete = async (c: CommentRow) => {
    if (!user || c.user_id !== user.id) return;
    if (!confirm('Delete this comment? Replies will remain.')) return;
    await supabase
      .from('matter_comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', c.id);
    // Realtime will refetch.
  };

  // Inline composer — renders right below the comment the user clicked
  // Reply on. Closure access to all the parent state (draft, sending,
  // error, etc.) so we don't have to prop-drill. Two render sites: under
  // a comment (when replyTo.id matches) and at the bottom of the feed
  // (when replyTo is null — i.e., writing a new top-level message).
  const composer = (variant: 'inline' | 'bottom') => {
    const isInline = variant === 'inline';
    return (
      <div
        className={
          isInline
            ? 'mt-2 rounded-lg border border-[rgba(232,184,74,0.18)] bg-[rgba(232,184,74,0.04)] p-3'
            : 'mt-3 border-t border-[rgba(255,255,255,0.06)] pt-3'
        }
      >
        {isInline && replyTo && (
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[#e8b84a]">
              Replying to {displayName(replyTo.author)}
            </span>
            <button
              onClick={() => setReplyTo(null)}
              className="text-white/40 hover:text-white/80"
              title="Cancel reply"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              }
            }}
            placeholder={isInline ? 'Write a reply…' : 'Write a message to the team…'}
            rows={2}
            maxLength={10000}
            className="flex-1 rounded-lg bg-[rgba(10,10,16,0.6)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-[13px] text-[#f5f1e8] placeholder-white/30 resize-none focus:outline-none focus:border-[#e8b84a]/40 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || sending}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={13} strokeWidth={2} />
            {sending ? 'Sending…' : isInline ? 'Reply' : 'Send'}
          </button>
        </div>
        {!isInline && (
          <p className="text-[10px] text-white/30 mt-1.5">
            Visible to everyone with matter access. Cmd/Ctrl+Enter to send.
          </p>
        )}
        {isInline && (
          <p className="text-[10px] text-white/30 mt-1.5">
            Cmd/Ctrl+Enter to send · Esc to cancel.
          </p>
        )}
        {error && (
          <p className="text-[11px] text-red-300 mt-2">{error}</p>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col" style={{ minHeight: '480px' }}>
      {/* Feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto pr-2"
        style={{ maxHeight: '60vh' }}
      >
        {loading && (
          <p className="text-[12px] text-white/40 py-6 text-center">Loading thread…</p>
        )}
        {!loading && comments.length === 0 && (
          <EmptyState />
        )}
        {!loading && threaded.length > 0 && (
          <ul className="space-y-4 py-2">
            {threaded.map(({ top, replies }) => (
              <li key={top.id} className="space-y-2">
                <CommentItem
                  comment={top}
                  currentUserId={user?.id}
                  onReply={() => startReply(top)}
                  onDelete={() => handleDelete(top)}
                />
                {/* Inline composer right under the top comment when
                    replying to it — spatially adjacent so the user
                    sees their click "land" next to where they clicked. */}
                {replyTo?.id === top.id && (
                  <div className="ml-10">{composer('inline')}</div>
                )}
                {replies.length > 0 && (
                  <ul className="pl-7 space-y-2 border-l border-[rgba(255,255,255,0.06)] ml-3">
                    {replies.map((r) => (
                      <li key={r.id} className="space-y-2">
                        <CommentItem
                          comment={r}
                          currentUserId={user?.id}
                          onReply={() => startReply(r)}
                          onDelete={() => handleDelete(r)}
                          isReply
                        />
                        {/* Inline composer under a reply when replying
                            to it — the data model still flattens to the
                            top's parent_id (see handleSend), but the
                            composer renders here spatially. */}
                        {replyTo?.id === r.id && (
                          <div className="ml-8">{composer('inline')}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Bottom composer — only when we're writing a new top-level
          message. When replying, the composer renders inline above and
          this slot hides so there's never two composers competing. */}
      {!replyTo && composer('bottom')}
    </div>
  );
}


// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function CommentItem({
  comment,
  currentUserId,
  onReply,
  onDelete,
  isReply = false,
}: {
  comment: CommentRow;
  currentUserId?: string;
  onReply: () => void;
  onDelete: () => void;
  isReply?: boolean;
}) {
  const isOwn = currentUserId && comment.user_id === currentUserId;
  return (
    <div className="group flex gap-3">
      <Avatar profile={comment.author} size={isReply ? 22 : 28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className={`font-medium text-[#f5f1e8] ${isReply ? 'text-[12px]' : 'text-[13px]'}`}>
            {displayName(comment.author)}
          </span>
          <span className="text-[10px] text-white/40" title={comment.created_at}>
            {relativeTime(comment.created_at)}
          </span>
          {comment.updated_at && (
            <span className="text-[10px] text-white/30 italic">edited</span>
          )}
        </div>
        <p className={`text-[#e8e5dc] whitespace-pre-wrap break-words ${isReply ? 'text-[12px]' : 'text-[13px]'}`}>
          {comment.body}
        </p>
        {/* Reply is always visible (discoverability — the prior
            opacity-on-hover treatment was a real problem: invisible on
            touch, easy to miss on desktop). Delete stays hover-only
            because it's destructive and we don't want it competing for
            attention on every comment. */}
        <div className="flex items-center gap-3 mt-1 group/actions">
          <button
            onClick={onReply}
            className="flex items-center gap-1 text-[10px] text-white/50 hover:text-[#e8b84a] transition-colors"
          >
            <CornerDownRight size={10} />
            Reply
          </button>
          {isOwn && (
            <button
              onClick={onDelete}
              className="flex items-center gap-1 text-[10px] text-white/30 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
              title="Delete"
            >
              <Trash2 size={10} />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({
  profile,
  size,
}: {
  profile: CommentRow['author'];
  size: number;
}) {
  const initial = (profile?.display_name?.[0] || profile?.email?.[0] || '?').toUpperCase();
  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt=""
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-full bg-[#d4a054]/15 text-[#d4a054] flex items-center justify-center shrink-0 font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initial}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <p className="text-[12px] text-white/40 max-w-sm leading-relaxed">
        No messages yet. Use the composer below to write the first one — your
        message will be visible to everyone with access to this matter.
      </p>
    </div>
  );
}


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function displayName(p: CommentRow['author']) {
  if (!p) return 'Unknown';
  return p.display_name?.trim() || p.email || 'Unknown';
}

function relativeTime(iso: string) {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = Math.round((now - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
