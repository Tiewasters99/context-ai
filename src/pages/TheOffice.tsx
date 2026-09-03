import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Landmark, Plus, X, BookOpen, Scale, ChevronRight, ChevronDown,
  ExternalLink, Folder, Users, Lock, FileText, DoorOpen, Image as JacketIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { canCaptureCover, captureOfficeImages } from '@/lib/office-cover';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import FullscreenToggle from '@/components/ui/FullscreenToggle';

// The Office — the back office of the firm's public room.
//
// The public-facing Office (a walkable photoreal office, served from
// /office/ on this same domain) shows a Library of book spines and a set of
// Practice Areas. THIS page is where those get filled: the vault on the
// left — the same serverspace → matter → sub-matter tree as everywhere
// else in the app — and the office's sections on the right. Drag a document
// across and it is published. Metadata and an excerpt travel; the file
// itself never leaves the vault (one-way glass — the office can show a book
// the way a physical library does, but nothing can be carried out).
//
// Data: office_sections / office_items (migration 050, owner-only RLS).
// The public reads exclusively through GET /api/office (service role,
// published rows, excerpts only; ?book= serves one item's text pages).
// The more you fill your Contextspaces, the richer your office.
//
// Drag protocol: the same custom MIME the Vault uses for document rows
// ('application/x-cs-vault-file', payload { docId, fromMatterId }) so any
// future vault surface can drop straight onto an office section too.
//
// Every card here is draggable and resizable (house rule): the whole card
// drags from any non-interactive spot, edges resize, right-click pins,
// and the header strip is the visible affordance.

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
interface DocRow {
  id: string;
  title: string;
  author: string | null;
}

const SPINES = ['#7a2530', '#243a52', '#39505f', '#8a6d2a', '#2e5a50', '#5a4a6e', '#6e4a2e', '#3a5a6e', '#742d2d', '#2e6b64'];
const spineFor = (title: string) =>
  SPINES[Array.from(title).reduce((a, c) => a + c.charCodeAt(0), 0) % SPINES.length];

// ---------------------------------------------------------------------------
// The vault picker — the exact tree the sidebar and the Vault page render:
// serverspaces in created order, matters nested by parent_matterspace_id,
// alphabetical at every level (buildMatterTree). Expanding a matter lists
// its documents; documents drag onto shelves and click open in the reader.
// Sealed matters (own tier or any ancestor B/C) show the lock and their
// papers don't drag out — the seal is a hard contract; unseal to publish.
// ---------------------------------------------------------------------------

function OfficeMatterNode({
  node,
  sealedAbove,
  expandedMatters,
  toggleMatter,
  docsByMatter,
  onOpenDoc,
}: {
  node: MatterTreeNode;
  sealedAbove: boolean;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  docsByMatter: Record<string, DocRow[] | 'loading'>;
  onOpenDoc: (docId: string) => void;
}) {
  const { matter, children } = node;
  const sealed = sealedAbove || matter.ai_tier !== 'A';
  const isExpanded = expandedMatters.has(matter.id);
  const docs = docsByMatter[matter.id];

  return (
    <div>
      <button
        onClick={() => toggleMatter(matter.id)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-[12px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors min-w-0"
        title={sealed ? `${matter.name} — sealed; its papers stay inside` : matter.name}
      >
        <span className="text-[#e8b84a]/80 w-3 shrink-0">
          {isExpanded ? <ChevronDown size={11} strokeWidth={2.5} /> : <ChevronRight size={11} strokeWidth={2.5} />}
        </span>
        <Folder size={11} className="shrink-0 text-[#d4a054]" strokeWidth={1.75} />
        <span className="truncate">{matter.name}</span>
        {sealed && <Lock size={10} className="shrink-0 text-white/35 ml-auto" strokeWidth={2} />}
      </button>
      {isExpanded && (
        <div className="ml-3 pl-2 border-l border-[rgba(255,255,255,0.06)] mt-0.5">
          {children.map((child) => (
            <OfficeMatterNode
              key={child.matter.id}
              node={child}
              sealedAbove={sealed}
              expandedMatters={expandedMatters}
              toggleMatter={toggleMatter}
              docsByMatter={docsByMatter}
              onOpenDoc={onOpenDoc}
            />
          ))}
          {docs === 'loading' && (
            <div className="px-2 py-1 text-[11px] text-white/30 italic">Opening the drawer…</div>
          )}
          {Array.isArray(docs) && docs.map((d) => (
            <button
              key={d.id}
              draggable={!sealed}
              onDragStart={sealed ? undefined : (e) => {
                e.dataTransfer.setData(
                  'application/x-cs-vault-file',
                  JSON.stringify({ docId: d.id, fromMatterId: matter.id }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onOpenDoc(d.id)}
              className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-[12px] text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors min-w-0 ${
                sealed ? '' : 'cursor-grab active:cursor-grabbing'
              }`}
              title={sealed
                ? `${d.title} — sealed matter: read it here, nothing leaves`
                : `${d.title} — drag onto a shelf to publish, click to open in the reader`}
            >
              <FileText size={11} className="shrink-0 text-white/35" strokeWidth={1.75} />
              <span className="truncate">{d.title}</span>
            </button>
          ))}
          {Array.isArray(docs) && docs.length === 0 && children.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-white/25 italic">No documents.</div>
          )}
        </div>
      )}
    </div>
  );
}

function VaultCard({ onOpenDoc }: { onOpenDoc: (docId: string) => void }) {
  const { cardRef, toggleFullscreen, isMobile } = useDraggableResizable(
    'cs.office.card.vault',
    { boundToViewport: true },
  );
  const { data: serverspaces = [] } = useServerspaces();
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [docsByMatter, setDocsByMatter] = useState<Record<string, DocRow[] | 'loading'>>({});

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleMatter = (id: string) => {
    toggle(setExpandedMatters, id);
    setDocsByMatter((d) => {
      if (d[id]) return d;
      supabase
        .from('documents')
        .select('id, title, author')
        .eq('matterspace_id', id)
        .order('title')
        .limit(300)
        .then(({ data }) =>
          setDocsByMatter((prev) => ({ ...prev, [id]: (data ?? []) as DocRow[] })),
        );
      return { ...d, [id]: 'loading' };
    });
  };

  return (
    <div
      ref={cardRef}
      className="rounded-xl border border-[rgba(255,255,255,0.08)] cursor-grab select-none"
      style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
    >
      {/* ribbon — the visible drag strip */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 pt-3 pb-2.5 rounded-t-xl border-b border-[rgba(255,255,255,0.07)] bg-[rgba(12,12,20,0.95)] backdrop-blur-[20px]">
        <span className="text-[11px] font-semibold text-white/70 uppercase tracking-wider">The Vault</span>
        {!isMobile && <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move — resize from any edge" />}
        {!isMobile && <FullscreenToggle onToggle={toggleFullscreen} />}
      </div>
      <div className="px-2 py-2">
        {serverspaces.length === 0 && (
          <div className="text-[12px] text-white/30 italic px-2 py-1.5">Loading the vault…</div>
        )}
        {serverspaces.map((server) => {
          const isExpanded = expandedServers.has(server.id);
          const tree = buildMatterTree(server.matterspaces);
          return (
            <div key={server.id}>
              <button
                onClick={() => toggle(setExpandedServers, server.id)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-[12.5px] text-white/85 hover:bg-[rgba(255,255,255,0.04)] transition-colors min-w-0"
              >
                <span className="text-[#e8b84a]/80 w-3 shrink-0">
                  {isExpanded ? <ChevronDown size={11} strokeWidth={2.5} /> : <ChevronRight size={11} strokeWidth={2.5} />}
                </span>
                <Users size={12} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
                <span className="truncate">{server.name}</span>
              </button>
              {isExpanded && (
                <div className="ml-3 pl-2 border-l border-[rgba(255,255,255,0.06)] mt-0.5 mb-1">
                  {tree.length === 0 && (
                    <div className="px-2 py-1 text-[11px] text-white/25 italic">No matters.</div>
                  )}
                  {tree.map((node) => (
                    <OfficeMatterNode
                      key={node.matter.id}
                      node={node}
                      sealedAbove={false}
                      expandedMatters={expandedMatters}
                      toggleMatter={toggleMatter}
                      docsByMatter={docsByMatter}
                      onOpenDoc={onOpenDoc}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A section card — one shelf or practice area. A drop target for vault
// documents; its items click open in the reader; the card itself drags,
// resizes, pins, and goes full screen like every other card in the app.
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  items,
  onDropDoc,
  onRemoveSection,
  onRemoveItem,
  onCaptureCover,
  onOpenDoc,
}: {
  section: OfficeSection;
  items: OfficeItem[];
  onDropDoc: (docId: string, section: OfficeSection) => void;
  onRemoveSection: (s: OfficeSection) => void;
  onRemoveItem: (it: OfficeItem) => void;
  onCaptureCover: (it: OfficeItem) => void;
  onOpenDoc: (docId: string) => void;
}) {
  const { cardRef, toggleFullscreen, isMobile } = useDraggableResizable(
    `cs.office.card.section.${section.id}`,
  );
  const [hover, setHover] = useState(false);

  return (
    <div
      ref={cardRef}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-cs-vault-file')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        try {
          const raw = e.dataTransfer.getData('application/x-cs-vault-file');
          if (!raw) return;
          const { docId } = JSON.parse(raw) as { docId: string };
          if (docId) onDropDoc(docId, section);
        } catch { /* not a vault drag */ }
      }}
      className={`rounded-xl border cursor-grab select-none transition-colors ${
        hover
          ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.06)]'
          : 'border-[rgba(255,255,255,0.08)]'
      }`}
      style={hover ? undefined : { backgroundColor: 'rgba(8,8,14,0.8)' }}
    >
      {/* ribbon — the visible drag strip */}
      <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-2 rounded-t-xl border-b border-[rgba(255,255,255,0.07)] bg-[rgba(12,12,20,0.92)]">
        <span className="text-[13px] font-semibold text-white truncate">{section.title}</span>
        {!isMobile && <div className="w-8 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors shrink-0" title="Drag to move — resize from any edge" />}
        <div className="flex items-center gap-0.5 shrink-0">
          {!isMobile && <FullscreenToggle onToggle={toggleFullscreen} />}
          <button
            onClick={() => onRemoveSection(section)}
            className="p-1 rounded text-white/25 hover:text-white/70 transition-colors"
            title="Remove section"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="px-4 py-2.5">
        {items.length === 0 ? (
          <div className="text-[11.5px] text-white/30 italic">Drag a document here to show it.</div>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.id} className="group flex items-center gap-2 text-[12.5px] text-white/80 min-w-0">
                <span className="w-[3px] h-4 rounded-full shrink-0" style={{ backgroundColor: it.spine }} />
                {/* span, not button: the card's drag machinery ignores spans,
                    so the title stays clickable without fighting the drag */}
                <span
                  onClick={() => it.document_id && onOpenDoc(it.document_id)}
                  className={`truncate flex-1 ${
                    it.document_id ? 'cursor-pointer hover:text-[#e8b84a] transition-colors' : ''
                  }`}
                  title={it.document_id ? 'Open in the reader' : 'The stored document is gone; only the listing remains'}
                >
                  {it.title}
                </span>
                {it.document_id && (
                  <button
                    onClick={() => onCaptureCover(it)}
                    className="p-0.5 rounded text-white/0 group-hover:text-white/50 hover:!text-white transition-colors"
                    title="Capture the jacket — page one of the PDF — and every page when it is a deck, for the office's Reader"
                  >
                    <JacketIcon size={12} />
                  </button>
                )}
                <button
                  onClick={() => onRemoveItem(it)}
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
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function TheOffice() {
  const navigate = useNavigate();
  const [sections, setSections] = useState<OfficeSection[]>([]);
  const [items, setItems] = useState<OfficeItem[]>([]);
  const [adding, setAdding] = useState<'library' | 'practice' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const say = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  const openDoc = useCallback(
    (docId: string) => navigate(`/app/document/${docId}`),
    [navigate],
  );

  const refresh = useCallback(async () => {
    const [s, i] = await Promise.all([
      supabase.from('office_sections').select('id, kind, title, blurb, sort_order').order('sort_order').order('created_at'),
      supabase.from('office_items').select('id, section_id, document_id, title, author, excerpt, spine, published').order('sort_order').order('created_at'),
    ]);
    if (s.error) say(`Could not load sections: ${s.error.message}`);
    else setSections((s.data ?? []) as OfficeSection[]);
    if (i.error) say(`Could not load items: ${i.error.message}`);
    else setItems((i.data ?? []) as OfficeItem[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  // The jacket: page one of the item's PDF, captured into the public cover
  // bucket so the office's Reader can open the book on its real cover. The
  // only image the one-way glass lets through; a Word file or a deck has
  // no page one to show and keeps the library's plate.
  const captureCover = async (it: OfficeItem, quiet = false) => {
    if (!it.document_id) return;
    const { data: doc } = await supabase
      .from('documents')
      .select('storage_path, source_filename')
      .eq('id', it.document_id)
      .single();
    if (!doc?.storage_path) { if (!quiet) say('The stored file could not be found.'); return; }
    if (!canCaptureCover(doc.source_filename)) {
      if (!quiet) say(`"${it.title}" is not a PDF — only a PDF has a page one to show as a jacket.`);
      return;
    }
    try {
      say(`Capturing the jacket for "${it.title}"…`);
      const got = await captureOfficeImages(it.id, doc.storage_path, doc.source_filename, (done, total) => {
        say(`Capturing the pages of "${it.title}"… ${done} of ${total}`);
      });
      say(got.pages
        ? `"${it.title}" shows its jacket and all ${got.pages} pages in the office now.`
        : `"${it.title}" wears its jacket in the office now.`);
    } catch (e) {
      say(e instanceof Error ? e.message : 'The jacket could not be captured.');
    }
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
    const { data: row, error } = await supabase
      .from('office_items')
      .insert({
        section_id: section.id,
        document_id: docId,
        title: doc.title,
        author: doc.author ?? '',
        excerpt,
        spine: spineFor(doc.title),
      })
      .select('id')
      .single();
    if (error) { say(error.message); return; }
    say(`"${doc.title}" is now showing in ${section.title}.`);
    refresh();
    // The jacket follows on its own; a book that has none keeps its plate.
    if (row?.id) {
      void captureCover({ id: row.id, section_id: section.id, document_id: docId, title: doc.title } as OfficeItem, true);
    }
  };

  const seedStarter = async () => {
    const { error } = await supabase.from('office_sections').insert([
      { kind: 'library', title: 'CLE Presentations', blurb: "The firm's continuing-legal-education work.", sort_order: 0 },
      { kind: 'library', title: 'From the Vault', blurb: 'Papers the firm is willing to show.', sort_order: 1 },
      // In a multi-row insert PostgREST fills missing keys with null (not the
      // column default), so every row must carry blurb explicitly.
      { kind: 'practice', title: 'Commercial Litigation', blurb: '', sort_order: 0 },
    ]);
    if (error) { say(error.message); return; }
    refresh();
  };

  const librarySections = sections.filter((s) => s.kind === 'library' || s.kind === 'cle');
  const practiceSections = sections.filter((s) => s.kind === 'practice');

  const sectionCard = (s: OfficeSection) => (
    <SectionCard
      key={s.id}
      section={s}
      items={items.filter((it) => it.section_id === s.id)}
      onDropDoc={publishDoc}
      onRemoveSection={removeSection}
      onRemoveItem={removeItem}
      onCaptureCover={(it) => void captureCover(it)}
      onOpenDoc={openDoc}
    />
  );

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
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <Landmark size={22} className="text-[#e8b84a]" strokeWidth={1.5} />
            <h1 className="font-display text-[28px] tracking-tight text-white">The Office</h1>
          </div>
          <p className="text-[13px] text-white/45 mt-1.5 max-w-xl">
            The public face of your workspace. Drag a document from the vault onto a shelf or a
            practice area and it appears — display-only — in your walkable office. The file itself
            never leaves Contextspaces.{' '}
            <a href="/api/office" target="_blank" rel="noopener" className="text-white/60 hover:text-[#e8b84a] inline-flex items-center gap-0.5">
              public manifest <ExternalLink size={11} />
            </a>
          </p>
        </div>
        {/* the front door: this back office publishes THERE */}
        <a
          href="/office/"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 rounded-lg bg-[#e8b84a] px-4 py-2.5 text-[13px] font-semibold text-[#16120a] hover:bg-[#f5d178] transition-colors shrink-0"
          title="Open the client-facing office — what visitors see"
        >
          <DoorOpen size={16} strokeWidth={2} /> Step into the office
        </a>
      </div>

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

      <div className="grid grid-cols-[minmax(260px,1fr)_minmax(340px,1.4fr)] gap-8 mt-8 items-start">
        {/* ---- the vault (drag source) ---- */}
        <div>
          <h2 className="text-[11px] font-semibold text-white/60 uppercase tracking-wider mb-2">The Vault</h2>
          <VaultCard onOpenDoc={openDoc} />
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
