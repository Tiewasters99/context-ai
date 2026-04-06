import { useState, useRef, useEffect } from 'react';
import { X, Send, EyeOff, Eye, Pencil, ChevronDown } from 'lucide-react';
import type { ChatMessage, AssistantMode } from '@/lib/types';

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
  content: "Hi! I'm your Context assistant. I can help you navigate, organize, and create content. What would you like to do?",
  timestamp: new Date(),
};

export default function Assistant({ isOpen, onClose }: AssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AssistantMode>('observer');
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    setTimeout(() => {
      const reply: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: "I'm still learning! This is a mock response. Full AI integration is coming soon.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, reply]);
    }, 600);
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
        className={`fixed top-0 right-0 h-full w-80 bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Context Assistant</h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
              {modeConfig[mode].label}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Selector */}
        <div className="px-4 py-2 border-b border-zinc-800 relative">
          <button
            onClick={() => setModeDropdownOpen(!modeDropdownOpen)}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition-colors"
          >
            <ActiveIcon className="h-3.5 w-3.5 text-indigo-400" />
            <span className="flex-1 text-left">{modeConfig[mode].label}</span>
            <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${modeDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {modeDropdownOpen && (
            <div className="absolute left-4 right-4 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden shadow-xl z-10">
              {(Object.keys(modeConfig) as AssistantMode[]).map((key) => {
                const { icon: Icon, label, description } = modeConfig[key];
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setMode(key);
                      setModeDropdownOpen(false);
                    }}
                    className={`flex items-start gap-3 w-full px-3 py-2.5 text-left hover:bg-zinc-700 transition-colors ${
                      mode === key ? 'bg-zinc-700/50' : ''
                    }`}
                  >
                    <Icon className="h-4 w-4 mt-0.5 text-indigo-400 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-white">{label}</div>
                      <div className="text-xs text-zinc-400">{description}</div>
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
                    : 'bg-zinc-800 text-zinc-200 rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-zinc-800">
          <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-1 rounded text-zinc-400 hover:text-indigo-400 disabled:opacity-30 disabled:hover:text-zinc-400 transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
