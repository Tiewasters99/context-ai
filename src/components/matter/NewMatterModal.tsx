import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';

// Single source of truth for "create a matter or sub-matter". Sidebar and
// Vault both render this — anything that grows another invocation point
// (matterspace view, serverspace view, etc) reuses the same modal.

export interface NewMatterContext {
  serverspaceId: string;
  parentMatterId: string | null;
  // Rendered under the title — typically "Acadamic" for top-level or
  // "Acadamic / History" for a sub-matter.
  contextLabel: string;
}

interface Props {
  context: NewMatterContext;
  onClose: () => void;
  onCreated?: (matterId: string) => void;
  // Optional pre-fill (e.g. the Orchestrator proposing a sub-matter). The user
  // still reviews and submits — this only seeds the fields.
  initialName?: string;
  initialDescription?: string;
}

const slugify = (s: string) => {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out && !/^[a-z]/.test(out)) out = 'm-' + out;
  return out.slice(0, 64);
};

export default function NewMatterModal({ context, onClose, onCreated, initialName = '', initialDescription = '' }: Props) {
  const refreshServerspaces = useServerspacesRefresh();
  const [name, setName] = useState(initialName);
  const [shortCode, setShortCode] = useState(initialName ? slugify(initialName) : '');
  const [shortCodeEdited, setShortCodeEdited] = useState(false);
  const [description, setDescription] = useState(initialDescription);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    const cleanName = name.trim();
    const cleanShort = (shortCodeEdited ? shortCode : slugify(cleanName)).trim();
    if (!cleanName) { setError('Name required'); return; }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(cleanShort)) {
      setError('Short code must be lowercase letters/digits/_/-, starting with a letter');
      return;
    }
    setCreating(true);
    setError(null);
    const { data, error: insErr } = await supabase
      .from('matterspaces')
      .insert({
        serverspace_id: context.serverspaceId,
        parent_matterspace_id: context.parentMatterId,
        name: cleanName,
        short_code: cleanShort,
        description: description.trim() || null,
      })
      .select('id')
      .single();
    setCreating(false);
    if (insErr) {
      setError(
        insErr.message.includes('duplicate') || insErr.code === '23505'
          ? `Short code "${cleanShort}" is already taken`
          : insErr.message,
      );
      return;
    }
    await refreshServerspaces();
    onCreated?.(data.id);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-white">
            {context.parentMatterId ? 'New Sub-Matter' : 'New Matter'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] text-white/50 mb-5">
          in <span className="text-[#e8b84a]/80">{context.contextLabel}</span>
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!shortCodeEdited) setShortCode(slugify(e.target.value));
            }}
            placeholder="Matter name"
            disabled={creating}
            className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[14px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent"
          />
          <div>
            <input
              type="text"
              value={shortCode}
              onChange={(e) => {
                setShortCode(e.target.value);
                setShortCodeEdited(true);
              }}
              placeholder="short-code"
              disabled={creating}
              className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[14px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent font-mono"
            />
            <p className="mt-1.5 text-[10px] text-white/40 leading-snug">
              Used in URLs and the MCP <code className="text-white/60">matter</code> arg. Lowercase letters/digits/_/-, must be unique.
            </p>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            disabled={creating}
            rows={2}
            className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent resize-none"
          />
          {error && <p className="text-[12px] text-red-300 leading-relaxed">{error}</p>}
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="w-full py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[13px] font-bold transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(240,200,80,0.3)]"
          >
            {creating ? 'Creating…' : 'Create Matter'}
          </button>
        </form>
      </div>
    </>
  );
}
