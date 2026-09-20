// Grapheon Discovery — the package's accounting: what was produced, what was
// withheld, what was a duplicate, and what could not be produced at all.
//
// Why this file exists (F7, discovery/RE-VERIFICATION-2026-09-20.md)
// ---------------------------------------------------------------------------
// partitionItems() selected `status = 'ready'`, so a document that failed
// normalization was simply absent from the stamp, from the package and from
// the load file. The item row recorded the error; nothing in the delivered
// package said a document had been left out. Opposing counsel received a
// production with holes, and nobody — including the producing lawyer — knew.
//
// A production is a representation. It has to add up:
//
//     received = produced + privileged-withheld + duplicates + exceptions
//
// Every intaken item lands in exactly one of those four buckets, by this
// precedence:
//
//   exception  — it never reached 'ready'. It could not be rendered, so it
//                could not be reviewed, so it cannot honestly be called
//                anything else.
//   withheld   — tagged Privileged or Non-Responsive. Even a duplicate that
//                carries a privilege tag is withheld, never produced: the
//                conservative reading is the only safe one.
//   duplicate  — byte-for-byte identical (sha256) to an earlier item in this
//                same production. Produced once, under the first instance's
//                Bates number.
//   produced   — stamped, in IMAGES/, on the load file.
//
// The equation alone cannot fail — the precedence puts every row in one bucket
// by construction — so reconcile() also checks two things the buckets do not
// know about: that every produced document actually carries a Bates number,
// and that the number of registry rows the database holds for this production
// equals the number of pages the package claims to contain. Those can fail,
// and packaging refuses to finalize when they do.

export const DISPOSITIONS = ['produced', 'withheld', 'duplicate', 'exception'];

const CRLF = '\r\n';

// RFC 4180, quoted unconditionally: a filename may contain a comma, a quote or
// a newline, and a production manifest that a paralegal opens in Excel must
// not shift a column because of one.
function cell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export function toCsv(header, rows) {
  return Buffer.from(
    [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join(CRLF) + CRLF,
    'utf8',
  );
}

/**
 * The exceptions report. One row per document that was intaken but could not
 * be produced, by the identity opposing counsel can check: the path it had
 * inside the delivered ZIP or folder, its sha256, and a plain reason.
 *
 * Distinct from the privilege log — nothing here was withheld as a judgment.
 * These are documents the software could not render.
 */
export function exceptionsCsv(items) {
  return toCsv(
    ['ORIGINAL_PATH', 'FILENAME', 'SHA256', 'SIZE_BYTES', 'REASON'],
    items.map((i) => [
      i.original_path ?? i.original_filename ?? '',
      i.original_filename ?? '',
      i.sha256 ?? '',
      i.file_size_bytes ?? '',
      exceptionReason(i),
    ]),
  );
}

/**
 * A 'pending' item is one intake never finished. It has no `error` of its own,
 * so say what is true rather than leaving the cell blank.
 */
export function exceptionReason(item) {
  if (item?.error) return String(item.error);
  if (item?.status === 'pending') return 'Intake did not finish for this document; it was never rendered or reviewed.';
  return `Item status '${item?.status ?? 'unknown'}'.`;
}

/**
 * The duplicates report. Each row names the Bates number the document WAS
 * produced under, so "where is this file?" has an answer.
 */
export function duplicatesCsv(rows) {
  return toCsv(
    ['ORIGINAL_PATH', 'FILENAME', 'SHA256', 'DUPLICATE_OF_FILENAME', 'PRODUCED_AS_BEGBATES', 'PRODUCED_AS_ENDBATES'],
    rows.map((r) => [
      r.original_path ?? r.original_filename ?? '',
      r.original_filename ?? '',
      r.sha256 ?? '',
      r.firstFilename ?? '',
      r.firstBatesFirst ?? '',
      r.firstBatesLast ?? '',
    ]),
  );
}

/**
 * @param {object} c
 * @param {number} c.received        every production_items row in the production
 * @param {number} c.produced        documents in IMAGES/ and on the load file
 * @param {number} c.withheld        privileged / non-responsive
 * @param {number} c.duplicates      exact sha256 duplicates, produced under the first instance
 * @param {number} c.exceptions      intaken but not renderable
 * @param {number} c.unnumbered      produced documents with no bates_first — must be 0
 * @param {number} c.producedPages   pages the package claims
 * @param {number} c.registeredPages bates_registry rows the database holds for this production
 * @returns {{ok: boolean, problems: string[]}}
 */
export function reconcile(c) {
  const problems = [];
  const sum = c.produced + c.withheld + c.duplicates + c.exceptions;
  if (sum !== c.received) {
    problems.push(
      `${c.received} document(s) were intaken but ${c.produced} produced + ${c.withheld} withheld `
      + `+ ${c.duplicates} duplicate(s) + ${c.exceptions} exception(s) = ${sum}`);
  }
  if (c.unnumbered > 0) {
    problems.push(`${c.unnumbered} document(s) in the produced set carry no Bates number`);
  }
  if (c.registeredPages !== c.producedPages) {
    problems.push(
      `the Bates registry holds ${c.registeredPages} page(s) for this production, `
      + `but the package accounts for ${c.producedPages}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The human-readable statement that ships inside the package. It is the
 * producing lawyer's own arithmetic, in the package, checkable by the
 * receiving one.
 */
export function reconciliationText(c, { matterName, productionName, batesFirst, batesLast, dateStr }) {
  const { ok, problems } = reconcile(c);
  const lines = [
    'PRODUCTION RECONCILIATION',
    '',
    `Matter:       ${matterName ?? ''}`,
    `Production:   ${productionName ?? ''}`,
    `Bates range:  ${batesFirst ?? ''} - ${batesLast ?? ''}`,
    `Prepared:     ${dateStr ?? ''}`,
    '',
    'Every document taken into this production is accounted for in exactly one',
    'line below.',
    '',
    `  Documents received into the production .......... ${c.received}`,
    `    produced (IMAGES/, DATA/loadfile.dat) ........ ${c.produced}   (${c.producedPages} page(s))`,
    `    withheld as privileged / non-responsive ...... ${c.withheld}   (see PrivilegeLog.pdf)`,
    `    exact duplicates, produced once .............. ${c.duplicates}   (see DATA/DUPLICATES.csv)`,
    `    could not be produced ........................ ${c.exceptions}   (see DATA/EXCEPTIONS.csv)`,
    '',
    `  Bates numbers assigned in this production ...... ${c.registeredPages}`,
    '',
    ok
      ? 'These figures reconcile.'
      : 'THESE FIGURES DO NOT RECONCILE:',
  ];
  for (const p of problems) lines.push(`  - ${p}`);
  lines.push('');
  return Buffer.from(lines.join(CRLF) + CRLF, 'utf8');
}
