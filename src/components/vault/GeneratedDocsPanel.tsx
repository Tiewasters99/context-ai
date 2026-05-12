import { X, Bot, Sparkles } from 'lucide-react';
import type { VaultFile } from '@/lib/vault-types';

interface GeneratedDocsPanelProps {
  docs: VaultFile[];
  onOpen: (file: VaultFile) => void;
  onRemove: (id: string) => void;
}

const timeAgo = (ms?: number) => {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
};

export default function GeneratedDocsPanel({ docs, onOpen, onRemove }: GeneratedDocsPanelProps) {
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)]">
        <h2 className="text-[18px] font-semibold text-white mb-1">Generated Documents</h2>
        <p className="text-[13px] text-white/80">
          Drafts you saved from the AI Workbench. Click to open and edit.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <Bot size={28} className="text-white/30" strokeWidth={1.5} />
            <p className="text-[13px] text-white/60">No generated documents yet.</p>
            <p className="text-[11px] text-white/40 max-w-sm">
              Run an instruction in the <span className="text-[#e8b84a]/70">AI Workbench</span>, then hit
              <span className="text-[#e8b84a]/70"> Save to Vault</span> on the output to keep an editable draft here.
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider mb-3">
              {docs.length} draft{docs.length !== 1 ? 's' : ''}
            </h3>
            {docs.map((doc) => (
              <div
                key={doc.id}
                onClick={() => onOpen(doc)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[rgba(255,255,255,0.03)] transition-colors group cursor-pointer"
                title="Open document"
              >
                <Sparkles size={14} className="text-[#e8b84a] shrink-0" strokeWidth={1.75} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-white truncate group-hover:text-[#e8b84a] transition-colors">{doc.name}</p>
                  <p className="text-[10px] text-white/50">
                    {doc.type.toUpperCase()} · {(doc.textContent?.length ?? 0).toLocaleString()} chars
                    {doc.createdAt && <span className="text-white/30"> · {timeAgo(doc.createdAt)}</span>}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(doc.id); }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-all"
                  title="Discard draft"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
