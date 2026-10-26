// lib/trademark/register/xml.mjs — the USPTO trademark applications XML
// (daily files apcYYMMDD.zip and the annual backfile pieces), streamed.
//
// Shape [V 10-21, "Trademark Applications Daily XML DTD Element Documentation
// (V 2.0)", uspto.gov/sites/default/files/products/applications-documentation.pdf]:
//
//   <trademark-applications-daily>
//     <version><version-no>…</version-no><version-date>YYYYMMDD</version-date></version>
//     <application-information>
//       <data-available-code>N</data-available-code>        (only when there is NO data)
//       <file-segments><file-segment>TRMK</file-segment>
//         <action-keys><action-key>NA</action-key>
//           <case-file>
//             <serial-number>8 digits</serial-number>
//             <registration-number>7 digits, zeros when none</registration-number>
//             <transaction-date>YYYYMMDD</transaction-date>
//             <case-file-header> filing-date, registration-date, status-code (3 digits),
//               status-date, mark-identification, mark-drawing-code, abandonment-date,
//               cancellation-date, attorney-name, … (a date with no value holds zeros)
//             <case-file-statements><case-file-statement><type-code/><text/>…
//               type-code GSccc1/2/3 = goods and services of prime class ccc,
//               PMnnnn = pseudo mark, TRnnn0 = translation, TLIT00 = transliteration
//             <classifications><classification> international-code*, us-code*,
//               primary-code, status-code (class status), first-use dates
//             <case-file-owners><case-file-owner> party-type, party-name, …
//             <design-searches><design-search><code>6 digits</code>
//             … (event statements, prior registrations, foreign applications,
//                international registration, Madrid history: read, not stored)
//
// The current files are DTD version 2.3 (since 2024-10-18, per the BDSS
// listing) and the documentation read is 2.0, so the parser is TOLERANT: it
// builds a small generic tree per <case-file> and reads the elements it knows;
// any other element is ignored, never an error. The file's own version-no and
// version-date are returned with every record so a format change is visible.
//
// STREAMED: never the whole file in memory. Bytes are fed to the `sax` parser
// chunk by chunk and finished records are yielded after each chunk, so memory
// holds one chunk plus the records completed in it.
//
// The files are UNTRUSTED DATA: this only parses text. No DTD is fetched
// (sax does not resolve external entities), nothing is executed.

import sax from 'sax';
import statusCodes from './status-codes.json' with { type: 'json' };

export const PARSER_VERSION = 'tm-register-xml/1';

/** YYYYMMDD → YYYY-MM-DD; zeros, blanks or a bad date → null. */
export function xmlDate(s) {
  const t = String(s ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m || /^0+$/.test(t)) return null;
  if (m[2] === '00' || m[3] === '00') return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Live or dead from the status code and the abandonment / cancellation dates (status-codes.json, [M]). */
export function liveFrom({ statusCode, abandonmentDate, cancellationDate }, table = statusCodes) {
  if (abandonmentDate || cancellationDate) return false;
  const n = Number(statusCode);
  if (Number.isInteger(n)) {
    if ((table.dead_codes ?? []).map(Number).includes(n)) return false;
    for (const r of table.dead_ranges ?? []) if (n >= r.from && n <= r.to) return false;
  }
  return true;
}

/** A plain-text status line the existing triage reads (parse.mjs liveFromStatus): LIVE … / DEAD …. */
export function statusLine(rec) {
  const bits = [];
  if (rec.status_code) bits.push(`status code ${rec.status_code}`);
  if (rec.abandonment_date) bits.push(`abandoned ${rec.abandonment_date}`);
  if (rec.cancellation_date) bits.push(`cancelled ${rec.cancellation_date}`);
  if (rec.registration_number) bits.push(`reg. ${rec.registration_number}`);
  return `${rec.live ? 'LIVE' : 'DEAD'}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

const kids = (node, name) => (node?.c ?? []).filter((x) => x.n === name);
const kid = (node, name) => kids(node, name)[0] ?? null;
const text = (node) => (node ? node.t.trim() : '');
const kidText = (node, name) => text(kid(node, name));

/** One <case-file> tree → one register row. Returns null when it has no serial. */
export function caseFileToRecord(cf, { versionNo = null, versionDate = null, actionKey = null, fileName = null, asOf = null } = {}) {
  const serial = kidText(cf, 'serial-number').replace(/\D/g, '');
  if (!/^\d{8}$/.test(serial)) return null;
  const regRaw = kidText(cf, 'registration-number').replace(/\D/g, '');
  const registration_number = regRaw && !/^0+$/.test(regRaw) ? regRaw.replace(/^0+/, '') : null;
  const h = kid(cf, 'case-file-header');

  const statements = kids(kid(cf, 'case-file-statements'), 'case-file-statement').map((s) => ({
    type: kidText(s, 'type-code').toUpperCase(),
    text: kids(s, 'text').map(text).filter(Boolean).join(' '),
  })).filter((s) => s.type);
  const pseudo = statements.filter((s) => s.type.startsWith('PM')).map((s) => s.text).filter(Boolean);
  const translations = statements.filter((s) => s.type.startsWith('TR')).map((s) => s.text).filter(Boolean);
  const transliterations = statements.filter((s) => s.type.startsWith('TLIT')).map((s) => s.text).filter(Boolean);
  // Goods and services: GS + prime class + qualifier (1 plain, 2 "less goods" only, 3 embedded "less goods").
  const goods = [];
  for (const s of statements) {
    const m = /^GS(\d{3}|[A-Z0-9]{3})([0-9])$/.exec(s.type);
    if (!m || !s.text) continue;
    goods.push({ class: m[1], qualifier: m[2], text: s.text });
  }

  const intl = new Set();
  const us = new Set();
  const classStatus = [];
  for (const c of kids(kid(cf, 'classifications'), 'classification')) {
    for (const ic of kids(c, 'international-code')) {
      const v = text(ic).toUpperCase();
      if (/^\d{1,3}$/.test(v)) intl.add(v === '200' ? '200' : v.padStart(3, '0'));
      else if (/^0*[AB]$/.test(v)) intl.add(v.replace(/^0+/, ''));
    }
    for (const uc of kids(c, 'us-code')) {
      const v = text(uc).toUpperCase();
      if (/^\d{1,3}$/.test(v)) us.add(v.padStart(3, '0'));
      else if (/^0*[AB]$/.test(v)) us.add(v.replace(/^0+/, ''));
    }
    const cs = kidText(c, 'status-code');
    if (cs) classStatus.push({ primary: kidText(c, 'primary-code') || null, status: cs });
  }

  const owners = kids(kid(cf, 'case-file-owners'), 'case-file-owner').map((o) => ({
    party_type: kidText(o, 'party-type') || null,
    name: kidText(o, 'party-name') || null,
    entity: kidText(o, 'legal-entity-type-code') || null,
  })).filter((o) => o.name);
  // The display owner: the highest party type (the latest owner of record).
  const owner = [...owners].sort((a, b) => Number(b.party_type ?? 0) - Number(a.party_type ?? 0))[0]?.name ?? null;

  const designCodes = [...new Set(kids(kid(cf, 'design-searches'), 'design-search')
    .map((d) => kidText(d, 'code').replace(/\D/g, '')).filter((c) => /^\d{6}$/.test(c)))];

  const rec = {
    serial,
    registration_number,
    mark: kidText(h, 'mark-identification') || null,
    pseudo_marks: pseudo,
    translations,
    transliterations,
    mark_drawing_code: kidText(h, 'mark-drawing-code') || null,
    status_code: kidText(h, 'status-code') || null,
    status_date: xmlDate(kidText(h, 'status-date')),
    filing_date: xmlDate(kidText(h, 'filing-date')),
    registration_date: xmlDate(kidText(h, 'registration-date')),
    abandonment_date: xmlDate(kidText(h, 'abandonment-date')),
    cancellation_date: xmlDate(kidText(h, 'cancellation-date')),
    attorney_name: kidText(h, 'attorney-name') || null,
    owners,
    owner,
    int_classes: [...intl].sort(),
    us_classes: [...us].sort(),
    class_status: classStatus,
    goods,
    design_codes: designCodes,
    transaction_date: xmlDate(kidText(cf, 'transaction-date')),
    action_key: actionKey,
    source_file: fileName,
    source_version: versionNo,
    source_version_date: versionDate,
    as_of: asOf,
  };
  rec.live = liveFrom({ statusCode: rec.status_code, abandonmentDate: rec.abandonment_date, cancellationDate: rec.cancellation_date });
  return rec;
}

export class RegisterXmlError extends Error {
  constructor(message) { super(message); this.name = 'RegisterXmlError'; }
}

/**
 * Stream the records of one file.
 *
 * @param {AsyncIterable<Uint8Array|string>} source  the XML bytes (a file stream or a zip entry stream)
 * @param {{fileName?:string, asOf?:string|null, onHeader?:(h:{versionNo:string|null, versionDate:string|null, dataAvailable:boolean})=>void}} [o]
 * @returns {AsyncGenerator<object>}  one register row per <case-file> with a serial
 */
export async function* streamRecords(source, { fileName = null, asOf = null, onHeader } = {}) {
  const parser = sax.parser(true, { trim: false, normalize: false, lowercase: true, xmlns: false, position: false });
  const done = [];
  let error = null;
  const stack = []; // the open path, element names
  let cf = null; // the open case-file tree
  const cfStack = []; // nodes inside the case-file
  let versionNo = null; let versionDate = null; let actionKey = null;
  let dataAvailable = true;
  let header = false;
  let rootSeen = null;
  let skipped = 0;
  let capture = null; // { name, t } for a top-level text we want
  const tellHeader = () => {
    if (header) return;
    header = true;
    if (typeof onHeader === 'function') onHeader({ versionNo, versionDate, dataAvailable });
  };

  parser.onerror = (e) => { error = e; };
  parser.onopentag = (node) => {
    const name = node.name;
    if (!rootSeen) rootSeen = name;
    stack.push(name);
    if (cf) {
      const n = { n: name, t: '', c: [] };
      cfStack[cfStack.length - 1].c.push(n);
      cfStack.push(n);
      return;
    }
    if (name === 'case-file') {
      tellHeader();
      cf = { n: name, t: '', c: [] };
      cfStack.length = 0;
      cfStack.push(cf);
      return;
    }
    if (name === 'version-no' || name === 'version-date' || name === 'action-key' || name === 'data-available-code') {
      capture = { name, t: '' };
    }
  };
  parser.ontext = (t) => {
    if (cf) { cfStack[cfStack.length - 1].t += t; return; }
    if (capture) capture.t += t;
  };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (name) => {
    stack.pop();
    if (cf) {
      cfStack.pop();
      if (name === 'case-file' && cfStack.length === 0) {
        const rec = caseFileToRecord(cf, { versionNo, versionDate, actionKey, fileName, asOf });
        if (rec) done.push(rec); else skipped++;
        cf = null;
      }
      return;
    }
    if (capture && capture.name === name) {
      const v = capture.t.trim();
      if (name === 'version-no') versionNo = v || null;
      else if (name === 'version-date') versionDate = v || null;
      else if (name === 'action-key') actionKey = v || null;
      else if (name === 'data-available-code' && v.toUpperCase() === 'N') dataAvailable = false;
      capture = null;
    }
  };

  const decoder = new TextDecoder('utf-8');
  for await (const chunk of source) {
    parser.write(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    if (error) throw new RegisterXmlError(`${fileName ?? 'XML'}: not well-formed XML (${String(error.message).split('\n')[0]})`);
    while (done.length) yield done.shift();
  }
  parser.write(decoder.decode());
  parser.close();
  if (error) throw new RegisterXmlError(`${fileName ?? 'XML'}: not well-formed XML (${String(error.message).split('\n')[0]})`);
  while (done.length) yield done.shift();
  if (rootSeen !== 'trademark-applications-daily') {
    throw new RegisterXmlError(`${fileName ?? 'XML'}: the root element is <${rootSeen ?? 'none'}>, not <trademark-applications-daily>; the format may have changed.`);
  }
  tellHeader();
  if (skipped) {
    // A case-file without an 8-digit serial is reported, never silently dropped.
    throw new RegisterXmlError(`${fileName ?? 'XML'}: ${skipped} <case-file> element(s) had no 8-digit serial number.`);
  }
}

/** The version and data-available flag a parse saw (for register_files). */
export function headerCollector() {
  const h = { versionNo: null, versionDate: null, dataAvailable: true };
  return { h, onHeader: (x) => Object.assign(h, x) };
}
