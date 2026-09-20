// The Matter Record's layout, once, for every output format.
//
// The .md and the .docx are the same document. Rather than write it twice and
// let the two drift, the whole thing is laid out here as a list of blocks, and
// each renderer only has to know how to draw a heading, a paragraph, a
// two-column table and a grid.
//
// Deterministic by construction: every string comes from the assembled
// document model, and nothing here reads the clock or the locale.

import { ATTORNEY_CELL, DRAFT_LEGEND, type MatterRecordDoc, type LineRow } from './assemble';
import type { JurisdictionEntry } from './types';

export type Block =
  | { type: 'title'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'legend'; text: string }
  | { type: 'p'; text: string }
  | { type: 'note'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'pairs'; rows: [string, string][] }
  | { type: 'table'; headers: string[]; rows: string[][] };

function money(value: number, recorded: boolean): string {
  return recorded ? `$${value.toFixed(4)}` : 'not recorded';
}

function lineTable(rows: LineRow[], withKind: boolean): Block {
  return withKind
    ? {
        type: 'table',
        headers: ['When (UTC)', 'What', 'Who', 'Matter', 'Kind'],
        rows: rows.map((r) => [r.when, r.what, r.who, r.matter, r.kind]),
      }
    : {
        type: 'table',
        headers: ['When (UTC)', 'What', 'Who', 'Matter'],
        rows: rows.map((r) => [r.when, r.what, r.who, r.matter]),
      };
}

function jurisdictionBlocks(entry: JurisdictionEntry, matrixVersion: string): Block[] {
  const out: Block[] = [];
  out.push({ type: 'h3', text: entry.name ?? entry.id });
  out.push({
    type: 'p',
    text:
      `Printed verbatim from the AI Use Record rules matrix, version ${matrixVersion}, entry ` +
      `${entry.id}. The wording below is the matrix’s own; this export adds no characterisation ` +
      'of the law.',
  });
  out.push({
    type: 'pairs',
    rows: [
      ['Entry id', entry.id],
      ['Kind', entry.kind ?? '—'],
      ['Status in the matrix', entry.status ?? '—'],
      ['Verified on', entry.verified_on ?? 'not verified'],
      ['Verified by', entry.verified_by ?? '—'],
      ['Attorney sign-off', entry.attorney_signoff ?? ATTORNEY_CELL],
      ['Disclosure to court', entry.disclosure_to_court ?? '—'],
      [
        'Certification required',
        entry.certification_required === null || entry.certification_required === undefined
          ? '—'
          : String(entry.certification_required),
      ],
      ['Record-keeping duty', entry.record_keeping_duty ?? '—'],
      ['Client disclosure duty', entry.client_disclosure_duty ?? '—'],
    ],
  });
  if (entry.status && entry.status !== 'verified') {
    out.push({
      type: 'note',
      text:
        `This entry is marked "${entry.status}" in the matrix. The matrix’s own rule is that a ` +
        'draft or stale entry is re-verified against the primary source before a record relies on it.',
    });
  }
  const longFields: [string, string | null | undefined][] = [
    ['Verification duty', entry.verification_duty],
    ['Confidentiality restriction', entry.confidentiality_restriction],
    ['Fees note', entry.fees_note],
    ['Certificate language required by the rule', entry.certificate_language],
    ['Matrix notes', entry.notes],
  ];
  for (const [label, value] of longFields) {
    if (!value) continue;
    out.push({ type: 'h3', text: label });
    for (const paragraph of String(value).split(/\n{2,}/)) {
      const text = paragraph.trim();
      if (text) out.push({ type: 'quote', text });
    }
  }
  const sources = entry.sources ?? [];
  if (sources.length > 0) {
    out.push({ type: 'h3', text: 'Sources' });
    for (const source of sources) {
      const dates = [
        source.effective ? `effective ${source.effective}` : null,
        source.fetched ? `fetched ${source.fetched}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      out.push({
        type: 'p',
        text: `${source.title ?? 'Source'}${source.url ? ` — ${source.url}` : ''}${
          dates ? ` (${dates})` : ''
        }`,
      });
      if (source.verbatim) {
        out.push({ type: 'quote', text: String(source.verbatim).replace(/\s*\n\s*/g, ' ').trim() });
      }
    }
  }
  return out;
}

/** The whole Matter Record, block by block, in reading order. */
export function matterRecordBlocks(doc: MatterRecordDoc): Block[] {
  const out: Block[] = [];

  out.push({ type: 'title', text: doc.title });
  out.push({ type: 'legend', text: DRAFT_LEGEND });
  out.push({
    type: 'pairs',
    rows: [
      ['Matter', doc.matter.name],
      [
        'Sub-matters included',
        doc.subMatters.length === 0 ? 'none' : doc.subMatters.map((m) => m.name).join('; '),
      ],
      [
        'Period covered',
        doc.fromDay && doc.toDay
          ? doc.fromDay === doc.toDay
            ? doc.fromDay
            : `${doc.fromDay} to ${doc.toDay}`
          : 'nothing recorded yet',
      ],
      ['Prepared', doc.integrity.generatedAt],
      ['Prepared by', doc.generatedBy],
      ['Entries covered', String(doc.integrity.entriesShown)],
      ['Record check', doc.integrity.headline],
    ],
  });
  out.push({
    type: 'p',
    text:
      'This is a mechanical account of what was done to this matter inside Contextspaces, ' +
      'assembled from the matter’s Record: an append-only, hash-chained list of recorded acts. ' +
      'Each entry is chained to the one before it, so an entry cannot be altered or removed ' +
      'without the chain failing to verify. No part of this document was written by a model; ' +
      'every figure below is copied from a recorded entry.',
  });
  out.push({
    type: 'p',
    text:
      'The Record holds metadata only — who acted, when, which model answered, which tool ran. ' +
      'It holds no document text, no prompt and no answer, so nothing privileged is reproduced here.',
  });

  if (doc.notDeployed) {
    out.push({
      type: 'note',
      text: 'The Record is not enabled in this installation yet, so there is nothing to report.',
    });
  }
  if (doc.error) {
    out.push({ type: 'note', text: `The Record could not be read in full: ${doc.error}` });
  }
  if (doc.integrity.truncated) {
    out.push({
      type: 'note',
      text:
        `Showing ${doc.integrity.entriesShown} of ${
          doc.integrity.entriesTotal ?? 'an unknown number of'
        } entries — this export stops at ${doc.integrity.ceiling}. The chain check below still ` +
        'covers every entry, because it runs in the database.',
    });
  }

  // 1 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '1. Tools memo — every model and assistant that touched this matter' });
  out.push({
    type: 'p',
    text:
      'One block per model, channel and tier. “Retention and training” states the terms as they ' +
      'were understood on the day this export was prepared; where it is bracketed, it is for ' +
      'counsel to confirm. Nothing here asserts a provider’s terms as fact.',
  });
  if (doc.tools.length === 0) {
    out.push({
      type: 'p',
      text: 'No model or connected assistant is recorded as having touched this matter.',
    });
  } else {
    doc.tools.forEach((tool, i) => {
      out.push({ type: 'h3', text: `T${i + 1} — ${tool.title}` });
      out.push({
        type: 'pairs',
        rows: [
          ['Channel', tool.channel],
          ['Model', tool.model],
          ['Provider', tool.provider],
          ['Matter tier at the time', tool.tier],
          ['Route', tool.route],
          ['Retention and training', tool.retention],
          ['First use', tool.firstUse],
          ['Last use', tool.lastUse],
          ['Recorded uses', String(tool.uses)],
          ['What may go in (counsel)', ATTORNEY_CELL],
          ['Terms confirmed by (initials)', ATTORNEY_CELL],
        ],
      });
    });
  }

  // 2 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '2. Session index' });
  out.push({
    type: 'p',
    text:
      'One block per AI session recorded on this matter or a sub-matter. The mechanical cells are ' +
      'filled from the Record; Purpose, Confidential input, Output relied on and Initials are ' +
      'counsel’s and are left empty.',
  });
  if (doc.sessions.length === 0) {
    out.push({ type: 'p', text: 'No AI session is recorded on this matter.' });
  } else {
    doc.sessions.forEach((s, i) => {
      out.push({
        type: 'h3',
        text: `S${i + 1} — ${s.firstDay}${s.lastDay !== s.firstDay ? ` to ${s.lastDay}` : ''}`,
      });
      out.push({
        type: 'pairs',
        rows: [
          ['Session id', s.sessionId],
          ['Matter', s.matterName],
          ['Asked by', s.actor],
          ['Model(s)', s.models || 'not recorded'],
          ['Provider', s.provider],
          ['Matter tier', s.tier],
          ['Route', s.route],
          ['Exchanges recorded', String(s.exchanges)],
          ['Input tokens', String(s.inputTokens)],
          ['Output tokens', String(s.outputTokens)],
          ['Estimated cost', money(s.cost, s.costRecorded)],
          ['Tools used', s.toolsUsed],
          ['Within policy', s.withinPolicy],
          ['Escalations', s.escalations],
          ['Exchanges ending in an error', String(s.errors)],
          ['Purpose (counsel)', ATTORNEY_CELL],
          ['Confidential input (counsel)', ATTORNEY_CELL],
          ['Output relied on (counsel)', ATTORNEY_CELL],
          ['Initials', ATTORNEY_CELL],
        ],
      });
    });
  }

  // 3 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '3. Connector activity — tool calls by connected AI clients' });
  if (doc.connectors.length === 0) {
    out.push({
      type: 'p',
      text: 'No connected AI client is recorded as having called a tool on this matter.',
    });
  } else {
    out.push({
      type: 'table',
      headers: ['Client', 'Tool', 'Calls', 'Refused (sealed)', 'Failed', 'First', 'Last'],
      rows: doc.connectors.map((c) => [
        c.client,
        c.tool,
        String(c.calls),
        String(c.refusedSealed),
        String(c.failed),
        c.firstUse,
        c.lastUse,
      ]),
    });
  }
  out.push({
    type: 'p',
    text:
      `In-app and worker tool calls recorded on this matter: ${doc.inAppToolCalls}. ` +
      `Agent-charter tool calls: ${doc.agentToolCalls}.`,
  });

  // Account-wide activity (migration 072). Counted from this matter's own
  // rows, which is the only way to say this without saying anything about a
  // matter the reader may have no right to know exists.
  out.push({ type: 'h3', text: 'Account-wide activity' });
  if (doc.accountWideReads === 0) {
    out.push({ type: 'p', text: 'None recorded.' });
    out.push({
      type: 'note',
      text:
        'This is also what is shown before migration 072 is applied, when an entry of this kind ' +
        'cannot exist yet.',
    });
  } else {
    const n = doc.accountWideReads;
    out.push({
      type: 'p',
      text:
        `${n} search${n === 1 ? '' : 'es'} run by a connected assistant across every matter that ` +
        `account can see returned passages from this matter, or from one of its sub-matters, ` +
        `during the period covered${
          doc.integrity.truncated ? ' (counted over the entries shown; this read stopped at its ceiling)' : ''
        }. What those searches returned from any other matter is not part of this matter’s Record ` +
        'and is not stated here.',
    });
  }

  // 4 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '4. Access and seal history' });
  if (doc.access.length === 0) {
    out.push({
      type: 'p',
      text: 'No membership change and no seal change is recorded for this matter.',
    });
  } else {
    out.push(lineTable(doc.access, false));
  }

  // 5 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '5. Exports and deliveries' });
  if (doc.exports.length === 0) {
    out.push({
      type: 'p',
      text:
        'None recorded. Export, send and delivery events are part of the Record’s vocabulary and ' +
        'are written by the export lane; until that change is in this installation, a download or ' +
        'an email of a document leaves no entry here. Absence of a row is therefore not evidence ' +
        'that nothing left the matter.',
    });
  } else {
    out.push(lineTable(doc.exports, true));
  }

  // 6 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '6. Cite-check runs' });
  if (doc.citeRuns.length === 0) {
    out.push({ type: 'p', text: 'No cite check has been run on this matter.' });
  } else {
    out.push({
      type: 'p',
      text: 'Run metadata only. Each run’s own report is exported from the Cite-Check tab, by run id.',
    });
    out.push({
      type: 'table',
      headers: ['Run id', 'Brief', 'Status', 'Citations', 'Date', 'Matter', 'Requested by'],
      rows: doc.citeRuns.map((r) => [
        r.runId,
        r.brief,
        r.status,
        String(r.citations),
        r.when,
        r.matter,
        r.requestedBy,
      ]),
    });
  }

  // 7 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '7. Integrity' });
  out.push({
    type: 'pairs',
    rows: [
      ['Record check', doc.integrity.headline],
      ['Entries in this export', String(doc.integrity.entriesShown)],
      [
        'Entries in the Record',
        doc.integrity.entriesTotal === null ? 'not counted' : String(doc.integrity.entriesTotal),
      ],
      ['First entry', doc.integrity.firstEntryAt ?? '—'],
      ['Last entry', doc.integrity.lastEntryAt ?? '—'],
      ['First entry hash', doc.integrity.firstHash ?? '—'],
      ['Last entry hash', doc.integrity.lastHash ?? '—'],
      ['Prepared', doc.integrity.generatedAt],
      ['Prepared by', doc.integrity.generatedBy],
    ],
  });
  out.push({ type: 'p', text: doc.integrity.meaning });
  if (doc.integrity.chains.length > 0) {
    out.push({
      type: 'table',
      headers: ['Matter', 'Chain', 'Entries checked', 'Result'],
      rows: doc.integrity.chains.map((c) => [
        c.matterName,
        c.matterId,
        String(c.checked),
        c.unavailable
          ? 'could not be checked from this account'
          : c.ok
            ? 'intact'
            : `fails at entry ${c.firstBadSeq ?? '?'}`,
      ]),
    });
  }

  // 8 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '8. The rules this record is kept against' });
  if (doc.jurisdiction) {
    out.push(...jurisdictionBlocks(doc.jurisdiction.entry, doc.jurisdiction.matrixVersion));
  } else {
    out.push({
      type: 'p',
      text:
        'No jurisdiction was selected for this export. The rules matrix bundled with this ' +
        'installation can print the forum court’s, the licensing state’s or a national guidance ' +
        'entry’s rule text here verbatim; select one when exporting.',
    });
  }
  out.push({
    type: 'pairs',
    rows: [
      ['Disclosure to the court required? (counsel’s determination)', ATTORNEY_CELL],
      ['If required, the rule relied on', ATTORNEY_CELL],
      ['Voluntary disclosure decision', ATTORNEY_CELL],
      ['Date decided', ATTORNEY_CELL],
      ['Initials', ATTORNEY_CELL],
    ],
  });

  // 9 -----------------------------------------------------------------------
  out.push({ type: 'h2', text: '9. Counsel’s review' });
  out.push({
    type: 'p',
    text:
      'This export is mechanical. It is not a certification, it is not legal advice, and it says ' +
      'nothing about whether any citation or factual assertion in any filing was verified — that ' +
      'is the Cite Verification Log’s job and counsel’s.',
  });
  out.push({
    type: 'pairs',
    rows: [
      ['Reviewed by (name)', ATTORNEY_CELL],
      ['Initials', ATTORNEY_CELL],
      ['Date reviewed', ATTORNEY_CELL],
      ['Corrections to this export (and where)', ATTORNEY_CELL],
    ],
  });

  // 10 ----------------------------------------------------------------------
  out.push({ type: 'h2', text: '10. What this record does not show' });
  out.push({
    type: 'bullets',
    items: [
      'A connected assistant’s search that names no matter touches many matters at once. It is ' +
        'recorded once migration 072 is applied: this matter’s Record then gains one entry for ' +
        'each such search that returned passages from this matter, and that entry says nothing ' +
        'about any other matter it may also have read. Before 072 is applied such a search ' +
        'leaves no entry anywhere and does not appear here.',
      'Work done on this matter outside Contextspaces — a browser chat, another firm’s tool, a ' +
        'local model — is not recorded and cannot be inferred from its absence.',
      'Document-level attestations, the citation verification log and the corrections log are ' +
        'kept separately and are not assembled here.',
      'The Record shows that an act happened; it does not show what was in the document the act ' +
        'was about.',
    ],
  });

  // Appendix ----------------------------------------------------------------
  out.push({ type: 'h2', text: 'Appendix A — chronology of every recorded act' });
  if (doc.chronology.length === 0) {
    out.push({ type: 'p', text: 'Nothing recorded.' });
  } else {
    out.push(lineTable(doc.chronology, true));
  }

  return out;
}
