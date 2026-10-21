// lib/trademark/register/load.mjs — load one USPTO applications XML file
// into the register copy, by serial.
//
//   - streamed (xml.mjs): never the whole file in memory;
//   - one row per serial, UPSERTED: the same loader takes the annual backfile
//     and each daily file; a row is replaced only by a file whose as-of date
//     is the same or later, so loading an old backfile piece after the
//     dailies never rolls a record back;
//   - IDEMPOTENT: a file already loaded with the same sha256 is skipped;
//   - ATOMIC: one transaction per file. A file that fails to parse or write
//     leaves the previous state of every row, register_files and as_of intact;
//   - as_of is NOT moved here: scripts/tm-register/daily.mjs stamps it only
//     when every day up to it has loaded (stampAsOf), so a missed day is never
//     papered over by a later one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { streamRecords, headerCollector, PARSER_VERSION } from './xml.mjs';
import { cmVariants, cmText, normalizeMark, joinedMark, ownerText, words } from './normalize.mjs';

export const BATCH = 500;

/** The file's own as-of date from its USPTO name: apcYYMMDD.zip → 20YY-MM-DD; apc18840407-YYYYMMDD-NN.zip → YYYY-MM-DD. */
export function fileAsOfFromName(name) {
  const b = path.basename(String(name ?? ''));
  let m = /^apc(\d{2})(\d{2})(\d{2})\.(zip|xml)$/i.exec(b);
  if (m) return { kind: 'daily', asOf: `20${m[1]}-${m[2]}-${m[3]}` };
  m = /^apc18840407-(\d{4})(\d{2})(\d{2})-\d{2}\.(zip|xml)$/i.exec(b);
  if (m) return { kind: 'backfile', asOf: `${m[1]}-${m[2]}-${m[3]}` };
  return null;
}

/** A parsed record → the row the SQL below inserts. */
export function rowFor(rec) {
  const variants = cmVariants({
    mark: rec.mark, pseudoMarks: rec.pseudo_marks, translations: rec.translations, transliterations: rec.transliterations,
  });
  return {
    serial: rec.serial,
    registration_number: rec.registration_number,
    mark: rec.mark,
    mark_norm: normalizeMark(rec.mark),
    mark_joined: joinedMark(rec.mark),
    pseudo_marks: rec.pseudo_marks.map(normalizeMark).filter(Boolean),
    cm_text: cmText(variants),
    owner: rec.owner,
    owner_text: ownerText(rec.owners.map((o) => o.name)),
    owners: rec.owners,
    attorney_name: rec.attorney_name,
    status_code: rec.status_code,
    status_date: rec.status_date,
    live: rec.live,
    filing_date: rec.filing_date,
    registration_date: rec.registration_date,
    abandonment_date: rec.abandonment_date,
    cancellation_date: rec.cancellation_date,
    mark_drawing_code: rec.mark_drawing_code,
    int_classes: rec.int_classes,
    us_classes: rec.us_classes,
    goods: rec.goods,
    gs_text: ` ${words(rec.goods.map((g) => g.text).join(' ')).join(' ')} `,
    design_codes: rec.design_codes,
    translations: [...rec.translations, ...rec.transliterations],
    transaction_date: rec.transaction_date,
    source_file: rec.source_file,
    source_version: rec.source_version,
    as_of: rec.as_of,
  };
}

const COLS = [
  ['serial', 'text'], ['registration_number', 'text'], ['mark', 'text'], ['mark_norm', 'text'], ['mark_joined', 'text'],
  ['pseudo_marks', 'text[]'], ['cm_text', 'text'], ['owner', 'text'], ['owner_text', 'text'], ['owners', 'jsonb'],
  ['attorney_name', 'text'], ['status_code', 'text'], ['status_date', 'date'], ['live', 'boolean'], ['filing_date', 'date'],
  ['registration_date', 'date'], ['abandonment_date', 'date'], ['cancellation_date', 'date'], ['mark_drawing_code', 'text'],
  ['int_classes', 'text[]'], ['us_classes', 'text[]'], ['goods', 'jsonb'], ['gs_text', 'text'], ['design_codes', 'text[]'],
  ['translations', 'text[]'], ['transaction_date', 'date'], ['source_file', 'text'], ['source_version', 'text'], ['as_of', 'date'],
];

const pick = (c, t) => {
  if (t === 'text[]') return `coalesce((select array_agg(x) from jsonb_array_elements_text(e->'${c}') x), '{}')`;
  if (t === 'jsonb') return `coalesce(e->'${c}', '[]'::jsonb)`;
  return `(e->>'${c}')::${t}`;
};

export const UPSERT_SQL = `
  insert into register_records (${COLS.map(([c]) => c).join(', ')}, dm_codes, loaded_at)
  select ${COLS.map(([c, t]) => pick(c, t)).join(', ')},
         register_dm(e->>'mark_norm', e->>'mark_joined'), now()
    from jsonb_array_elements($1::jsonb) e
  on conflict (serial) do update set
    ${COLS.filter(([c]) => c !== 'serial').map(([c]) => `${c} = excluded.${c}`).join(', ')},
    dm_codes = excluded.dm_codes, loaded_at = now()
  where register_records.as_of <= excluded.as_of
  returning (xmax = 0) as inserted`;

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

/** The XML bytes of a .xml file, or of the one .xml entry of a .zip, as a stream. */
export async function xmlSource(file) {
  if (/\.xml$/i.test(file)) return { stream: fs.createReadStream(file), close: async () => {} };
  if (!/\.zip$/i.test(file)) throw new Error(`${file}: expected a .zip or .xml file`);
  const { default: StreamZip } = await import('node-stream-zip');
  const zip = new StreamZip.async({ file });
  const entries = Object.values(await zip.entries()).filter((e) => !e.isDirectory && /\.xml$/i.test(e.name));
  if (entries.length !== 1) { await zip.close(); throw new Error(`${file}: expected exactly one .xml entry, found ${entries.length}`); }
  // Never trust an entry's path: only its bytes are read, nothing is written to disk.
  return { stream: await zip.stream(entries[0].name), close: () => zip.close(), entry: entries[0].name };
}

/**
 * Load one file.
 * @param {object} db   lib/trademark/register/db.mjs adapter
 * @param {string} file a .zip or .xml path
 * @param {{kind?:'daily'|'backfile'|'fixture', asOf?:string, fileName?:string, log?:(s:string)=>void}} [o]
 * @returns {Promise<{file:string, skipped?:boolean, records:number, inserted:number, updated:number, unchanged:number, asOf:string, versionNo:string|null, dataAvailable:boolean}>}
 */
export async function loadFile(db, file, { kind, asOf, fileName, log = () => {} } = {}) {
  const name = fileName ?? path.basename(file);
  const fromName = fileAsOfFromName(name);
  const fileKind = kind ?? fromName?.kind;
  const fileAsOf = asOf ?? fromName?.asOf;
  if (!fileKind || !fileAsOf || !/^\d{4}-\d{2}-\d{2}$/.test(fileAsOf)) {
    throw new Error(`${name}: not a USPTO file name (apcYYMMDD.zip or apc18840407-YYYYMMDD-NN.zip); pass --kind and --as-of`);
  }
  const sha = await sha256File(file);
  const prior = (await db.query('select sha256 from register_files where file_name = $1', [name])).rows[0];
  if (prior?.sha256 === sha) {
    log(`${name}: already loaded (same sha256); nothing to do.`);
    return { file: name, skipped: true, records: 0, inserted: 0, updated: 0, unchanged: 0, asOf: fileAsOf, versionNo: null, dataAvailable: true };
  }

  const src = await xmlSource(file);
  const { h, onHeader } = headerCollector();
  let records = 0; let inserted = 0; let updated = 0;
  try {
    await db.transaction(async (tx) => {
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const out = await tx.query(UPSERT_SQL, [JSON.stringify(batch)]);
        for (const r of out.rows) (r.inserted ? inserted++ : updated++);
        batch = [];
      };
      for await (const rec of streamRecords(src.stream, { fileName: name, asOf: fileAsOf, onHeader })) {
        records++;
        batch.push(rowFor(rec));
        if (batch.length >= BATCH) { await flush(); log(`${name}: ${records} records…`); }
      }
      await flush();
      await tx.query(
        `insert into register_files (file_name, sha256, kind, file_as_of, version_no, version_date, data_available, records, inserted, updated, parser)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (file_name) do update set sha256 = excluded.sha256, kind = excluded.kind, file_as_of = excluded.file_as_of,
           version_no = excluded.version_no, version_date = excluded.version_date, data_available = excluded.data_available,
           records = excluded.records, inserted = excluded.inserted, updated = excluded.updated, parser = excluded.parser, loaded_at = now()`,
        [name, sha, fileKind, fileAsOf, h.versionNo, h.versionDate, h.dataAvailable, records, inserted, updated, PARSER_VERSION],
      );
    });
  } finally {
    await src.close();
  }
  const unchanged = records - inserted - updated;
  log(`${name}: ${records} records (${inserted} new, ${updated} updated, ${unchanged} kept: a later file already had them); DTD version ${h.versionNo ?? '?'}.`);
  return { file: name, records, inserted, updated, unchanged, asOf: fileAsOf, versionNo: h.versionNo, dataAvailable: h.dataAvailable };
}

/** Apply the schema (re-runnable). */
export async function applySchema(db, schemaPath) {
  const p = schemaPath ?? new URL('../../../db/tm-register/schema.sql', import.meta.url);
  await db.exec(fs.readFileSync(p, 'utf8'));
}

/** Stamp the copy's as-of date (only ever forward). */
export async function stampAsOf(db, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`as_of must be YYYY-MM-DD (${date})`);
  await db.query(
    `insert into register_meta (key, value, updated_at) values ('as_of', $1, now())
     on conflict (key) do update set value = greatest(register_meta.value, excluded.value), updated_at = now()`,
    [date],
  );
}
