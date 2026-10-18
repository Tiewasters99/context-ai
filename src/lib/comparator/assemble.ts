// The Model Comparator's "Comparison notes", for the browser. The template is
// a pure function (grades + margin notes in, Markdown out) implemented in
// lib/comparator-assemble.mjs so the server and the browser share one copy;
// nothing under lib/ or api/ can import src/ (the brief-md.mjs arrangement).

export {
  assembleComparisonNotes,
  countWords,
  dimensionOf,
  compareNotes,
  noteLocation,
  GENERAL,
} from '../../../lib/comparator-assemble.mjs';
export type { AssembleInput, AssembleNote, RubricDim } from '../../../lib/comparator-assemble.mjs';
