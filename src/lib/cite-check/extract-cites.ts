import { generateStructured } from '@/lib/llm';
import type { Cite, AuthorityType } from './types';

const EXTRACT_SYSTEM = `You are a legal citation extractor. Read the draft and extract every legal citation with the surrounding proposition.

For each distinct citation in the text, include it in the citations array. Extract every citation — if the same case is cited multiple times, emit one entry per location.

Rules:
  - Don't invent citations. If you're not sure something is a real cite, omit it.
  - Statutes (11 U.S.C. § 523(a)(7), CPLR § 214(2), 6 RCNY § 6-47) are authority_type = "statute".
  - Federal regulations (12 C.F.R. § 1026.x, eCFR) are authority_type = "regulation".
  - Cases are authority_type = "case".
  - "court" is the court level (e.g., "S.Ct.", "2d Cir.", "N.Y.", "1st Dep't"); null for statutes.
  - "pin_cite" is the page or section pin (e.g., "282", "44", "486-87") if present.
  - "signal" is "see", "see also", "accord", "cf.", "but see", "e.g.", "compare", or null.
  - "doctrinal_subject" is an array of subject tags ("consumer protection", "bankruptcy", "First Amendment", etc).
  - "location" is a short snippet of surrounding text (~80 chars) so a human can find this cite in the draft.
  - "proposition" is the claim the cite is supporting, drawn from the surrounding sentence (1-2 sentences max).`;

const CITE_SCHEMA = {
  type: 'object',
  properties: {
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          citation_bluebook: { type: ['string', 'null'] },
          case_name: { type: ['string', 'null'] },
          court: { type: ['string', 'null'] },
          year: { type: ['integer', 'null'] },
          pin_cite: { type: ['string', 'null'] },
          proposition: { type: ['string', 'null'] },
          signal: { type: ['string', 'null'] },
          authority_type: { type: 'string', enum: ['statute', 'regulation', 'case', 'treatise', 'rule', 'other'] },
          doctrinal_subject: { type: 'array', items: { type: 'string' } },
          location: { type: ['string', 'null'] },
        },
        required: ['raw', 'authority_type'],
      },
    },
  },
  required: ['citations'],
} as const;

interface RawCite {
  raw?: string;
  citation_bluebook?: string | null;
  case_name?: string | null;
  court?: string | null;
  year?: number | null;
  pin_cite?: string | null;
  proposition?: string | null;
  signal?: string | null;
  authority_type?: string;
  doctrinal_subject?: string[];
  location?: string | null;
}

export async function extractCitations(
  draftText: string,
  opts: { modelId: string; signal?: AbortSignal } = { modelId: 'claude-opus-4-8' },
): Promise<Cite[]> {
  const result = await generateStructured<{ citations?: RawCite[] }>({
    modelId: opts.modelId,
    signal: opts.signal,
    system: EXTRACT_SYSTEM,
    userContent: draftText,
    toolName: 'record_citations',
    toolDescription: 'Record every legal citation extracted from the draft.',
    inputSchema: CITE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
  });
  const cites = Array.isArray(result?.citations) ? result.citations : [];
  return cites.map(normaliseCite);
}

function normaliseCite(c: RawCite): Cite {
  const validTypes: AuthorityType[] = ['statute', 'regulation', 'case', 'treatise', 'rule', 'other'];
  const t = validTypes.includes(c.authority_type as AuthorityType) ? (c.authority_type as AuthorityType) : 'other';
  return {
    raw: c.raw ?? null,
    citation_bluebook: c.citation_bluebook ?? c.raw ?? null,
    case_name: c.case_name ?? null,
    court: c.court ?? null,
    year: typeof c.year === 'number' ? c.year : null,
    pin_cite: c.pin_cite ?? null,
    proposition: c.proposition ?? null,
    signal: c.signal ?? null,
    authority_type: t,
    doctrinal_subject: Array.isArray(c.doctrinal_subject) ? c.doctrinal_subject : [],
    location: c.location ?? null,
  };
}
