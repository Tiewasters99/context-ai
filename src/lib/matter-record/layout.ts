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
      'This is a mechanical account of what was done on this matter inside Contextspaces, ' +
      'assembled from the matter’s Record. The Record is tamper-evident: each entry is sealed to ' +
      'the one before it, so any later change, removal or insertion of an entry would be detected ' +
      'when the Record is checked. Entries cannot be edited or deleted. No part of this document ' +
      'was written by a model; every figure below is copied from a recorded entry.',
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
      text: 'Recording has not been switched on for this account yet, so there is nothing to report.',
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
        } entries — this export stops at ${doc.integrity.ceiling}. The integrity check below still ` +
        'covers every entry, including the ones this export does not list.',
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

  // 2b ----------------------------------------------------------------------
  // Inside the session index rather than as a section of its own: these are
  // AI uses on this matter, and the numbering of the sections below is
  // referred to elsewhere in this document.
  out.push({ type: 'h3', text: 'Feature AI calls — model calls made by a feature, outside a chat session' });
  out.push({
    type: 'p',
    text:
      'Bucketizer, Cite-Check, the Editor, Deck Composer, the AI Workbench and Moot Bench call a ' +
      'model directly rather than through a chat session, so they have no session above. One row ' +
      'here is one feature on one model at one confidentiality tier, with every call it made on ' +
      'this matter summed. The counts are of calls, not of documents.',
  });
  if (doc.featureCalls.length === 0) {
    out.push({
      type: 'p',
      text:
        'None recorded. A feature’s model call is recorded in the same way as everything else ' +
        'here; where a matter shows none, either no feature was used on it or this part of the ' +
        'product had not been switched on for this account at the time.',
    });
  } else {
    out.push({
      type: 'table',
      headers: ['Feature and act', 'Model', 'Route', 'Tier', 'Calls', 'Refused', 'Did not finish', 'Input tokens', 'Output tokens', 'Estimated cost', 'First', 'Last'],
      rows: doc.featureCalls.map((f) => [
        f.title,
        f.model,
        f.route,
        f.tier,
        String(f.calls),
        f.refused === 0 ? '0' : `${f.refused} (${f.refusedReasons})`,
        String(f.unfinished + f.failed),
        f.tokensReportedFor === 0 ? 'not reported' : String(f.inputTokens),
        f.tokensReportedFor === 0 ? 'not reported' : String(f.outputTokens),
        f.tokensReportedFor === 0 ? 'not reported' : money(f.cost, f.costRecorded),
        f.firstUse,
        f.lastUse,
      ]),
    });
    const streamed = doc.featureCalls.reduce((n, f) => n + f.streamed, 0);
    const partial = doc.featureCalls.filter((f) => f.tokensReportedFor < f.calls - f.refused);
    if (streamed > 0 || partial.length > 0) {
      out.push({
        type: 'note',
        text:
          'Where a model streams its answer back word by word, it reports no token count that ' +
          'this product is willing to record as fact, so those calls show "not reported" rather ' +
          'than an estimate. The calls themselves are recorded in full either way.',
      });
    }
    const refusedTotal = doc.featureCalls.reduce((n, f) => n + f.refused, 0);
    if (refusedTotal > 0) {
      out.push({
        type: 'p',
        text:
          `${refusedTotal} of these calls ${refusedTotal === 1 ? 'was' : 'were'} refused. A refused ` +
          'call reached no model at all: the reason is recorded beside it, and nothing was sent.',
      });
    }
    const unfinishedTotal = doc.featureCalls.reduce((n, f) => n + f.unfinished, 0);
    if (unfinishedTotal > 0) {
      out.push({
        type: 'p',
        text:
          `${unfinishedTotal} ${unfinishedTotal === 1 ? 'call was' : 'calls were'} recorded as asked ` +
          'and never recorded as answered. The model was contacted; what came back, if anything, ' +
          'was not recorded. They are counted under “Did not finish” above and are not counted as ' +
          'answers anywhere in this document.',
      });
    }
  }
  out.push({
    type: 'pairs',
    rows: [
      ['Purpose of these runs (counsel)', ATTORNEY_CELL],
      ['Confidential input (counsel)', ATTORNEY_CELL],
      ['Output relied on (counsel)', ATTORNEY_CELL],
      ['Initials', ATTORNEY_CELL],
    ],
  });

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
        'This is also what is shown where account-wide recording has not been switched on for ' +
        'this account, in which case an entry of this kind cannot exist yet.',
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
        'None recorded. Exports, sends and deliveries are recorded in the same way as everything ' +
        'else here, but the part of the product that writes them has not been switched on for ' +
        'this account yet — so a download or an email of a document leaves no entry here. The ' +
        'absence of an entry is therefore not evidence that nothing left the matter.',
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
      ['Seal of the first entry', doc.integrity.firstHash ?? '—'],
      ['Seal of the last entry', doc.integrity.lastHash ?? '—'],
      ['Prepared', doc.integrity.generatedAt],
      ['Prepared by', doc.integrity.generatedBy],
    ],
  });
  out.push({ type: 'p', text: doc.integrity.meaning });
  out.push({
    type: 'p',
    text:
      'The seals above are the digital fingerprints of the first and last entries in this ' +
      'export. Anyone holding a later copy of this Record can compare them and confirm it is ' +
      'the same Record, with the same entries, in the same order.',
  });
  out.push({ type: 'h3', text: 'How this Record can be relied on' });
  out.push({
    type: 'p',
    text:
      'Entries are written automatically, as the work happens: each AI answer, each model call a ' +
      'feature made, each tool a connected assistant ran, each change to who can see the matter, ' +
      'and each change to its confidentiality tier. Nobody can edit or delete an entry once it ' +
      'is written — not a member of the matter, not the firm, and not Contextspaces; repairing ' +
      'an entry would require a deliberate, visible change to the database itself, which the ' +
      'check below is designed to expose.',
  });
  out.push({
    type: 'p',
    text:
      'The check reads every entry in order and re-verifies the seal linking it to the entry ' +
      'before it. “Intact” means every seal matched, so no entry has been altered, removed or ' +
      'inserted since it was written. It does not mean the entries are complete: the Record ' +
      'shows what was recorded, and an act the product did not record would not appear here at ' +
      'all. Work done on this matter outside Contextspaces is not recorded and cannot be ' +
      'inferred from its absence. Nothing in this document is a legal characterisation of the ' +
      'Record or of its use in any proceeding.',
  });
  if (doc.integrity.chains.length > 0) {
    out.push({
      type: 'table',
      headers: ['Matter', 'Record', 'Entries checked', 'Result'],
      rows: doc.integrity.chains.map((c) => [
        c.matterName,
        c.matterId,
        String(c.checked),
        c.unavailable
          ? 'could not be checked from this account'
          : c.ok
            ? 'intact'
            : `the check fails at entry ${c.firstBadSeq ?? '?'} — entries from that point on `
              + 'cannot be relied on until this is explained',
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
        'No jurisdiction was selected for this export. The rules matrix that comes with ' +
        'Contextspaces can print the forum court’s, the licensing state’s or a national guidance ' +
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
      'A connected assistant’s search that names no matter touches many matters at once. Where ' +
        'account-wide recording has been switched on, this matter’s Record gains one entry for ' +
        'each such search that returned passages from this matter, and that entry says nothing ' +
        'about any other matter it may also have read. Where it has not, such a search leaves no ' +
        'entry anywhere and does not appear here.',
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
