import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { X, Send, Maximize2, Minimize2 } from 'lucide-react';
import type { ChatMessage } from '@/lib/types';
import { supabase } from '@/lib/supabase';
import { getOrchestratorContext } from '@/lib/orchestrator-context';
import { ASSISTANT_COMMAND_EVENT, type AssistantCommand } from '@/lib/assistant-bus';
import { parseServerRefusal } from '@/lib/llm/refusals';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import { moveVaultDocument } from '@/lib/vault-persist';
import { useIsMobile } from '@/hooks/useIsMobile';
import PinToggle from '@/components/ui/PinToggle';
import {
  describeScope,
  unscopedStripText,
  type ScopeFacts,
  type Starter,
} from '@/components/ai/assistant-scope';
import { useMatterAiState } from '@/components/ai/useMatterAiState';
import {
  readPanelState,
  writePanelState,
  browserStore,
  type PanelBox,
} from '@/components/ai/assistant-panel-state';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which matter the panel is talking about, and how it got there. */
type Bound = {
  id?: string;
  name?: string;
  source: 'command' | 'route' | 'context' | 'none';
};

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

// penLabel and every sentence the panel says about its scope now live in
// components/ai/assistant-scope.ts — pure, so the wording is tested offline
// (scripts/_test-sealed-assistant-scope.mjs) instead of being read off the
// screen. The old local penLabel mapped any id containing "kimi" to "Kimi K3",
// which mislabelled every sealed answer: the sealed pen is
// `moonshotai.kimi-k2.5` on Bedrock, and Kimi K3 on Fireworks was deleted with
// PR #159.

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Commands arrive from other surfaces (the docket's highlight-to-Run
  // chip, next-step Run buttons, SecureChat's open button, the matter
  // header's "Ask the assistant") carrying the matter they came from. The
  // scope sticks for follow-up questions in the same panel session and is
  // replaced by the next command. A ref for the wire (nothing re-renders),
  // plus display state so the panel re-renders when the scope changes.
  const commandMatterRef = useRef<{ id?: string; name?: string } | null>(null);
  const [commandScope, setCommandScope] = useState<{ id?: string; name?: string; sealed?: boolean } | null>(null);

  // "Ask without a matter", keyed to the matter it was asked FOR. A boolean
  // would follow the user to the next matter and silently unscope a panel
  // they never cleared; keyed, walking into another matter scopes the panel
  // again, which is what the strip will then say.
  const unscopedRef = useRef<string | null>(null);
  const [unscopedFor, setUnscopedFor] = useState<string | null>(null);
  const setUnscoped = (id: string | null) => {
    unscopedRef.current = id;
    setUnscopedFor(id);
  };

  // ONE resolution of "which matter is this?", used by the strip AND by
  // send(). Two copies of this rule is how a panel comes to name one matter
  // in its header while binding another on the wire.
  const resolveBound = (): Bound => {
    const cmd = commandMatterRef.current;
    if (cmd?.id) return { id: cmd.id, name: cmd.name, source: 'command' };
    const ctx = getOrchestratorContext();
    if (routeMatterId) return { id: routeMatterId, name: ctx.matterName, source: 'route' };
    if (ctx.matterId) return { id: ctx.matterId, name: ctx.matterName, source: 'context' };
    return { source: 'none' };
  };
  const bound = resolveBound();
  const unscoped = Boolean(bound.id) && unscopedFor === bound.id;
  const scoped = Boolean(bound.id) && !unscoped;

  // The pen that actually answered, from the server's `session` event. It is
  // stamped with the matter it answered FOR, so walking from a sealed matter
  // to an open one cannot leave the sealed pen's name in the header.
  const [livePen, setLivePen] = useState<
    { matterId?: string; tier: string; provider: string; model: string } | null
  >(null);
  const liveForBound = livePen && livePen.matterId === bound.id ? livePen : null;

  // The matter's name, its effective tier and whether AI is paused — read
  // under the user's own RLS, for WHATEVER the panel is bound to, command or
  // page alike. A command's `sealed` flag is only a display hint (the reader's
  // "Ask about this passage" sends none at all, and no command carries a
  // pause), so it seeds the first frame and this read settles it.
  const ai = useMatterAiState(bound.id, { enabled: isOpen, name: bound.name });
  const hintedSealed = commandScope?.id === bound.id && commandScope?.sealed === true;
  const facts: ScopeFacts = scoped
    ? {
      name: ai.name ?? bound.name,
      tier: ai.tier ?? (hintedSealed ? 'B' : null),
      paused: ai.paused,
      pausedSentence: ai.pausedSentence,
      livePen: liveForBound,
    }
    // No matter means no seal: a matter-less chat is Tier A by definition,
    // which is what the server does with it too.
    : { tier: 'A', livePen: liveForBound };
  const describe = describeScope(facts);
  const conversationEmpty = messages.length === 1;

  // A wider panel for a real conversation — a toggle, not a mode: the
  // sidebar width suits a question in passing; a discussion wants room to
  // read. Remembered on this machine.
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem('cs.assistant.wide') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('cs.assistant.wide', wide ? '1' : '0'); } catch { /* a blocked store forgets the width, nothing more */ }
  }, [wide]);

  // Free to move, size and PIN, like the cards elsewhere in the workspace:
  // drag the header to lift the panel off the edge, pull its corner to size
  // it, double-click the header to dock it again — and pin it when it is
  // where you want it. Position, size and the pin live in one localStorage
  // record, written whole, so unpinning can never lose the rect.
  // On a phone the panel fills the screen and none of this applies.
  const isMobile = useIsMobile();
  const [box, setBox] = useState<PanelBox | null>(() => readPanelState(browserStore()).box);
  const [pinned, setPinned] = useState<boolean>(() => readPanelState(browserStore()).pinned);
  useEffect(() => {
    writePanelState(browserStore(), { box, pinned });
  }, [box, pinned]);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; left: number; top: number } | null>(null);
  const floating = !isMobile && box !== null;

  // Pinning a docked panel first lifts it, exactly where it already is —
  // "pin at the current position", the same promise useDraggableResizable
  // makes for a route card. Unpinning keeps the rect and only releases the
  // lock.
  const togglePin = () => {
    if (pinned) { setPinned(false); return; }
    if (!box) {
      const r = panelRef.current?.getBoundingClientRect();
      if (r) setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    setPinned(true);
  };

  const onHeaderDown = (e: React.PointerEvent) => {
    if (isMobile || pinned || (e.target as HTMLElement).closest('button')) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { px: e.clientX, py: e.clientY, left: r.left, top: r.top };
    if (!box) setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const left = clamp(d.left + e.clientX - d.px, 0, window.innerWidth - 160);
    const top = clamp(d.top + e.clientY - d.py, 0, window.innerHeight - 56);
    setBox((b) => (b ? { ...b, left, top } : b));
  };
  const onHeaderUp = () => { dragRef.current = null; };
  // The corner resize is the browser's own; what it produces is remembered.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || !floating) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBox((b) => (b && (Math.abs(b.width - r.width) > 1 || Math.abs(b.height - r.height) > 1)
        ? { ...b, width: r.width, height: r.height }
        : b));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [floating]);
  const toggleWide = () => {
    setWide((v) => !v);
    if (box) {
      const width = wide ? 320 : Math.min(860, window.innerWidth - box.left - 8);
      setBox({ ...box, width });
    }
  };

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
    const matterId = resolveBound().id;
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

      // A command's matter first; else the page's — resolved through the very
      // same function the strip renders from, and read now rather than at
      // render, since the reader publishes its matter after its document
      // loads. "Ask without a matter" is honoured here too: the strip says
      // the panel is unscoped, so the wire must be.
      const here = resolveBound();
      const boundMatterId = unscopedRef.current && unscopedRef.current === here.id
        ? undefined
        : here.id;
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

      // Pre-stream failures (401, config errors, and since PR #161 a 402 when
      // the month's budget is spent or a 429 on the rate window) arrive as
      // plain JSON. This used to render `data.error` — the machine code — so
      // a lawyer stopped by the cap read the words "over_monthly_budget".
      // parseServerRefusal prefers the sentence the server wrote. No banner
      // here: the refusal lands in the transcript below as ⚠️ <message>, and
      // two copies of the same news is worse than one.
      if (!res.ok || !res.body) {
        throw new Error((await parseServerRefusal(res)).message);
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
            // The pen the tier chose — rendered live in the header and in the
            // strip. The server is the authority: where this disagrees with
            // what the strip predicted, the strip adopts this and says so.
            if (ev.provider && ev.model) {
              setLivePen({
                matterId: boundMatterId,
                tier: ev.tier ?? 'A',
                provider: ev.provider,
                model: ev.model,
              });
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

  // A starter with a blank in it is put in the INPUT with the blank selected,
  // not sent: "find the word 'term'" is not a question anybody has.
  const runStarter = (s: Starter) => {
    if (!s.select) { void send(s.text); return; }
    const [from, to] = s.select;
    setInput(s.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(from, to); } catch { /* not all inputs allow it */ }
    });
  };

  // "clear" means two different things, and the strip says which. On a scope
  // a COMMAND put there, it drops back to the page's own matter. On the
  // page's own matter there is nothing to drop back to, so it means "ask
  // without a matter" — for this matter, until the user says otherwise.
  const clearScope = () => {
    setLivePen(null);
    if (commandMatterRef.current?.id) {
      commandMatterRef.current = null;
      setCommandScope(null);
      return;
    }
    if (bound.id) setUnscoped(bound.id);
  };

  // Subscribe once; route events through a ref so the handler always calls
  // the latest send() without re-subscribing every render.
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const cmd = (e as CustomEvent<AssistantCommand>).detail;
      if (!cmd) return;
      commandMatterRef.current = cmd.matterId ? { id: cmd.matterId, name: cmd.matterName } : null;
      setCommandScope(cmd.matterId ? { id: cmd.matterId, name: cmd.matterName, sealed: cmd.sealed } : null);
      // A new command re-scopes the panel, so an earlier "ask without a
      // matter" is spent.
      setUnscoped(null);
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
      {/* A dimmed page behind the panel only on a phone, where the panel
          covers it anyway; on a laptop the page stays live — the companion
          sits beside the book, not in front of it. */}
      {isOpen && isMobile && (
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      )}

      <div
        ref={panelRef}
        className={
          floating
            ? `fixed z-50 flex flex-col shadow-2xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.1)] rounded-xl overflow-hidden ${isOpen ? '' : 'hidden'}`
            : `fixed top-0 right-0 h-full ${
              wide ? 'w-[94vw] sm:w-[min(860px,82vw)] max-w-none' : 'w-[88vw] sm:w-80 max-w-[22rem]'
            } border-l border-[rgba(255,255,255,0.08)] z-50 flex flex-col shadow-2xl transition-[transform,width] duration-300 ease-in-out backdrop-blur-[30px] ${
              isOpen ? 'translate-x-0' : 'translate-x-full'
            }`
        }
        style={floating && box ? {
          left: box.left, top: box.top, width: box.width, height: box.height,
          // Pinned: no resize handle, and the cursor stops inviting a drag.
          resize: pinned ? 'none' : 'both',
          cursor: pinned ? 'default' : undefined,
          minWidth: 300, minHeight: 280, maxWidth: '96vw', maxHeight: '96vh',
        } : undefined}
      >
        {/* Header — the ribbon, and the handle. */}
        <div
          className={`flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.08)] select-none ${isMobile || pinned ? '' : 'cursor-grab active:cursor-grabbing'}`}
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          onPointerCancel={onHeaderUp}
          onDoubleClick={(e) => {
            // A pinned card does not move, and docking would move it.
            if (pinned) return;
            if (!(e.target as HTMLElement).closest('button')) setBox(null);
          }}
          title={
            isMobile
              ? undefined
              : pinned
                ? 'Pinned in place — unpin to move or size it'
                : floating
                  ? 'Drag to move · pull the corner to size · double-click to dock'
                  : 'Drag to lift the panel off the edge'
          }
        >
          {/* Truth-in-labeling: name the model that will answer, BEFORE the
              first exchange — from the matter's own tier, read under the
              user's RLS. Once the server's `session` event names the pen it
              actually chose, that replaces the prediction outright. A tier we
              could not read shows no name at all: silence is better than a
              guess about which mind is reading the file. */}
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
            Orchestrator{' '}
            {describe.penChip && (
              <span className="text-[11px] font-normal text-white/45">· {describe.penChip}</span>
            )}
            {describe.sealed && (
              <span
                className="px-1 py-px rounded text-[9px] font-semibold tracking-wide"
                style={{ backgroundColor: 'rgba(90,168,143,0.14)', color: '#5aa88f' }}
                title="This matter is sealed: it is answered by a zero-retention model in the firm’s own AWS account — no training, and nothing reaches an outside provider."
              >
                SEALED
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            {/* Every card in the workspace is draggable, resizable and
                pinnable; this one was the exception. Pinned state persists
                with the position and size in one record. Meaningless on a
                phone, where the panel fills the screen. */}
            {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
            <button
              onClick={toggleWide}
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

        {/* Where the panel is scoped — WHENEVER it is scoped, by a command or
            simply by the page the user is standing on. This used to render
            only for a command, so a lawyer inside a sealed matter saw an
            ordinary chat box: no matter name, no seal, no model, until after
            an answer had already been produced.

            Sealed scopes state the ground rules up front — the Heppner facts,
            inverted: no training, zero retention, inside a matter. Line two
            names the pen before the first message and corrects itself if the
            server chose another. Line three is the one thing worth knowing
            about searching inside a seal. Both are quiet, and both stand down
            once the conversation has started. */}
        {scoped && (
          <div
            className="px-4 py-2 border-b border-[rgba(255,255,255,0.08)]"
            style={describe.sealed ? { backgroundColor: 'rgba(90,168,143,0.07)' } : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[11px] truncate"
                style={{ color: describe.sealed ? '#5aa88f' : 'rgba(255,255,255,0.55)' }}
              >
                {describe.lead}
                <span className="font-semibold">{describe.name}</span>
                {describe.tail}
              </span>
              <button
                onClick={clearScope}
                className="text-[11px] text-white/45 hover:text-white transition-colors shrink-0"
                title={
                  bound.source === 'command'
                    ? 'Leave this matter’s scope and use the page’s own matter'
                    : 'Ask without a matter for the rest of this conversation'
                }
              >
                clear
              </button>
            </div>
            {describe.penNote && (conversationEmpty || describe.corrected) && (
              <p
                className="mt-1 text-[11px] leading-snug"
                style={{ color: describe.sealed ? 'rgba(90,168,143,0.85)' : 'rgba(255,255,255,0.5)' }}
              >
                {describe.corrected && <span className="font-semibold">Corrected: </span>}
                {describe.penNote}
              </p>
            )}
            {describe.searchNote && conversationEmpty && (
              <p className="mt-1 text-[11px] leading-snug text-white/45">{describe.searchNote}</p>
            )}
          </div>
        )}

        {/* Cleared off the page's own matter: the panel is unscoped on
            purpose, and says so rather than looking like an accident. */}
        {unscoped && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[rgba(255,255,255,0.08)]">
            <span className="text-[11px] text-white/45 truncate">
              {unscopedStripText(ai.name ?? bound.name)}
            </span>
            <button
              onClick={() => { setUnscoped(null); setLivePen(null); }}
              className="text-[11px] text-white/45 hover:text-white transition-colors shrink-0"
              title="Scope the panel to this page’s matter again"
            >
              use this matter
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
          {conversationEmpty && !loading && !describe.paused && (
            <div className="flex flex-col items-start gap-1.5 pt-1">
              {reading && !describe.sealed && (
                <p className="text-[12px] text-white/70 leading-snug mb-1">
                  Reading <span className="text-[#e8d9b8]">“{reading.title ?? 'this document'}”</span>
                  {reading.page ? `, p. ${reading.page}` : ''}. Select a passage on the page and choose Ask to bring it here.
                </p>
              )}
              {/* Inside a seal the openings are different: three questions
                  that work against WORD search, one of them a template the
                  user finishes. Everywhere else, the panel's usual four. */}
              {describe.starters.length > 0
                ? describe.starters.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => runStarter(s)}
                    title={s.select ? 'Puts this in the box with the word selected — type over it' : undefined}
                    className="max-w-[92%] px-3 py-2 rounded-xl text-left text-[13.5px] font-medium transition-colors"
                    style={{
                      border: '1px solid rgba(90,168,143,0.55)',
                      backgroundColor: 'rgba(90,168,143,0.10)',
                      color: '#bfe3d5',
                    }}
                  >
                    {s.label}
                  </button>
                ))
                : (reading ? READING_SUGGESTIONS : SUGGESTIONS).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="max-w-[85%] px-3 py-2 rounded-xl border border-[rgba(232,184,74,0.65)] bg-[rgba(232,184,74,0.10)] text-left text-[13.5px] font-medium text-[#f5e6c4] hover:bg-[rgba(232,184,74,0.2)] hover:border-[#e8b84a] hover:text-white transition-colors"
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

        {/* Input — unless AI is paused on this matter (migration 070), in
            which case the box would only produce a refusal. The sentence the
            server would have answered with is shown instead, in the place the
            box would have been. */}
        {describe.paused ? (
          <div className={`py-3 border-t border-[rgba(255,255,255,0.08)] ${wide ? 'px-6 sm:px-10' : 'px-4'}`}>
            <p
              className={`text-[12px] leading-relaxed rounded-lg px-3 py-2.5 ${wide ? 'max-w-3xl mx-auto' : ''}`}
              style={{
                color: '#e8b84a',
                backgroundColor: 'rgba(232,184,74,0.07)',
                border: '1px solid rgba(232,184,74,0.35)',
              }}
            >
              {describe.pauseNote}
            </p>
          </div>
        ) : (
        <div className={`py-3 border-t border-[rgba(255,255,255,0.08)] ${wide ? 'px-6 sm:px-10' : 'px-4'}`}>
          <div className={`flex items-center gap-2 bg-[rgba(20,20,30,0.8)] rounded-lg px-3 py-2 ${wide ? 'max-w-3xl mx-auto' : ''}`}>
            <input
              ref={inputRef}
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
        )}
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
