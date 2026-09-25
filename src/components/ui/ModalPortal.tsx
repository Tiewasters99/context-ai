// Renders modal content into document.body instead of leaving it where it
// was declared in the tree.
//
// Why this is necessary and not just tidiness: an ancestor with a non-none
// `backdrop-filter` (also `transform`, `filter`, `perspective`, `contain`,
// `will-change`) becomes the containing block for any `position: fixed`
// descendant. The app Sidebar's <aside> carries `backdrop-blur-[30px]`, so
// every modal declared inside it had its `fixed inset-0` resolve against a
// 256px-wide box rather than the viewport — the dialog rendered squeezed
// into the sidebar strip. In ShareModal that collapsed the email field to
// 25px wide, which read as "the keyboard doesn't work" because there was
// nowhere visible for the typing to land.
//
// Portalling to <body> puts the modal above every such ancestor, so `fixed`
// means viewport-fixed again regardless of where the modal is declared.

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

//
// It portals on the FIRST render whenever there is a document (always, in
// this SPA). Until 2026-09-25 it waited one effect before mounting its
// children, and that broke every draggable card built on it: a card's
// useDraggableResizable runs its effect in the same pass, finds its ref
// still empty because the portal had not mounted yet, and never binds —
// the AgentCard, CharterEditor, CalendarOverlay and SiteSearch cards showed
// a drag handle and a Pin that could not move or restore anything. The gate
// is kept only for a render with no document at all.
export default function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(() => typeof document !== 'undefined');
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
