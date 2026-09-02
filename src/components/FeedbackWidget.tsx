import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquarePlus, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';

/**
 * Feedback widget — a bug, a complaint, a suggestion, from anywhere in the
 * app. Tickets land in feedback_tickets (insert-only RLS) and are swept
 * periodically into a Claude Code triage session alongside Grapheon's, so
 * every note left here reaches the workbench where things get fixed.
 */

type Category = 'bug' | 'suggestion' | 'complaint';

const CATEGORY_LABELS: Record<Category, string> = {
  bug: 'Something broke',
  suggestion: 'An idea',
  complaint: 'A gripe',
};

export default function FeedbackWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('bug');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const submit = async () => {
    const trimmed = message.trim();
    if (!trimmed || state === 'sending') return;
    setState('sending');
    try {
      let token: string | undefined;
      try { token = (await supabase.auth.getSession()).data.session?.access_token; } catch { /* anonymous */ }
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          category,
          message: trimmed,
          page: location.pathname,
          context: { viewport: `${window.innerWidth}x${window.innerHeight}` },
        }),
      });
      if (!res.ok) throw new Error('failed');
      setState('sent');
      setMessage('');
      setTimeout(() => { setState('idle'); setOpen(false); }, 2200);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Leave feedback — a bug, an idea, a gripe"
        aria-label="Leave feedback"
        className="fixed bottom-[4.2rem] md:bottom-5 right-4 z-40 w-10 h-10 rounded-full flex items-center justify-center
                   text-white/70 hover:text-white transition-colors backdrop-blur-[20px]
                   border border-[rgba(255,255,255,0.14)] shadow-lg"
        style={{ backgroundColor: 'rgba(10, 10, 16, 0.8)' }}
      >
        {open ? <X size={17} strokeWidth={1.75} /> : <MessageSquarePlus size={17} strokeWidth={1.75} />}
      </button>

      {open && (
        <div
          className="fixed bottom-[7rem] md:bottom-[4.6rem] right-4 z-40 w-[min(320px,calc(100vw-2rem))]
                     rounded-xl border border-[rgba(255,255,255,0.14)] backdrop-blur-[30px] shadow-2xl p-4"
          style={{ backgroundColor: 'rgba(12, 12, 20, 0.92)' }}
        >
          <p className="text-[13px] font-medium text-white/90 mb-2.5">
            Leave a note — it reaches the workbench
          </p>
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                  category === c
                    ? 'border-[#d4a054] bg-[rgba(212,160,84,0.14)] text-[#e8c078]'
                    : 'border-[rgba(255,255,255,0.12)] text-white/60 hover:text-white/85'
                }`}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder={
              category === 'bug'
                ? 'What happened, and what did you expect?'
                : category === 'suggestion'
                  ? 'What would make Contextspaces better?'
                  : 'What rubbed you the wrong way?'
            }
            className="w-full resize-y rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]
                       px-3 py-2 text-[13px] text-white/90 placeholder-white/35 outline-none
                       focus:border-[rgba(212,160,84,0.5)]"
          />
          <div className="flex items-center gap-3 mt-2.5">
            <button
              type="button"
              onClick={submit}
              disabled={!message.trim() || state === 'sending'}
              className="px-4 py-1.5 rounded-lg text-[13px] font-medium border border-[#d4a054]
                         bg-[rgba(212,160,84,0.14)] text-[#e8c078] transition-opacity
                         disabled:opacity-40 disabled:cursor-default hover:bg-[rgba(212,160,84,0.22)]"
            >
              {state === 'sending' ? 'Sending…' : 'Send'}
            </button>
            <span className="text-[12px] text-white/50 italic">
              {state === 'sent' ? 'Received — thank you.' : state === 'error' ? 'Could not send — try again.' : ''}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
