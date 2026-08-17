import { useCallback, useEffect, useState } from 'react';
import { Landmark, Plus, X, BookOpen, Scale, ChevronRight, ChevronDown, ExternalLink } from 'lucide-react';
import { supabase } from '@/lib/supabase';

// The Office — the back office of the firm's public room.
//
// The public-facing Office (a walkable photoreal office; today the Office v.1
// depth-parallax build, later its own domain) shows a Library of book spines
// and a set of Practice Areas. THIS page is where those get filled: the vault
// on the left, the office's sections on the right — drag a document across
// and it is published. Metadata and an excerpt travel; the file itself never
// leaves the vault (one-way glass — the office can show a book the way a
// physical library does, but nothing can be carried out).
//
// Data: office_sections / office_items (migration 050, owner-only RLS).
// The public reads exclusively through GET /api/office (service role,
// published rows, excerpts only). The more you fill your Contextspaces,
// the richer your office.
//
// Drag protocol: the same custom MIME the Vault uses for document rows
// ('application/x-cs-vault-file', payload { docId, fromMatterId }) so any
// future vault surface can drop straight onto an office section too.

interface OfficeSection {
  id: string;
  kind: 'library' | 'practice' | 'cle' | 'page';
  title: string;
  blurb: string;
  sort_order: number;
}
interface OfficeItem {
  id: string;
  section_id: string;
  document_id: string | null;
  title: string;
  author: string;
  excerpt: string;
  spine: string;
  published: boolean;
}
interface MatterRow {
  id: string;
  name: string;
}
interface DocRow {
  id: string;
  title: string;
  author: string | null;
}

const SPINES = ['#7a2530', '#243a52', '#39505f', '#8a6d2a', '#2e5a50', '#5a4a6e', '#6e4a2e', '#3a5a6e', '#742d2d', '#2e6b64'];
const spineFor = (title: string) =>
  SPINES[Array.from(title).reduce((a, c) => a + c.charCodeAt(0), 0) % SPINES.length];

export default function TheOffice() {
  const [sections, setSections] = useState<OfficeSection[]>([]);
  const [items, setItems] = useState<OfficeItem[]>([]);
  const [matters, setMatters] = useState<MatterRow[]>([]);
  const [docsByMatter, setDocsByMatter] = useState<Record<string, DocRow[]>>({});
  const [openMatters, setOpenMatters] = useState<Record<string, boolean>>({});
  const [dropHover, setDropHover] = useState<string | null>(null);
  const [adding, setAdding] = useState<'library' | 'practice' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const say = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  const refresh = useCallback(async () => {
    const [s, i] = await Promise.all([
      supabase.from('office_sections').select('id, kind, title, blurb, sort_order').order('sort_order').order('created_at'),
      supabase.from('office_items').select('id, section_id, document_id, title, author, excerpt, spine, published').order('sort_order').order('created_at'),
    ]);
    if (!s.error) setSections((s.data ?? []) as OfficeSection[]);
    if (!i.error) setItems((i.data ?? []) as OfficeItem[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    supabase
      .from('matterspaces')
      .select('id, name')
      .order('name')
      .then(({ data }) => setMatters((data ?? []) as MatterRow[]));
  }, [refresh]);

  const toggleMatter = async (id: string) => {
    setOpenMatters((m) => ({ ...m, [id]: !m[id] }));
    if (!docsByMatter[id]) {
      const { data } = await supabase
        .from('documents')
        .select('id, title, author')
        .eq('matterspace_id', id)
        .order('title')
        .limit(300);
      setDocsByMatter((d) => ({ ...d, [id]: (data ?? []) as DocRow[] }));
    }
  };

  const addSection = async (kind: 'library' | 'practice') => {
    const title = newTitle.trim();
    if (!title) return;
    const { error } = await supabase.from('office_sections').insert({ kind, title });
    if (error) { say(error.message); return; }
    setAdding(null);
    setNewTitle('');
    refresh();
  };

  const removeSection = async (s: OfficeSection) => {
    const n = items.filter((it) => it.section_id === s.id).length;
    if (n > 0 && !window.confirm(`Remove "${s.title}" and take its ${n} item${n === 1 ? '' : 's'} off the public office?`)) return;
    await supabase.from('office_sections').delete().eq('id', s.id);
    refresh();
  };

  const removeItem = async (it: OfficeItem) => {
    await supabase.from('office_items').delete().eq('id', it.id);
    setItems((prev) => prev.filter((p) => p.id !== it.id));
  };

  // The drop: a vault document lands on a section → it is published.
  const publishDoc = async (docId: string, section: OfficeSection) => {
    const { data: doc } = await supabase
      .from('documents')
      .select('id, title, author')
      .eq('id', docId)
      .single();
    if (!doc) { say('Could not read that document.'); return; }
    if (items.some((it) => it.document_id === docId && it.section_id === section.id)) {
      say(`"${doc.title}" is already on that shelf.`);
      return;
    }
    const { data: firstPassage } = await supabase
      .from('passages')
      .select('text')
      .eq('document_id', docId)
      .order('sequence_number')
      .limit(1)
      .maybeSingle();
    const excerpt = (firstPassage?.text ?? '').slice(0, 700);
    const { error } = await supabase.from('office_items').insert({
      section_id: section.id,
      document_id: docId,
      title: doc.title,
      author: doc.author ?? '',
      excerpt,
      spine: spineFor(doc.title),
    });
    if (error) { say(error.message); return; }
    say(`"${doc.title}" is now showing in ${section.title}.`);
    refresh();
  };

  const onDrop = (e: React.DragEvent, section: OfficeSection) => {
    e.preventDefault();
    setDropHover(null);
    try {
      const raw = e.dataTransfer.getData('application/x-cs-vault-file');
      if (!raw) return;
      const { docId } = JSON.parse(raw) as { docId: string };
      if (docId) publishDoc(docId, section);
    } catch { /* not a vault drag */ }
  };

  const seedStarter = async () => {
    const { error } = await supabase.from('office_sections').insert([
      { kind: 'library', title: 'CLE Presentations', blurb: "The firm's continuing-legal-education work.", sort_order: 0 },
      { kind: 'library', title: 'From the Vault', blurb: 'Papers the firm is willing to show.', sort_order: 1 },
      { kind: 'practice', title: 'Commercial Litigation', sort_order: 0 },
    ]);
    if (error) { say(error.message); return; }
    refresh();
  };

  const librarySections = sections.filter((s) => s.kind === 'library' || s.kind === 'cle');
  const practiceSections = sections.filter((s) => s.kind === 'practice');

  const sectionCard = (s: OfficeSection) => {
    const its = items.filter((it) => it.section_id === s.id);
    return (
      <div
        key={s.id}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-cs-vault-file')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropHover(s.id);
          }
        }}
        onDragLeave={() => setDropHover((h) => (h === s.id ? null : h))}
        onDrop={(e) => onDrop(e, s)}
        className={`rounded-xl border px-4 py-3 transition-colors ${
          dropHover === s.id
            ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.06)]'
            : 'border-[rgba(255,255,255,0.08)] bg-[rgba(8,8,14,0.8)]'
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-white">{s.title}</span>
          <button
            onClick={() => removeSection(s)}
            className="p-1 rounded text-white/25 hover:text-white/70 transition-colors"
            title="Remove section"
          >
            <X size={13} />
          </button>
        </div>
        {its.length === 0 ? (
          <div className="text-[11.5px] text-white/30 italic mt-1.5">Drag a document here to show it.</div>
        ) : (
          <ul className="mt-2 space-y-1">
            {its.map((it) => (
              <li key={it.id} className="group flex items-center gap-2 text-[12.5px] text-white/80">
                <span className="w-[3px] h-4 rounded-full shrink-0" style={{ backgroundColor: it.spine }} />
                <span className="truncate flex-1">{it.title}</span>
                <button
                  onClick={() => removeItem(it)}
                  className="p-0.5 rounded text-white/0 group-hover:text-white/50 hover:!text-white transition-colors"
                  title="Take off the shelf"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const addRow = (kind: 'library' | 'practice', label: string) =>
    adding === kind ? (
      <div className="flex items-center gap-2 mt-2">
        <input
          autoFocus
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSection(kind);
            if (e.key === 'Escape') { setAdding(null); setNewTitle(''); }
          }}
          placeholder={kind === 'practice' ? 'e.g. Defamation' : 'e.g. CLE Presentations'}
          className="flex-1 bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] rounded-md px-2.5 py-1.5 text-[12.5px] text-white outline-none focus:border-[#e8b84a]"
        />
        <button onClick={() => addSection(kind)} className="text-[12px] text-[#e8b84a] px-2 py-1">Add</button>
      </div>
    ) : (
      <button
        onClick={() => { setAdding(kind); setNewTitle(''); }}
        className="flex items-center gap-1.5 mt-2 text-[12px] text-white/40 hover:text-[#e8b84a] transition-colors"
      >
        <Plus size={13} /> {label}
      </button>
    );

  return (
    <div className="max-w-5xl mx-auto px-8 py-12">
      <div className="flex items-center gap-3">
        <Landmark size={22} className="text-[#e8b84a]" strokeWidth={1.5} />
        <h1 className="font-display text-[28px] tracking-tight text-white">The Office</h1>
      </div>
      <p className="text-[13px] text-white/45 mt-1.5">
        The public face of your workspace. Drag a document from the vault onto a shelf or a practice
        area and it appears — display-only — in your walkable office. The file itself never leaves
        Contextspaces.{' '}
        <a href="/api/office" target="_blank" rel="noopener" className="text-white/60 hover:text-[#e8b84a] inline-flex items-center gap-0.5">
          public manifest <ExternalLink size={11} />
        </a>
      </p>

      {notice && (
        <div className="mt-4 text-[12.5px] text-[#e8b84a] border border-[rgba(232,184,74,0.35)] bg-[rgba(232,184,74,0.07)] rounded-lg px-3.5 py-2">
          {notice}
        </div>
      )}

      {!loading && sections.length === 0 && (
        <button
          onClick={seedStarter}
          className="mt-6 rounded-xl border border-dashed border-[rgba(255,255,255,0.2)] px-5 py-4 text-[13px] text-white/60 hover:text-white hover:border-[#e8b84a] transition-colors"
        >
          Set up the starter sections — CLE Presentations, From the Vault, Commercial Litigation
        </button>
      )}

      <div className="grid grid-cols-[minmax(260px,1fr)_minmax(340px,1.4fr)] gap-8 mt-8">
        {/* ---- the vault (drag source) ---- */}
        <div>
          <h2 className="text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-2">The Vault</h2>
          <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[rgba(8,8,14,0.8)] px-2 py-2 max-h-[70vh] overflow-y-auto">
            {matters.length === 0 && (
              <div className="text-[12px] text-white/30 italic px-2 py-1.5">No matters visible.</div>
            )}
            {matters.map((m) => (
              <div key={m.id}>
                <button
                  onClick={() => toggleMatter(m.id)}
                  className="flex items-center gap-1.5 w-full text-left px-2 py-1.5 rounded-md text-[12.5px] text-white/80 hover:bg-[rgba(255,255,255,0.04)]"
                >
                  {openMatters[m.id] ? <ChevronDown size={13} className="shrink-0 text-white/40" /> : <ChevronRight size={13} className="shrink-0 text-white/40" />}
                  <span className="truncate">{m.name}</span>
                </button>
                {openMatters[m.id] && (
                  <ul className="ml-5 mb-1">
                    {(docsByMatter[m.id] ?? []).map((d) => (
                      <li
                        key={d.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/x-cs-vault-file',
                            JSON.stringify({ docId: d.id, fromMatterId: m.id }),
                          );
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        className="px-2 py-1 rounded text-[12px] text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.04)] cursor-grab active:cursor-grabbing truncate"
                        title={d.title}
                      >
                        {d.title}
                      </li>
                    ))}
                    {docsByMatter[m.id] && docsByMatter[m.id].length === 0 && (
                      <li className="px-2 py-1 text-[11.5px] text-white/25 italic">No documents.</li>
                    )}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ---- the office (drop targets), mirroring the public menu ---- */}
        <div className="space-y-7">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <BookOpen size={13} className="text-[#e8b84a]" />
              <h2 className="text-[11px] font-semibold text-white/60 uppercase tracking-wider">The Library</h2>
            </div>
            <div className="space-y-2.5">{librarySections.map(sectionCard)}</div>
            {addRow('library', 'Add a shelf')}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Scale size={13} className="text-[#e8b84a]" />
              <h2 className="text-[11px] font-semibold text-white/60 uppercase tracking-wider">Areas of Practice</h2>
            </div>
            <div className="space-y-2.5">{practiceSections.map(sectionCard)}</div>
            {addRow('practice', 'Add a practice area')}
          </div>
        </div>
      </div>
    </div>
  );
}
