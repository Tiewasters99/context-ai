// Generic share modal — works for either a serverspace or a single
// matterspace (which then also covers all sub-matters under it).
//
// For 'serverspace' scope: queries serverspace_members; access flows down
// to every matter under the serverspace.
//
// For 'matterspace' scope (introduced in migration 016): queries
// matterspace_members; access is granted to that specific matter plus any
// of its descendants, and does NOT flow up to sibling matters or the rest
// of the serverspace. Useful for sharing a single case with co-counsel.
//
// Permissions (per RLS in migrations 005 + 016):
//   SELECT membership rows  → any co-member of the scope.
//   INSERT / DELETE         → owners + admins of the scope.
// The modal opens for everyone — if the caller lacks admin rights, the
// server rejects the write with a clear message that we surface inline.

import { useEffect, useState } from 'react';
import { X, UserPlus, Trash2, Loader2, AlertCircle, Check } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

type Scope = 'serverspace' | 'matterspace';
type Role = 'owner' | 'admin' | 'member' | 'viewer';

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  joinedAt: string;
}

interface ShareModalProps {
  scope: Scope;
  scopeId: string;
  scopeName: string;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: Exclude<Role, 'owner'>; label: string; help: string }[] = [
  { value: 'admin',  label: 'Admin',  help: 'Read + write + manage members' },
  { value: 'member', label: 'Member', help: 'Read + write documents and passages' },
  { value: 'viewer', label: 'Viewer', help: 'Read-only access' },
];

const ROLE_BADGE: Record<Role, string> = {
  owner:  'bg-[#e8b84a] text-black',
  admin:  'bg-[rgba(232,184,74,0.2)] text-[#e8b84a]',
  member: 'bg-[rgba(255,255,255,0.08)] text-white/80',
  viewer: 'bg-[rgba(255,255,255,0.04)] text-white/60',
};

// Per-scope wiring — single source of truth for the table + FK names so the
// rest of the component stays scope-agnostic.
const SCOPE_CONFIG = {
  serverspace: {
    table: 'serverspace_members' as const,
    fk: 'serverspace_id' as const,
    label: 'serverspace',
    help: 'Members see every matter, document, and transcript in this serverspace.',
  },
  matterspace: {
    table: 'matterspace_members' as const,
    fk: 'matterspace_id' as const,
    label: 'matter',
    help: 'Members see this matter and any sub-matters under it — not the rest of the serverspace.',
  },
};

export default function ShareModal({ scope, scopeId, scopeName, onClose }: ShareModalProps) {
  const { user } = useAuth();
  const cfg = SCOPE_CONFIG[scope];

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('member');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const loadMembers = async () => {
    setLoading(true);
    setListError(null);
    const { data, error } = await supabase
      .from(cfg.table)
      .select('id, role, joined_at, user_id, user:profiles(id, email, display_name)')
      .eq(cfg.fk, scopeId)
      .order('joined_at', { ascending: true });
    if (error) { setListError(error.message); setLoading(false); return; }
    const rows: MemberRow[] = (data ?? []).map((r: any) => ({
      membershipId: r.id,
      userId: r.user_id,
      role: r.role as Role,
      joinedAt: r.joined_at,
      email: r.user?.email ?? '(unknown email)',
      displayName: r.user?.display_name ?? null,
    }));
    setMembers(rows);
    setLoading(false);
  };

  useEffect(() => { void loadMembers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scopeId, scope]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setFormError(null);
    setFlash(null);
    setSubmitting(true);
    try {
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('id, email, display_name')
        .ilike('email', trimmed)
        .maybeSingle();
      if (profileErr) throw new Error(profileErr.message);
      if (!profile) {
        setFormError(`No Contextspaces account for ${trimmed}. Have them sign up at contextspaces.ai first, then add them here.`);
        return;
      }
      if (members.some((m) => m.userId === profile.id)) {
        setFormError(`${trimmed} is already a member of this ${cfg.label}.`);
        return;
      }
      const { error: insErr } = await supabase
        .from(cfg.table)
        .insert({ [cfg.fk]: scopeId, user_id: profile.id, role });
      if (insErr) {
        if (/row-level security|permission/i.test(insErr.message)) {
          throw new Error(`Only owners and admins of this ${cfg.label} can add members.`);
        }
        throw new Error(insErr.message);
      }
      setFlash(`Added ${profile.display_name || trimmed} as ${role}.`);
      setEmail('');
      await loadMembers();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (m: MemberRow) => {
    if (m.role === 'owner') return;
    if (user && m.userId === user.id) return;
    if (!confirm(`Remove ${m.displayName || m.email} from "${scopeName}"?`)) return;
    const { error } = await supabase.from(cfg.table).delete().eq('id', m.membershipId);
    if (error) {
      setListError(/row-level security|permission/i.test(error.message)
        ? `Only owners and admins can remove members from this ${cfg.label}.`
        : error.message);
      return;
    }
    setFlash(`Removed ${m.displayName || m.email}.`);
    await loadMembers();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-[fadeIn_0.15s_ease-out]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[min(540px,100%)] max-h-[88vh] flex flex-col rounded-2xl border border-[rgba(255,255,255,0.1)] shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}
      >
        <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)] flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-white truncate flex items-center gap-2">
              <UserPlus size={16} className="text-[#e8b84a]" strokeWidth={1.75} />
              Share {cfg.label} "{scopeName}"
            </h2>
            <p className="text-[12px] text-white/60 mt-1">{cfg.help}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors shrink-0"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleAdd} className="px-6 py-5 border-b border-[rgba(255,255,255,0.06)] shrink-0">
          <label className="block text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-2">
            Add member by email
          </label>
          <div className="flex flex-col md:flex-row gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              disabled={submitting}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a] focus:border-transparent disabled:opacity-50"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}
              disabled={submitting}
              className="px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a] disabled:opacity-50"
              title={ROLE_OPTIONS.find((o) => o.value === role)?.help}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-[#1c1c26]">{o.label}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors disabled:opacity-40 shrink-0"
            >
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
              {submitting ? 'Adding…' : 'Add'}
            </button>
          </div>
          <p className="text-[10px] text-white/40 mt-2">{ROLE_OPTIONS.find((o) => o.value === role)?.help}</p>
          {formError && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-300">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {formError}
            </p>
          )}
          {flash && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-emerald-400">
              <Check size={12} className="shrink-0 mt-0.5" /> {flash}
            </p>
          )}
        </form>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <p className="text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-3">
            Members ({members.length})
          </p>
          {loading ? (
            <p className="text-[12px] text-white/40 py-6 text-center">
              <Loader2 size={14} className="inline animate-spin mr-1.5" /> Loading…
            </p>
          ) : listError ? (
            <p className="text-[12px] text-red-300/90 py-6">{listError}</p>
          ) : members.length === 0 ? (
            <p className="text-[12px] text-white/40 py-6 text-center">
              No direct members yet.{scope === 'matterspace' && ' Members of the parent serverspace already have access via inheritance.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {members.map((m) => {
                const isSelf = !!user && m.userId === user.id;
                const removable = m.role !== 'owner' && !isSelf;
                return (
                  <li key={m.membershipId} className="group flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-[rgba(255,255,255,0.03)] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-[#e8b84a]/20 flex items-center justify-center text-[12px] font-semibold text-[#e8b84a] shrink-0">
                      {(m.displayName?.[0] ?? m.email[0]).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-white truncate">
                        {m.displayName || m.email}
                        {isSelf && <span className="ml-1.5 text-[10px] text-white/40">(you)</span>}
                      </p>
                      <p className="text-[11px] text-white/40 truncate">{m.email}</p>
                    </div>
                    <span className={`text-[10px] font-medium px-2 py-1 rounded uppercase tracking-wide ${ROLE_BADGE[m.role]}`}>
                      {m.role}
                    </span>
                    {removable && (
                      <button
                        onClick={() => handleRemove(m)}
                        className="p-1.5 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
                        title="Remove member"
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[rgba(255,255,255,0.06)] text-[10px] text-white/40 shrink-0 text-center">
          New members must already have a Contextspaces.ai account.
          {scope === 'matterspace' && ' Sub-matters under this one inherit your access automatically.'}
        </div>
      </div>
    </div>
  );
}
