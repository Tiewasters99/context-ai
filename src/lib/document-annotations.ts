import { supabase } from './supabase';

export type AnnotationColor = 'gold' | 'green' | 'pink' | 'blue';

// 'client_shared' is reserved for the client layer (migration 048) — no UI
// writes it yet; readers must treat it like 'matter' until client roles land.
export type AnnotationVisibility = 'private' | 'matter' | 'client_shared';

export type FractionalRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type AnnotationAuthor = {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
};

export type AnnotationLink = {
  id: string;
  target_document_id: string;
  target_page: number | null;
  target_line: number | null;
  label: string | null;
  target: { id: string; title: string } | null;
};

export type Annotation = {
  id: string;
  document_id: string;
  user_id: string;
  page: number;
  color: AnnotationColor;
  note: string | null;
  anchor_text: string | null;
  rects: FractionalRect[];
  visibility: AnnotationVisibility;
  line_start: number | null;
  line_end: number | null;
  created_at: string;
  updated_at: string;
  author: AnnotationAuthor | null;
  links: AnnotationLink[];
};

// A link arriving AT a document — the reverse direction of annotation_links,
// used for cross-reference marks ("a note elsewhere cites this page").
export type IncomingLink = {
  id: string;
  target_page: number | null;
  target_line: number | null;
  label: string | null;
  annotation: {
    id: string;
    document_id: string;
    page: number;
    note: string | null;
    anchor_text: string | null;
    user_id: string;
    document: { id: string; title: string } | null;
  } | null;
};

// A margin note is an annotation with a written body; plain highlights have
// rects only. No UI wrote `note` before marginalia, so this split is clean.
export function annotationIsNote(a: Annotation): boolean {
  return a.note != null && a.note.trim().length > 0;
}

export function annotationAuthorName(a: Annotation['author']): string {
  if (!a) return 'Someone';
  return a.display_name || a.email?.split('@')[0] || 'Someone';
}

// profiles is referenced twice from document_annotations since migration 048
// (user_id + addressee_user_id), so the author embed must name its FK.
const ANNOTATION_SELECT =
  'id, document_id, user_id, page, color, note, anchor_text, rects, visibility, line_start, line_end, created_at, updated_at, ' +
  'author:profiles!document_annotations_user_id_fkey(id, display_name, email, avatar_url), ' +
  'links:annotation_links(id, target_document_id, target_page, target_line, label, target:documents(id, title))';

export async function listAnnotations(documentId: string): Promise<Annotation[]> {
  const { data, error } = await supabase
    .from('document_annotations')
    .select(ANNOTATION_SELECT)
    .eq('document_id', documentId)
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[annotations load] failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as Annotation[];
}

export async function createAnnotation(args: {
  documentId: string;
  page: number;
  color: AnnotationColor;
  rects: FractionalRect[];
  anchorText?: string | null;
  note?: string | null;
  visibility?: AnnotationVisibility;
  lineStart?: number | null;
  lineEnd?: number | null;
}): Promise<Annotation | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;
  const { data, error } = await supabase
    .from('document_annotations')
    .insert({
      document_id: args.documentId,
      user_id: userId,
      page: args.page,
      color: args.color,
      rects: args.rects,
      anchor_text: args.anchorText ?? null,
      note: args.note ?? null,
      visibility: args.visibility ?? 'matter',
      line_start: args.lineStart ?? null,
      line_end: args.lineEnd ?? null,
    })
    .select(ANNOTATION_SELECT)
    .single();
  if (error) {
    console.warn('[annotation insert] failed:', error.message);
    return null;
  }
  return data as unknown as Annotation;
}

export async function deleteAnnotation(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('document_annotations')
    .delete()
    .eq('id', id);
  if (error) {
    console.warn('[annotation delete] failed:', error.message);
    return false;
  }
  return true;
}

export async function updateAnnotation(
  id: string,
  patch: { note?: string | null; visibility?: AnnotationVisibility },
): Promise<boolean> {
  const { error } = await supabase
    .from('document_annotations')
    .update(patch)
    .eq('id', id);
  if (error) {
    console.warn('[annotation update] failed:', error.message);
    return false;
  }
  return true;
}

export async function addAnnotationLink(args: {
  annotationId: string;
  targetDocumentId: string;
  targetPage?: number | null;
  targetLine?: number | null;
  label?: string | null;
}): Promise<AnnotationLink | null> {
  const { data, error } = await supabase
    .from('annotation_links')
    .insert({
      annotation_id: args.annotationId,
      target_document_id: args.targetDocumentId,
      target_page: args.targetPage ?? null,
      target_line: args.targetLine ?? null,
      label: args.label ?? null,
    })
    .select('id, target_document_id, target_page, target_line, label, target:documents(id, title)')
    .single();
  if (error) {
    console.warn('[annotation link insert] failed:', error.message);
    return null;
  }
  return data as unknown as AnnotationLink;
}

export async function deleteAnnotationLink(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('annotation_links')
    .delete()
    .eq('id', id);
  if (error) {
    console.warn('[annotation link delete] failed:', error.message);
    return false;
  }
  return true;
}

export async function listIncomingLinks(documentId: string): Promise<IncomingLink[]> {
  const { data, error } = await supabase
    .from('annotation_links')
    .select(
      'id, target_page, target_line, label, ' +
        'annotation:document_annotations!annotation_links_annotation_id_fkey(id, document_id, page, note, anchor_text, user_id, document:documents(id, title))',
    )
    .eq('target_document_id', documentId);
  if (error) {
    console.warn('[incoming links load] failed:', error.message);
    return [];
  }
  return (data ?? []) as unknown as IncomingLink[];
}

// ─────────────────────────────────────────────────────────────────────────
// page:line derivation — deterministic, no model in the loop.
//
// The verbatim selection (anchor_text) is the ground truth; line numbers are
// display metadata derived by matching the selection against the ingested
// passages for the page. Only transcript-parsed passages carry line_start
// (see lib/ingest-core.mjs parseTranscriptPage), so for briefs/exhibits this
// returns null and the citation shows page only.
// ─────────────────────────────────────────────────────────────────────────

function normalizeWithLineMap(text: string): { norm: string; lineAt: number[] } {
  const norm: string[] = [];
  const lineAt: number[] = [];
  let line = 1;
  let prevSpace = true;
  for (const ch of text) {
    if (ch === '\n') line++;
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm.push(' ');
        lineAt.push(line);
        prevSpace = true;
      }
    } else {
      norm.push(ch.toLowerCase());
      lineAt.push(line);
      prevSpace = false;
    }
  }
  return { norm: norm.join(''), lineAt };
}

export async function derivePageLine(
  documentId: string,
  page: number,
  anchorText: string,
): Promise<{ lineStart: number; lineEnd: number } | null> {
  const words = anchorText.toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
  if (words.length === 0 || words[0] === '') return null;
  const startSnip = words.slice(0, 8).join(' ');
  const endSnip = words.slice(-8).join(' ');

  const { data, error } = await supabase
    .from('passages')
    .select('text, page_start, line_start')
    .eq('document_id', documentId)
    .eq('summary_level', 0)
    .lte('page_start', page)
    .gte('page_end', page)
    .not('line_start', 'is', null)
    .order('sequence_number', { ascending: true });
  if (error || !data || data.length === 0) return null;

  for (const p of data as { text: string; line_start: number }[]) {
    const { norm, lineAt } = normalizeWithLineMap(p.text);
    const idx = norm.indexOf(startSnip);
    if (idx < 0) continue;
    const relStart = lineAt[idx];
    let relEnd = relStart;
    const endIdx = norm.indexOf(endSnip, idx);
    if (endIdx >= 0 && endIdx + endSnip.length - 1 < lineAt.length) {
      relEnd = lineAt[endIdx + endSnip.length - 1];
    }
    return {
      lineStart: p.line_start + relStart - 1,
      lineEnd: p.line_start + Math.max(relStart, relEnd) - 1,
    };
  }
  return null;
}

// Client-side twin of lib/mcp-core.mjs formatCitation, reduced to what the
// reader knows (no doc_type): "12:5-8" for transcript-style anchors with
// line numbers, "p. 12" otherwise.
export function formatNoteCite(
  page: number,
  lineStart: number | null,
  lineEnd: number | null,
): string {
  if (lineStart != null) {
    return lineEnd != null && lineEnd !== lineStart
      ? `${page}:${lineStart}-${lineEnd}`
      : `${page}:${lineStart}`;
  }
  return `p. ${page}`;
}
