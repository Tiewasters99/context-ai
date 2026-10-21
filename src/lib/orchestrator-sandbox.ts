// The Orchestrator's document tasks (2026-10-17): send_to_sandbox,
// copy_document, assemble_documents, edit_pdf, create_deck, create_chart.
//
// The model only PROPOSES them (lib/assistant-core.mjs forwards a `confirm`
// event); the panel shows one sentence and a button, and on the press runs the
// step through /api/sandbox — the endpoint the Vault's Sandbox panel uses, with
// its seal-crossing guard and spend meter. Two pure pieces live here so the
// harness can read them without a browser:
//
//   proposalSentence  what the button will do, in words, before the press;
//   resultNote        what it did, after — posted into the conversation. The
//                     note is the ONLY way the model learns the new ids, the
//                     Sandbox box and the download link (the wire carries
//                     role + content), so it names them plainly.

export const SANDBOX_ACTIONS = [
  'send_to_sandbox', 'copy_document', 'assemble_documents', 'edit_pdf', 'create_deck', 'create_chart',
] as const;
export type SandboxAction = (typeof SANDBOX_ACTIONS)[number];

export const isSandboxAction = (a: unknown): a is SandboxAction =>
  typeof a === 'string' && (SANDBOX_ACTIONS as readonly string[]).includes(a);

type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** Every document id the step names: the ones to look up titles for. */
export function documentIdsOf(action: SandboxAction, args: Args): string[] {
  const out = [...ids(args.document_ids)];
  if (str(args.document_id)) out.push(str(args.document_id));
  if (action === 'edit_pdf' && Array.isArray(args.inserts)) {
    for (const ins of args.inserts) if (ins && typeof ins === 'object' && str((ins as Args).document_id)) out.push(str((ins as Args).document_id));
  }
  return [...new Set(out)];
}

/** The matter the step names (a short_code or a uuid), if any. */
export function matterKeyOf(action: SandboxAction, args: Args): string {
  return action === 'copy_document' ? str(args.to_matter) : str(args.matter);
}

const quote = (t: string) => `“${t}”`;
function list(titles: string[], max = 4) {
  const q = titles.map(quote);
  if (q.length <= max) return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : q[0] ?? '';
  return `${q.slice(0, max).join(', ')} and ${q.length - max} more`;
}

/**
 * One sentence, before the press. `title(id)` returns a document's title (or
 * the id itself when unknown); `matterName` is the named matter's display name.
 */
export function proposalSentence(
  action: SandboxAction, args: Args, title: (id: string) => string, matterName?: string,
): string {
  const where = matterName ? quote(matterName) : 'this matter';
  const docIds = ids(args.document_ids);
  const n = docIds.length;
  switch (action) {
    case 'send_to_sandbox':
      return `Copy ${list(docIds.map(title))} to your Sandbox? The ${n === 1 ? 'original stays' : 'originals stay'} filed where ${n === 1 ? 'it is' : 'they are'}.`;
    case 'copy_document':
      return `Copy ${list(docIds.map(title))} to ${where}? The ${n === 1 ? 'original stays' : 'originals stay'} where ${n === 1 ? 'it is' : 'they are'}.`;
    case 'assemble_documents': {
      const name = str(args.filename) || 'assembled.pdf';
      return `Combine ${n} PDFs into one, in this order: ${docIds.map((id, i) => `${i + 1}. ${quote(title(id))}`).join('; ')}? The new PDF, ${quote(name)}, is filed in ${where}; the sources are untouched.`;
    }
    case 'edit_pdf': {
      const parts: string[] = [];
      if (str(args.pages)) parts.push(`keep pages ${str(args.pages)}, in that order`);
      if (Array.isArray(args.rotate) && args.rotate.length) {
        parts.push(args.rotate.map((r) => `rotate ${str((r as Args).pages) || '?'} by ${(r as Args).degrees}°`).join(', '));
      }
      if (Array.isArray(args.inserts) && args.inserts.length) {
        parts.push(args.inserts.map((r) => `put in pages ${str((r as Args).pages)} of ${quote(title(str((r as Args).document_id)))} at ${(r as Args).at}`).join(', '));
      }
      return `Edit ${quote(title(str(args.document_id)))}: ${parts.join('; ') || 'no change'}? The result is a new PDF beside the original, which is untouched.`;
    }
    case 'create_deck': {
      const slides = Array.isArray(args.slides) ? args.slides.length : 0;
      return `Build the deck ${quote(str(args.title) || 'Untitled')} (${slides} slide${slides === 1 ? '' : 's'} and a cover) and file it in ${where}?`;
    }
    case 'create_chart':
      return `Make the chart ${quote(str(args.title) || 'Untitled')} and file it in ${where}?`;
  }
}

type Doc = { document_id?: string; title?: string; copied_from?: string; already_copied?: boolean; earlier_copy?: string; note?: string };
type Box = { box?: { id?: string; short_code?: string; name?: string }; documents?: Doc[]; note?: string };
type Result = Args & {
  boxes?: Box[]; to?: { id?: string; short_code?: string; name?: string }; copies?: Doc[];
  document_id?: string; matter?: { id?: string; short_code?: string; name?: string };
  filename?: string; page_count?: number; slide_count?: number; download_url?: string | null;
  manifest?: Array<{ title?: string; pages_from?: number; pages_to?: number }>;
};

const docLine = (d: Doc) =>
  `- ${quote(d.title || 'document')} — id ${d.document_id}${d.already_copied ? ' (a copy of this version was already there)' : ''}${d.earlier_copy ? ` (new copy; the original changed since the earlier copy, id ${d.earlier_copy}, which stays)` : ''}${d.note ? ` (${d.note})` : ''}`;
const matterLabel = (m?: { short_code?: string; name?: string; id?: string }) =>
  m ? `${quote(m.name || m.short_code || m.id || 'the matter')}${m.short_code ? ` (short_code ${m.short_code})` : ''}` : 'the matter';
const link = (url?: string | null, label = 'Download') =>
  url ? `\n\n[${label}](${url}) — the link works for 15 minutes; the file stays filed.` : '';

/** What happened, after the press — markdown, naming every new id. */
export function resultNote(action: SandboxAction, r: Result): string {
  switch (action) {
    case 'send_to_sandbox': {
      const boxes = r.boxes ?? [];
      return 'Copied to your Sandbox; the originals stay filed.\n\n' + boxes.map((b) =>
        `In the box ${matterLabel(b.box)}${b.note ? ` — ${b.note}` : ''}:\n${(b.documents ?? []).map(docLine).join('\n')}`,
      ).join('\n\n');
    }
    case 'copy_document':
      return `Copied to ${matterLabel(r.to)}; the originals stay where they were.\n\n${(r.copies ?? []).map(docLine).join('\n')}`;
    case 'assemble_documents': {
      const man = (r.manifest ?? []).map((m) => `- pp. ${m.pages_from}–${m.pages_to}: ${quote(m.title || 'document')}`).join('\n');
      return `Combined into ${quote(r.filename || 'the PDF')} (${r.page_count} pages), filed in ${matterLabel(r.matter)} — id ${r.document_id}.\n\n${man}${link(r.download_url)}`;
    }
    case 'edit_pdf':
      return `Edited copy ${quote(r.filename || 'the PDF')} (${r.page_count} pages) filed in ${matterLabel(r.matter)} — id ${r.document_id}. The original is unchanged.${link(r.download_url)}`;
    case 'create_deck':
      return `Deck ${quote(r.filename || 'the deck')} (${r.slide_count} slides) filed in ${matterLabel(r.matter)} — id ${r.document_id}.${link(r.download_url, 'Download the deck')}`;
    case 'create_chart':
      return `Chart ${quote(r.filename || 'the chart')} filed in ${matterLabel(r.matter)} — id ${r.document_id}.${link(r.download_url, 'Download the chart')}`;
  }
}
