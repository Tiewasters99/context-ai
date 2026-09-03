import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ReadingRoom from './ReadingRoom';

// The Reading Room's own entry (reader.html): the Reader and nothing else —
// no router, no auth, no workspace bundle — so a visitor taking a book
// down in the office waits for a reader, not for Contextspaces.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReadingRoom />
  </StrictMode>,
);
