import { useState, useEffect } from 'react';
import { X, Lock, Check } from 'lucide-react';

interface Template {
  id: string;
  name: string;
  file: string;
  category: string;
}

const FREE_CATEGORIES = new Set(['Sea & Coast', 'Landscapes', 'Abstract', 'Tech']);
const FREE_TRIAL_DAYS = 14;

interface TemplateLibraryProps {
  onSelect: (url: string) => void;
  onClose: () => void;
}

export default function TemplateLibrary({ onSelect, onClose }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);

  useEffect(() => {
    fetch('/templates/manifest.json')
      .then((r) => r.json())
      .then((data: Template[]) => setTemplates(data))
      .catch(() => {});
  }, []);

  const categories = [...new Set(templates.map((t) => t.category))];
  const filtered = activeCategory ? templates.filter((t) => t.category === activeCategory) : templates;
  const isFree = (t: Template) => FREE_CATEGORIES.has(t.category);
  const freeCount = templates.filter(isFree).length;
  const premiumCount = templates.length - freeCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[900px] max-h-[85vh] rounded-2xl border border-[rgba(255,255,255,0.08)] overflow-hidden flex flex-col" style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}>
        {/* Header */}
        <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-[18px] font-semibold text-white">Background Templates</h2>
            <p className="text-[12px] text-white/60 mt-1">
              {freeCount} free · {premiumCount} premium · <span className="text-[#e8b84a]">{FREE_TRIAL_DAYS}-day free trial on all</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Category pills */}
        <div className="px-6 py-3 border-b border-[rgba(255,255,255,0.06)] flex gap-2 flex-wrap shrink-0">
          <button
            onClick={() => setActiveCategory(null)}
            className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
              !activeCategory ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
            }`}
          >
            All ({templates.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                activeCategory === cat ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-4 gap-3">
            {filtered.map((t) => (
              <button
                key={t.id}
                onClick={() => setPreviewTemplate(t)}
                className="group relative rounded-lg overflow-hidden aspect-[4/3] border border-[rgba(255,255,255,0.06)] hover:border-[#e8b84a]/50 transition-all"
              >
                <img
                  src={t.file}
                  alt={t.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="absolute bottom-0 left-0 right-0 p-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-[11px] text-white font-medium truncate">{t.name}</p>
                  <p className="text-[9px] text-white/50">{t.category}</p>
                </div>
                {!isFree(t) && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <Lock size={10} className="text-[#e8b84a]" />
                  </div>
                )}
                {isFree(t) && (
                  <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-[8px] text-emerald-400 font-bold uppercase">
                    Free
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[rgba(255,255,255,0.06)] shrink-0">
          <p className="text-[10px] text-white/40 text-center">
            All artwork by Contextspaces.ai. Premium templates are free for {FREE_TRIAL_DAYS} days, then $2.99/mo for the full library.
          </p>
        </div>
      </div>

      {/* Preview modal */}
      {previewTemplate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80" onClick={() => setPreviewTemplate(null)}>
          <div className="max-w-3xl w-full mx-6" onClick={(e) => e.stopPropagation()}>
            <div className="rounded-2xl overflow-hidden border border-[rgba(255,255,255,0.1)]">
              <img
                src={previewTemplate.file}
                alt={previewTemplate.name}
                className="w-full max-h-[60vh] object-cover"
              />
              <div className="px-5 py-4 flex items-center justify-between" style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}>
                <div>
                  <h3 className="text-[15px] font-semibold text-white">{previewTemplate.name}</h3>
                  <p className="text-[11px] text-white/50 mt-0.5">
                    {previewTemplate.category}
                    {!isFree(previewTemplate) && <span className="text-[#e8b84a] ml-2">Premium · Free during trial</span>}
                    {isFree(previewTemplate) && <span className="text-emerald-400 ml-2">Free forever</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPreviewTemplate(null)}
                    className="px-3 py-2 rounded-lg text-[12px] text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      onSelect(previewTemplate.file);
                      setPreviewTemplate(null);
                      onClose();
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors"
                  >
                    <Check size={14} /> Apply
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
