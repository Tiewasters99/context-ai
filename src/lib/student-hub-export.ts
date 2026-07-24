// Export a Student Hub reading into regular Contextspaces: the reading
// becomes an ordinary ingested document (passages + embeddings) inside a
// private "Academic — …" serverspace, reachable by every MCP connector
// and usable anywhere the student works. The Hub is the classroom; the
// export makes the student a full Contextspaces client.
//
// Privacy (design doc "Guardrails"): the created serverspace has only the
// owner as member — the reading is the student's own scanned casebook and
// stays locked to their account. Their derived study work (brief, outline,
// notes, transcript) is their own product and exports as a companion
// document when asked.

import { supabase } from '@/lib/supabase';
import { persistVaultFile, watchDocumentStatus, type MatterRef } from '@/lib/vault-persist';
import { formatTranscript, listMessages, type StudySession } from '@/lib/student-hub';

const SERVERSPACE_NAME = 'Academic — Contracts';

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z]/.test(s) ? s : `m-${s}`;
}

async function ensureServerspace(): Promise<{ id: string; name: string }> {
  const { data: existing, error: findErr } = await supabase
    .from('serverspaces')
    .select('id, name')
    .eq('name', SERVERSPACE_NAME)
    .limit(1)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (existing) return existing;

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data: cs, error: csErr } = await supabase
    .from('clientspaces')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (csErr) throw new Error(csErr.message);

  // Owner membership is added by the handle_new_serverspace trigger; with
  // no one else added, the space is private to the student.
  const { data: created, error: insErr } = await supabase
    .from('serverspaces')
    .insert({ clientspace_id: cs.id, name: SERVERSPACE_NAME })
    .select('id, name')
    .single();
  if (insErr) throw new Error(insErr.message);
  return created;
}

async function ensureMatter(serverspaceId: string, name: string): Promise<{ id: string; short_code: string | null }> {
  const { data: existing, error: findErr } = await supabase
    .from('matterspaces')
    .select('id, short_code')
    .eq('serverspace_id', serverspaceId)
    .eq('name', name)
    .is('parent_matterspace_id', null)
    .limit(1)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (existing) return existing;

  // short_code is globally unique (it's the MCP handle) — retry with a
  // numeric suffix on collision.
  const base = slugify(name);
  for (let n = 0; n < 5; n++) {
    const short_code = n === 0 ? base : `${base}-${n + 1}`;
    const { data: created, error: insErr } = await supabase
      .from('matterspaces')
      .insert({ serverspace_id: serverspaceId, parent_matterspace_id: null, name, short_code })
      .select('id, short_code')
      .single();
    if (!insErr) return created;
    if (!/duplicate|unique/i.test(insErr.message)) throw new Error(insErr.message);
  }
  throw new Error('Could not find a free short code for the matter.');
}

function readingDocument(session: StudySession): string {
  const head = [
    session.title,
    session.citation,
    session.source_label,
    '',
  ].filter(Boolean).join('\n');
  return `${head}\n${session.reading}`;
}

async function studyNotesDocument(session: StudySession): Promise<string | null> {
  const parts: string[] = [];
  if (session.brief?.length) {
    parts.push('CASE BRIEF', '', ...session.brief.map((f) => `${f.label}: ${f.content}`), '');
  }
  if (session.outline?.length) {
    parts.push('OUTLINE', '');
    for (const sec of session.outline) {
      parts.push(sec.heading, ...sec.items.map((i) => `  § ${i}`), '');
    }
    const marks = session.annotations?.marks ?? {};
    const custom = session.annotations?.custom ?? {};
    const noteLines = Object.values(marks).filter((m) => m.note).map((m) => `  – ${m.note}`);
    const customLines = Object.values(custom).flat().map((c) => `  + ${c}`);
    if (noteLines.length || customLines.length) {
      parts.push('MY OUTLINE MARKS', ...customLines, ...noteLines, '');
    }
  }
  const passageNotes = (session.highlights ?? []).filter((h) => h.note);
  if (passageNotes.length) {
    parts.push('PASSAGE NOTES', ...passageNotes.map((h) => `  p. ${h.page + 1}: ${h.note}`), '');
  }
  if (session.notes?.trim()) {
    parts.push('NOTES', '', session.notes.trim(), '');
  }
  const coldCall = await listMessages(session.id, 'coldcall');
  if (coldCall.length) {
    parts.push(formatTranscript(session, coldCall));
  }
  if (!parts.length) return null;
  return [`${session.title} — study notes`, session.citation, '', ...parts].filter((l) => l !== undefined).join('\n');
}

export interface ExportResult {
  matterId: string;
  matterName: string;
  shortCode: string | null;
  documentIds: string[];
}

/**
 * Files the reading (and optionally the student's study work) into
 * Academic — Contracts → <chapter>, then resolves when ingestion has made
 * it searchable. onProgress receives short human-readable stage notes.
 */
export async function exportReading(
  session: StudySession,
  chapterName: string,
  opts: { includeStudyNotes: boolean },
  onProgress: (note: string) => void,
): Promise<ExportResult> {
  onProgress('Opening Academic — Contracts…');
  const space = await ensureServerspace();
  const matter = await ensureMatter(space.id, chapterName);

  const matterRef: MatterRef = {
    id: matter.id,
    name: chapterName,
    short_code: matter.short_code,
    cover_url: null,
    serverspace_id: space.id,
    serverspace_name: space.name,
    parent_matterspace_id: null,
  };

  const docs: { name: string; text: string }[] = [
    { name: `${session.title}.txt`, text: readingDocument(session) },
  ];
  if (opts.includeStudyNotes) {
    const notes = await studyNotesDocument(session);
    if (notes) docs.push({ name: `${session.title} — study notes.txt`, text: notes });
  }

  const documentIds: string[] = [];
  for (const d of docs) {
    onProgress(`Filing ${d.name}…`);
    const file = new File([d.text], d.name, { type: 'text/plain' });
    const { documentId } = await persistVaultFile(matterRef, file);
    documentIds.push(documentId);
    onProgress(`Indexing ${d.name}…`);
    await new Promise<void>((resolve, reject) => {
      const stopAt = Date.now() + 120_000;
      const stop = watchDocumentStatus(documentId, (status, errorMessage) => {
        if (status === 'indexed') { stop(); resolve(); }
        else if (status === 'error') { stop(); reject(new Error(errorMessage || 'Ingestion failed.')); }
        else if (Date.now() > stopAt) { stop(); resolve(); /* still processing; it will finish */ }
      });
    });
  }

  return { matterId: matter.id, matterName: chapterName, shortCode: matter.short_code, documentIds };
}

/** A local copy of the reading — for feeding any outside tool directly. */
export function downloadReading(session: StudySession): void {
  const blob = new Blob([readingDocument(session)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.title}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
