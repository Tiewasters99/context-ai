// The judgment step, after every rule has run: which document in the record
// does this cite mean? A lawyer who knows the file finds it in seconds
// because the cite's form and the document's name mean the same thing to
// them ("OATH Pet." — the DCWP petition; "L. 2020, ch. 205" — the chapter
// filed under a longer name). The rules cover the forms they know; this
// covers the rest, with the model choosing ONLY from the names it is shown,
// and what opens saying it was the assistant's pick — never confirmed by it.
// (Eden, 09-28: "give the Desk some intelligence, rather than just have it
// deterministically pull things up.")

import { generateStructured } from '@/lib/llm/structured';

export interface CandidateDoc { id: string; title: string; filename?: string | null }

export interface AssistantMatch {
  document_id: string | null;
  /** One line: why this document, in the model's words — shown on the pane. */
  why: string;
  /** The model's own confidence; low means "open it, but read the caption". */
  confidence: 'high' | 'medium' | 'low';
}

const SYSTEM = `You match a citation in a legal brief to ONE document in the matter's file, by name.
The names are as filed by the lawyer: court download filenames, Westlaw names, shorthand.
Rules:
- Choose only from the numbered list. Answer with the document's id exactly as listed, or null.
- A cite names a case, statute, rule, regulation, session law, local law, record document (petition, affidavit, transcript, exhibit, order) or agency decision. Match on what the cite and the name both identify: parties, index or docket number, section or chapter number, year, the kind of document.
- Abbreviations mean their long forms (Pet. = Petition; Aff. = Affidavit or Affirmation; L. 2020, ch. 205 = chapter 205 of the laws of 2020; OATH = Office of Administrative Trials and Hearings).
- If two names could both be it, pick the more specific one and say so in "why".
- If nothing on the list is that document, answer null. Never choose a brief or petition draft as the authority for its own cite.`;

const SCHEMA = {
  type: 'object',
  properties: {
    document_id: { type: ['string', 'null'], description: 'The id from the list, or null when no listed document is the one cited.' },
    why: { type: 'string', description: 'One sentence: which words of the cite matched which words of the name.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['document_id', 'why', 'confidence'],
  additionalProperties: false,
};

/** Ask which listed document the cite means. Returns null when the model says none, or names an id that is not on the list. */
export async function assistantMatch(opts: {
  cite: string;
  sentence: string;
  candidates: CandidateDoc[];
  modelId: string;
  matterId: string;
  signal?: AbortSignal;
}): Promise<AssistantMatch | null> {
  const list = opts.candidates.slice(0, 400);
  if (!list.length) return null;
  const lines = list.map((d, i) => `${i + 1}. id=${d.id} · ${d.title}${d.filename && d.filename !== d.title ? ` (file: ${d.filename})` : ''}`);
  const userContent = [
    `CITE: ${opts.cite}`,
    opts.sentence ? `SENTENCE IT SITS IN: ${opts.sentence.slice(0, 600)}` : '',
    '',
    `DOCUMENTS IN THE FILE (${list.length}):`,
    ...lines,
  ].filter(Boolean).join('\n');
  const out = await generateStructured<AssistantMatch>({
    modelId: opts.modelId,
    matterId: opts.matterId,
    feature: 'citecheck.check',   // the cite-check budget line: this is a cite check
    system: SYSTEM,
    userContent,
    toolName: 'match_cite_to_document',
    toolDescription: 'Which listed document, if any, the cite means.',
    inputSchema: SCHEMA,
    maxTokens: 300,
    signal: opts.signal,
  });
  if (!out || !out.document_id) return null;
  if (!list.some((d) => d.id === out.document_id)) return null;   // not on the list: no
  return out;
}
