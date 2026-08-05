import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FileText, List } from 'lucide-react';

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
  onNeedThumb: (page: number) => void;
};

type Tab = 'pages' | 'contents';

export default function ReaderSidebar({
  totalPages,
  currentPage,
  thumbnails,
  outline,
  onJumpPage,
  onJumpDest,
  onNeedThumb,
}: Props) {
  const hasOutline = !!outline && outline.length > 0;
  const [tab, setTab] = useState<Tab>('pages');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Keep the latest callback reachable from the (stable) observer.
  const needThumbRef = useRef(onNeedThumb);
  useEffect(() => { needThumbRef.current = onNeedThumb; });

  // One shared observer requests a page's thumbnail as its placeholder
  // nears the viewport. Rendering thumbnails on demand (instead of all
  // upfront) is what keeps this strip scrollable on long documents.
  // Created lazily because item ref callbacks fire before parent effects
  // run — the first item to register creates it. root stays null (the
  // viewport): IntersectionObserver still respects the rail's clipping,
  // and the rail is viewport-height anyway.
  const registerThumb = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const p = Number((e.target as HTMLElement).dataset.page);
            if (p) {
              needThumbRef.current(p);
              obs.unobserve(e.target); // one request per placeholder is enough
            }
          }
        },
        { rootMargin: '600px 0px' },
      );
    }
    observerRef.current.observe(el);
  }, []);

  useEffect(() => {
    // Re-observe whatever is already mounted (tab switches, StrictMode
    // remounts); requestThumbnail dedupes so double-observation is free.
    const obs = observerRef.current;
    if (obs) {
      scrollRef.current
        ?.querySelectorAll<HTMLElement>('[data-page]')
        .forEach((el) => obs.observe(el));
    }
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [totalPages, tab]);

  // Keep the active page's thumbnail in view — matters when a document
  // opens at a deep saved page or the user navigates via slider/search.
  useEffect(() => {
    if (tab !== 'pages') return;
    const el = scrollRef.current?.querySelector(`[data-page="${currentPage}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentPage, tab]);

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
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'pages' && (
          <div className="p-2 space-y-2">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <PageThumb
                key={p}
                page={p}
                thumb={thumbnails[p - 1] ?? null}
                isCurrent={p === currentPage}
                onJumpPage={onJumpPage}
                registerThumb={registerThumb}
              />
            ))}
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
      </div>
    </aside>
  );
}

// Memoized so a thumbnail arriving for one page doesn't re-render the
// whole strip — on long documents that per-page full-list re-render was
// most of the jank.
const PageThumb = memo(function PageThumb({
  page,
  thumb,
  isCurrent,
  onJumpPage,
  registerThumb,
}: {
  page: number;
  thumb: string | null;
  isCurrent: boolean;
  onJumpPage: (page: number) => void;
  registerThumb: (el: HTMLElement | null) => void;
}) {
  return (
    <button
      data-page={page}
      ref={registerThumb}
      onClick={() => onJumpPage(page)}
      className={`block w-full text-left rounded-md overflow-hidden border transition ${
        isCurrent
          ? 'border-[var(--color-primary)] shadow-[0_0_0_2px_var(--color-primary-light)]'
          : 'border-[var(--color-border)] hover:border-white/20'
      }`}
      title={`Go to page ${page}`}
    >
      <div className="aspect-[3/4] bg-[rgba(20,20,30,0.5)] flex items-center justify-center overflow-hidden">
        {thumb ? (
          <img
            src={thumb}
            alt={`Page ${page}`}
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
        {page}
      </div>
    </button>
  );
});

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
