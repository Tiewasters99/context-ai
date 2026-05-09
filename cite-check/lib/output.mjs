// Two outputs per run:
//   <draft>.toa.md         — clean Bluebook-style Table of Authorities
//   <draft>.cite-report.md — verbose per-cite verification report (the
//                            audit trail; the lawyer reads this first)

import fs from 'node:fs/promises';
import path from 'node:path';

// Five-level flag scheme. The two ⊕ / ⊖ glyphs are deliberately distinct
// from each other so a glance at the TOA tells you direction even before
// the label.
const FLAG_GLYPH = {
  green: '✓',
  'lean-green': '⊕',
  'lean-red': '⊖',
  red: '✗',
  blue: '◇',
};

const FLAG_LABEL = {
  green: 'verified — clean',
  'lean-green': 'verified — minor issue',
  'lean-red': 'unverified — model concern',
  red: 'verified mismatch',
  blue: 'westlaw paste needed',
};

export async function writeReport({ draftPath, results, toaPath, reportPath }) {
  await fs.writeFile(toaPath, renderToa(results), 'utf8');
  await fs.writeFile(reportPath, renderReport(draftPath, results), 'utf8');
}

function renderToa(results) {
  const cases = [];
  const statutes = [];
  const regs = [];
  const other = [];
  for (const r of results) {
    const c = r.cite;
    const row = `- ${FLAG_GLYPH[r.flag] ?? '?'} **${c.citation_bluebook ?? c.raw}**${c.pin_cite ? `, ${c.pin_cite}` : ''}`;
    if (c.authority_type === 'case') cases.push(row);
    else if (c.authority_type === 'statute') statutes.push(row);
    else if (c.authority_type === 'regulation') regs.push(row);
    else other.push(row);
  }
  const sections = [];
  sections.push('# Table of Authorities\n');
  sections.push('Legend: ✓ verified clean · ⊕ verified, minor issue · ⊖ unverified, model concern · ✗ verified mismatch · ◇ Westlaw paste needed\n');
  if (cases.length)    sections.push('## Cases\n\n' + dedup(cases).join('\n') + '\n');
  if (statutes.length) sections.push('## Statutes\n\n' + dedup(statutes).join('\n') + '\n');
  if (regs.length)     sections.push('## Regulations\n\n' + dedup(regs).join('\n') + '\n');
  if (other.length)    sections.push('## Other\n\n' + dedup(other).join('\n') + '\n');
  return sections.join('\n');
}

function renderReport(draftPath, results) {
  const lines = [];
  lines.push(`# Cite-Check Report`);
  lines.push('');
  lines.push(`**Draft:** \`${path.basename(draftPath)}\``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Citations checked:** ${results.length}`);
  const flagged = results.filter((r) => r.flag !== 'green').length;
  lines.push(`**Flagged (yellow/red/blue):** ${flagged}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const r of results) {
    const c = r.cite;
    lines.push(`## ${FLAG_GLYPH[r.flag]} ${c.citation_bluebook ?? c.raw}`);
    lines.push('');
    lines.push(`- **Status:** ${FLAG_LABEL[r.flag]} (${r.verification_status})`);
    lines.push(`- **Confidence:** ${r.rating}`);
    if (c.proposition) lines.push(`- **Cited for:** ${c.proposition}`);
    if (c.pin_cite) lines.push(`- **Pin:** ${c.pin_cite}`);
    if (c.signal) lines.push(`- **Signal:** ${c.signal}`);
    if (r.source_url) lines.push(`- **Source:** [${r.source_label}](${r.source_url})`);
    else if (r.source_label) lines.push(`- **Source:** ${r.source_label}`);
    if (r.justification) lines.push(`- **Note:** ${r.justification}`);
    if (r.flags.length) {
      lines.push(`- **Flags:**`);
      for (const f of r.flags) lines.push(`  - \`${f.kind}\`: ${f.detail}`);
    }
    if (c.location) {
      lines.push(`- **In draft:** _"${c.location.replace(/\n/g, ' ').slice(0, 200)}"_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function dedup(rows) {
  return Array.from(new Set(rows));
}
