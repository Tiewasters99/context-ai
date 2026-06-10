import { useState } from 'react';
import { Tags, Plus, Trash2, Check } from 'lucide-react';
import {
  createTagDef, deleteTagDef,
  type DocumentTagDef, type ProductionItem,
} from '@/lib/discovery';
import FloatingPanel from './FloatingPanel';

const SWATCHES = ['#f87171', '#fbbf24', '#4ade80', '#60a5fa', '#a78bfa', '#f472b6', '#9ca3af', '#d4a054'];

// Custom-tag picker (the T key): toggle any tag on the selected document,
// create new custom tags (name + color + optional page endorsement), and
// delete custom defs. Preset defs can't be deleted.
export default function TagPickerPanel({
  matterspaceId,
  defs,
  item,
  onToggle,
  onDefsChanged,
  onClose,
}: {
  matterspaceId: string;
  defs: DocumentTagDef[];
  item: ProductionItem | null;
  onToggle: (def: DocumentTagDef) => void;
  onDefsChanged: (defs: DocumentTagDef[]) => void;
  onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[4]);
  const [endorses, setEndorses] = useState(false);
  const [endorseText, setEndorseText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const def = await createTagDef({
        matterspace_id: matterspaceId,
        name: name.trim(),
        color,
        is_endorsement: endorses,
        endorsement_text: endorses ? (endorseText.trim() || name.trim().toUpperCase()) : null,
      });
      onDefsChanged([...defs, def]);
      setName(''); setEndorseText(''); setEndorses(false); setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create tag');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (def: DocumentTagDef) => {
    try {
      await deleteTagDef(def.id);
      onDefsChanged(defs.filter((d) => d.id !== def.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete tag');
    }
  };

  return (
    <FloatingPanel
      title="Tags"
      icon={<Tags size={14} />}
      storageKey="cs.discovery.tagpicker"
      defaultStyle={{ right: 64, top: 140, width: 320 }}
      onClose={onClose}
    >
      <div className="px-3 py-3 cursor-default">
        {item ? (
          <p className="text-[10.5px] text-white/40 mb-2 truncate">
            Tagging <span className="text-white/70">{item.original_filename}</span>
          </p>
        ) : (
          <p className="text-[10.5px] text-white/40 mb-2">No document selected.</p>
        )}

        <div className="space-y-px">
          {defs.map((def) => {
            const applied = !!item?.tags.some((t) => t.tag_def_id === def.id);
            return (
              <div key={def.id} className="flex items-center group rounded-md hover:bg-[rgba(255,255,255,0.04)]">
                <button
                  onClick={() => item && onToggle(def)}
                  disabled={!item}
                  className="flex items-center gap-2.5 flex-1 min-w-0 px-2 py-1.5 text-left disabled:opacity-40"
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors`}
                    style={{
                      borderColor: `${def.color}88`,
                      backgroundColor: applied ? def.color : 'transparent',
                    }}
                  >
                    {applied && <Check size={10} strokeWidth={3.5} className="text-black/80" />}
                  </span>
                  <span className="text-[12px] truncate" style={{ color: applied ? def.color : '#d8d4cc' }}>
                    {def.name}
                  </span>
                  {def.is_endorsement && (
                    <span className="text-[8.5px] uppercase tracking-wider text-white/30 border border-white/15 rounded px-1 py-px shrink-0">
                      stamps
                    </span>
                  )}
                  {def.behavior && (
                    <span className="text-[8.5px] uppercase tracking-wider text-white/30 shrink-0">
                      {def.behavior === 'privileged' ? 'withheld' : 'excluded'}
                    </span>
                  )}
                </button>
                {!def.is_preset && (
                  <button
                    onClick={() => void handleDelete(def)}
                    className="p-1.5 mr-1 rounded text-white/0 group-hover:text-white/35 hover:!text-red-300 transition-colors"
                    title={`Delete tag "${def.name}"`}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 pt-3 border-t border-[rgba(255,255,255,0.07)]">
          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 text-[11.5px] text-[#e8b84a]/85 hover:text-[#e8b84a] transition-colors"
            >
              <Plus size={11} strokeWidth={2.5} />
              New custom tag
            </button>
          ) : (
            <div className="space-y-2.5">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
                placeholder="Tag name"
                className="w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60"
              />
              <div className="flex items-center gap-1.5">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-5 h-5 rounded-full transition-transform ${color === c ? 'scale-110 ring-2 ring-white/60' : 'hover:scale-110'}`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
              <label className="flex items-center gap-2 text-[11px] text-white/60 cursor-pointer">
                <input
                  type="checkbox"
                  checked={endorses}
                  onChange={(e) => setEndorses(e.target.checked)}
                  className="accent-[#d4a054]"
                />
                Burn endorsement onto produced pages
              </label>
              {endorses && (
                <input
                  value={endorseText}
                  onChange={(e) => setEndorseText(e.target.value)}
                  placeholder={name.trim() ? name.trim().toUpperCase() : 'ENDORSEMENT TEXT'}
                  className="w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[11px] font-mono uppercase tracking-wider text-[#f0ebe3] placeholder:text-white/25 focus:outline-none focus:border-[#d4a054]/60"
                />
              )}
              {error && <p className="text-[10.5px] text-red-300">{error}</p>}
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => { setCreating(false); setError(null); }}
                  className="text-[11px] text-white/45 hover:text-white/75"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleCreate()}
                  disabled={!name.trim() || busy}
                  className="px-3 py-1 rounded-md bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[11px] font-medium transition-colors disabled:opacity-40"
                >
                  {busy ? 'Creating…' : 'Create tag'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}
