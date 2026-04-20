// Ingest documents into a Contextspaces matterspace.
//
// Usage:
//   node scripts/ingest.mjs --matter <short_code_or_uuid> [flags] <file_or_folder> [...]
//
// Examples:
//   node scripts/ingest.mjs --matter webster ~/webster-transcripts/
//   node scripts/ingest.mjs --matter webster --doc-type transcript --volume 3 \
//     --witness "Peloso" ~/webster/Hearing_Vol_III.pdf
//
// Required env (read from ./.env):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (add to .env; do NOT commit)
//   OPENAI_API_KEY
//
// Filename conventions (folder mode) — inferred when flags aren't set:
//   Hearing_Vol_III.pdf                 transcript, volume_number=3
//   Trial_Day_4.pdf                     transcript, volume_number=4
//   Dep_Peloso_2024-03-15.pdf           deposition, witness=Peloso, date=2024-03-15
//   Peloso_Deposition.pdf               deposition, witness=Peloso
//   PostHearing_Brief.pdf               brief
//   Ex_47.pdf                           exhibit, exhibit_number=47
//   Expert_Report_Shenoy.pdf            expert_report, witness=Shenoy
//   (anything else)                     other

import { createClient } from '@supabase/supabase-js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1024;
const EMBEDDING_BATCH = 96;
const MAX_PASSAGE_WORDS = 500;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = parseArgs(process.argv.slice(2));
if (!args.matter) die('Missing --matter <short_code_or_uuid>');
if (args._.length === 0) die('No files or folders to ingest');

const matterspace = await resolveMatterspace(args.matter);
const createdBy = await resolveCreatorProfile(matterspace);
log(`Matter: ${matterspace.name} (${matterspace.id})`);
log(`Ingesting as: ${createdBy.email} (${createdBy.id})`);

const files = await expandPaths(args._);
log(`Files to process: ${files.length}`);

let totalPassages = 0;
for (const file of files) {
  try {
    totalPassages += await ingestFile(file, matterspace, createdBy, args);
  } catch (err) {
    log(`ERROR ${file}: ${err.message}`);
  }
}

log(`Done. ${totalPassages} passages inserted across ${files.length} files.`);


// -----------------------------------------------------------------------------
// Ingestion pipeline for one file
// -----------------------------------------------------------------------------
async function ingestFile(filePath, matterspace, createdBy, flags) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  const stat = await fs.stat(filePath);
  log(`\n[${filename}] ${(stat.size / 1048576).toFixed(1)} MB`);

  const inferred = inferFromFilename(filename);
  const doc = {
    matterspace_id: matterspace.id,
    title: flags.title || inferred.title,
    doc_type: flags['doc-type'] || inferred.doc_type,
    source_filename: filename,
    file_size_bytes: stat.size,
    witness_name: flags.witness || inferred.witness_name || null,
    deposition_date: flags.date || inferred.deposition_date || null,
    volume_number: numOrNull(flags.volume) ?? inferred.volume_number ?? null,
    exhibit_number: flags.exhibit || inferred.exhibit_number || null,
    processing_status: 'pending',
    created_by: createdBy.id,
  };

  // Insert document row first so we get its id for the storage path
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .insert(doc)
    .select()
    .single();
  if (docErr) throw new Error(`insert document: ${docErr.message}`);
  log(`  document_id=${docRow.id}  doc_type=${doc.doc_type}`);

  try {
    // Upload original to storage
    const storagePath = `${matterspace.id}/${docRow.id}/${filename}`;
    const fileBuf = await fs.readFile(filePath);
    const { error: upErr } = await supabase.storage
      .from('vault-documents')
      .upload(storagePath, fileBuf, {
        contentType: mimeFor(ext),
        upsert: true,
      });
    if (upErr) throw new Error(`storage upload: ${upErr.message}`);
    await supabase
      .from('documents')
      .update({ storage_path: storagePath, processing_status: 'extracting' })
      .eq('id', docRow.id);

    // Extract per-page text
    let pages;
    if (ext === '.pdf') {
      pages = await extractPdfPages(fileBuf);
    } else {
      const text = fileBuf.toString('utf8');
      pages = [{ pageNumber: 1, text }];
    }
    await supabase
      .from('documents')
      .update({ page_count: pages.length, processing_status: 'chunking' })
      .eq('id', docRow.id);
    log(`  pages=${pages.length}`);

    // Chunk into passages
    const passages = chunkPages(pages, {
      witness_name: doc.witness_name,
    });
    log(`  passages=${passages.length}`);

    if (passages.length === 0) {
      await supabase
        .from('documents')
        .update({
          processing_status: 'error',
          processing_error: 'no passages extracted',
        })
        .eq('id', docRow.id);
      return 0;
    }

    // Embed in batches
    await supabase
      .from('documents')
      .update({ processing_status: 'embedding' })
      .eq('id', docRow.id);

    for (let i = 0; i < passages.length; i += EMBEDDING_BATCH) {
      const batch = passages.slice(i, i + EMBEDDING_BATCH);
      const embeddings = await embedBatch(batch.map(p => p.text));
      batch.forEach((p, idx) => (p.embedding = embeddings[idx]));
      process.stdout.write(`  embedded ${i + batch.length}/${passages.length}\r`);
    }
    process.stdout.write('\n');

    // Insert passages (chunked to stay under PostgREST row limit)
    const INSERT_CHUNK = 200;
    for (let i = 0; i < passages.length; i += INSERT_CHUNK) {
      const batch = passages.slice(i, i + INSERT_CHUNK).map(p => ({
        document_id: docRow.id,
        matterspace_id: matterspace.id,
        sequence_number: p.sequence_number,
        page_start: p.page_start,
        page_end: p.page_end,
        line_start: p.line_start,
        line_end: p.line_end,
        witness_name: p.witness_name,
        examination_type: p.examination_type,
        speaker: p.speaker,
        text: p.text,
        passage_type: p.passage_type,
        embedding: p.embedding,
        summary_level: 0,
      }));
      const { error: insErr } = await supabase.from('passages').insert(batch);
      if (insErr) throw new Error(`insert passages: ${insErr.message}`);
    }

    await supabase
      .from('documents')
      .update({
        processing_status: 'ready',
        ingested_at: new Date().toISOString(),
      })
      .eq('id', docRow.id);
    log(`  ready.`);
    return passages.length;
  } catch (err) {
    await supabase
      .from('documents')
      .update({
        processing_status: 'error',
        processing_error: err.message,
      })
      .eq('id', docRow.id);
    throw err;
  }
}


// -----------------------------------------------------------------------------
// PDF extraction — per-page text
// -----------------------------------------------------------------------------
async function extractPdfPages(buf) {
  // pdfjs expects a plain Uint8Array and will detach the buffer; feed a fresh copy
  const data = new Uint8Array(buf);
  const pdf = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // items don't carry newlines; reconstruct using y-position grouping
    const lines = groupItemsIntoLines(content.items);
    const text = lines.join('\n');
    pages.push({ pageNumber: i, text });
  }
  return pages;
}

function groupItemsIntoLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const y = Math.round(it.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top-to-bottom
    .map(([_, items]) =>
      items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim()
    )
    .filter(Boolean);
}


// -----------------------------------------------------------------------------
// Chunking
// - If a page looks like a transcript (numbered lines 1–25), split into Q/A
//   exchanges and capture line_start / line_end per passage.
// - Otherwise paragraph-group into ~500-word passages with page boundaries preserved.
// -----------------------------------------------------------------------------
function chunkPages(pages, opts) {
  const passages = [];
  let seq = 0;
  let activeWitness = opts.witness_name || null;
  let activeExamType = null;

  for (const { pageNumber, text } of pages) {
    const transcript = parseTranscriptPage(text);
    if (transcript) {
      // Carry witness / exam type across pages until a new header appears
      for (const c of transcript.chunks) {
        if (c.witness_name) activeWitness = c.witness_name;
        if (c.examination_type) activeExamType = c.examination_type;
        passages.push({
          sequence_number: seq++,
          page_start: pageNumber,
          page_end: pageNumber,
          line_start: c.line_start,
          line_end: c.line_end,
          witness_name: activeWitness,
          examination_type: activeExamType,
          speaker: c.speaker || null,
          text: c.text,
          passage_type: c.passage_type,
        });
      }
    } else {
      for (const block of paragraphChunks(text, MAX_PASSAGE_WORDS)) {
        passages.push({
          sequence_number: seq++,
          page_start: pageNumber,
          page_end: pageNumber,
          line_start: null,
          line_end: null,
          witness_name: activeWitness,
          examination_type: null,
          speaker: null,
          text: block,
          passage_type: 'monologue',
        });
      }
    }
  }
  return passages;
}

// Detect + parse a transcript page. Returns { chunks } or null if not transcript-shaped.
function parseTranscriptPage(pageText) {
  // Expect numbered lines like "  1  Q. ..." or "11  A. ..."
  const lineRE = /^(?:\s{0,6})(\d{1,2})\s{1,6}(.*)$/gm;
  const lines = [];
  let m;
  while ((m = lineRE.exec(pageText)) !== null) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 40) continue;
    lines.push({ lineNum: n, text: m[2].trim() });
  }
  if (lines.length < 8) return null; // not transcript-shaped enough

  // Detect section headers inside the page (exam type / witness changes)
  const headerRE = /\b(DIRECT|CROSS|REDIRECT|RECROSS|VOIR DIRE)\s+EXAMINATION\b/i;
  const byRE = /\bBY\s+(MR\.|MRS\.|MS\.|DR\.)\s+([A-Z][A-Z'\- ]+)\b/;
  const witnessCallRE = /\b([A-Z][A-Z'\- ]+),\s+(?:having been|was)\b/;

  const chunks = [];
  let cur = null;

  function flush() {
    if (cur && cur.text.trim()) chunks.push(cur);
    cur = null;
  }

  for (const { lineNum, text } of lines) {
    const header = headerRE.exec(text);
    const witnessCall = witnessCallRE.exec(text);
    const isQ = /^Q\.\s/.test(text);
    const isA = /^A\.\s/.test(text);
    const isExamBy = /^BY\s+(MR\.|MRS\.|MS\.|DR\.)/.test(text);

    if (header || witnessCall || isExamBy) {
      flush();
      const sectionChunk = {
        line_start: lineNum,
        line_end: lineNum,
        text,
        passage_type: 'section_heading',
        witness_name: witnessCall ? witnessCall[1].trim() : null,
        examination_type: header ? normalizeExamType(header[1]) : null,
        speaker: null,
      };
      chunks.push(sectionChunk);
      continue;
    }

    // Q/A pair boundary: new Q starts a new passage (unless cur is a Q waiting for A)
    if (isQ && cur && cur.hasAnswer) flush();
    if (isA && cur) cur.hasAnswer = true;

    if (!cur) {
      cur = {
        line_start: lineNum,
        line_end: lineNum,
        text,
        passage_type: 'qa_pair',
        speaker: isQ ? 'Q' : isA ? 'A' : null,
        hasAnswer: isA,
      };
    } else {
      cur.line_end = lineNum;
      cur.text += '\n' + text;
    }
  }
  flush();

  // Collapse tiny chunks into neighbors so we don't emit 2-line passages
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.passage_type === c.passage_type && last.text.length < 300) {
      last.line_end = c.line_end;
      last.text += '\n' + c.text;
    } else {
      merged.push(c);
    }
  }
  return { chunks: merged };
}

function normalizeExamType(s) {
  const u = s.toUpperCase();
  if (u.startsWith('DIRECT')) return 'direct';
  if (u.startsWith('CROSS')) return 'cross';
  if (u.startsWith('REDIRECT')) return 'redirect';
  if (u.startsWith('RECROSS')) return 'recross';
  if (u.startsWith('VOIR')) return 'voir_dire';
  return null;
}

function paragraphChunks(text, maxWords) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  let bufWords = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (buf && bufWords + w > maxWords) {
      out.push(buf);
      buf = '';
      bufWords = 0;
    }
    buf = buf ? buf + '\n\n' + p : p;
    bufWords += w;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}


// -----------------------------------------------------------------------------
// Embeddings
// -----------------------------------------------------------------------------
async function embedBatch(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIM,
      input: texts,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}


// -----------------------------------------------------------------------------
// Filename inference
// -----------------------------------------------------------------------------
function inferFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const lower = base.toLowerCase();

  const volMatch =
    /(?:vol(?:ume)?|day)[ _-]+((?:[ivxlcdm]+)|\d+)/i.exec(base);
  if (volMatch || /hearing|trial|transcript/i.test(lower)) {
    return {
      doc_type: 'transcript',
      title: prettify(base),
      volume_number: volMatch ? romanOrInt(volMatch[1]) : null,
      witness_name: null,
      deposition_date: null,
    };
  }

  const depMatch =
    /^(?:dep[_ -]|deposition[_ -])([a-z'\- ]+?)(?:[_ -](\d{4}-\d{2}-\d{2}))?$/i.exec(base) ||
    /^([a-z'\- ]+?)[_ -]deposition(?:[_ -](\d{4}-\d{2}-\d{2}))?$/i.exec(base);
  if (depMatch) {
    return {
      doc_type: 'deposition',
      title: prettify(base),
      witness_name: prettify(depMatch[1]),
      deposition_date: depMatch[2] || null,
      volume_number: null,
    };
  }

  if (/^ex[_ -]|^exhibit[_ -]/i.test(base)) {
    const exMatch = /^(?:ex|exhibit)[_ -]?([\w\-]+)/i.exec(base);
    return {
      doc_type: 'exhibit',
      title: prettify(base),
      exhibit_number: exMatch ? exMatch[1] : null,
      witness_name: null,
      deposition_date: null,
      volume_number: null,
    };
  }

  if (/brief|memorandum|motion|reply|opposition|memo/i.test(lower)) {
    return {
      doc_type: 'brief',
      title: prettify(base),
      witness_name: null,
      deposition_date: null,
      volume_number: null,
    };
  }

  if (/expert|report/i.test(lower)) {
    const witnessMatch = /expert[_ -]report[_ -]([a-z'\- ]+)$/i.exec(base);
    return {
      doc_type: 'expert_report',
      title: prettify(base),
      witness_name: witnessMatch ? prettify(witnessMatch[1]) : null,
      deposition_date: null,
      volume_number: null,
    };
  }

  return {
    doc_type: 'other',
    title: prettify(base),
    witness_name: null,
    deposition_date: null,
    volume_number: null,
  };
}

function prettify(s) {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function romanOrInt(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const up = s.toUpperCase();
  let total = 0;
  let prev = 0;
  for (let i = up.length - 1; i >= 0; i--) {
    const v = map[up[i]] || 0;
    total += v < prev ? -v : v;
    prev = v;
  }
  return total || null;
}


// -----------------------------------------------------------------------------
// Supabase lookups
// -----------------------------------------------------------------------------
async function resolveMatterspace(key) {
  // UUID?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, name, short_code, serverspace_id')
      .eq('id', key)
      .single();
    if (error) die(`matterspace ${key}: ${error.message}`);
    return data;
  }
  // short_code
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, serverspace_id')
    .eq('short_code', key)
    .maybeSingle();
  if (error) die(`matterspace short_code ${key}: ${error.message}`);
  if (!data) die(`No matterspace with short_code '${key}'. Create one first or pass a UUID.`);
  return data;
}

async function resolveCreatorProfile(matterspace) {
  // Use the first owner of the parent serverspace as the created_by reference.
  const { data, error } = await supabase
    .from('serverspace_members')
    .select('user_id, profiles:user_id (id, email)')
    .eq('serverspace_id', matterspace.serverspace_id)
    .eq('role', 'owner')
    .limit(1)
    .single();
  if (error) die(`resolve owner: ${error.message}`);
  return data.profiles;
}


// -----------------------------------------------------------------------------
// Filesystem + utilities
// -----------------------------------------------------------------------------
async function expandPaths(inputs) {
  const out = [];
  for (const p of inputs) {
    const abs = path.resolve(p);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      log(`Skip (not found): ${abs}`);
      continue;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs);
      for (const e of entries.sort()) {
        const sub = path.join(abs, e);
        const st = await fs.stat(sub);
        if (st.isFile() && /\.(pdf|txt|md)$/i.test(e)) out.push(sub);
      }
    } else if (/\.(pdf|txt|md)$/i.test(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function mimeFor(ext) {
  const m = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return m[ext] || 'application/octet-stream';
}

function numOrNull(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function loadEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing env: ${name}`);
  return v;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(msg) {
  process.stderr.write(`ingest: ${msg}\n`);
  process.exit(1);
}
