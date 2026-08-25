// Renders the pinned cards for the space you are in, and keeps the canvas
// pointed at the right space as you move around.
//
// One rule keeps the canvas from ever showing a card twice: the panel whose
// content you are already looking at full-size on the route is hidden while
// you are on that route, and comes back the moment you navigate away. So
// pinning Business Development and then opening Creative gives you both —
// Creative in the route card, Business Development on the canvas.

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useCanvas } from '@/hooks/useCanvas';
import { useContentItem } from '@/hooks/useContentItems';
import { CALENDAR_CARD_ID, isCanvasKind, panelZ, type CanvasCard, type CanvasCardKind, type CanvasSpace } from '@/lib/canvas';
import CanvasPanel from './CanvasPanel';
import ListView from '@/pages/ListView';
import PageView from '@/pages/PageView';
import TableView from '@/pages/TableView';
import DocumentReader from '@/pages/DocumentReader';
import CalendarView from '@/pages/CalendarView';

// Route segment → card kind. `table` is the route; `database` is the
// content_type behind it — the canvas speaks in routes.
const ROUTE_TO_KIND: Record<string, CanvasCardKind> = {
  list: 'list',
  page: 'page',
  table: 'table',
  document: 'document',
};

// Where a card's "open as a full page" goes. Every kind but the calendar
// carries an id in its path; the calendar is a single sheet at /app/calendar.
function routeFor(card: { kind: CanvasCardKind; id: string }): string {
  return card.kind === 'calendar' ? '/app/calendar' : `/app/${card.kind}/${card.id}`;
}

interface RouteTarget {
  kind: CanvasCardKind | null;
  id: string | null;
  space: CanvasSpace | null;
}

function readRoute(pathname: string): RouteTarget {
  const parts = pathname.split('/').filter(Boolean); // ['app', 'list', '<id>']
  if (parts[0] !== 'app') return { kind: null, id: null, space: null };
  // The calendar route carries no id — it is the one card of its kind.
  if (parts.length === 2 && parts[1] === 'calendar') {
    return { kind: 'calendar', id: CALENDAR_CARD_ID, space: null };
  }
  if (parts.length < 3) return { kind: null, id: null, space: null };
  const [, segment, id] = parts;
  if (segment === 'matterspace') return { kind: null, id: null, space: { spaceId: id, spaceType: 'matterspace' } };
  if (segment === 'serverspace') return { kind: null, id: null, space: { spaceId: id, spaceType: 'serverspace' } };
  const kind = ROUTE_TO_KIND[segment];
  if (kind) return { kind, id, space: null };
  return { kind: null, id: null, space: null };
}

// A document knows its matter directly. One tiny cached select — the reader
// itself fetches far more than this.
function useDocumentSpace(documentId: string | null) {
  return useQuery({
    queryKey: ['document_space', documentId],
    enabled: !!documentId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CanvasSpace | null> => {
      if (!documentId) return null;
      const { data, error } = await supabase
        .from('documents')
        .select('matterspace_id')
        .eq('id', documentId)
        .maybeSingle();
      if (error || !data?.matterspace_id) return null;
      return { spaceId: data.matterspace_id as string, spaceType: 'matterspace' };
    },
  });
}

export default function CanvasLayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { cards, setSpace, unpin, raise, toggleMax, setRect, setTitle } = useCanvas();

  const route = useMemo(() => readRoute(location.pathname), [location.pathname]);

  // Content routes carry their space on the item itself. This read is already
  // in the React Query cache — the route view fetched it — so it costs nothing.
  const contentId =
    route.kind && route.kind !== 'document' && route.kind !== 'calendar'
      ? route.id ?? undefined
      : undefined;
  const { data: contentItem } = useContentItem(contentId);
  const { data: docSpace } = useDocumentSpace(route.kind === 'document' ? route.id : null);

  // Memoised on the primitives: a fresh object every render would re-fire the
  // effect below on every keystroke anywhere in the app.
  const itemSpaceId = contentItem?.space_id;
  const itemSpaceType = contentItem?.space_type;
  const routeSpace = route.space;
  const derivedSpace: CanvasSpace | null = useMemo(
    () =>
      routeSpace ??
      (itemSpaceId && itemSpaceType ? { spaceId: itemSpaceId, spaceType: itemSpaceType } : null) ??
      docSpace ??
      null,
    [routeSpace, itemSpaceId, itemSpaceType, docSpace],
  );

  useEffect(() => {
    setSpace(derivedSpace);
  }, [derivedSpace, setSpace]);

  // Keep the ribbon honest about a card that has since been renamed.
  useEffect(() => {
    if (!contentItem || !route.kind || !route.id) return;
    setTitle(`${route.kind}:${route.id}`, contentItem.title);
  }, [contentItem, route.kind, route.id, setTitle]);

  const visible = cards.filter(
    (c) => !(route.kind === c.kind && route.id === c.id),
  );

  if (visible.length === 0) return null;

  return (
    <div className={isMobile ? 'pt-2' : ''} data-canvas-layer>
      {isMobile && (
        <p className="px-4 pb-2 text-[11px] uppercase tracking-wider text-white/35">
          Pinned
        </p>
      )}
      {visible.map((card, i) => (
        <CanvasPanel
          key={card.key}
          card={card}
          stacked={isMobile}
          zIndex={panelZ(i)}
          onFocus={() => raise(card.key)}
          onUnpin={() => unpin(card.key)}
          onOpenFull={() => navigate(routeFor(card))}
          onToggleMax={() => toggleMax(card.key)}
          onRect={(rect) => setRect(card.key, rect)}
        >
          <CanvasCardBody card={card} onClose={() => unpin(card.key)} />
        </CanvasPanel>
      ))}
    </div>
  );
}

function CanvasCardBody({ card, onClose }: { card: CanvasCard; onClose: () => void }) {
  if (!isCanvasKind(card.kind)) return null;
  switch (card.kind) {
    case 'list':
      return <ListView id={card.id} embedded onClose={onClose} />;
    case 'page':
      return <PageView id={card.id} embedded onClose={onClose} />;
    case 'table':
      return <TableView id={card.id} embedded onClose={onClose} />;
    case 'document':
      return <DocumentReader id={card.id} embedded onClose={onClose} />;
    case 'calendar':
      return <CalendarView embedded onClose={onClose} />;
  }
}
