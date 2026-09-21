import { useState } from 'react';
import { FileText, List, Film, Plus, Trash2 } from 'lucide-react';
import type { DocumentAnimation } from '@/lib/document-animations';

// Tree node returned by pdfjs `pdf.getOutline()`. The shape is flexible —
// pdfjs may include extra properties we don't need.
export type OutlineNode = {
  title: string;
  dest: unknown;
  items: OutlineNode[];
};

type Props = {
  totalPages: number;
  currentPage: number;
  thumbnails: (string | null)[];
  outline: OutlineNode[] | null;
  onJumpPage: (page: number) => void;
  onJumpDest: (dest: unknown) => void;
  /** Clips attached to pages of this document — the living illustrations. */
  animations: DocumentAnimation[];
  /** Arms "draw a rectangle round the picture"; null when adding isn't possible. */
  onAddAnimation: (() => void) | null;
  onRemoveAnimation: (id: string) => void;
  /** True while the reader is waiting for that rectangle. */
  addingAnimation: boolean;
};

type Tab = 'pages' | 'contents' | 'animations';

export default function ReaderSidebar({
  totalPages,
  currentPage,
  thumbnails,
  outline,
  onJumpPage,
  onJumpDest,
  animations,
  onAddAnimation,
  onRemoveAnimation,
  addingAnimation,
}: Props) {
  const hasOutline = !!outline && outline.length > 0;
  const [tab, setTab] = useState<Tab>('pages');

  return (
    <aside
      className="w-60 shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md"
    >
      <div className="flex items-center gap-1 px-2 h-9 border-b border-[var(--color-border)] shrink-0">
        <SidebarTab
          active={tab === 'pages'}
          onClick={() => setTab('pages')}
          icon={<List size={13} />}
          label="Pages"
        />
        <SidebarTab
          active={tab === 'contents'}
          onClick={() => setTab('contents')}
          icon={<FileText size={13} />}
          label="Contents"
          disabled={!hasOutline}
        />
        <SidebarTab
          active={tab === 'animations'}
          onClick={() => setTab('animations')}
          icon={<Film size={13} />}
          label="Animations"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'pages' && (
          <div className="p-2 space-y-2">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
              const thumb = thumbnails[p - 1];
              const isCurrent = p === currentPage;
              return (
                <button
                  key={p}
                  onClick={() => onJumpPage(p)}
                  className={`block w-full text-left rounded-md overflow-hidden border transition ${
                    isCurrent
                      ? 'border-[var(--color-primary)] shadow-[0_0_0_2px_var(--color-primary-light)]'
                      : 'border-[var(--color-border)] hover:border-white/20'
                  }`}
                  title={`Go to page ${p}`}
                >
                  <div className="aspect-[3/4] bg-[rgba(20,20,30,0.5)] flex items-center justify-center overflow-hidden">
                    {thumb ? (
                      <img
                        src={thumb}
                        alt={`Page ${p}`}
                        className="max-w-full max-h-full block"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-[10px] text-white/35">Rendering…</span>
                    )}
                  </div>
                  <div
                    className={`px-2 py-1 text-[10px] tabular-nums ${
                      isCurrent ? 'text-[var(--color-primary)]' : 'text-white/55'
                    }`}
                  >
                    {p}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {tab === 'contents' && (
          <div className="p-2">
            {hasOutline ? (
              <OutlineTree nodes={outline!} onJumpDest={onJumpDest} depth={0} />
            ) : (
              <p className="text-[11px] text-white/40 p-2">
                This document has no table of contents.
              </p>
            )}
          </div>
        )}

        {tab === 'animations' && (
          <div className="p-2 space-y-2">
            {animations.length === 0 && !addingAnimation && (
              <p className="p-2 text-[11px] leading-relaxed text-white/40">
                Nothing is animated yet. A clip filed in this matter can be laid over a picture
                in the book, so it comes alive when a reader taps it.
              </p>
            )}

            {animations.map((a) => (
              <div
                key={a.id}
                className="group flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1.5 hover:border-white/20"
              >
                <button
                  onClick={() => onJumpPage(a.page)}
                  className="min-w-0 flex-1 text-left"
                  title={`Go to page ${a.page}`}
                >
                  <span className="block truncate text-[11px] text-white/80">
                    {a.label || a.media?.title || 'Animation'}
                  </span>
                  <span className="block text-[10px] tabular-nums text-white/45">
                    p. {a.page}{a.turn ? ` · turned ${a.turn}°` : ''}{a.loops ? '' : ' · plays once'}
                  </span>
                </button>
                <button
                  onClick={() => onRemoveAnimation(a.id)}
                  title="Take this animation off the page"
                  aria-label={`Remove the animation on page ${a.page}`}
                  className="shrink-0 rounded p-1 text-white/35 opacity-0 transition hover:bg-white/5 hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {onAddAnimation && (
              addingAnimation ? (
                <p className="rounded-md border border-[var(--color-primary)] px-2 py-2 text-[11px] leading-relaxed text-[var(--color-primary)]">
                  Draw a rectangle round the picture on the page, and the clip will play there.
                  Press Esc to stop.
                </p>
              ) : (
                <button
                  onClick={onAddAnimation}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/18 px-2 py-2 text-[11px] text-white/55 transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                >
                  <Plus size={13} /> Add an animation
                </button>
              )
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function SidebarTab({
  active,
  onClick,
  icon,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center justify-center gap-1.5 h-7 rounded-md text-[11px] font-medium transition ${
        disabled
          ? 'text-white/25 cursor-default'
          : active
            ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-bright)]'
            : 'text-white/55 hover:text-white/85 hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function OutlineTree({
  nodes,
  onJumpDest,
  depth,
}: {
  nodes: OutlineNode[];
  onJumpDest: (dest: unknown) => void;
  depth: number;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node, i) => (
        <li key={`${depth}-${i}-${node.title}`}>
          <button
            onClick={() => onJumpDest(node.dest)}
            className="w-full text-left px-2 py-1 rounded-md text-[12px] text-white/75 hover:text-white hover:bg-white/5 transition truncate"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            title={node.title}
          >
            {node.title}
          </button>
          {node.items && node.items.length > 0 && (
            <OutlineTree nodes={node.items} onJumpDest={onJumpDest} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}
