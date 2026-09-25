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

// It portals on the FIRST render. Until 2026-09-25 it waited one effect
// before mounting its children, and that broke every draggable card built on
// it: the card's useDraggableResizable ran its effect in the same pass, found
// its ref still empty because the portal had not mounted yet, and never bound
// — the AgentCard, CharterEditor, CalendarOverlay and SiteSearch cards showed
// a drag handle and a Pin that could not move or restore anything. This is a
// client-only SPA, so there is always a document; the guard is for a render
// without one.

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
