// "New conversation": a title, who it is for, and whether AI may read it.
// The audience is fixed once the conversation is started (091 refuses a later
// change), so the card says so before the button is pressed.

import { useMemo, useState } from 'react';
import { Lock, Users } from 'lucide-react';
import AgentCard, { cardField, cardLegend } from '@/components/agents/AgentCard';
import {
  AI_SWITCH_LABEL, AUDIENCE_LABEL, HISTORY_NOTE, PRIVATE_PICKER_NOTE, PRIVATE_START_REFUSED,
  aiSwitchHelp, canStartPrivate, defaultAiReadable, isMatterManager, personName,
  type Audience, type Person,
} from '@/lib/conversations';
import { createConversation } from './api';

export default function NewConversationCard({
  matterId,
  people,
  viewerId,
  onClose,
  onCreated,
}: {
  matterId: string;
  people: Person[];
  viewerId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [audience, setAudience] = useState<Audience>('matter');
  const [aiReadable, setAiReadable] = useState(defaultAiReadable('matter'));
  const [aiTouched, setAiTouched] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const viewerRole = people.find((p) => p.user_id === viewerId)?.role ?? null;
  const mayStartPrivate = canStartPrivate(viewerRole);
  const others = useMemo(() => people.filter((p) => p.user_id !== viewerId), [people, viewerId]);
  // The matter's owners and admins read every conversation whatever is
  // ticked; they are shown as always included, never as a choice.
  const managers = useMemo(() => others.filter((p) => isMatterManager(p.role)), [others]);
  const choosable = useMemo(() => others.filter((p) => !isMatterManager(p.role)), [others]);

  const chooseAudience = (a: Audience) => {
    setAudience(a);
    // The switch follows the audience's default until the person sets it.
    if (!aiTouched) setAiReadable(defaultAiReadable(a));
  };

  const canSave = title.trim().length > 0 && (audience === 'matter' || mayStartPrivate) && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createConversation({
        matterId,
        title: title.trim(),
        audience,
        aiReadable,
        memberIds: audience === 'members' ? [...picked] : [],
      });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <AgentCard
      storageKey={`cs.thread.new-conversation:${matterId}`}
      title="New conversation"
      subtitle="Who can read it is set now and cannot be changed later."
      onClose={onClose}
      footer={(
        <>
          {error && <p className="text-[11.5px] text-red-300 mr-auto">{error}</p>}
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded-lg text-[12.5px] text-white/60 hover:text-white hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium border border-[#e8b84a]/35 bg-[#e8b84a]/10 text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-35 disabled:cursor-not-allowed"
          >
            {saving ? 'Starting…' : 'Start conversation'}
          </button>
        </>
      )}
    >
      <div>
        <p className={cardLegend}>Title</p>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="e.g. Settlement strategy"
          className={cardField}
        />
      </div>

      <fieldset>
        <legend className={cardLegend}>Who can read it</legend>
        <div className="space-y-1.5">
          {(['matter', 'members'] as const).map((a) => (
            <label key={a} className={`flex items-start gap-2.5 text-[13px] ${a === 'members' && !mayStartPrivate ? 'text-white/35 cursor-not-allowed' : 'text-white/85 cursor-pointer'}`}>
              <input
                type="radio"
                name="audience"
                checked={audience === a}
                disabled={a === 'members' && !mayStartPrivate}
                onChange={() => chooseAudience(a)}
                className="mt-1 accent-[#e8b84a]"
              />
              <span className="flex items-center gap-1.5">
                {a === 'members' ? <Lock size={12} className="text-white/55" /> : <Users size={12} className="text-white/55" />}
                {AUDIENCE_LABEL[a]}
              </span>
            </label>
          ))}
        </div>
        {!mayStartPrivate && <p className="text-[11px] text-white/45 mt-1.5 pl-6">{PRIVATE_START_REFUSED}</p>}
      </fieldset>

      {audience === 'members' && (
        <div>
          <p className={cardLegend}>People</p>
          <p className="text-[11.5px] text-white/50 mb-2 leading-relaxed">{PRIVATE_PICKER_NOTE}</p>
          {others.length === 0 ? (
            <p className="text-[12px] text-white/45">Nobody else can open this matter yet.</p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
              <li className="text-[12.5px] text-white/45 pl-6">You (always included)</li>
              {managers.map((p) => (
                <li key={p.user_id} className="text-[12.5px] text-white/45 pl-6">
                  {personName(p)} (matter {p.role} — can always read it)
                </li>
              ))}
              {choosable.map((p) => (
                <li key={p.user_id}>
                  <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-white/85">
                    <input
                      type="checkbox"
                      checked={picked.has(p.user_id)}
                      onChange={(e) => setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.user_id); else next.delete(p.user_id);
                        return next;
                      })}
                      className="accent-[#e8b84a]"
                    />
                    <span className="truncate">{personName(p)}</span>
                    {p.email && p.display_name && <span className="text-[11px] text-white/35 truncate">{p.email}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-white/40 mt-2">{HISTORY_NOTE}</p>
        </div>
      )}

      <div>
        <label className="flex items-center gap-2.5 cursor-pointer text-[13px] text-white/85">
          <input
            type="checkbox"
            checked={aiReadable}
            onChange={(e) => { setAiReadable(e.target.checked); setAiTouched(true); }}
            className="accent-[#e8b84a]"
          />
          {AI_SWITCH_LABEL}
        </label>
        <p className="text-[11.5px] text-white/50 mt-1 leading-relaxed pl-6">{aiSwitchHelp(audience)}</p>
      </div>
    </AgentCard>
  );
}
