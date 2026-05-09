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
const MODEL = 'claude-opus-4-7';

export async function extractCitations(draftText, { apiKey }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');

  const system = `You are a legal citation extractor. Read the draft and extract every legal citation with the surrounding proposition.

Output ONLY a JSON array. Each element has:
  - raw: the citation as it appears in the text
  - citation_bluebook: the citation in canonical Bluebook form (best effort; if you can't, repeat the raw)
  - case_name: short case name, or null for statutes
  - court: court level (e.g., "S.Ct.", "2d Cir.", "N.Y.", "1st Dep't"), or null
  - year: decision/effective year as integer, or null
  - pin_cite: page or section pin if present, or null
  - proposition: the textual claim the cite is supporting, drawn from the surrounding sentence (1-2 sentences max)
  - signal: "see", "see also", "accord", "cf.", "but see", "e.g.", "compare", or null
  - authority_type: one of "statute", "regulation", "case", "treatise", "rule", "other"
  - doctrinal_subject: array of relevant subject tags (e.g., ["consumer protection"], ["bankruptcy"], ["First Amendment"])
  - location: short snippet of surrounding text (~80 chars) so a human can find it in the draft

Rules:
  - Extract every distinct citation. If the same case is cited multiple times, emit one entry per location.
  - Don't invent citations. If unsure, omit.
  - Treat statutes (11 U.S.C. § 523(a)(7), CPLR § 214(2), 6 RCNY § 6-47) as authority_type = "statute".
  - Federal regulations (12 C.F.R. § 1026.x, eCFR cites) are authority_type = "regulation".
  - Cases are authority_type = "case".
  - If unable to determine year, omit (null is fine).
  - Output a single JSON array. No prose, no markdown, no explanation.`;

  const body = {
    model: MODEL,
    max_tokens: 8000,
    system,
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
  const text = data.content?.[0]?.text ?? '';
  const cites = safeJsonArray(text);
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
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to extract a JSON array from messy output (e.g. ```json fences).
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      try { const p = JSON.parse(m[0]); return Array.isArray(p) ? p : []; } catch {}
    }
    return [];
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
