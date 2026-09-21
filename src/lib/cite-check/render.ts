// Markdown renderers — produce the same .toa.md and .cite-report.md the
// CLI writes, so the in-app "Download" buttons hand back a familiar artifact.

import { FLAG_GLYPH, FLAG_LABEL, citesChecked, tallyFlags, type CheckResult, type FlagCounts } from './types';

function dedup(rows: string[]): string[] {
  return Array.from(new Set(rows));
}

export function renderToa(results: CheckResult[]): string {
  const cases: string[] = [];
  const statutes: string[] = [];
  const regs: string[] = [];
  const other: string[] = [];
  for (const r of results) {
    const c = r.cite;
    const row = `- ${FLAG_GLYPH[r.flag] ?? '?'} **${c.citation_bluebook ?? c.raw}**${c.pin_cite ? `, ${c.pin_cite}` : ''}`;
    if (c.authority_type === 'case') cases.push(row);
    else if (c.authority_type === 'statute') statutes.push(row);
    else if (c.authority_type === 'regulation') regs.push(row);
    else other.push(row);
  }
  const sections: string[] = [];
  sections.push('# Table of Authorities\n');
  sections.push('Legend: ✓ verified clean · ⊕ verified, minor issue · ⊖ unverified, model concern · ✗ verified mismatch · ◇ Westlaw paste needed · — not checked\n');
  if (cases.length) sections.push('## Cases\n\n' + dedup(cases).join('\n') + '\n');
  if (statutes.length) sections.push('## Statutes\n\n' + dedup(statutes).join('\n') + '\n');
  if (regs.length) sections.push('## Regulations\n\n' + dedup(regs).join('\n') + '\n');
  if (other.length) sections.push('## Other\n\n' + dedup(other).join('\n') + '\n');
  return sections.join('\n');
}

/**
 * THE HEADER'S ARITHMETIC MUST RECONCILE.
 *
 * It used to say "Citations checked: N" where N was every citation extracted,
 * including any the model failed to rate. A reader counted that as work done.
 * Now the three numbers add up on the page: extracted = checked + not checked,
 * and a citation nobody could check is named in its own line rather than
 * hidden inside a total.
 */
export function renderReport(
  sourceLabel: string,
  results: CheckResult[],
  opts: { counts?: FlagCounts; setAside?: number } = {},
): string {
  const counts = opts.counts ?? tallyFlags(results);
  const lines: string[] = [];
  lines.push('# Cite-Check Report');
  lines.push('');
  lines.push(`**Source:** \`${sourceLabel}\``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Citations extracted:** ${results.length}`);
  lines.push(`**Checked:** ${citesChecked(counts)} · **Not checked:** ${counts.not_checked ?? 0}`);
  if (counts.not_checked) {
    lines.push('');
    lines.push(
      `> ${counts.not_checked} citation${counts.not_checked === 1 ? '' : 's'} could not be checked: `
      + 'the checker’s answer could not be read, twice. Those citations are neither verified nor '
      + 'missing — nothing has been established about them, and they still need checking by hand.',
    );
  }
  if (opts.setAside) {
    lines.push('');
    lines.push(
      `> ${opts.setAside} entr${opts.setAside === 1 ? 'y was' : 'ies were'} returned by the extractor `
      + 'but could not be found in the draft, so they were set aside rather than checked. They are not '
      + 'in the count above.',
    );
  }
  lines.push(`**Flagged (lean-green / lean-red / red / blue / not checked):** ${results.filter((r) => r.flag !== 'green').length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const r of results) {
    const c = r.cite;
    lines.push(`## ${FLAG_GLYPH[r.flag]} ${c.citation_bluebook ?? c.raw}`);
    lines.push('');
    lines.push(`- **Status:** ${FLAG_LABEL[r.flag]} (${r.verification_status})`);
    // Never a rating the model did not give. "not rated" is the honest word
    // for a citation whose checker could not be read.
    lines.push(`- **Confidence:** ${r.rating ?? 'not rated'}`);
    if (c.proposition) lines.push(`- **Cited for:** ${c.proposition}`);
    if (c.pin_cite) lines.push(`- **Pin:** ${c.pin_cite}`);
    if (c.signal) lines.push(`- **Signal:** ${c.signal}`);
    if (r.source_url) lines.push(`- **Source:** [${r.source_label}](${r.source_url})`);
    else if (r.source_label) lines.push(`- **Source:** ${r.source_label}`);
    if (r.justification) lines.push(`- **Note:** ${r.justification}`);
    if (r.flags.length) {
      lines.push('- **Flags:**');
      for (const f of r.flags) lines.push(`  - \`${f.kind}\`: ${f.detail}`);
    }
    if (c.location) lines.push(`- **In draft:** _"${c.location.replace(/\n/g, ' ').slice(0, 200)}"_`);
    lines.push('');
  }
  return lines.join('\n');
}
