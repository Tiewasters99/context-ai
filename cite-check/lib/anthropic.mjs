// Anthropic API calls used by the cite-check pipeline.
//
//   extractCitations(draftText, opts) → array of cite objects:
//     { raw, citation_bluebook, case_name, court, year, pin_cite,
//       proposition, signal, authority_type, doctrinal_subject, location }
//
//   rateConfidence(cite, sourceText, opts) → { rating, justification }
//
// The model does the legal-cite extraction in a single pass — regex is
// brittle for the long tail (memo decisions, slip ops, parallel cites).
// We use Claude 4.7 with a tight system prompt and JSON-mode output.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

export async function extractCitations(draftText, { apiKey }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');

  const system = `You are a legal citation extractor. Read the draft and extract every legal citation with the surrounding proposition.

For each distinct citation in the text, call the record_citations tool with all citations you found. Extract every citation — if the same case is cited multiple times, emit one entry per location.

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

  const tools = [{
    name: 'record_citations',
    description: 'Record every legal citation extracted from the draft.',
    input_schema: {
      type: 'object',
      properties: {
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              raw: { type: 'string' },
              citation_bluebook: { type: 'string' },
              case_name: { type: ['string', 'null'] },
              court: { type: ['string', 'null'] },
              year: { type: ['integer', 'null'] },
              pin_cite: { type: ['string', 'null'] },
              proposition: { type: ['string', 'null'] },
              signal: { type: ['string', 'null'] },
              authority_type: {
                type: 'string',
                enum: ['statute', 'regulation', 'case', 'treatise', 'rule', 'other'],
              },
              doctrinal_subject: { type: 'array', items: { type: 'string' } },
              location: { type: ['string', 'null'] },
            },
            required: ['raw', 'authority_type'],
          },
        },
      },
      required: ['citations'],
    },
  }];

  const body = {
    model: MODEL,
    max_tokens: 16000,
    system,
    tools,
    tool_choice: { type: 'tool', name: 'record_citations' },
    messages: [{ role: 'user', content: draftText }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic extract: ${res.status} ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find((c) => c.type === 'tool_use');
  const cites = Array.isArray(toolUse?.input?.citations) ? toolUse.input.citations : [];
  if (cites.length === 0) {
    console.error('[cite-check] WARNING: zero citations parsed. stop_reason:', data.stop_reason);
    console.error('[cite-check] content blocks:', JSON.stringify(data.content, null, 2).slice(0, 2000));
  }
  return cites.map(normaliseCite);
}

export async function rateConfidence(cite, sourceText, { apiKey }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');

  const system = `You are a careful legal-citation auditor. Given a citation and the source text we retrieved, assess whether the citation is real, well-formed, and supports the proposition the lawyer claims it stands for.

Output ONLY a JSON object:
  - rating: "high" | "medium" | "low"
  - justification: 1-2 sentences explaining the rating

"high" = real, well-formed, supports the proposition.
"medium" = real and well-formed but proposition is parallel/distant or pin missing.
"low" = likely fabricated, mis-attributed, or proposition flatly contradicts source.

If the source text is empty or generic ("verified by attestation"), default to "medium" unless the citation has obvious format problems.

No prose outside the JSON object.`;

  const userPayload = {
    citation: cite.citation_bluebook,
    proposition: cite.proposition,
    pin_cite: cite.pin_cite,
    source_text_excerpt: (sourceText ?? '').slice(0, 4000),
  };

  const body = {
    model: MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic rate: ${res.status} ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  const obj = safeJson(text);
  return {
    rating: obj?.rating ?? 'medium',
    justification: obj?.justification ?? '',
  };
}

function normaliseCite(c) {
  return {
    raw: c.raw ?? null,
    citation_bluebook: c.citation_bluebook ?? c.raw ?? null,
    case_name: c.case_name ?? null,
    court: c.court ?? null,
    year: typeof c.year === 'number' ? c.year : null,
    pin_cite: c.pin_cite ?? null,
    proposition: c.proposition ?? null,
    signal: c.signal ?? null,
    authority_type: c.authority_type ?? 'other',
    doctrinal_subject: Array.isArray(c.doctrinal_subject) ? c.doctrinal_subject : [],
    location: c.location ?? null,
  };
}

function safeJsonArray(text) {
  // Try direct parse first.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // Allow a wrapped object: {"citations": [...]} / {"results": [...]} / etc.
    if (parsed && typeof parsed === 'object') {
      for (const key of ['citations', 'cites', 'results', 'items', 'data']) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
    }
  } catch {}

  // Fall back: extract the largest balanced JSON array from messy text.
  const start = text.indexOf('[');
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) {
    // Truncation: array opened but never closed. Try to repair by
    // dropping the final partial object and closing.
    const lastObjEnd = text.lastIndexOf('}');
    if (lastObjEnd > start) {
      const candidate = text.slice(start, lastObjEnd + 1) + ']';
      try { const p = JSON.parse(candidate); if (Array.isArray(p)) return p; } catch {}
    }
    return [];
  }
  try {
    const p = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
