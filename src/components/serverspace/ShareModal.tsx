// Share a serverspace with another Contextspaces user. Lists current members
// with their roles, lets owners/admins add a new member by email and pick a
// role (viewer / member / admin), and lets them remove non-owner members.
//
// Permissions, per the RLS in migration 005 (serverspace_members):
//   - SELECT: any current member sees the membership list of shared spaces.
//   - INSERT / DELETE: only owners + admins of that serverspace.
// We let the modal open for everyone — the form just no-ops with a clear
// error if the caller lacks permission, instead of needing a separate role
// query before rendering. Lookup by email uses public.profiles, which is
// readable by every authenticated user.

import { useEffect, useState } from 'react';
import { X, UserPlus, Trash2, Loader2, AlertCircle, Check } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

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
  serverspaceId: string;
  serverspaceName: string;
  onClose: () => void;
}

const ROLE_OPTIONS: { value: Exclude<Role, 'owner'>; label: string; help: string }[] = [
  { value: 'admin',  label: 'Admin',  help: 'Read + write + manage members & matters' },
  { value: 'member', label: 'Member', help: 'Read + write documents in this serverspace' },
  { value: 'viewer', label: 'Viewer', help: 'Read-only access to matters and documents' },
];

const ROLE_BADGE: Record<Role, string> = {
  owner:  'bg-[#e8b84a] text-black',
  admin:  'bg-[rgba(232,184,74,0.2)] text-[#e8b84a]',
  member: 'bg-[rgba(255,255,255,0.08)] text-white/80',
  viewer: 'bg-[rgba(255,255,255,0.04)] text-white/60',
};

export default function ShareModal({ serverspaceId, serverspaceName, onClose }: ShareModalProps) {
  const { user } = useAuth();
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
    // Pull memberships + the profile (email, display_name) of each member in one round-trip.
    const { data, error } = await supabase
      .from('serverspace_members')
      .select('id, role, joined_at, user_id, user:profiles(id, email, display_name)')
      .eq('serverspace_id', serverspaceId)
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

  useEffect(() => { void loadMembers(); }, [serverspaceId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setFormError(null);
    setFlash(null);
    setSubmitting(true);
    try {
      // 1. Find the profile by email. Profiles RLS allows any authed user to read.
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
        setFormError(`${trimmed} is already a member.`);
        return;
      }
      // 2. Insert membership. RLS will reject if caller isn't owner/admin.
      const { error: insErr } = await supabase
        .from('serverspace_members')
        .insert({ serverspace_id: serverspaceId, user_id: profile.id, role });
      if (insErr) {
        if (/row-level security|permission/i.test(insErr.message)) {
          throw new Error('Only owners and admins of this serverspace can add members.');
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
    if (m.role === 'owner') return;                 // never remove an owner from this UI
    if (user && m.userId === user.id) return;       // never remove yourself
    if (!confirm(`Remove ${m.displayName || m.email} from "${serverspaceName}"?`)) return;
    const { error } = await supabase
      .from('serverspace_members')
      .delete()
      .eq('id', m.membershipId);
    if (error) {
      setListError(/row-level security|permission/i.test(error.message)
        ? 'Only owners and admins can remove members.'
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
        {/* Header */}
        <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)] flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-white truncate flex items-center gap-2">
              <UserPlus size={16} className="text-[#e8b84a]" strokeWidth={1.75} />
              Share "{serverspaceName}"
            </h2>
            <p className="text-[12px] text-white/60 mt-1">
              Members see all matters, documents, and transcripts in this serverspace.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors shrink-0"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Add member form */}
        <form onSubmit={handleAdd} className="px-6 py-5 border-b border-[rgba(255,255,255,0.06)] shrink-0">
          <label className="block text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-2">
            Add member by email
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
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

        {/* Members list */}
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
            <p className="text-[12px] text-white/40 py-6 text-center">No members yet.</p>
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
        </div>
      </div>
    </div>
  );
}
