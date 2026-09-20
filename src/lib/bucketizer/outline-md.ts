// The outline as Markdown — the version that gets FILED into the matter and
// ingested, so the outline is itself searchable alongside the record it cites.
//
// Byte-for-byte deterministic over the model: no clock, no locale-dependent
// formatting, no Set or Map iteration that has not been sorted first. Two runs
// over the same confirmed evidence produce the same file, which is what lets
// an attorney diff last week's outline against today's and see only what
// changed in the case.

import { DRAFT_LEGEND, type OutlineEvidence, type OutlineModel, type OutlineSection } from './outline-model';

const RULE = '---';

export function renderOutlineMarkdown(model: OutlineModel): string {
  const out: string[] = [];
  const w = (line = '') => out.push(line);

  // --- head ----------------------------------------------------------------
  w(`# ${model.matter.title} — Trial Outline`);
  w();
  w(`**${model.version}**`);
  w();
  if (!model.reviewedAt) {
    // A Markdown file has no pages, so "on every page" becomes "at the top and
    // at the foot, and in the file's own name if you rename it". The .docx,
    // which does have pages, carries it in the running header.
    w(`> **${DRAFT_LEGEND}**`);
    w('>');
    w('> Every quotation below was checked character for character against the stored');
    w('> passage, and every citation was computed from that passage\'s own coordinates —');
    w('> but no part of this outline has been reviewed by an attorney. Nothing in it');
    w('> should be filed, served, or read to a witness until it has been.');
  } else {
    w(`> Reviewed by counsel ${model.reviewedAt}.`);
  }
  w();
  w(RULE);
  w();

  // --- counts --------------------------------------------------------------
  const c = model.counts;
  w('## The state of the record');
  w();
  w('| | |');
  w('|---|---|');
  w(`| Claims / elements / subissues | ${c.claims} / ${c.elements} / ${c.subissues} |`);
  w(`| Themes | ${c.themes} |`);
  w(`| Documents filed into the tree | ${c.documentsFiled.toLocaleString('en-US')} |`);
  w(`| Quotations confirmed by counsel | ${c.evidenceConfirmed.toLocaleString('en-US')} |`);
  w(`| Quotations proposed, not yet confirmed | ${c.evidenceProposed.toLocaleString('en-US')} |`);
  w(`| Document–issue pairings not yet read for evidence | ${c.pairsNotRun.toLocaleString('en-US')} |`);
  if (c.pairsFailed > 0) {
    w(`| Pairings that could not be read | ${c.pairsFailed.toLocaleString('en-US')} |`);
  }
  w();
  w('Citations by precision: '
    + `${c.citeTiers.page_line} page:line · `
    + `${c.citeTiers.page_line_inferred} page:line (positional) · `
    + `${c.citeTiers.page_only} page only · `
    + `${c.citeTiers.document_page} document and page · `
    + `${c.citeTiers.no_page} no page.`);
  w();

  // --- method --------------------------------------------------------------
  w('## How this outline was built');
  w();
  w('Documents were classified into the case-theory tree by a model and confirmed or');
  w('rejected by counsel. For each confirmed pairing, a model then chose which of the');
  w('recorded passages support the issue and where the quotable span begins and ends.');
  w('**Every quotation was then verified deterministically**: the span must appear in');
  w('the stored passage word for word, allowing only for line wrapping. Anything that');
  w('did not match was discarded, never corrected. The outline itself — the numbering,');
  w('the ordering, the citations and this text — is assembled by code; no model wrote');
  w('any sentence of it.');
  w();
  w('Quotations counsel has **not** confirmed are listed separately under each issue');
  w('and are never presented as established.');
  w();

  // --- citation notes ------------------------------------------------------
  if (model.citationNotes.length) {
    w('## About the citations in this outline');
    w();
    for (const note of model.citationNotes) {
      w(`- ${note}`);
    }
    w();
  }

  // --- gaps, first ---------------------------------------------------------
  w('## What still needs evidence');
  w();
  if (!model.gaps.length) {
    w('Every element and subissue in the tree carries at least '
      + `${3} confirmed quotations. Nothing is flagged here.`);
    w();
  } else {
    w('| Outline | Issue | What is missing |');
    w('|---|---|---|');
    for (const g of model.gaps) {
      w(`| ${g.number} | ${escapeCell(g.label)} | ${gapPrefix(g.gap)}${escapeCell(g.reason)} |`);
    }
    w();
  }

  // --- the case ------------------------------------------------------------
  w(RULE);
  w();
  w('## The case, claim by claim');
  w();
  if (!model.claims.length) {
    w('_No claims in the tree yet._');
    w();
  }
  for (const claim of model.claims) renderSection(w, claim, 3);

  // --- themes --------------------------------------------------------------
  if (model.themes.length) {
    w(RULE);
    w();
    w('## Themes');
    w();
    for (const theme of model.themes) renderSection(w, theme, 3);
  }

  // --- indices -------------------------------------------------------------
  w(RULE);
  w();
  w('## Witnesses cited');
  w();
  if (!model.witnesses.length) {
    w('_No confirmed testimony is cited in this outline yet._');
    w();
  } else {
    for (const witness of model.witnesses) {
      const where = witness.cites.map((x) => `${x.cite} (${x.number})`).join('; ');
      w(`- **${escapeInline(witness.name)}** — ${escapeInline(where)}`);
    }
    w();
  }

  w('## Documents cited');
  w();
  if (!model.documents.length) {
    w('_No document is quoted in this outline yet._');
    w();
  } else {
    for (const doc of model.documents) {
      w(`- [${escapeInline(doc.title)}](${doc.readerUrl}) — `
        + `${doc.quotes} quotation${doc.quotes === 1 ? '' : 's'}, at ${doc.numbers.join(', ')}`);
    }
    w();
  }

  w(RULE);
  w();
  if (!model.reviewedAt) {
    w(`**${DRAFT_LEGEND}**`);
    w();
  }
  w(`Generated ${model.generatedAt} from the Bucketizer case-theory tree for `
    + `${model.matter.title}${model.matter.shortCode ? ` (${model.matter.shortCode})` : ''}.`);
  w();

  // A single trailing newline, always — so the byte comparison is on content.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function gapPrefix(kind: string): string {
  switch (kind) {
    case 'empty': return '**Nothing here** — ';
    case 'unconfirmed': return '**Nothing confirmed** — ';
    default: return '**Thin** — ';
  }
}

function renderSection(w: (line?: string) => void, section: OutlineSection, level: number): void {
  const hashes = '#'.repeat(Math.min(6, level));
  w(`${hashes} ${escapeInline(section.heading)}`);
  w();
  w(`*Must prove:* ${escapeInline(section.mustProve)}`);
  w();

  if (section.confirmed.length) {
    for (const item of section.confirmed) renderEvidence(w, item);
  }

  if (section.proposed.length) {
    w(`**Proposed, not yet confirmed by counsel (${section.proposed.length}):**`);
    w();
    for (const item of section.proposed) renderEvidence(w, item, true);
  }

  const unquoted = section.documents.filter((d) => d.evidenceState !== 'quoted');
  if (unquoted.length) {
    w(`**Also filed under this issue, without a quotation (${unquoted.length}):**`);
    w();
    for (const doc of unquoted) {
      const status = doc.status === 'confirmed'
        ? 'confirmed'
        : `proposed${doc.confidence != null ? ` · ${Math.round(doc.confidence * 100)}%` : ''}`;
      w(`- [${escapeInline(doc.title)}](${doc.readerUrl}) — ${status}`
        + `${doc.evidenceNote ? `; ${escapeInline(doc.evidenceNote)}` : ''}`);
    }
    w();
  }

  // A claim with elements under it is a container, not a bucket — saying
  // "nothing is filed here" of it would be noise on every claim in the tree.
  // A LEAF with nothing in it is the thing the gaps section is about, and it
  // says so again where the reader has reached it.
  if (!section.children.length
    && !section.confirmed.length && !section.proposed.length && !section.documents.length) {
    w('_Nothing is filed under this issue._');
    w();
  }

  for (const child of section.children) renderSection(w, child, level + 1);
}

function renderEvidence(
  w: (line?: string) => void,
  item: OutlineEvidence,
  proposed = false,
): void {
  // A block quote, then the citation on its own line beneath it — the shape a
  // lawyer reads. The quotation is reproduced exactly as stored; only the
  // Markdown quote marker is added, line by line.
  for (const line of item.quote.split('\n')) {
    w(`> ${line}`);
  }
  w();
  const caveat = item.cite.caveat ? ` *(${item.cite.caveat})*` : '';
  const flag = proposed ? '**PROPOSED — not confirmed.** ' : '';
  w(`${flag}— **${escapeInline(item.cite.text)}**${caveat} · `
    + `[open at ${item.cite.page != null ? `p. ${item.cite.page}` : 'the document'}](${item.readerUrl})`);
  w();
  if (item.rationale) {
    w(`*Why it matters:* ${escapeInline(item.rationale)}`);
    w();
  }
}

/** Markdown table cells cannot hold a raw pipe or newline. */
function escapeCell(text: string): string {
  return escapeInline(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * Only what Markdown would otherwise EAT is escaped, and nothing that would
 * change a word. A quotation is never passed through here — it is written
 * verbatim into a block quote.
 */
function escapeInline(text: string): string {
  return String(text ?? '').replace(/([*_`[\]])/g, '\\$1');
}
