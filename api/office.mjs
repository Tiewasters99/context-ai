// GET /api/office — the public manifest of The Office
// GET /api/office?book=<item_id> — the reading room: one published book's text
//
// The Office (migration 050) is the externally-facing room: a walkable
// photoreal office whose Library shelves and Practice Areas are populated
// from Contextspaces. This endpoint is the ONLY window the public has into
// that data: it serves published sections and items — titles, author lines,
// excerpts, spine colors — and deliberately nothing else. No storage paths,
// no file bytes, no links back into the vault. One-way glass by
// construction: the office can SHOW a book the way a physical library
// does; nothing can be carried out.
//
// The reading room extends the same rule to the text itself: ?book= serves
// the indexed passages of one published item as plain reading pages —
// a visitor browsing a book left out on the office table. Text only, no
// original file, no storage path, no download; the volume is capped so the
// longest works trail off into "the rest stays in the vault."
//
// Auth: none (public, read-only), but the room is NOT the whole database.
// It runs on the service role because the office tables have owner-only
// RLS, and the service role sees every tenant — so the one thing that
// decides whose room this is cannot come from the caller. It comes from
// the server: OFFICE_DEFAULT_OWNER_ID names the single owner whose
// published office is public. Every query here is scoped to that owner,
// and the rows are filtered again in memory before anything is shaped
// (selectRoom / selectBook below) so a widened query can never widen the
// room. Publishing in the app (published=true) says "show this in MY
// office"; it does not, by itself, make anything public — a second
// tenant's published items are invisible here, in the listing and in
// ?book= alike, and become public only if the operator deliberately
// points OFFICE_DEFAULT_OWNER_ID at them.
//
// Unconfigured is CLOSED, never open: with no valid OFFICE_DEFAULT_OWNER_ID
// the office answers 503 and shows nothing at all.
//
// CORS is open so the office front end can live on any origin (today a
// local depth-parallax build; later its own domain).

import { createClient } from '@supabase/supabase-js';
import { isSealedTier, matterTierWithClient } from '../lib/ai-tier-policy.mjs';

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- whose room this is, and what belongs in it -------------------------
// Pure, network-free, and exported so scripts/_verify-office-tenancy.mjs can
// drive them with two owners' rows and prove the filtering.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// The manifest's items without any whose document is sealed, or whose seal
// could not be read (fails closed: omitted, never shown).
export async function dropSealedItems(supabase, items) {
  const keep = [];
  for (const it of items) {
    if (!it?.document_id) { keep.push(it); continue; }
    try {
      if (!(await documentIsSealed(supabase, it.document_id))) keep.push(it);
    } catch {
      // omitted
    }
  }
  return keep;
}

// Is this document in a sealed matter (its own tier or an ancestor's is B or
// C)? Read with the service role the room already runs on. After 098 it is one
// column; before 098 is pasted (42703) the ancestry is walked. Any other
// failure throws, and the caller refuses.
export async function documentIsSealed(supabase, documentId) {
  if (!documentId) return false;
  const { data: d, error: dErr } = await supabase
    .from('documents').select('matterspace_id').eq('id', documentId).maybeSingle();
  if (dErr) throw new Error(`seal lookup: ${dErr.message}`);
  if (!d?.matterspace_id) return false;
  const { data: m, error: mErr } = await supabase
    .from('matterspaces').select('sealed_effective').eq('id', d.matterspace_id).maybeSingle();
  if (!mErr) return m?.sealed_effective === true;
  if (mErr.code !== '42703' && !/sealed_effective/.test(mErr.message ?? '')) {
    throw new Error(`seal lookup: ${mErr.message}`);
  }
  return isSealedTier(await matterTierWithClient(supabase, d.matterspace_id));
}

// The room's owner comes from the environment, never from the request.
// Missing or malformed closes the office rather than opening it to everyone.
export function resolveRoomOwner(env = process.env) {
  const raw = (env.OFFICE_DEFAULT_OWNER_ID ?? '').toString().trim();
  if (!raw) return { ok: false, reason: 'unset' };
  if (!isUuid(raw)) return { ok: false, reason: 'invalid' };
  return { ok: true, ownerId: raw.toLowerCase() };
}

const ownedBy = (ownerId, row) =>
  Boolean(row) && typeof row.owner_id === 'string' && row.owner_id.toLowerCase() === ownerId;

// The manifest: this owner's published items, on this owner's shelves.
// Input order is the DB's order (sort_order, created_at) and is preserved.
export function selectRoom({ ownerId, sections = [], items = [], jackets = new Map(), pages = new Map() }) {
  if (!isUuid(ownerId)) return [];
  const owner = ownerId.toLowerCase();
  const bySection = {};
  for (const it of items) {
    if (!ownedBy(owner, it) || it.published !== true) continue;
    (bySection[it.section_id] ??= []).push({
      id: it.id,
      title: it.title,
      author: it.author,
      excerpt: it.excerpt,
      spine: it.spine,
      cover: jackets.get(it.id) ?? null,
      pages: pages.get(it.id)?.length ?? 0,
      // whether ?book= will answer for this item — the document id itself
      // stays behind the glass
      readable: Boolean(it.document_id),
    });
  }
  return sections
    .filter((s) => ownedBy(owner, s))
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      blurb: s.blurb,
      items: bySection[s.id] ?? [],
    }))
    // an empty shelf is a back-office fact, not a public one
    .filter((s) => s.items.length > 0);
}

// The reading room: the same rule as the listing, applied to one item.
// Anything that is not this owner's published, readable item is simply
// not on the shelves — one answer for missing, unpublished, and foreign.
export function selectBook({ ownerId, item }) {
  if (!isUuid(ownerId)) return null;
  if (!ownedBy(ownerId.toLowerCase(), item)) return null;
  if (item.published !== true) return null;
  if (!item.document_id) return null;
  return item;
}

// Jackets. A cover is the one image the glass lets through — it is what a
// bookshop window shows. At publish time the app captures page one of a
// PDF into the public cover-images bucket at <owner>/office/<item id>.jpg;
// nothing records it but the object itself, so the feed lists that folder
// and any item whose id has a jacket there gets a `cover` URL. The URL is
// the bucket's public object URL, versioned by its upload time so a
// re-captured jacket is not hidden behind a cached one.
// Pages, the same way: a deck — a PDF whose pages are wider than tall —
// has every page captured into <owner>/office/<item id>/0001.jpg…, and the
// Reader turns those images like a scanned book. The folder is the record.
const publicUrl = (owner, name, stamp) =>
  `${SUPABASE_URL}/storage/v1/object/public/cover-images/${owner}/office/${name}?v=${encodeURIComponent(stamp ?? '')}`;

async function officeImages(supabase, owners) {
  const jackets = new Map();
  const pages = new Map();
  for (const owner of new Set(owners.filter(Boolean))) {
    const { data } = await supabase.storage
      .from('cover-images')
      .list(`${owner}/office`, { limit: 1000 });
    for (const o of data ?? []) {
      const jacket = /^([0-9a-f-]{36})\.jpg$/i.exec(o.name);
      if (jacket) {
        jackets.set(jacket[1], publicUrl(owner, o.name, o.updated_at ?? o.created_at));
        continue;
      }
      // A folder lists with no metadata; its name is the item whose pages it holds.
      if (o.id == null && /^[0-9a-f-]{36}$/i.test(o.name)) {
        const { data: files } = await supabase.storage
          .from('cover-images')
          .list(`${owner}/office/${o.name}`, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
        const urls = (files ?? [])
          .filter((f) => /^\d{4}\.jpg$/.test(f.name))
          .map((f) => publicUrl(owner, `${o.name}/${f.name}`, f.updated_at ?? f.created_at));
        if (urls.length) pages.set(o.name, urls);
      }
    }
  }
  return { jackets, pages };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'Supabase env not configured' });
    return;
  }

  // Whose office is open to the public. No owner, no office.
  const room = resolveRoomOwner();
  if (!room.ok) {
    res.status(503).json({ error: 'The office is not open' });
    return;
  }
  const ownerId = room.ownerId;

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- the reading room: ?book=<office_item_id> ---------------------------
  const bookId = (req.query?.book ?? '').toString().trim();
  if (bookId) {
    // Validated before it reaches a service-role query: only a uuid can be
    // an office item, and an unshaped string is not a filter we will run.
    if (!isUuid(bookId)) {
      res.status(404).json({ error: 'No such book on the shelves' });
      return;
    }
    const { data: row, error: itemError } = await supabase
      .from('office_items')
      .select('id, title, author, document_id, published, owner_id')
      .eq('id', bookId)
      .eq('owner_id', ownerId)
      .eq('published', true)
      .maybeSingle();
    if (itemError) {
      res.status(500).json({ error: itemError.message });
      return;
    }
    const item = selectBook({ ownerId, item: row });
    if (!item) {
      res.status(404).json({ error: 'No such book on the shelves' });
      return;
    }
    // 098: a sealed matter's document is never read out in the public room,
    // whatever the item row says (an item shelved before 098, or by a session
    // that had confirmed its factor). Unknown is refused, not served.
    let sealed;
    try {
      sealed = await documentIsSealed(supabase, item.document_id);
    } catch {
      res.status(503).json({ error: 'The book cannot be opened just now' });
      return;
    }
    if (sealed) {
      res.status(404).json({ error: 'No such book on the shelves' });
      return;
    }
    // What KIND of reading this is: a slide deck reads as slides (one card
    // per passage — ingest indexes one passage per slide), everything else
    // as flowing text pages. Only the shape travels; never the file.
    const { data: srcDoc } = await supabase
      .from('documents')
      .select('source_filename')
      .eq('id', item.document_id)
      .maybeSingle();
    const srcName = (srcDoc?.source_filename ?? '').toLowerCase();
    const readKind = srcName.endsWith('.pptx') || srcName.endsWith('.ppt') ? 'slides' : 'text';
    // Raw text passages in reading order. The cap keeps one request from
    // shipping a 700-page transcript; MAX_CHARS trims the tail passage-by-
    // passage so the reader can say, honestly, that the rest stays filed.
    // Sized so a full novel reads to its last line — Tender Is the Night
    // runs ~617k chars and was losing its ending at 600k.
    const MAX_PASSAGES = 1200;
    const MAX_CHARS = 1_200_000;
    const { data: passages, error: passError } = await supabase
      .from('passages')
      .select('sequence_number, page_start, text')
      .eq('document_id', item.document_id)
      .eq('summary_level', 0)
      .order('sequence_number', { ascending: true })
      .limit(MAX_PASSAGES + 1);
    if (passError) {
      res.status(500).json({ error: passError.message });
      return;
    }
    const pages = [];
    let chars = 0;
    let truncated = (passages ?? []).length > MAX_PASSAGES;
    for (const p of (passages ?? []).slice(0, MAX_PASSAGES)) {
      const text = p.text ?? '';
      if (chars + text.length > MAX_CHARS) { truncated = true; break; }
      chars += text.length;
      pages.push({ n: p.sequence_number, page: p.page_start ?? null, text });
    }
    const images = await officeImages(supabase, [ownerId]);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.status(200).json({
      id: item.id,
      title: item.title,
      author: item.author,
      kind: readKind,
      cover: images.jackets.get(item.id) ?? null,
      images: images.pages.get(item.id) ?? null,
      pages,
      truncated,
    });
    return;
  }

  const [sections, items] = await Promise.all([
    supabase
      .from('office_sections')
      .select('id, kind, title, blurb, sort_order, owner_id')
      .eq('owner_id', ownerId)
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('office_items')
      .select('id, section_id, title, author, excerpt, spine, sort_order, document_id, owner_id, published')
      .eq('owner_id', ownerId)
      .eq('published', true)
      .order('sort_order')
      .order('created_at'),
  ]);
  if (sections.error || items.error) {
    res.status(500).json({ error: (sections.error || items.error).message });
    return;
  }

  // 098: nothing sealed ever appears on a public page. An item's excerpt is
  // the document's own opening text, so an item whose document is sealed —
  // shelved before 098, or sealed after it was published — is dropped whole,
  // not trimmed. A seal that cannot be read drops the item too.
  const shelved = await dropSealedItems(supabase, items.data ?? []);
  const images = await officeImages(supabase, [ownerId]);
  const out = selectRoom({
    ownerId,
    sections: sections.data ?? [],
    items: shelved,
    jackets: images.jackets,
    pages: images.pages,
  });

  // Let Vercel's edge cache absorb visitor traffic; a minute of staleness
  // is invisible next to the act of curating a library.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  res.status(200).json({ generated: new Date().toISOString(), sections: out });
}
