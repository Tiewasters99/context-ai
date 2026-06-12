import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { X, Send, EyeOff, Eye, Pencil, ChevronDown } from 'lucide-react';
import type { ChatMessage, AssistantMode } from '@/lib/types';
import { supabase } from '@/lib/supabase';
import { getOrchestratorContext } from '@/lib/orchestrator-context';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import { moveVaultDocument } from '@/lib/vault-persist';

interface AssistantProps {
  isOpen: boolean;
  onClose: () => void;
}

const modeConfig: Record<AssistantMode, { icon: typeof EyeOff; label: string; description: string }> = {
  blind: { icon: EyeOff, label: 'Blind', description: 'Assistant cannot see your content' },
  observer: { icon: Eye, label: 'Observer', description: 'Assistant can see your current page' },
  collaborative: { icon: Pencil, label: 'Collaborative', description: 'Assistant can view and edit content' },
};

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: "Hi — I'm the Orchestrator. Ask me how anything here works, what's in your documents, or to do something for you.",
  timestamp: new Date(),
};

export default function Assistant({ isOpen, onClose }: AssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AssistantMode>('observer');
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const { id: matterId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
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

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput('');
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

      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          matterId,
          context: { route: location.pathname, ...getOrchestratorContext() },
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
          };
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'text' && ev.text) {
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const ActiveIcon = modeConfig[mode].icon;

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      )}

      <div
        className={`fixed top-0 right-0 h-full w-80 border-l border-[rgba(255,255,255,0.08)] z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out backdrop-blur-[30px] ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Orchestrator</h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
              {modeConfig[mode].label}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(20,20,30,0.8)] text-[#8a8693] hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Selector */}
        <div className="px-4 py-2 border-b border-[rgba(255,255,255,0.08)] relative">
          <button
            onClick={() => setModeDropdownOpen(!modeDropdownOpen)}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-[rgba(20,20,30,0.8)] hover:bg-[rgba(40,40,55,0.8)] text-sm text-[#e8e4de] transition-colors"
          >
            <ActiveIcon className="h-3.5 w-3.5 text-indigo-400" />
            <span className="flex-1 text-left">{modeConfig[mode].label}</span>
            <ChevronDown className={`h-3.5 w-3.5 text-[#5a5665] transition-transform ${modeDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {modeDropdownOpen && (
            <div className="absolute left-4 right-4 top-full mt-1 bg-[rgba(20,20,30,0.8)] border border-[rgba(255,255,255,0.08)] rounded-lg overflow-hidden shadow-xl z-10">
              {(Object.keys(modeConfig) as AssistantMode[]).map((key) => {
                const { icon: Icon, label, description } = modeConfig[key];
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setMode(key);
                      setModeDropdownOpen(false);
                    }}
                    className={`flex items-start gap-3 w-full px-3 py-2.5 text-left hover:bg-[rgba(40,40,55,0.8)] transition-colors ${
                      mode === key ? 'bg-[rgba(40,40,55,0.8)]/50' : ''
                    }`}
                  >
                    <Icon className="h-4 w-4 mt-0.5 text-indigo-400 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-white">{label}</div>
                      <div className="text-xs text-[#8a8693]">{description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm'
                    : 'bg-[rgba(20,20,30,0.8)] text-[#e8e4de] rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {searching && (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm text-sm italic bg-[rgba(20,20,30,0.8)] text-[#8a8693]">
                Searching the matter…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
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
        <div className="px-4 py-3 border-t border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center gap-2 bg-[rgba(20,20,30,0.8)] rounded-lg px-3 py-2">
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
