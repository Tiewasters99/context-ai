// Free legal-database fetchers. Every fetcher returns either:
//   { found: true, full_text, source_url, source_label } or
//   { found: false }
//
// We try statute fetchers first when authority_type === 'statute', case
// fetchers when 'case'. Phase 1 covers the common-case fast paths:
//   - Statutes: Cornell LII (federal U.S.C., NY consolidated laws,
//                CPLR), eCFR for regulations.
//   - Cases:    CourtListener Free Law Project (REST API, no key
//                needed for opinion text).
// Google Scholar and Justia are deliberately not wired in Phase 1 —
// they don't have stable APIs and HTML scraping is brittle. The model
// does best-effort recall when a free DB miss happens.

const COURTLISTENER_BASE = 'https://www.courtlistener.com/api/rest/v4';

export async function fetchStatute(cite) {
  // Federal U.S.C.: "11 U.S.C. § 523(a)(7)" → www.law.cornell.edu/uscode/text/11/523
  const usc = cite.citation_bluebook?.match(/(\d+)\s*U\.?S\.?C\.?\s*§\s*([0-9a-z]+)/i);
  if (usc) {
    const [, title, section] = usc;
    const url = `https://www.law.cornell.edu/uscode/text/${title}/${section}`;
    return tryFetch(url, 'Cornell LII (USC)');
  }
  // Federal CFR: "12 C.F.R. § 1026.x" → ecfr.gov
  const cfr = cite.citation_bluebook?.match(/(\d+)\s*C\.?F\.?R\.?\s*§?\s*([0-9.]+)/i);
  if (cfr) {
    const [, title, section] = cfr;
    const url = `https://www.ecfr.gov/current/title-${title}/section-${section}`;
    return tryFetch(url, 'eCFR');
  }
  // NY CPLR: "CPLR § 214(2)" → www.law.cornell.edu/cplr (catalogs the rules)
  const cplr = cite.citation_bluebook?.match(/CPLR\s*§?\s*([0-9a-z\-]+)/i);
  if (cplr) {
    const url = `https://www.nysenate.gov/legislation/laws/CVP/${cplr[1].toUpperCase()}`;
    return tryFetch(url, 'NY Senate (CPLR)');
  }
  // NY consolidated laws: "Gen. Bus. Law § 349" → nysenate.gov
  const ny = cite.citation_bluebook?.match(/(?:N\.?Y\.?\s+)?(Gen\.?\s+Bus\.?\s+Law|Exec\.?\s+Law|Pub\.?\s+Off\.?\s+Law)\s*§\s*([0-9a-z\-]+)/i);
  if (ny) {
    return { found: false, hint: `NY consolidated law detected; manual lookup at nysenate.gov` };
  }
  return { found: false };
}

export async function fetchCase(cite) {
  if (!cite.case_name) return { found: false };
  // CourtListener REST: search opinions by citation if available, else by case name.
  // The free tier is rate-limited; we use a single targeted query per cite.
  const params = new URLSearchParams();
  if (cite.citation_bluebook) {
    params.set('citation', cite.citation_bluebook);
  } else {
    params.set('case_name', cite.case_name);
  }
  params.set('order_by', 'score desc');
  const url = `${COURTLISTENER_BASE}/search/?${params.toString()}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { found: false };
    const data = await res.json();
    const hit = data?.results?.[0];
    if (!hit) return { found: false };
    // Pull opinion text from the resource_uri if present.
    const opinionRef = hit.resource_uri || hit.absolute_url;
    let full_text = null;
    if (hit.absolute_url) {
      // Opinion HTML page — fetch + minimal extraction
      const ores = await fetch(`https://www.courtlistener.com${hit.absolute_url}`);
      if (ores.ok) {
        const html = await ores.text();
        full_text = stripHtml(html).slice(0, 200_000); // cap at 200KB to keep response reasonable
      }
    }
    return {
      found: true,
      full_text,
      source_url: hit.absolute_url
        ? `https://www.courtlistener.com${hit.absolute_url}`
        : null,
      source_label: 'CourtListener',
      raw_hit: { id: hit.id, score: hit.score, name: hit.caseName },
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

async function tryFetch(url, label) {
  try {
    const res = await fetch(url, { headers: { accept: 'text/html' } });
    if (!res.ok) return { found: false };
    const html = await res.text();
    const text = stripHtml(html).slice(0, 100_000);
    if (text.length < 200) return { found: false }; // page came back empty / blocked
    return { found: true, full_text: text, source_url: url, source_label: label };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

function stripHtml(html) {
  // Crude but adequate for Phase 1: drop scripts/styles, then tags, then
  // collapse whitespace. We're not preserving markup — the LLM only needs
  // the readable text to do confidence rating.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
