// The Method panel: the procedure tables, read-only, with their hash and how
// to change them. The same tables the report prints in its Method section.

import { useEffect, useState } from 'react';
import { PROCEDURE, HOW_TO_CHANGE, procedureHash } from '../../../lib/trademark/procedure.mjs';
import { mono, td, th } from './styles';
import { Note, Panel, Scroll } from './ui';

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <Scroll>
      <table className="w-full min-w-[520px] border-collapse">
        <thead><tr className="border-b border-white/10">{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-white/5">{r.map((c, j) => <td key={j} className={td}>{c}</td>)}</tr>)}</tbody>
      </table>
    </Scroll>
  );
}

export default function MethodPanel({ storedHash }: { storedHash: string | null }) {
  const [hash, setHash] = useState<string>('');
  useEffect(() => {
    let live = true;
    void procedureHash().then((h) => { if (live) setHash(h); });
    return () => { live = false; };
  }, []);
  const p = PROCEDURE;
  const h4 = 'mt-4 mb-1 text-[12px] font-semibold text-white/80';
  return (
    <Panel id="tm-method" title="Method">
      <p className={`text-[12px] text-white/75 break-all ${mono}`}>Procedure version (sha256): {hash || '…'}</p>
      {storedHash && hash && storedHash !== hash && (
        <p className="mt-1 text-[12px] text-[#e8b84a]">The queries in this clearance were generated under an earlier version ({storedHash.slice(0, 12)}…).</p>
      )}
      <Note>{HOW_TO_CHANGE}</Note>

      <h4 className={h4}>Search syntax</h4>
      <Note>Source: {p.syntax.source}, verified {p.syntax.verified}.</Note>
      <ul className="mt-1 list-disc pl-5 text-[12px] text-white/75">{p.syntax.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <Table head={['Tag', 'Meaning']} rows={p.syntax.tags.map((t) => [t.tag, t.meaning])} />

      <h4 className={h4}>Substitutions</h4>
      <Table head={['From', 'To', 'Tier', 'Why']} rows={p.substitutions.rows.map((r) => [r.from + (r.initialOnly ? ' (initial)' : ''), r.to.join(', '), r.tier, r.why])} />
      <Note>Caps: {p.substitutions.variantCap} whole-word variants, {p.substitutions.stemCap} stems, {p.substitutions.endingCap} endings.</Note>

      <h4 className={h4}>Endings</h4>
      <Note>{p.endings.rule} {p.endings.why}</Note>

      <h4 className={h4}>Exclusion defaults (Q8)</h4>
      <Table head={['Opening', 'Excluded stems', 'Why']} rows={Object.entries(p.exclusions.defaults).map(([o, l]) => [o, l.map((x) => `${x}*`).join(' '), p.exclusions.why[o] ?? ''])} />
      <Note>Review threshold {p.exclusions.reviewThreshold} records; frequency floor {p.exclusions.frequencyFloor} words.</Note>

      <h4 className={h4}>Class notes</h4>
      <Table head={['Class', 'Covers', 'Why']} rows={p.classes.notes.map((n) => [n.code, n.label, n.why])} />

      <h4 className={h4}>Self-test</h4>
      <Note>SN:{p.selftest.serial} must return exactly {p.selftest.expect}. {p.selftest.why}</Note>

      <h4 className={h4}>Phrases this product never prints</h4>
      <Table head={['Phrase', 'Why']} rows={p.forbidden.phrases.map((f) => [`“${f.phrase}”${f.unlessFollowedBy ? ` unless followed by “${f.unlessFollowedBy}”` : ''}`, f.why])} />
    </Panel>
  );
}
