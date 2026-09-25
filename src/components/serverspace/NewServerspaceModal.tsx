import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import CardDialog from '@/components/ui/CardDialog';
import { defaultCoverFor, loadCoreCovers } from '@/lib/covers';

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
    // A serverspace used to be born with cover_url null, so the first thing a
    // new account saw inside its first space was an empty "Add cover" strip.
    // It now opens on a core cover chosen by a stable hash of the name (see
    // lib/covers.ts), which every plan is entitled to. If the allow-list is
    // unavailable this is null and the old behaviour stands — a missing cover
    // must never stop a space being created.
    const core = await loadCoreCovers();
    const cover = defaultCoverFor(cleanName, core?.core ?? null);
    const { data, error: insertError } = await supabase
      .from('serverspaces')
      .insert({ clientspace_id: clientspaceId, name: cleanName, cover_url: cover })
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
    <CardDialog
      storageKey="cs.dialog.newServerspace"
      z={50}
      maxWidth={384}
      onClose={onClose}
      // A typed name is not lost to a stray click outside.
      closeOnBackdrop={!name.trim()}
      title="New Serverspace"
    >
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
    </CardDialog>
  );
}
