// Containers: one uploaded file that holds other files. Three kinds so far —
// PDF portfolios (pdf-portfolio.mjs), .zip archives (zip-container.mjs) and
// email attachments (eml-attachments.mjs) — and one way of filing what is
// inside them, here, so the folder rule, the child rows, the queueing and the
// dedupe cannot drift between kinds (Phase 3 of the ingestion plan,
// 2026-09-04; the portfolio unpack of 2026-09-03 was the first and is now a
// caller of this).
//
// Each entry becomes its own documents row in the parent's matter (or, when
// `folder` is true, in a folder named after the parent, into which the
// parent is then moved so the matter shows one entry rather than a shell
// beside a folder), with the bytes in storage and one ingest_document job
// queued — the normal pipeline reads it from there, so a scanned PDF inside a
// zip is OCR'd like any other and a nested zip is unpacked in its turn.
//
// Everything past "create the child rows" is best effort: a folder the
// caller may not create (RLS) falls back to filing beside the parent; a
// parent move that fails leaves it where it was. Provider-agnostic and
// side-effect free except through the supabase client it is handed, so it
// runs identically on the Fly worker, the Vercel inline path and the MCP
// file_document path.

export function stripExt(name = '') {
  return String(name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

export function safeFilename(name = '', fallback = 'attachment.bin') {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function slugify(name = '', fallback = 'container') {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || fallback;
}

// File each entry as its own document and queue it for the pipeline.
//
//   parent    — the container's documents row: id, matterspace_id, title,
//               source_filename, created_by, doc_type, storage_path
//   kind      — 'portfolio' | 'zip' | 'eml' (recorded on every child as
//               metadata.container_kind, beside container_parent and
//               container_entry, so a child can always be traced back)
//   entries   — [{ title, filename, bytes, entry?, metadata? }]: `filename`
//               keeps the real extension (it drives the pipeline's format
//               switch); `entry` is the path inside the container, for the
//               record; `metadata` is merged into the child's metadata
//   folder    — true: file the children in a folder named after the parent
//               and move the parent in (portfolios, archives); false: file
//               them beside the parent (an email's attachments)
//   describe  — one line for the folder's description, e.g. 'the PDF
//               portfolio "x.pdf"'
//
// Returns { folder, targetMatterId, children, moved, notes } — children is
// [{ id, title, filename, size, reused }], reused meaning a twin (same
// matter, filename, size) was already there, so a retried job files no
// duplicates.
export async function unpackContainer(supabase, { parent, kind, entries, folder = true, describe = null, onProgress = () => {} }) {
  if (!parent?.id || !parent.matterspace_id) throw new Error('unpackContainer: parent document row required');
  const folderName = (parent.title || stripExt(parent.source_filename) || 'Unpacked files').trim().slice(0, 120);
  const notes = [];
  const noun = { portfolio: 'Portfolio', zip: 'Archive', eml: 'Email' }[kind] || 'Container';

  // 1. Folder under the parent's matter (idempotent by name).
  let folderRow = null;
  if (folder) {
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
        folderRow = existing[0];
      } else {
        const base = slugify(folderName, kind);
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
              description: `Unpacked from ${describe || `the ${noun.toLowerCase()} "${parent.source_filename || folderName}"`} on ${new Date().toISOString().slice(0, 10)}.`,
            })
            .select('id, name, short_code')
            .single();
          if (!error) { folderRow = data; break; }
          lastErr = error;
          const dup = error.code === '23505' || /duplicate/i.test(error.message || '');
          if (!dup) break;
        }
        if (!folderRow) notes.push(`folder skipped: ${lastErr?.message || 'insert failed'} — filing beside the ${noun.toLowerCase()}`);
      }
    }
  }
  const targetMatterId = folderRow?.id ?? parent.matterspace_id;

  // 2. Children: row → bytes → storage_path → job. Dedupe on (matter,
  //    filename, size) so a retried job does not file twins.
  const children = [];
  let index = 0;
  for (const e of entries) {
    index += 1;
    const filename = e.filename;
    const title = e.title || stripExt(filename) || 'Attachment';
    onProgress({ stage: 'extracting', message: `${noun}: filing ${index}/${entries.length} — ${title}` });

    const { data: dup } = await supabase
      .from('documents')
      .select('id, processing_status')
      .eq('matterspace_id', targetMatterId)
      .eq('source_filename', filename)
      .eq('file_size_bytes', e.bytes.length)
      .limit(1);
    if (dup?.length) {
      children.push({ id: dup[0].id, title, filename, size: e.bytes.length, reused: true });
      continue;
    }

    const { data: row, error: insErr } = await supabase
      .from('documents')
      .insert({
        matterspace_id: targetMatterId,
        title,
        doc_type: parent.doc_type || 'other',
        source_filename: filename,
        file_size_bytes: e.bytes.length,
        processing_status: 'pending',
        created_by: parent.created_by ?? null,
        metadata: {
          container_parent: parent.id,
          container_kind: kind,
          container_entry: e.entry ?? filename,
          ...(e.metadata || {}),
        },
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`${noun.toLowerCase()} child "${title}": create document: ${insErr.message}`);

    const storagePath = `${targetMatterId}/${row.id}/${filename}`;
    const { error: upErr } = await supabase.storage
      .from('vault-documents')
      .upload(storagePath, e.bytes, { contentType: mimeFor(filename), upsert: true });
    if (upErr) {
      await supabase.from('documents').delete().eq('id', row.id);
      throw new Error(`${noun.toLowerCase()} child "${title}": upload: ${upErr.message}`);
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
    children.push({ id: row.id, title, filename, size: e.bytes.length, reused: false });
  }

  // 3. Move the parent into the folder (storage object first, then the row).
  //    Only for a parent that is itself stored without text — a portfolio
  //    cover or an archive; an email keeps its passages and its place.
  let moved = false;
  if (folderRow && parent.storage_path) {
    const base = parent.storage_path.split('/').pop();
    const newPath = `${folderRow.id}/${parent.id}/${base}`;
    const { error: mvErr } = await supabase.storage.from('vault-documents').move(parent.storage_path, newPath);
    if (!mvErr) {
      const { error: rowErr } = await supabase
        .from('documents')
        .update({ matterspace_id: folderRow.id, storage_path: newPath })
        .eq('id', parent.id);
      if (rowErr) {
        try { await supabase.storage.from('vault-documents').move(newPath, parent.storage_path); } catch { /* best effort */ }
        notes.push(`${noun.toLowerCase()} left in place: ${rowErr.message}`);
      } else {
        moved = true;
      }
    } else {
      notes.push(`${noun.toLowerCase()} left in place: ${mvErr.message}`);
    }
  }

  return { folder: folderRow, targetMatterId, children, moved, notes };
}

// The summary written on the parent row (metadata.portfolio / .archive /
// .email_attachments) — what was filed, where, and anything that did not go
// to plan. Small on purpose: ids and titles, not bytes.
export function containerSummary(result, { count, skipped = [] } = {}) {
  return {
    unpacked_at: new Date().toISOString(),
    entry_count: count ?? result.children.length,
    folder_id: result.folder?.id ?? null,
    folder_name: result.folder?.name ?? null,
    children: result.children.map((c) => ({ id: c.id, title: c.title, filename: c.filename })),
    ...(skipped.length ? { skipped } : {}),
    ...(result.notes.length ? { notes: result.notes } : {}),
  };
}

export function mimeFor(filename = '') {
  const ext = (filename.match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0].toLowerCase();
  return {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.eml': 'message/rfc822',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
  }[ext] || 'application/octet-stream';
}
