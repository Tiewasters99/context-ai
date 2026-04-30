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
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

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
  // EPUB files default to doc_type='book' unless the user passes --doc-type.
  // Title/author/publisher get overwritten by extracted EPUB metadata
  // inside processDocument, so the inferred title is just a placeholder.
  if (ext === '.epub' && !flags['doc-type']) inferred.doc_type = 'book';
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
    // Upload original to storage.
    // Supabase Storage object keys reject a narrower character set than
    // the local filesystem allows — brackets and braces in particular
    // break uploads ("Invalid key"). Sanitize the final path segment
    // while preserving the raw filename in documents.source_filename for
    // display.
    const safeName = sanitizeStorageName(filename);
    const storagePath = `${matterspace.id}/${docRow.id}/${safeName}`;
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
      .update({ storage_path: storagePath })
      .eq('id', docRow.id);

    // Run the shared pipeline: extract → chunk → embed → insert.
    const { passageCount } = await processDocument(supabase, {
      documentId: docRow.id,
      fileBuf,
      ext,
      witnessName: doc.witness_name,
      openaiApiKey: OPENAI_API_KEY,
      onProgress: ({ stage, message }) => {
        if (stage === 'embedding' && message.startsWith('Embedded')) {
          process.stdout.write(`  ${message}\r`);
        } else {
          log(`  ${message}`);
        }
      },
    });
    process.stdout.write('\n');
    log(`  ready.`);
    return passageCount;
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
// Filename inference
// -----------------------------------------------------------------------------
function inferFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const lower = base.toLowerCase();

  // Volume-anchored transcript: has "Vol"/"Volume"/"Day" + number. Highest confidence.
  const volMatch =
    /(?:vol(?:ume)?|day)[ _-]+((?:[ivxlcdm]+)|\d+)/i.exec(base);
  if (volMatch) {
    return {
      doc_type: 'transcript',
      title: prettify(base),
      volume_number: romanOrInt(volMatch[1]),
      witness_name: null,
      deposition_date: null,
    };
  }

  // Exhibit: "Ex. A", "Ex_47", "Exhibit B". Check BEFORE brief/hearing keywords
  // because exhibit titles often reference the brief they were filed with.
  if (/^(?:ex\.|ex[ _-]|exhibit\b)/i.test(base)) {
    const exMatch = /^(?:ex\.|ex|exhibit)[\s._ -]*([A-Za-z0-9]+)/i.exec(base);
    return {
      doc_type: 'exhibit',
      title: prettify(base),
      exhibit_number: exMatch ? exMatch[1] : null,
      witness_name: null,
      deposition_date: null,
      volume_number: null,
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

  if (/brief|memorandum|motion|reply|opposition|memo/i.test(lower)) {
    return {
      doc_type: 'brief',
      title: prettify(base),
      witness_name: null,
      deposition_date: null,
      volume_number: null,
    };
  }

  // Generic transcript fallback: has the keyword but no volume marker.
  if (/hearing|trial|transcript/i.test(lower)) {
    return {
      doc_type: 'transcript',
      title: prettify(base),
      volume_number: null,
      witness_name: null,
      deposition_date: null,
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
      const entries = await fs.readdir(abs, { recursive: true, withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.(pdf|txt|md|docx|epub)$/i.test(e.name)) continue;
        const parent = e.parentPath || e.path || abs;
        out.push(path.join(parent, e.name));
      }
      out.sort();
    } else if (/\.(pdf|txt|md|docx|epub)$/i.test(abs)) {
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
    '.epub': 'application/epub+zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return m[ext] || 'application/octet-stream';
}

// Sanitize a filename for use as a Supabase Storage object key.
// Supabase rejects keys containing [ ] { } and a few other chars that are
// legal on local filesystems but break storage uploads. Strip those entirely
// rather than replacing with underscores, so files stay human-readable
// ("Option_Agreement_Execution.pdf" beats "Option_Agreement__Execution_.pdf").
// Collapse any remaining underscore runs produced by sanitization.
function sanitizeStorageName(name) {
  return name
    .replace(/[\[\]{}]/g, '')
    .replace(/[^\w/!\-.*'() ]/g, '_')
    .replace(/_+/g, '_');
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
