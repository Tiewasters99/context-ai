// lib/comparator.mjs — the Model Comparator's one server action (slice 1).
//
// add_comparison_candidate files a candidate into a comparison's Sandbox box,
// BLIND. It is the only way a candidate is added — the Compare dialog's upload
// and a script filing drafts from disk both POST it to /api/sandbox — so the
// blind is enforced in one place:
//
//   * the document's title is "Candidate <label> — <comparison title>" and its
//     filename "candidate-<label>-<title>.<ext>", whatever the caller's file
//     was called (an original filename like "opus-draft.md" would give the
//     game away in the Vault);
//   * who made it (`revealed_label`) goes into comparison_candidate_keys with
//     the caller's own session; migration 120's RLS lets nobody read it back
//     until every candidate is graded and the comparison is revealed. The
//     insert names no RETURNING, which the policy would refuse;
//   * the Record row (comparison.candidate) carries the blind label and ids,
//     never the revealed name.
//
// Everything runs under the CALLER's Supabase client (RLS decides), exactly
// like the rest of api/sandbox.mjs. Filing goes through the existing
// file_document tool, so the document is stored and ingested like any other
// (and that call writes its own tool.invoked row).
//
// Slice 2 extension point: a model-run candidate (source 'model') is executed
// through the llm-sealed-route adapters and filed by this same function, with
// model/settings/usage written only to the key side so the blind holds. Not
// built here.

import { countWords } from './comparator-assemble.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_RE = /^[A-Z]{1,2}$/;
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt']);
const ALLOWED_EXTS = new Set([...TEXT_EXTS, '.pdf', '.docx']);
const MAX_REVEALED_LABEL = 200;


export class ComparatorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** True when the error says the comparator's tables are not in this database yet. */
export function isComparatorMissing(error) {
  const code = String(error?.code ?? '');
  const msg = String(error?.message ?? '');
  return code === 'PGRST205' || code === '42P01' || /comparison(s|_candidates|_candidate_keys|_types)?\b.*(does not exist|schema cache)/i.test(msg);
}

/** The labels in order: A … Z, then AA … ZZ. */
export function nextLabel(taken) {
  const used = new Set(taken);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letters) if (!used.has(a)) return a;
  for (const a of letters) for (const b of letters) if (!used.has(a + b)) return a + b;
  return null;
}

export function slug(s, max = 60) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/g, '') || 'comparison';
}

/** The blind name and filename a candidate is filed under. */
export function blindNames(label, comparisonTitle, ext) {
  const title = String(comparisonTitle ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: `Candidate ${label} — ${title}`,
    filename: `candidate-${label.toLowerCase()}-${slug(title)}${ext}`,
  };
}

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename ?? '').trim());
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * @param sb    the caller's Supabase client (user-scoped).
 * @param args  {comparison_id, filename, content, encoding?, label?, revealed_label?}
 * @param deps  {userId, fileDocument(args) → file_document's result, record(sb, opts)}
 */
export async function addComparisonCandidate(sb, args, deps) {
  const { userId, fileDocument, record } = deps;
  const comparisonId = String(args?.comparison_id ?? '').trim();
  if (!UUID_RE.test(comparisonId)) throw new ComparatorError('comparison_id must be the comparison\'s id.');
  const ext = extOf(args?.filename);
  if (!ALLOWED_EXTS.has(ext)) {
    throw new ComparatorError('A candidate must be a Markdown, text, PDF or Word (.docx) file.');
  }
  if (typeof args?.content !== 'string' || !args.content.length) throw new ComparatorError('content is required.');
  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  const revealedLabel = typeof args.revealed_label === 'string' ? args.revealed_label.replace(/\s+/g, ' ').trim() : '';
  if (revealedLabel.length > MAX_REVEALED_LABEL) throw new ComparatorError(`revealed_label is limited to ${MAX_REVEALED_LABEL} characters.`);

  // 1. The comparison, as the caller sees it.
  const { data: cmp, error: cmpErr } = await sb
    .from('comparisons')
    .select('id, box_matter_id, title, revealed_at')
    .eq('id', comparisonId)
    .maybeSingle();
  if (cmpErr) {
    if (isComparatorMissing(cmpErr)) throw new ComparatorError('The Model Comparator is not set up in this database yet (migration 120 is not applied).', 503);
    throw new ComparatorError(`comparison: ${cmpErr.message}`, 500);
  }
  if (!cmp) throw new ComparatorError('comparison not found (or not in a matter you can open).', 403);
  if (cmp.revealed_at) throw new ComparatorError('This comparison has been revealed; its candidates are fixed.', 409);

  // 2. The blind label.
  const { data: existing, error: exErr } = await sb
    .from('comparison_candidates')
    .select('label')
    .eq('comparison_id', comparisonId);
  if (exErr) throw new ComparatorError(`candidates: ${exErr.message}`, 500);
  const taken = (existing ?? []).map((r) => r.label);
  let label;
  if (args.label != null && String(args.label).trim()) {
    label = String(args.label).trim().toUpperCase();
    if (!LABEL_RE.test(label)) throw new ComparatorError('label must be one or two capital letters (A, B, … AA).');
    if (taken.includes(label)) throw new ComparatorError(`Candidate ${label} already exists in this comparison.`, 409);
  } else {
    label = nextLabel(taken);
    if (!label) throw new ComparatorError('This comparison has no blind labels left.', 409);
  }

  // 3. File it under the blind name.
  const names = blindNames(label, cmp.title, ext);
  const filed = await fileDocument({
    matter: cmp.box_matter_id,
    filename: names.filename,
    title: names.title,
    content: args.content,
    encoding,
    doc_type: 'other',
  });
  const documentId = filed?.document_id;
  if (!documentId) throw new ComparatorError('The candidate could not be filed.', 500);
  if (filed.already_filed) {
    throw new ComparatorError(`${filed.note ?? 'This file is already filed in the box.'} A candidate needs its own document.`, 409);
  }

  const rollback = async () => {
    try {
      const { data: d } = await sb.from('documents').select('storage_path').eq('id', documentId).maybeSingle();
      if (d?.storage_path) await sb.storage.from('vault-documents').remove([d.storage_path]);
      await sb.from('documents').delete().eq('id', documentId);
    } catch { /* best effort: the error below is what the caller needs */ }
  };

  // 4. The candidate row (shown blind), then the key (never read back).
  let wordCount = null;
  if (TEXT_EXTS.has(ext)) {
    const text = encoding === 'base64' ? Buffer.from(args.content, 'base64').toString('utf8') : args.content;
    wordCount = countWords(text);
  }
  const { data: cand, error: candErr } = await sb
    .from('comparison_candidates')
    .insert({
      comparison_id: comparisonId,
      label,
      source: 'upload',
      document_id: documentId,
      word_count: wordCount,
      created_by: userId,
    })
    .select('id')
    .single();
  if (candErr || !cand) {
    await rollback();
    throw new ComparatorError(`candidate: ${candErr?.message ?? 'not created'}`, candErr?.code === '42501' ? 403 : 500);
  }

  if (revealedLabel) {
    // No .select(): RETURNING would have to pass the SELECT policy, which
    // refuses every key until the reveal.
    const { error: keyErr } = await sb
      .from('comparison_candidate_keys')
      .insert({ candidate_id: cand.id, revealed_label: revealedLabel, created_by: userId });
    if (keyErr) {
      await sb.from('comparison_candidates').delete().eq('id', cand.id);
      await rollback();
      throw new ComparatorError(`key: ${keyErr.message}`, keyErr.code === '42501' ? 403 : 500);
    }
  }

  // 5. The Record — the blind label and ids, never the revealed name.
  await record(sb, {
    kind: 'comparison.candidate',
    matterId: cmp.box_matter_id,
    actor: { kind: 'user', ref: userId, user_id: userId },
    payload: { comparison_id: comparisonId, candidate_id: cand.id, document_id: documentId, label, source: 'upload' },
  });

  return {
    comparison_id: comparisonId,
    candidate_id: cand.id,
    label,
    document_id: documentId,
    title: names.title,
    filename: names.filename,
    word_count: wordCount,
    status: filed.status ?? null,
    key_filed: Boolean(revealedLabel),
  };
}
