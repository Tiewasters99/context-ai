// Export a Student Hub reading into regular Contextspaces: the reading
// becomes an ordinary ingested document (passages + embeddings) inside a
// serverspace the student picks, reachable by every MCP connector and
// usable anywhere the student works. The Hub is the classroom; the export
// makes the student a full Contextspaces client.
//
// The student chooses the destination. With no choice on record the old
// default still applies — a private "Academic — Contracts" space with a
// matter named for the chapter, both created on demand.
//
// Privacy (design doc "Guardrails"): a serverspace created here has only
// the owner as member — the reading is the student's own scanned casebook
// and stays locked to their account. Their derived study work (brief,
// outline, notes, transcript) is their own product and exports as a
// companion document when asked.

import { supabase } from '@/lib/supabase';
import { persistVaultFile, watchDocumentStatus, type MatterRef } from '@/lib/vault-persist';
import { formatTranscript, listMessages, type StudySession } from '@/lib/student-hub';
import { reflowReading } from '@/lib/student-hub-reflow';

export const DEFAULT_SERVERSPACE_NAME = 'Academic — Contracts';

/** Where the reading is to be filed. */
export type ExportDestination =
  /** A matter that already exists. */
  | { kind: 'existing'; serverspaceId: string; matterspaceId: string }
  /** A new matter, by name, inside an existing serverspace. */
  | { kind: 'new'; serverspaceId: string; matterName: string }
  /** The old behavior: Academic — Contracts → <chapter>, created if absent. */
  | { kind: 'default' };

export interface NamedRow { id: string; name: string }

/** The student's serverspaces; RLS already limits these to their memberships. */
export async function listExportServerspaces(): Promise<NamedRow[]> {
  const { data, error } = await supabase
    .from('serverspaces')
    .select('id, name')
    .order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The top-level matters of one serverspace. */
export async function listExportMatters(serverspaceId: string): Promise<NamedRow[]> {
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name')
    .eq('serverspace_id', serverspaceId)
    .is('parent_matterspace_id', null)
    .order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ---- The last destination used, remembered on this machine ---- */

const DEST_KEY = 'student-hub-export-dest';

export interface RememberedDestination {
  serverspaceId: string;
  matterspaceId?: string;
  newName?: string;
}

export function readRememberedDestination(): RememberedDestination | null {
  try {
    const raw = localStorage.getItem(DEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedDestination;
    return parsed && typeof parsed.serverspaceId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function rememberDestination(dest: RememberedDestination): void {
  try {
    localStorage.setItem(DEST_KEY, JSON.stringify(dest));
  } catch { /* a full or blocked store is not worth an error here */ }
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[a-z]/.test(s) ? s : `m-${s}`;
}

async function ensureServerspace(): Promise<{ id: string; name: string }> {
  const { data: existing, error: findErr } = await supabase
    .from('serverspaces')
    .select('id, name')
    .eq('name', DEFAULT_SERVERSPACE_NAME)
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
    .insert({ clientspace_id: cs.id, name: DEFAULT_SERVERSPACE_NAME })
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

/** One serverspace by id, for the name the vault wants alongside the matter. */
async function serverspaceById(id: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase
    .from('serverspaces')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('That space is no longer there.');
  return data;
}

/** Turns the student's choice into the matter the vault files into. */
async function resolveDestination(
  dest: ExportDestination,
  defaultMatterName: string,
  onProgress: (note: string) => void,
): Promise<MatterRef> {
  if (dest.kind === 'existing') {
    const sel = 'id, name, short_code, cover_url, serverspace_id, parent_matterspace_id, serverspace:serverspaces(name)';
    const { data, error } = await supabase
      .from('matterspaces')
      .select(sel)
      .eq('id', dest.matterspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('That matter is no longer there.');
    // Supabase types the joined serverspace as an object | null on a non-array FK.
    const joined = (data as unknown as { serverspace: { name: string } | null }).serverspace;
    onProgress(`Opening ${data.name}…`);
    return {
      id: data.id,
      name: data.name,
      short_code: data.short_code,
      cover_url: data.cover_url,
      serverspace_id: data.serverspace_id,
      serverspace_name: joined?.name ?? '',
      parent_matterspace_id: data.parent_matterspace_id,
    };
  }

  // Both remaining cases end in the same ensure-by-name path — the one the
  // hub has always used.
  const space = dest.kind === 'new'
    ? await serverspaceById(dest.serverspaceId)
    : await ensureServerspace();
  const matterName = dest.kind === 'new' ? dest.matterName : defaultMatterName;
  onProgress(`Opening ${space.name}…`);
  const matter = await ensureMatter(space.id, matterName);
  return {
    id: matter.id,
    name: matterName,
    short_code: matter.short_code,
    cover_url: null,
    serverspace_id: space.id,
    serverspace_name: space.name,
    parent_matterspace_id: null,
  };
}

function readingDocument(session: StudySession): string {
  const head = [
    session.title,
    session.citation,
    session.source_label,
    '',
  ].filter(Boolean).join('\n');
  // The copy that leaves the hub reads the way the reading reads on screen:
  // real paragraphs, not the hard-wrapped lines the ingest handed over. The
  // stored row keeps whatever it was given.
  return `${head}\n${reflowReading(session.reading)}`;
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
  serverspaceId: string;
  serverspaceName: string;
  matterId: string;
  matterName: string;
  shortCode: string | null;
  documentIds: string[];
}

/**
 * Files the reading (and optionally the student's study work) into the
 * destination the student chose, then resolves when ingestion has made it
 * searchable. `chapterName` is the matter name used by the default
 * destination only. onProgress receives short human-readable stage notes.
 */
export async function exportReading(
  session: StudySession,
  chapterName: string,
  destination: ExportDestination,
  opts: { includeStudyNotes: boolean },
  onProgress: (note: string) => void,
): Promise<ExportResult> {
  const matterRef = await resolveDestination(destination, chapterName, onProgress);

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

  return {
    serverspaceId: matterRef.serverspace_id,
    serverspaceName: matterRef.serverspace_name,
    matterId: matterRef.id,
    matterName: matterRef.name,
    shortCode: matterRef.short_code,
    documentIds,
  };
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
