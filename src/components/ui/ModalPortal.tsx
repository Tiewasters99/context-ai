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

export default function ModalPortal({ children }: { children: ReactNode }) {
  // Mount-gate so the portal target is never touched during SSR/first render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
