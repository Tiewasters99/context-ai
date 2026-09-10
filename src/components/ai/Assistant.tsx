import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { X, Send, Maximize2, Minimize2 } from 'lucide-react';
import type { ChatMessage } from '@/lib/types';
import { supabase } from '@/lib/supabase';
import { getOrchestratorContext } from '@/lib/orchestrator-context';
import { ASSISTANT_COMMAND_EVENT, type AssistantCommand } from '@/lib/assistant-bus';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import { moveVaultDocument } from '@/lib/vault-persist';

interface AssistantProps {
  isOpen: boolean;
  onClose: () => void;
}

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: "Ask me anything — how this place works, what's in your documents, or something you'd like done. I explain first; I act when you ask.",
  timestamp: new Date(),
};

// The opening screen's suggestions. A fresh panel is a blank box, and a
// blank box teaches nothing; these show the kind of thing worth asking.
// They are plain questions the Orchestrator answers by explaining — none
// of them starts an action.
const SUGGESTIONS = [
  'Can you help me prepare a summary judgment brief?',
  'How can you help me prepare for trial?',
  'Does Contextspaces connect to a public-facing site?',
  'What kind of tools do you have to help me?',
];

// With a book open in the reader, the panel is a companion at the same
// table: the suggestions are about the work, and the page in front of the
// reader travels with every message (see orchestrator-context).
const READING_SUGGESTIONS = [
  'What should I know about this work before reading on?',
  'What is happening on this page?',
  'What echoes or themes should I watch for here?',
];

// Friendly pen names for the header, from the model ids the server emits
// (PENS in lib/assistant-core.mjs). An unknown id shows as itself — truth
// beats pretty.
function penLabel(model: string): string {
  if (model.includes('opus-5')) return 'Opus 5';
  if (model.includes('opus-4-8')) return 'Opus 4.8';
  if (model.includes('kimi')) return 'Kimi K3';
  return model.replace(/^anthropic\./, '');
}

export default function Assistant({ isOpen, onClose }: AssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // The URL names a matter only on a Matterspace page. In the reader it
  // names a document — the reader publishes its matter through the context.
  const routeMatterId = location.pathname.startsWith('/app/matterspace/') ? routeId : undefined;
  const matterId = routeMatterId ?? getOrchestratorContext().matterId;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // A wider panel for a real conversation — a toggle, not a mode: the
  // sidebar width suits a question in passing; a discussion wants room to
  // read. Remembered on this machine.
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem('cs.assistant.wide') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('cs.assistant.wide', wide ? '1' : '0'); } catch { /* a blocked store forgets the width, nothing more */ }
  }, [wide]);

  // What the reader has open, snapshotted when the panel opens, so the
  // opening screen speaks to the book rather than to the workspace.
  const [reading, setReading] = useState<{ title?: string; page?: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const ctx = getOrchestratorContext();
    setReading(ctx.documentId ? { title: ctx.documentTitle, page: ctx.page } : null);
  }, [isOpen]);
  const [pendingSubMatter, setPendingSubMatter] = useState<{
    context: NewMatterContext;
    initialName: string;
    initialDescription: string;
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    documentId: string;
    targetMatterId: string;
    docTitle: string;
    matterName: string;
  } | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const note = (content: string) =>
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date() },
    ]);

  // M2.1: the Orchestrator proposed a sub-matter. Resolve the current matter's
  // parent context, then open the standard creation modal pre-filled. The write
  // happens only when the user submits that modal, under their own session.
  const openCreateSubMatter = async (input: { name?: string; description?: string }) => {
    const name = (input.name || '').trim();
    if (!matterId) {
      note('Open a matter first — sub-matters are created inside a matter.');
      return;
    }
    const { data, error } = await supabase
      .from('matterspaces')
      .select('serverspace_id, name')
      .eq('id', matterId)
      .single();
    if (error || !data) {
      note(`⚠️ Couldn't prepare the sub-matter: ${error?.message || 'matter not found'}.`);
      return;
    }
    setPendingSubMatter({
      context: { serverspaceId: data.serverspace_id, parentMatterId: matterId, contextLabel: data.name },
      initialName: name,
      initialDescription: (input.description || '').trim(),
    });
  };

  // M2.2: the Orchestrator proposed moving a document. Resolve names for a
  // clear confirmation, then show the inline confirm strip. The move itself —
  // which correctly updates the document AND its passages server-side, under
  // the user's session — runs only on confirm.
  const proposeMove = async (input: { document_id?: string; target_matter_id?: string }) => {
    const documentId = (input.document_id || '').trim();
    const targetMatterId = (input.target_matter_id || '').trim();
    if (!documentId || !targetMatterId) {
      note("I couldn't identify the document or destination to move.");
      return;
    }
    const [docRes, matRes] = await Promise.all([
      supabase.from('documents').select('title, source_filename').eq('id', documentId).single(),
      supabase.from('matterspaces').select('name').eq('id', targetMatterId).single(),
    ]);
    if (docRes.error || !docRes.data) {
      note(`⚠️ Couldn't find that document: ${docRes.error?.message || 'not found'}.`);
      return;
    }
    if (matRes.error || !matRes.data) {
      note(`⚠️ Couldn't find the destination matter: ${matRes.error?.message || 'not found'}.`);
      return;
    }
    setPendingMove({
      documentId,
      targetMatterId,
      docTitle: docRes.data.title || docRes.data.source_filename || 'this document',
      matterName: matRes.data.name,
    });
  };

  const confirmMove = async () => {
    if (!pendingMove || moving) return;
    setMoving(true);
    const { documentId, targetMatterId, docTitle, matterName } = pendingMove;
    try {
      await moveVaultDocument(documentId, targetMatterId);
      note(`Moved "${docTitle}" to "${matterName}".`);
      setPendingMove(null);
      navigate(`/app/matterspace/${targetMatterId}`);
    } catch (err) {
      note(`⚠️ Move failed: ${err instanceof Error ? err.message : 'unknown error'}.`);
    } finally {
      setMoving(false);
    }
  };

  // Commands arrive from other surfaces (the docket's highlight-to-Run
  // chip, next-step Run buttons, SecureChat's open button) carrying the
  // matter they came from. The scope sticks for follow-up questions in the
  // same panel session and is replaced by the next command. A ref for the
  // wire (nothing re-renders), plus display state so the panel can SAY
  // where it is scoped — a sticky scope the user can't see is a scope
  // they'll forget.
  const commandMatterRef = useRef<{ id?: string; name?: string } | null>(null);
  const [scope, setScope] = useState<{ name: string; sealed?: boolean } | null>(null);

  // The pen that actually answered, from the server's `session` event —
  // tier, provider, model, escalation. The header renders it live instead
  // of guessing; reset when the scope changes (a different matter may sit
  // at a different tier).
  const [livePen, setLivePen] = useState<{ tier: string; provider: string; model: string } | null>(null);

  // Agents: a command can also arrive carrying a CHARTER — the agent whose
  // job this run is. Only the id crosses the wire; the server loads the
  // charter under the user's own RLS, appends its prose to the system
  // prompt, and narrows the run's tools to the charter's list. It sticks
  // for follow-ups the same way the matter does, and the header says so, so
  // nobody wonders which agent is answering.
  const [runningCharter, setRunningCharter] = useState<{ id: string; name: string } | null>(null);
  const charterRef = useRef<{ id: string; name: string } | null>(null);
  const setCharter = (c: { id: string; name: string } | null) => {
    charterRef.current = c;
    setRunningCharter(c);
  };

  // SecureSpace: matter-bound exchanges are recorded server-side as an
  // ai_sessions row (the privileged work-product ledger). We keep the id the
  // server hands back so follow-ups land in the same session; it is keyed by
  // matter so a scope change starts a fresh session. A ref: nothing re-renders.
  // Keyed by matter AND charter: a charter run is its own session in the
  // ledger, so switching agents inside one matter does not silently
  // continue the previous agent's record.
  const sessionRef = useRef<{ key: string; sessionId: string } | null>(null);

  const send = async (text: string) => {
    if (!text || loading) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    const next = [...messages, userMessage];
    setMessages(next);
    setLoading(true);
    setSearching(true);

    const append = (content: string) =>
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date() },
      ]);

    // One assistant bubble that fills in as the answer streams.
    const assistantId = crypto.randomUUID();
    let acc = '';
    let created = false;
    const ensureAssistant = () => {
      if (created) return;
      created = true;
      setSearching(false);
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', timestamp: new Date() },
      ]);
    };
    const setAssistant = (content: string) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content } : m)));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('You need to be signed in to use the assistant.');

      // A command's matter first; else the page's — read now, not at render,
      // since the reader publishes its matter after its document loads.
      const boundMatterId = commandMatterRef.current?.id ?? routeMatterId ?? getOrchestratorContext().matterId;
      const boundCharterId = charterRef.current?.id;
      const sessionKey = `${boundMatterId ?? ''}|${boundCharterId ?? ''}`;
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          matterId: boundMatterId,
          charterId: boundCharterId,
          sessionId: boundMatterId && sessionRef.current?.key === sessionKey
            ? sessionRef.current.sessionId
            : undefined,
          context: {
            route: location.pathname,
            ...getOrchestratorContext(),
            ...(commandMatterRef.current?.name
              ? { matterName: commandMatterRef.current.name }
              : {}),
          },
        }),
      });

      // Pre-stream failures (401, config errors) arrive as plain JSON.
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(data?.error || `Request failed (${res.status})`);
      }

      // Parse the SSE stream: `data: {json}\n\n` per event.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          let ev: {
            type?: string;
            text?: string;
            message?: string;
            action?: string;
            input?: { document_id?: string; page?: number; matter_id?: string; name?: string; description?: string };
            sessionId?: string | null;
            tier?: string;
            provider?: string;
            model?: string;
          };
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'session') {
            // The server opened (or continued) the recorded session for this matter.
            if (boundMatterId && ev.sessionId) {
              sessionRef.current = { key: sessionKey, sessionId: ev.sessionId };
            }
            // The pen the tier chose — rendered live in the header.
            if (ev.provider && ev.model) {
              setLivePen({ tier: ev.tier ?? 'A', provider: ev.provider, model: ev.model });
            }
          } else if (ev.type === 'text' && ev.text) {
            ensureAssistant();
            acc += ev.text;
            setAssistant(acc);
          } else if (ev.type === 'error') {
            ensureAssistant();
            acc += (acc ? '\n\n' : '') + `⚠️ ${ev.message || 'Something went wrong.'}`;
            setAssistant(acc);
          } else if (ev.type === 'action') {
            // Client-executed UI action (M2): navigate the browser, then get
            // the panel out of the way so the destination is visible.
            const inp = ev.input || {};
            if (ev.action === 'open_document' && inp.document_id) {
              navigate(`/app/document/${inp.document_id}${inp.page ? `?page=${inp.page}` : ''}`);
              onClose();
            } else if (ev.action === 'open_matter' && inp.matter_id) {
              navigate(`/app/matterspace/${inp.matter_id}`);
              onClose();
            }
          } else if (ev.type === 'confirm') {
            // Confirm-required write (M2.1): open the gated dialog; the user
            // performs the change, not the model.
            if (ev.action === 'create_sub_matter') void openCreateSubMatter(ev.input || {});
            else if (ev.action === 'move_document') void proposeMove(ev.input || {});
          }
          // 'tool' / 'done' events need no UI change.
        }
      }
      if (!created) append('No answer was returned.');
    } catch (err) {
      const msg = `⚠️ ${err instanceof Error ? err.message : 'Something went wrong.'}`;
      if (created) {
        acc += (acc ? '\n\n' : '') + msg;
        setAssistant(acc);
      } else {
        append(msg);
      }
    } finally {
      setLoading(false);
      setSearching(false);
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    void send(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Subscribe once; route events through a ref so the handler always calls
  // the latest send() without re-subscribing every render.
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const cmd = (e as CustomEvent<AssistantCommand>).detail;
      if (!cmd) return;
      commandMatterRef.current = { id: cmd.matterId, name: cmd.matterName };
      setScope(cmd.matterName ? { name: cmd.matterName, sealed: cmd.sealed } : null);
      setLivePen(null);
      setCharter(cmd.charterId ? { id: cmd.charterId, name: cmd.charterName || 'Agent' } : null);
      // A command may carry no prompt: it scopes and opens the panel
      // (SecureChat's door) without spending a model call.
      if (cmd.prompt?.trim()) void sendRef.current(cmd.prompt.trim());
    };
    window.addEventListener(ASSISTANT_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(ASSISTANT_COMMAND_EVENT, onCommand);
  }, []);

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      )}

      <div
        className={`fixed top-0 right-0 h-full ${
          wide ? 'w-[94vw] sm:w-[min(860px,82vw)] max-w-none' : 'w-[88vw] sm:w-80 max-w-[22rem]'
        } border-l border-[rgba(255,255,255,0.08)] z-50 flex flex-col shadow-2xl transition-[transform,width] duration-300 ease-in-out backdrop-blur-[30px] ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
          {/* Truth-in-labeling: name the model that actually answers. Before
              the first exchange we show the Tier-A default; after it, the
              server's `session` event tells us which pen the matter's tier
              actually chose (a sealed matter is served by the sealed pen,
              never the default), and a SEALED chip says so. */}
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
            Orchestrator{' '}
            <span className="text-[11px] font-normal text-white/45">
              · {livePen ? penLabel(livePen.model) : 'Opus 4.8'}
            </span>
            {livePen && livePen.tier !== 'A' && (
              <span
                className="px-1 py-px rounded text-[9px] font-semibold tracking-wide"
                style={{ backgroundColor: 'rgba(90,168,143,0.14)', color: '#5aa88f' }}
                title="This matter is sealed: no training, zero data retention, recorded as privileged work product."
              >
                SEALED
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setWide((v) => !v)}
              className="hidden sm:inline-flex p-1 rounded hover:bg-[rgba(20,20,30,0.8)] text-[#8a8693] hover:text-white transition-colors"
              title={wide ? 'Back to the sidebar width' : 'Widen for a longer conversation'}
              aria-label={wide ? 'Narrow the panel' : 'Widen the panel'}
              aria-pressed={wide}
            >
              {wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[rgba(20,20,30,0.8)] text-[#8a8693] hover:text-white transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Where the panel is scoped. For SecureChat (a born-sealed room)
            the strip states the ground rules up front — the Heppner facts,
            inverted: no training, zero retention, inside a matter. For any
            other command scope it simply names the matter, so the sticky
            scope is visible instead of remembered. */}
        {scope && (
          <div
            className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[rgba(255,255,255,0.08)]"
            style={scope.sealed ? { backgroundColor: 'rgba(90,168,143,0.07)' } : undefined}
          >
            <span className="text-[11px] truncate" style={{ color: scope.sealed ? '#5aa88f' : 'rgba(255,255,255,0.55)' }}>
              {scope.sealed ? (
                <>Sealed room — <span className="font-semibold">{scope.name}</span> · no training · zero data retention</>
              ) : (
                <>In <span className="font-semibold">{scope.name}</span></>
              )}
            </span>
            <button
              onClick={() => { commandMatterRef.current = null; setScope(null); setLivePen(null); }}
              className="text-[11px] text-white/45 hover:text-white transition-colors shrink-0"
              title="Leave this matter's scope"
            >
              clear
            </button>
          </div>
        )}

        {/* Running under a charter (Agents). Stated plainly, with a way out:
            an agent that answers without saying it is an agent is exactly the
            thing this tab is not. */}
        {runningCharter && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(232,184,74,0.06)]">
            <span className="text-[11px] text-[#e8b84a] truncate">
              Running as <span className="font-semibold">{runningCharter.name}</span>
            </span>
            <button
              onClick={() => setCharter(null)}
              className="text-[11px] text-white/45 hover:text-white transition-colors shrink-0"
              title="Stop running under this charter"
            >
              clear
            </button>
          </div>
        )}

        {/* Messages. Wide, the column is capped and centred so lines stay
            readable, and the type steps up a size. */}
        <div className={`flex-1 overflow-y-auto py-4 space-y-3 ${wide ? 'px-6 sm:px-10' : 'px-4'}`}>
          <div className={wide ? 'max-w-3xl mx-auto space-y-3' : 'space-y-3'}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`${wide ? 'max-w-[80%] px-4 py-2.5 text-[15px]' : 'max-w-[85%] px-3 py-2 text-sm'} rounded-xl leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm'
                    : 'bg-[rgba(20,20,30,0.8)] text-[#e8e4de] rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {messages.length === 1 && !loading && (
            <div className="flex flex-col items-start gap-1.5 pt-1">
              {reading && (
                <p className="text-[11px] text-white/45 leading-snug mb-1">
                  Reading <span className="text-[#e8d9b8]">“{reading.title ?? 'this document'}”</span>
                  {reading.page ? `, p. ${reading.page}` : ''}. Select a passage on the page and choose Ask to bring it here.
                </p>
              )}
              {(reading ? READING_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="max-w-[85%] px-3 py-1.5 rounded-xl border border-[rgba(232,184,74,0.35)] text-left text-[13px] text-[#e8d9b8] hover:bg-[rgba(232,184,74,0.08)] hover:border-[rgba(232,184,74,0.6)] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {searching && (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm text-sm italic bg-[rgba(20,20,30,0.8)] text-[#8a8693]">
                Searching the matter…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Move confirmation (M2.2) — gated write, inline so it stays in context */}
        {pendingMove && (
          <div className="px-4 py-3 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(20,20,30,0.6)]">
            <p className="text-[12px] text-[#e8e4de] leading-snug mb-2">
              Move <span className="text-white font-medium">"{pendingMove.docTitle}"</span> to{' '}
              <span className="text-[#e8b84a]">"{pendingMove.matterName}"</span>?
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmMove}
                disabled={moving}
                className="flex-1 py-1.5 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold transition-colors disabled:opacity-40"
              >
                {moving ? 'Moving…' : 'Move'}
              </button>
              <button
                onClick={() => setPendingMove(null)}
                disabled={moving}
                className="flex-1 py-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] text-[#e8e4de] text-[12px] hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div className={`py-3 border-t border-[rgba(255,255,255,0.08)] ${wide ? 'px-6 sm:px-10' : 'px-4'}`}>
          <div className={`flex items-center gap-2 bg-[rgba(20,20,30,0.8)] rounded-lg px-3 py-2 ${wide ? 'max-w-3xl mx-auto' : ''}`}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              placeholder={loading ? 'Searching…' : 'Ask anything...'}
              className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="p-1 rounded text-[#8a8693] hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-[#8a8693] transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {pendingSubMatter && (
        <NewMatterModal
          context={pendingSubMatter.context}
          initialName={pendingSubMatter.initialName}
          initialDescription={pendingSubMatter.initialDescription}
          onClose={() => setPendingSubMatter(null)}
          onCreated={(id) => {
            const created = pendingSubMatter.initialName;
            setPendingSubMatter(null);
            note(`Created sub-matter "${created}". Taking you there.`);
            navigate(`/app/matterspace/${id}`);
          }}
        />
      )}
    </>
  );
}
