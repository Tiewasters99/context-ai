import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@fontsource-variable/cormorant-garamond';
import '@fontsource-variable/cormorant-garamond/wght-italic.css';
import EditionApp from './EditionApp';

// The Grapheon Reader's own entry (edition.html): the Reader, My Library and
// the Workshop, and nothing of the workspace — no router, no matter
// contexts, no Orchestrator — so read.grapheon.ai loads a reader and not
// Contextspaces (docs/specs/GRAPHEON-READER-2026-10-10.md, "The reader app").
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditionApp />
  </StrictMode>,
);
