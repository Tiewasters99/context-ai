// Marginalia — the reader's side margins as a quiet annotation layer.
//
// Design contract (2026-08-14 margin-notes conversation):
//   * The margin's resting state never changes. An unannotated page looks
//     exactly like it did before; notes collapse to small marks.
//   * Right rail = notes anchored on this page. Left rail = cross-reference
//     marks (a note in another document cites this page) — these fall out
//     of the annotation_links graph, they are not a separate feature.
//   * Private notes ("just me") render dimmer than team notes.
//   * On phones the rails shrink to a slim gutter and cards become bottom
//     sheets (the drag/resize house pattern intentionally doesn't apply —
//     these are anchored popovers, not floating panels).

import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownRight, FileText, Link2, Loader2, Lock, Search, Trash2, Users, X } from 'lucide-react';
import { useDocumentSearch, type DocumentHit } from '@/hooks/useDocumentSearch';
import { sandboxApi } from '@/lib/sandbox-api';
import {
  annotationAuthorName as displayName,
  formatNoteCite,
  type Annotation,
  type AnnotationLink,
  type AnnotationVisibility,
  type IncomingLink,
} from '@/lib/document-annotations';

export const NOTE_RAIL_W = 36;
export const NOTE_RAIL_W_MOBILE = 16;

const BRASS = '#d4a054';
const BRASS_BRIGHT = '#e8b84a';

function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Nudge marks apart when two anchors share (nearly) the same line so the
// rail reads as a column of distinct ticks, not a blot.
function spreadPositions(ys: number[], minGap = 0.016): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  const out: number[] = new Array(ys.length);
  for (const { y, i } of order) {
    const pos = Math.max(y, prev + minGap);
    out[i] = Math.min(pos, 0.99);
    prev = out[i];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Rails
// ─────────────────────────────────────────────────────────────────────────

export function NotesRail({
  notes,
  currentUserId,
  isMobile,
  onOpen,
}: {
  notes: Annotation[];
  currentUserId: string | null;
  isMobile: boolean;
  onOpen: (note: Annotation, anchor: { x: number; y: number }) => void;
}) {
  const positions = useMemo(
    () => spreadPositions(notes.map((n) => n.rects[0]?.y ?? 0)),
    [notes],
  );
  return (
    <div
      className="relative shrink-0 self-stretch"
      style={{ width: isMobile ? NOTE_RAIL_W_MOBILE : NOTE_RAIL_W }}
    >
      {notes.map((n, i) => {
        const mine = n.user_id === currentUserId;
        const priv = n.visibility === 'private';
        return (
          <button
            key={n.id}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpen(n, { x: r.right, y: r.top + r.height / 2 });
            }}
            className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center group"
            style={{ top: `${positions[i] * 100}%`, width: 24, height: 18 }}
            title={(priv ? 'Note to self — ' : `${displayName(n.author)} — `) + (n.note ?? '').slice(0, 120)}
            aria-label={mine ? 'Your margin note' : `Margin note by ${displayName(n.author)}`}
          >
            <span
              className="rounded-full transition-all group-hover:w-5"
              style={{
                width: 14,
                height: 2.5,
                backgroundColor: priv
                  ? 'rgba(255,255,255,0.32)'
                  : `${BRASS}99`,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

export function CrossRefRail({
  refs,
  isMobile,
  onOpen,
}: {
  refs: IncomingLink[];
  isMobile: boolean;
  onOpen: (ref: IncomingLink, anchor: { x: number; y: number }) => void;
}) {
  return (
    <div
      className="relative shrink-0 self-stretch"
      style={{ width: isMobile ? NOTE_RAIL_W_MOBILE : NOTE_RAIL_W }}
    >
      {refs.map((r, i) => (
        <button
          key={r.id}
          onClick={(e) => {
            const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpen(r, { x: el.left, y: el.top + el.height / 2 });
          }}
          className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center group"
          style={{ top: 18 + i * 22, width: 24, height: 18 }}
          title={`Cited by a note in ${r.annotation?.document?.title ?? 'another document'}`}
          aria-label="Cross-reference: a note elsewhere cites this page"
        >
          <span
            className="block rotate-45 transition-colors group-hover:border-[#e8b84a]"
            style={{
              width: 7,
              height: 7,
              border: `1.5px solid ${BRASS}80`,
              borderRadius: 1,
            }}
          />
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Cards — fixed-position popovers on desktop, bottom sheets on phones.
// ─────────────────────────────────────────────────────────────────────────

function cardPosition(
  anchor: { x: number; y: number },
  isMobile: boolean,
  width = 320,
  estHeight = 340,
): React.CSSProperties {
  if (isMobile) {
    // Capped so the card cannot run off the top of a phone with the keyboard
    // up (the composer with its picker open is the tall case); it scrolls.
    return { position: 'fixed', left: 8, right: 8, bottom: 60, zIndex: 70, maxHeight: '70vh', overflowY: 'auto' };
  }
  const left = Math.min(Math.max(anchor.x + 10, 8), window.innerWidth - width - 8);
  const top = Math.min(Math.max(anchor.y - 40, 8), window.innerHeight - estHeight - 8);
  return { position: 'fixed', left, top, width, zIndex: 70 };
}

function useDismiss(onClose: () => void, ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, ref]);
}

const CARD_SHELL =
  'flex flex-col rounded-xl border border-white/15 shadow-2xl backdrop-blur-[30px] overflow-hidden';
const CARD_BG = { backgroundColor: 'rgba(10,10,16,0.92)' };

export function NoteCard({
  note,
  anchor,
  isMobile,
  isAuthor,
  onClose,
  onDelete,
  onSaveEdit,
  onOpenLink,
}: {
  note: Annotation;
  anchor: { x: number; y: number };
  isMobile: boolean;
  isAuthor: boolean;
  onClose: () => void;
  onDelete: () => void;
  onSaveEdit: (body: string, visibility: AnnotationVisibility) => void;
  onOpenLink: (link: AnnotationLink) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.note ?? '');
  const [visibility, setVisibility] = useState<AnnotationVisibility>(note.visibility);
  useDismiss(onClose, ref);
  const priv = note.visibility === 'private';

  return (
    <div ref={ref} className={CARD_SHELL} style={{ ...CARD_BG, ...cardPosition(anchor, isMobile) }}>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="text-[12px] font-medium text-white/85 truncate">
          {priv && isAuthor ? 'Note to self' : displayName(note.author)}
        </span>
        <span className="text-[11px] text-white/35 shrink-0">{relativeTime(note.created_at)}</span>
        {priv && (
          <span className="inline-flex items-center gap-1 text-[10px] text-white/40 shrink-0">
            <Lock size={10} /> just me
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-white/40 tabular-nums shrink-0">
          {/* A note on a document without pages has no page to cite. */}
          {note.text_anchor ? null : formatNoteCite(note.page, note.line_start, note.line_end)}
        </span>
        <button
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/55 hover:text-white shrink-0"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>

      {note.anchor_text && (
        <blockquote
          className="mx-3.5 mb-2 pl-2.5 border-l-2 text-[12px] italic text-white/55 leading-snug max-h-16 overflow-hidden"
          style={{ borderColor: `${BRASS}66` }}
        >
          {note.anchor_text.length > 220 ? `${note.anchor_text.slice(0, 220)}…` : note.anchor_text}
        </blockquote>
      )}

      {editing ? (
        <div className="px-3.5 pb-3 flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            autoFocus
            className="w-full resize-none rounded-md bg-white/5 border border-white/10 px-2.5 py-2 text-[13px] text-white/90 outline-none focus:border-[rgba(212,160,84,0.5)]"
          />
          <div className="flex items-center gap-2">
            <VisibilityToggle value={visibility} onChange={setVisibility} />
            <span className="flex-1" />
            <button
              onClick={() => setEditing(false)}
              className="text-[12px] text-white/45 hover:text-white px-2 py-1"
            >
              Cancel
            </button>
            <button
              onClick={() => { onSaveEdit(body.trim(), visibility); setEditing(false); }}
              disabled={!body.trim()}
              className="text-[12px] px-2.5 py-1 rounded-md disabled:opacity-40"
              style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: BRASS_BRIGHT }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="px-3.5 pb-2.5 text-[13px] leading-relaxed text-white/90 whitespace-pre-wrap max-h-52 overflow-y-auto">
          {note.note}
        </p>
      )}

      {note.links.length > 0 && !editing && (
        <div className="px-3.5 pb-2.5 flex flex-col gap-1">
          {note.links.map((l) => (
            <button
              key={l.id}
              onClick={() => onOpenLink(l)}
              className="flex items-center gap-1.5 text-left text-[12px] text-white/65 hover:text-white group"
            >
              <Link2 size={11} className="shrink-0" style={{ color: `${BRASS}cc` }} />
              <span className="truncate group-hover:underline underline-offset-2">
                {linkChipText(l)}
              </span>
            </button>
          ))}
        </div>
      )}

      {isAuthor && !editing && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-t border-white/8">
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] text-white/45 hover:text-white px-1.5 py-1 rounded hover:bg-white/5"
          >
            Edit
          </button>
          <button
            onClick={() => {
              const next: AnnotationVisibility = priv ? 'matter' : 'private';
              onSaveEdit(note.note ?? '', next);
            }}
            className="inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white px-1.5 py-1 rounded hover:bg-white/5"
            title={priv ? 'Share with the matter team' : 'Make it a note to self'}
          >
            {priv ? <Users size={11} /> : <Lock size={11} />}
            {priv ? 'Share with team' : 'Make private'}
          </button>
          <span className="flex-1" />
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 text-[11px] text-white/25 hover:text-red-400 px-1.5 py-1 rounded hover:bg-white/5"
            title="Delete note"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

export function RefCard({
  refLink,
  anchor,
  isMobile,
  onClose,
  onOpenSource,
}: {
  refLink: IncomingLink;
  anchor: { x: number; y: number };
  isMobile: boolean;
  onClose: () => void;
  onOpenSource: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, ref);
  const ann = refLink.annotation;
  return (
    <div ref={ref} className={CARD_SHELL} style={{ ...CARD_BG, ...cardPosition(anchor, isMobile, 300, 220) }}>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        <CornerDownRight size={12} style={{ color: BRASS }} className="shrink-0" />
        <span className="text-[12px] text-white/85 truncate">
          Cited by a note in {ann?.document?.title ?? 'another document'}
        </span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/55 hover:text-white shrink-0"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>
      {ann?.note && (
        <p className="px-3.5 pb-2 text-[12px] leading-snug text-white/60 max-h-24 overflow-hidden">
          {ann.note.length > 180 ? `${ann.note.slice(0, 180)}…` : ann.note}
        </p>
      )}
      <div className="px-3.5 pb-3">
        <button
          onClick={onOpenSource}
          className="text-[12px] px-2.5 py-1 rounded-md"
          style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: BRASS_BRIGHT }}
        >
          Open the note{ann ? `, p. ${ann.page}` : ''}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────────

function VisibilityToggle({
  value,
  onChange,
}: {
  value: AnnotationVisibility;
  onChange: (v: AnnotationVisibility) => void;
}) {
  const priv = value === 'private';
  return (
    <div className="inline-flex rounded-md border border-white/10 overflow-hidden">
      <button
        onClick={() => onChange('matter')}
        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] transition-colors"
        style={
          !priv
            ? { backgroundColor: 'rgba(232,184,74,0.16)', color: BRASS_BRIGHT }
            : { color: 'rgba(255,255,255,0.45)' }
        }
        title="Visible to everyone on the matter"
      >
        <Users size={11} /> Team
      </button>
      <button
        onClick={() => onChange('private')}
        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] transition-colors"
        style={
          priv
            ? { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.85)' }
            : { color: 'rgba(255,255,255,0.45)' }
        }
        title="Note to self — only you see it"
      >
        <Lock size={11} /> Just me
      </button>
    </div>
  );
}

// What a saved link's chip says. A label is kept only when it says more
// than the title (a citation); otherwise the title read through the
// reader's own RLS, with the page and line the link opens on.
function linkChipText(l: AnnotationLink): string {
  const title = l.target?.title ?? null;
  if (l.label && l.label !== title) return l.label;
  const page = l.target_page ? `, p. ${l.target_page}${l.target_line ? `:${l.target_line}` : ''}` : '';
  return `${title ?? 'Linked document'}${page}`;
}

export type ComposerLink = {
  documentId: string;
  title: string;
  /** The PDF page the link opens (never a printed page number). */
  page: number | null;
  line: number | null;
  /**
   * What the chip on the saved note says. Null = the cited document's own
   * title, read through the reader's RLS at display time. A citation is kept
   * here only when the cited document sits in the same matter as the note,
   * so a note never carries another matter's text to a team that cannot open
   * that matter.
   */
  label: string | null;
  matterName: string | null;
  sealed: boolean;
};

// One hit of the Vault's passage search (lib/mcp-core.mjs handleSearch via
// /api/sandbox), reduced to what a link needs.
type PassageHit = {
  passage_id: string;
  document_id: string;
  document_title: string;
  citation: string;
  text?: string;
  text_preview?: string;
  matter?: { id: string; short_code: string | null; name: string };
  coordinates?: {
    page_start: number | null;
    page_end: number | null;
    line_start: number | null;
    line_end: number | null;
  };
  // `reader_page` is the PDF page that opens the file; a transcript's
  // citation may name the court reporter's printed page instead.
  page_basis?: { reader_page?: number | null };
};

function docHitName(h: DocumentHit): string {
  return h.source_filename || h.title || 'Untitled';
}

// The picker behind "Link a document": names of documents across every
// matter the person can open as they type (search_documents, cheap), and on
// Enter the passage search inside those documents (hybrid search, metered
// — so never on a keystroke). A link is a pointer; the document stays in its
// own matter.
function LinkPicker({
  matterId,
  currentDocumentId,
  onPick,
  onClose,
}: {
  matterId: string | null;
  currentDocumentId: string;
  onPick: (link: ComposerLink) => void;
  onClose: () => void;
}) {
  const docs = useDocumentSearch({ debounceMs: 180 });
  const [passages, setPassages] = useState<PassageHit[] | null>(null);
  const [passageQuery, setPassageQuery] = useState('');
  const [passageBusy, setPassageBusy] = useState(false);
  const [passageError, setPassageError] = useState<string | null>(null);
  const q = docs.query.trim();

  const searchInside = async () => {
    if (!q || passageBusy) return;
    setPassageBusy(true);
    setPassageError(null);
    setPassages(null);
    setPassageQuery(q);
    try {
      const out = await sandboxApi<{ results?: PassageHit[] }>('search', { q, limit: 8 });
      setPassages((out.results ?? []).filter((h) => h.document_id !== currentDocumentId));
    } catch (e) {
      setPassageError(e instanceof Error ? e.message : String(e));
      setPassages([]);
    } finally {
      setPassageBusy(false);
    }
  };

  const docHits = docs.hits.filter((h) => h.document_id !== currentDocumentId).slice(0, 6);
  const busy = docs.searching || passageBusy;
  const nothingNamed = q.length > 0 && !docs.searching && !docs.error && docHits.length === 0;
  const offerInside = q.length > 0 && !passageBusy && (passages === null || passageQuery !== q);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        {busy ? (
          <Loader2 size={12} className="absolute left-2 top-1/2 -translate-y-1/2 animate-spin" style={{ color: BRASS }} />
        ) : (
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/30" />
        )}
        <input
          value={docs.query}
          onChange={(e) => docs.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void searchInside();
            } else if (e.key === 'Escape') {
              // Shut the picker, not the whole note.
              e.stopPropagation();
              onClose();
            }
          }}
          autoFocus
          placeholder="A document's name, in any matter…"
          className="w-full rounded-md bg-white/5 border border-white/10 pl-7 pr-2.5 py-1.5 text-[12px] text-white/90 placeholder:text-white/25 outline-none focus:border-[rgba(212,160,84,0.5)]"
        />
      </div>

      {docs.error && <p className="text-[11px] text-red-400/90 px-1">{docs.error}</p>}
      {docs.prefixOnly && q.length > 0 && (
        <p className="text-[10px] text-white/35 px-1">Matching the start of names until three letters.</p>
      )}

      <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
        {docHits.map((h) => (
          <button
            key={h.document_id}
            onClick={() =>
              onPick({
                documentId: h.document_id,
                title: docHitName(h),
                page: null,
                line: null,
                label: null,
                matterName: h.matterspace_name,
                sealed: h.sealed,
              })
            }
            className="text-left px-1.5 py-1 rounded hover:bg-white/5 group min-w-0"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <FileText size={11} className="shrink-0" style={{ color: `${BRASS}cc` }} />
              <span className="truncate text-[12px] text-white/75 group-hover:text-white">{docHitName(h)}</span>
              {h.sealed && <Lock size={10} className="shrink-0 text-[#5aa88f]" aria-label="Sealed matter" />}
            </span>
            <span className="block pl-[17px] truncate text-[10px] text-white/40">
              {h.matterspace_name ?? 'Unknown matter'}
            </span>
          </button>
        ))}

        {nothingNamed && passages === null && (
          <p className="text-[11px] text-white/45 px-1 py-0.5">No document is named that.</p>
        )}

        {offerInside && (
          <button
            onClick={() => void searchInside()}
            className="text-left px-1.5 py-1 rounded hover:bg-white/5 text-[11px] text-white/55 hover:text-white inline-flex items-center gap-1.5"
          >
            <Search size={10} className="shrink-0" />
            <span className="truncate">Search inside documents for “{q}”</span>
            <span className="ml-auto shrink-0 text-[10px] text-white/30">Enter</span>
          </button>
        )}

        {passageError && <p className="text-[11px] text-red-400/90 px-1">{passageError}</p>}
        {passages && passages.length === 0 && !passageError && (
          <p className="text-[11px] text-white/45 px-1 py-0.5">No passage matched “{passageQuery}”.</p>
        )}
        {passages?.map((h) => {
          const page = h.page_basis?.reader_page ?? h.coordinates?.page_start ?? null;
          const line = h.coordinates?.line_start ?? null;
          const sameMatter = !!matterId && h.matter?.id === matterId;
          return (
            <button
              key={h.passage_id}
              onClick={() =>
                onPick({
                  documentId: h.document_id,
                  title: h.document_title,
                  page,
                  line,
                  label: sameMatter ? h.citation : null,
                  matterName: h.matter?.name ?? null,
                  sealed: false,
                })
              }
              className="text-left px-1.5 py-1 rounded hover:bg-white/5 group min-w-0"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-[12px] font-medium" style={{ color: BRASS_BRIGHT }}>
                  {h.citation}
                </span>
                {h.matter && (
                  <span className="ml-auto shrink-0 text-[10px] text-white/40 bg-white/5 rounded-full px-1.5 py-px truncate max-w-[40%]">
                    {h.matter.name}
                  </span>
                )}
              </span>
              <span className="block text-[11px] text-white/50 leading-snug line-clamp-2">
                {(h.text_preview ?? h.text ?? '').slice(0, 200)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NoteComposer({
  anchor,
  quote,
  matterId,
  currentDocumentId,
  isMobile,
  onSave,
  onCancel,
}: {
  anchor: { x: number; y: number };
  quote: string;
  matterId: string | null;
  currentDocumentId: string;
  isMobile: boolean;
  /**
   * Saves the note and its links. Resolves to the titles of links that could
   * not be saved (the note itself is kept); the composer then says so instead
   * of closing. An empty list or nothing = all saved, and the host closes it.
   */
  onSave: (args: {
    body: string;
    visibility: AnnotationVisibility;
    links: ComposerLink[];
  }) => Promise<string[] | void> | void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<AnnotationVisibility>('matter');
  const [links, setLinks] = useState<ComposerLink[]>([]);
  const [linking, setLinking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string[] | null>(null);
  useDismiss(onCancel, ref);

  const canSave = body.trim().length > 0 && !saving && !failed;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const out = await onSave({ body: body.trim(), visibility, links });
    if (out && out.length > 0) {
      setFailed(out);
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className={CARD_SHELL} style={{ ...CARD_BG, ...cardPosition(anchor, isMobile, 340, 320) }}>
      <div className="px-3.5 pt-3 pb-1.5">
        <span className="text-[11px] uppercase tracking-[0.08em] text-white/35">Margin note</span>
      </div>
      {quote && (
        <blockquote
          className="mx-3.5 mb-2 pl-2.5 border-l-2 text-[12px] italic text-white/55 leading-snug max-h-12 overflow-hidden"
          style={{ borderColor: `${BRASS}66` }}
        >
          {quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}
        </blockquote>
      )}
      <div className="px-3.5 flex flex-col gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save();
          }}
          rows={3}
          autoFocus
          disabled={!!failed}
          placeholder="Seems contradictory with…"
          className="w-full resize-none rounded-md bg-white/5 border border-white/10 px-2.5 py-2 text-[13px] text-white/90 placeholder:text-white/25 outline-none focus:border-[rgba(212,160,84,0.5)] disabled:opacity-60"
        />

        {links.length > 0 && (
          <div className="flex flex-col gap-1">
            {links.map((l, i) => (
              <div key={`${l.documentId}-${i}`} className="flex items-center gap-1.5 text-[12px] text-white/70 min-w-0">
                <Link2 size={11} className="shrink-0" style={{ color: `${BRASS}cc` }} />
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="truncate">
                    {l.label ?? l.title}
                    {l.sealed && <Lock size={10} className="inline ml-1 text-[#5aa88f]" aria-label="Sealed matter" />}
                  </span>
                  {l.matterName && <span className="truncate text-[10px] text-white/40">{l.matterName}</span>}
                </span>
                <input
                  type="number"
                  min={1}
                  placeholder="p."
                  value={l.page ?? ''}
                  disabled={!!failed}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setLinks((prev) => prev.map((x, xi) => (xi === i ? { ...x, page: v } : x)));
                  }}
                  className="w-12 rounded bg-white/5 border border-white/10 px-1 py-0.5 text-[11px] text-white/80 outline-none"
                  title="PDF page in the linked document (optional)"
                />
                {l.line != null && <span className="text-[11px] text-white/45 shrink-0">:{l.line}</span>}
                {!failed && (
                  <button
                    onClick={() => setLinks((prev) => prev.filter((_, xi) => xi !== i))}
                    className="text-white/30 hover:text-white"
                    title="Remove link"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {failed ? (
          <p className="text-[11px] leading-snug text-amber-300/90">
            The note is saved. {failed.length === 1 ? 'One link' : `${failed.length} links`} could not be saved:{' '}
            {failed.join(', ')}.
          </p>
        ) : linking ? (
          <LinkPicker
            matterId={matterId}
            currentDocumentId={currentDocumentId}
            onPick={(link) => {
              setLinks((prev) => [...prev, link]);
              setLinking(false);
            }}
            onClose={() => setLinking(false)}
          />
        ) : (
          <button
            onClick={() => setLinking(true)}
            className="self-start inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-white/80"
          >
            <Link2 size={11} /> Link a document
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5 mt-1 border-t border-white/8">
        {!failed && <VisibilityToggle value={visibility} onChange={setVisibility} />}
        <span className="flex-1" />
        {failed ? (
          <button
            onClick={onCancel}
            className="text-[12px] px-3 py-1 rounded-md"
            style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: BRASS_BRIGHT }}
          >
            Close
          </button>
        ) : (
          <>
            <button onClick={onCancel} className="text-[12px] text-white/45 hover:text-white px-2 py-1">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={!canSave}
              className="text-[12px] px-3 py-1 rounded-md disabled:opacity-40"
              style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: BRASS_BRIGHT }}
            >
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
