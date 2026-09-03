// PDF portfolios ("PDF packages" / collections): a one-page cover sheet plus
// a set of embedded files. The Fifth Circuit's Electronic Record on Appeal
// (E-Record_<case>.pdf, built by the AO's iText) is the canonical example —
// 223 MB whose page tree is a single page reading "This document contains a
// collection of PDFs re: Case - 25-20513", with the 1,800-page record living
// in six attachments.
//
// Read as an ordinary PDF that is "one page with 63 characters", so the
// pipeline called it a scan, OCR'd the cover, and would have filed a
// searchable copy of one sentence (2026-09-03). This module detects the
// container and files each attachment as its own document, queued for the
// normal pipeline, inside a folder named after the wrapper.
//
// Provider-agnostic and side-effect free except through the supabase client
// it is handed, so it runs identically on the Fly worker, the Vercel inline
// path, and the MCP file_document path.

const MARKERS = ['/EmbeddedFiles', '/Collection'];

// Cheap byte scan before paying for a pdf.js parse. Object streams could hide
// the markers; a portfolio we miss is handled exactly as before (store the
// wrapper), so the miss is safe, just unimproved.
export function mightBePortfolio(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (const m of MARKERS) {
    if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(m)) return true;
  }
  return false;
}

// → { pageCount, isCollection, attachments: [{ name, filename, bytes }] } or null.
// `name` is the display key from the EmbeddedFiles name tree (the AO writes
// the human title there, e.g. "Pleadings, vol. 2 - 4:22-CV-4315");
// `filename` is the stored file name (e.g. "vol-685249.pdf").
export async function detectPdfPortfolio(buf) {
  if (!mightBePortfolio(buf)) return null;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of (detaches) the array it is given — hand it a
  // copy so the caller's buffer survives for the normal pipeline.
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const task = pdfjs.getDocument({
    data: new Uint8Array(src),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  try {
    const att = await doc.getAttachments();
    const names = att ? Object.keys(att) : [];
    if (!names.length) return null;
    let isCollection = false;
    try {
      const { info } = await doc.getMetadata();
      isCollection = info?.IsCollectionPresent === true;
    } catch { /* metadata is advisory */ }
    const pageCount = doc.numPages;
    // A real brief that happens to carry an attached exhibit is still a
    // brief: only a declared collection, or a cover-sheet-sized page tree,
    // counts as a container.
    if (!isCollection && pageCount > 2) return null;
    const attachments = names
      .map((name) => {
        const a = att[name] || {};
        const content = a.content ? Buffer.from(a.content) : Buffer.alloc(0);
        return { name, filename: a.filename || name, bytes: content };
      })
      .filter((a) => a.bytes.length > 0);
    if (!attachments.length) return null;
    return { pageCount, isCollection, attachments };
  } finally {
    try { await doc.destroy(); } catch { /* best effort */ }
  }
}

function stripExt(name = '') {
  return String(name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

function safeFilename(name = '') {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'attachment.pdf';
}

function slugify(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'portfolio';
}

// Title for a child document: the display key when it looks like a title,
// otherwise the stored filename without its extension.
function titleFor(a) {
  const key = String(a.name || '').trim();
  if (key && key !== a.filename && !/\.[A-Za-z0-9]{1,5}$/.test(key)) return key;
  return stripExt(a.filename || key) || 'Attachment';
}

// Filename the child is stored under: keep the real extension (it drives the
// pipeline's format switch) but carry the display title so a listing of
// vault-documents reads as well as the app does.
function childFilename(a) {
  const ext = (String(a.filename || '').match(/\.[A-Za-z0-9]{1,5}$/) || ['.pdf'])[0].toLowerCase();
  return safeFilename(`${titleFor(a)}${ext}`);
}

// File each attachment as its own document under a folder named after the
// wrapper, queue each for the pipeline, and move the wrapper into the folder
// so the parent matter shows one entry, not a shell beside a folder.
// Everything past "create the child rows" is best effort: a folder the caller
// may not create (RLS) falls back to filing beside the wrapper; a wrapper move
// that fails leaves it where it was. Returns what was done.
export async function unpackPortfolio(supabase, { parent, attachments, onProgress = () => {} }) {
  if (!parent?.id || !parent.matterspace_id) throw new Error('unpackPortfolio: parent document row required');
  const folderName = (parent.title || stripExt(parent.source_filename) || 'PDF portfolio').trim().slice(0, 120);
  const notes = [];

  // 1. Folder under the wrapper's matter (idempotent by name).
  let folder = null;
  const { data: parentMatter, error: pmErr } = await supabase
    .from('matterspaces')
    .select('id, serverspace_id, short_code')
    .eq('id', parent.matterspace_id)
    .single();
  if (pmErr || !parentMatter) {
    notes.push(`folder skipped: could not load matter (${pmErr?.message || 'not found'})`);
  } else {
    const { data: existing } = await supabase
      .from('matterspaces')
      .select('id, name, short_code')
      .eq('parent_matterspace_id', parentMatter.id)
      .eq('name', folderName)
      .limit(1);
    if (existing?.length) {
      folder = existing[0];
    } else {
      const base = slugify(folderName);
      const codes = [base, ...[2, 3, 4, 5].map((n) => `${base.slice(0, 47)}-${n}`)];
      let lastErr = null;
      for (const code of codes) {
        const { data, error } = await supabase
          .from('matterspaces')
          .insert({
            serverspace_id: parentMatter.serverspace_id,
            parent_matterspace_id: parentMatter.id,
            name: folderName,
            short_code: code,
            description: `Unpacked from the PDF portfolio "${parent.source_filename || folderName}" on ${new Date().toISOString().slice(0, 10)}.`,
          })
          .select('id, name, short_code')
          .single();
        if (!error) { folder = data; break; }
        lastErr = error;
        const dup = error.code === '23505' || /duplicate/i.test(error.message || '');
        if (!dup) break;
      }
      if (!folder) notes.push(`folder skipped: ${lastErr?.message || 'insert failed'} — filing beside the wrapper`);
    }
  }
  const targetMatterId = folder?.id ?? parent.matterspace_id;

  // 2. Children: row → bytes → storage_path → job. Dedupe on (matter,
  //    filename, size) so a retried wrapper job does not file twins.
  const children = [];
  let index = 0;
  for (const a of attachments) {
    index += 1;
    const filename = childFilename(a);
    const title = titleFor(a);
    onProgress({ stage: 'extracting', message: `Portfolio: filing ${index}/${attachments.length} — ${title}` });

    const { data: dup } = await supabase
      .from('documents')
      .select('id, processing_status')
      .eq('matterspace_id', targetMatterId)
      .eq('source_filename', filename)
      .eq('file_size_bytes', a.bytes.length)
      .limit(1);
    if (dup?.length) {
      children.push({ id: dup[0].id, title, filename, size: a.bytes.length, reused: true });
      continue;
    }

    const { data: row, error: insErr } = await supabase
      .from('documents')
      .insert({
        matterspace_id: targetMatterId,
        title,
        doc_type: parent.doc_type || 'other',
        source_filename: filename,
        file_size_bytes: a.bytes.length,
        processing_status: 'pending',
        created_by: parent.created_by ?? null,
        metadata: { portfolio_parent: parent.id, portfolio_attachment: a.name },
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`portfolio child "${title}": create document: ${insErr.message}`);

    const storagePath = `${targetMatterId}/${row.id}/${filename}`;
    const { error: upErr } = await supabase.storage
      .from('vault-documents')
      .upload(storagePath, a.bytes, { contentType: mimeFor(filename), upsert: true });
    if (upErr) {
      await supabase.from('documents').delete().eq('id', row.id);
      throw new Error(`portfolio child "${title}": upload: ${upErr.message}`);
    }
    await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);

    const { data: openJob } = await supabase
      .from('processing_jobs')
      .select('id')
      .eq('job_type', 'ingest_document')
      .in('status', ['queued', 'running'])
      .contains('payload', { document_id: row.id })
      .limit(1);
    if (!openJob?.length) {
      const { error: qErr } = await supabase.from('processing_jobs').insert({
        matterspace_id: targetMatterId,
        job_type: 'ingest_document',
        payload: { document_id: row.id },
      });
      if (qErr) notes.push(`child "${title}" stored but not queued: ${qErr.message}`);
    }
    children.push({ id: row.id, title, filename, size: a.bytes.length, reused: false });
  }

  // 3. Move the wrapper into the folder (storage object first, then the row;
  //    the wrapper has no passages to re-point).
  let moved = false;
  if (folder && parent.storage_path) {
    const base = parent.storage_path.split('/').pop();
    const newPath = `${folder.id}/${parent.id}/${base}`;
    const { error: mvErr } = await supabase.storage.from('vault-documents').move(parent.storage_path, newPath);
    if (!mvErr) {
      const { error: rowErr } = await supabase
        .from('documents')
        .update({ matterspace_id: folder.id, storage_path: newPath })
        .eq('id', parent.id);
      if (rowErr) {
        try { await supabase.storage.from('vault-documents').move(newPath, parent.storage_path); } catch { /* best effort */ }
        notes.push(`wrapper left in place: ${rowErr.message}`);
      } else {
        moved = true;
      }
    } else {
      notes.push(`wrapper left in place: ${mvErr.message}`);
    }
  }

  return { folder, targetMatterId, children, moved, notes };
}

function mimeFor(filename = '') {
  const ext = (filename.match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0].toLowerCase();
  return {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
  }[ext] || 'application/octet-stream';
}
