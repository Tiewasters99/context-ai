// Ingestion failure triage — one shared vocabulary for what went wrong and what
// to do about it.
//
// Three surfaces need to agree on this: the bulk importer's --report, the
// ingest monitor's digest, and (next) the in-app document health panel. When
// each one carried its own string matching, the same failure got three
// different names and the user got three different answers. One table here.
//
// Every class carries:
//   label      — plain language, for someone who is not debugging the pipeline
//   action     — the specific next step, not "investigate"
//   retryable  — whether simply re-running fixes it (drives auto-retry)
//   severity   — 'blocking' needs a human; 'transient' clears itself;
//                'benign' is a document that is fine as stored

export const TRIAGE = {
  rate_limit_429: {
    label: 'Embedding rate limit reached',
    action: 'The OpenAI org hit its tokens-per-minute ceiling. Re-run — the shared limiter now paces requests. If it recurs, lower EMBED_TPM_LIMIT or reduce concurrency.',
    retryable: true,
    severity: 'transient',
  },
  token_limit_400: {
    label: 'Passage exceeded the model token limit',
    // This was described as already-capped-just-re-run, and it was not. The cap
    // truncated on 4 chars/token — the same average-case ratio that overflowed
    // in the first place — so dense text failed again at exactly the same
    // point, and a re-run only re-spent the embedding budget. Fixed properly on
    // 2026-08-02 (pessimistic cap plus a shrink-and-retry driven by the API's
    // own verdict). Re-running is now genuinely the right move, but only for
    // documents that failed before that build.
    action: 'A chunk tokenized past the 8192-token per-input ceiling. Fixed 2026-08-02: the cap is now pessimistic and embedBatch shrinks the exact input the API names. Re-run — but confirm the worker is running a build from 2026-08-02 or later, or it will fail identically.',
    retryable: true,
    severity: 'transient',
  },
  encoding_reject: {
    label: 'Text contained bytes the database rejects',
    action: 'Control characters (usually NUL from a scanner) reached the insert. sanitizeText() strips these now — re-run it.',
    retryable: true,
    severity: 'transient',
  },
  ocr_needed: {
    label: 'Scanned document, OCR not configured',
    action: 'Set GOOGLE_API_KEY where the ingest runs (Vercel env, Fly secrets, or .env) and re-run.',
    retryable: true,
    severity: 'blocking',
  },
  no_text: {
    label: 'No readable text found',
    action: 'OCR ran and found nothing — usually a photo or diagram. The file is stored and viewable; treat as complete unless you expected text.',
    retryable: false,
    severity: 'benign',
  },
  media_timeout: {
    label: 'Audio/video transcription stalled',
    action: 'Gemini exhausted its retries on a long recording. Requeue to the worker; recordings over ~1 hour need segmenting before they will finish.',
    retryable: true,
    severity: 'blocking',
  },
  too_large: {
    label: 'File exceeds the storage size cap',
    action: 'Raise the vault-documents bucket limit in the Supabase dashboard, or upload via the resumable/TUS path. Until then the original is not stored.',
    retryable: false,
    severity: 'blocking',
  },
  storage: {
    label: 'Upload to the vault failed',
    action: 'Check the vault-documents bucket size cap and that the service-role key is current.',
    retryable: true,
    severity: 'blocking',
  },
  billing: {
    label: 'Provider billing blocked',
    action: 'Google (Gemini) is refusing the project over a past-due balance — "Lightning dunning decision is deny" (2026-09-03). Pay it under Google Cloud → Billing → the account → Payment overview; the key needs no change and the document retries on its own.',
    retryable: true,
    severity: 'blocking',
  },
  auth: {
    label: 'Credentials rejected',
    action: 'A key is stale. Refresh SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY / GOOGLE_API_KEY wherever this ingest path runs.',
    retryable: true,
    severity: 'blocking',
  },
  corrupt_file: {
    label: 'File is malformed',
    action: 'The PDF/archive failed to parse. scripts/_repair-corrupt-pdfs.mjs round-trips these via PyMuPDF; badly broken ones need rasterize-then-OCR.',
    retryable: false,
    severity: 'blocking',
  },
  empty_file: {
    label: 'File is zero bytes',
    action: 'Nothing was uploaded. Delete the row and re-upload from the original.',
    retryable: false,
    severity: 'blocking',
  },
  retries_exhausted: {
    label: 'Gave up after repeated failures',
    action: 'The recovery sweep retried this document until its budget ran out and stopped. The original cause is gone from the row — open the file and re-run it once by hand (Retry in the Vault) to see the real error, then classify that.',
    retryable: false,
    severity: 'blocking',
  },
  db_timeout: {
    label: 'Database timed out inserting passages',
    action: 'A very large document overran the statement timeout while its passages were being inserted. Re-run — inserts are batched smaller now; if it recurs, split the document.',
    retryable: true,
    severity: 'transient',
  },
  stuck: {
    label: 'Stuck mid-pipeline',
    action: 'The document has sat in a transient state past the staleness window — the process handling it died. Requeue it.',
    retryable: true,
    severity: 'transient',
  },
  ready_but_empty: {
    label: 'Marked ready but not searchable',
    // The 2026-08-22 audit's headline class: 99.3% of documents said `ready`
    // while only 60.5% had any passage behind them — 5,782 TIFFs of a live
    // Bates production sat green-lit and invisible to search for weeks.
    // `ready` records that the pipeline finished, not that text exists; for a
    // text-bearing extension, zero passages means the pipeline finished WRONG.
    action: 'A text document claims success but produced zero searchable passages. Re-run ingestion (--fix requeues these); if it comes back empty again, open the file and see what the pipeline is missing — that is how the TIFF gap was found.',
    retryable: true,
    severity: 'blocking',
  },
  duplicate_of_indexed: {
    label: 'Duplicate of an indexed copy',
    action: 'Same matter, filename and byte size as a copy that IS searchable. Left un-OCRed by choice (2026-08-23) — the content is reachable through its twin. Deduplicating the rows is audit fix 7.',
    retryable: false,
    severity: 'benign',
  },
  stored_without_text: {
    label: 'Stored without text (image/media)',
    action: 'An image or recording with no extracted text — store-and-display is its normal resting state. Wire OCR/transcription hooks if you expected text.',
    retryable: false,
    severity: 'benign',
  },
  // The six recorded reasons (documents.metadata.text_status, written by
  // ingest-core since 2026-09-04). A row carrying one of these is empty ON
  // PURPOSE and says why; the monitor counts it as known-benign instead of
  // guessing from the extension.
  stored_image_only: {
    label: 'Image only — OCR found no text',
    action: 'The pipeline ran OCR (or the format is never OCR\'d) and found no words. Stored and viewable. If you expected text, open the file: a faint or skewed scan may need a cleaner copy.',
    retryable: false,
    severity: 'benign',
  },
  stored_no_text: {
    label: 'Opened, but held no text',
    action: 'The file extracted cleanly and was empty (blank .txt, workbook with no cell text, picture-only deck). Stored and viewable; nothing to retry.',
    retryable: false,
    severity: 'benign',
  },
  stored_portfolio: {
    label: 'Portfolio wrapper (children filed separately)',
    action: 'A PDF that packaged other files. Its attachments were unpacked into their own documents; the cover is kept for reference. Check the children, not the wrapper.',
    retryable: false,
    severity: 'benign',
  },
  stored_media_no_transcript: {
    label: 'Recording stored without a transcript',
    action: 'No transcription hook was configured where this ingest ran (GOOGLE_API_KEY). Set it and requeue if the recording should be searchable.',
    retryable: false,
    severity: 'benign',
  },
  stored_binary_asset: {
    label: '3D / design asset stored',
    action: 'A .obj/.glb/.fbx-type asset, kept to open or download. It has no text to index; nothing to do.',
    retryable: false,
    severity: 'benign',
  },
  stored_unsupported: {
    label: 'Unrecognized format stored as-is',
    action: 'Binary content in a format the pipeline does not read. Stored for download. Convert to PDF/.docx and re-upload if it should be searchable.',
    retryable: false,
    severity: 'benign',
  },
  // Pages a PDF still owes OCR (documents.metadata.ocr_pending, Phase 2 of
  // the ingestion plan, 2026-09-04). The document itself is ready — its typed
  // pages are indexed — so these are about completeness, not failure. The
  // worker's idle sweep retries on the schedule in ingest-formats
  // (OCR_RETRY_DELAYS_MS); --fix stays out of its way until that schedule is
  // exhausted. classifyOcrPending picks among the three.
  ocr_pending: {
    label: 'Pages awaiting OCR (retrying automatically)',
    action: 'OCR could not run on some pages — usually a provider outage. The typed pages are searchable now; the worker retries the rest on its own schedule (5 min → 6 h). Nothing to do unless it recurs.',
    retryable: false,
    severity: 'transient',
  },
  ocr_exhausted: {
    label: 'OCR gave up on some pages',
    action: 'The automatic retries ran out (about ten hours). Read the recorded reason: a dead key or blocked billing wants fixing first; an outage that long wants a look. Then Re-run the document (or --fix).',
    retryable: true,
    severity: 'blocking',
  },
  ocr_held_sealed: {
    label: 'Scanned pages held by the SecureSpace seal',
    action: 'The typed pages are indexed; the scanned pages were not sent out for OCR. They stay unread until a sealed OCR route exists (plan: AWS Textract, Phase 4). Nothing to do now.',
    retryable: false,
    severity: 'benign',
  },
  other: {
    label: 'Unclassified failure',
    action: 'No rule matched. Read the raw error and add a rule here once the cause is known.',
    retryable: true,
    severity: 'blocking',
  },
};

// Map a raw error string onto a class. Ordered most-specific first: several
// patterns co-occur (a 429 body also contains "tokens"), so the sequence is
// load-bearing.
export function classifyError(msg = '') {
  const m = String(msg).toLowerCase();
  if (!m.trim()) return 'other';
  // Exact phrases this codebase writes itself go FIRST. They carry
  // interpolated numbers ("failed to process 1429 times", "429 page(s)"),
  // and the loose substring rules below — '429' above all — would otherwise
  // reclassify a blocking failure as a transient rate limit.
  //   · the recovery sweep's wording (migration 058) for an upload that never
  //     finished and for a document it gave up on — 8 of the 19 rows the
  //     monitor called "unclassified" on 2026-09-04;
  //   · ingest-core's wording since 2026-09-04 for a scan it could not read
  //     because no OCR hook was wired (before: "no passages extracted", which
  //     triage called a benign photo).
  if (m.includes('upload did not finish')) return 'empty_file';
  if (m.includes('will not be retried automatically')) return 'retries_exhausted';
  if (m.includes('ocr not configured')) return 'ocr_needed';
  if (m.includes('statement timeout')) return 'db_timeout';
  if (m.includes('maximum request size')) return 'token_limit_400';
  if (m.includes('429') || m.includes('rate limit reached')) return 'rate_limit_429';
  if (m.includes('max_tokens_per_request') || m.includes('maximum input length')) return 'token_limit_400';
  if (m.includes('unsupported unicode escape')) return 'encoding_reject';
  if (m.includes('gemini') && (m.includes('idle') || m.includes('wall clock') || m.includes('timeout'))) return 'media_timeout';
  if (m.includes('no passages extracted')) return 'no_text';
  if (m.includes('bad xref') || m.includes('command token too long') || m.includes('invalid pdf') || m.includes('drm-protected')) return 'corrupt_file';
  if (m.includes('exceeded the maximum allowed size') || m.includes('payload too large') || m.includes('413')) return 'too_large';
  // A billing hold answers 403 too — it must outrank the credentials rule or a
  // paid-up key gets "refreshed" for nothing.
  if (m.includes('dunning') || m.includes('billing') || m.includes('past due') || m.includes('payment required')) return 'billing';
  if (m.includes('401') || m.includes('403') || m.includes('invalid api key') || m.includes('jwt')) return 'auth';
  if (m.includes('upload:') || m.includes('storage')) return 'storage';
  if (m.includes('0 bytes') || m.includes('empty file')) return 'empty_file';
  return 'other';
}

export function describe(cls) {
  return TRIAGE[cls] || TRIAGE.other;
}

// Map a recorded text_status (documents.metadata.text_status) onto a triage
// class. Returns null when the row carries none, so callers fall back to the
// extension guess. Every value ingest-core writes has a class here; an
// unknown value still lands on a benign class rather than escalating — the
// row SAID why it is empty, which is the whole point of the field.
const TEXT_STATUS_CLASS = {
  image_only: 'stored_image_only',
  no_text: 'stored_no_text',
  portfolio: 'stored_portfolio',
  media_no_transcript: 'stored_media_no_transcript',
  binary_stored: 'stored_binary_asset',
  unsupported: 'stored_unsupported',
  // Not a stored_* class: a scan whose OCR has not run yet is transient, and
  // the monitor reads the fuller ocr_pending record for the exhausted/held
  // distinction (classifyOcrPending). Listed so the value never falls to the
  // generic class.
  ocr_pending: 'ocr_pending',
};
// The benign stored_* classes only — the monitor mutes these. ocr_pending is
// deliberately not among them: it is transient, and must surface.
export const TEXT_STATUS_CLASSES = Object.freeze(
  Object.values(TEXT_STATUS_CLASS).filter((c) => c.startsWith('stored_')));
export function classifyTextStatus(textStatus) {
  if (!textStatus) return null;
  return TEXT_STATUS_CLASS[String(textStatus)] || 'stored_without_text';
}

// Map an ocr_pending record (documents.metadata.ocr_pending) onto a triage
// class: sealed → benign, schedule exhausted → blocking, otherwise transient.
export function classifyOcrPending(pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (pending.held) return 'ocr_held_sealed';
  if (pending.exhausted) return 'ocr_exhausted';
  return 'ocr_pending';
}

// What the document row should say after a failed worker attempt. Until
// 2026-09-03 a first-attempt failure wrote nothing to the document, so a job
// that died in 23 seconds looked like a 45-minute upload; the retry sweep
// (migration 058) then buried the real cause under the generic exhausted text.
// `retrying` is written while attempts remain, `exhausted` when they are gone.
export function attemptFailureNote(rawError, attempts, maxAttempts) {
  const raw = String(rawError ?? '');
  const cls = classifyError(raw);
  const t = describe(cls);
  const label = t?.label || 'Processing failed';
  const firstLine = raw.split('\n')[0].trim().slice(0, 160);
  const detail = firstLine ? ` (${firstLine})` : '';
  const n = Number(attempts) || 0;
  const max = Number(maxAttempts) || 0;
  return {
    cls,
    exhausted: `${label}. ${t?.action ?? ''}`.trim(),
    retrying: `Attempt ${n} of ${max} failed — ${label}${detail}. Retrying automatically within about 15 minutes.`,
  };
}

// Group classified rows into a report structure both the CLI and the email
// digest render from, so they can never disagree about counts.
export function summarize(rows) {
  const byClass = new Map();
  for (const r of rows) {
    const cls = r.cls || classifyError(r.error);
    if (!byClass.has(cls)) byClass.set(cls, { cls, ...describe(cls), count: 0, examples: [] });
    const e = byClass.get(cls);
    e.count++;
    if (e.examples.length < 5) e.examples.push(r);
  }
  const groups = [...byClass.values()].sort((a, b) => b.count - a.count);
  const rank = { blocking: 0, transient: 1, benign: 2 };
  groups.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
  return {
    total: rows.length,
    groups,
    needsHuman: groups.filter((g) => g.severity === 'blocking').reduce((s, g) => s + g.count, 0),
    autoRetryable: groups.filter((g) => g.retryable && g.severity !== 'blocking').reduce((s, g) => s + g.count, 0),
  };
}
