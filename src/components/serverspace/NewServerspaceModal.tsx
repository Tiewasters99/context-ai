import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';

// Single source of truth for "create a serverspace". Sidebar and Dashboard
// both render this — the markup and behaviour were lifted verbatim from the
// Sidebar's previously-inline modal so the two entry points can't drift.

interface Props {
  onClose: () => void;
  onCreated?: (serverspaceId: string) => void;
}

export default function NewServerspaceModal({ onClose, onCreated }: Props) {
  const { user } = useAuth();
  const refreshServerspaces = useServerspacesRefresh();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientspaceId, setClientspaceId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      const { data: cs } = await supabase
        .from('clientspaces')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (cs) setClientspaceId(cs.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || creating) return;
    if (!clientspaceId) {
      setError('No clientspace found for your account. Refresh the page and try again.');
      return;
    }
    setCreating(true);
    setError(null);
    const { data, error: insertError } = await supabase
      .from('serverspaces')
      .insert({ clientspace_id: clientspaceId, name: cleanName })
      .select('id')
      .maybeSingle();
    setCreating(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    // Invalidate the shared cache — sidebar and dashboard both refetch.
    await refreshServerspaces();
    if (data?.id) onCreated?.(data.id);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-semibold text-white">New Serverspace</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Serverspace name"
            disabled={creating}
            className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[14px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent"
          />
          {error && (
            <p className="mt-3 text-[12px] text-red-300 leading-relaxed">{error}</p>
          )}
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="w-full mt-4 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[13px] font-bold transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(240,200,80,0.3)]"
          >
            {creating ? 'Creating…' : 'Create Serverspace'}
          </button>
        </form>
      </div>
    </>
  );
}
