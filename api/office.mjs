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
// Auth: none (public, read-only). Runs on the service role because the
// office tables have owner-only RLS — publishing is the explicit act of
// setting published=true in the app, so serving those rows anonymously is
// the feature, not a leak. CORS is open so the office front end can live
// on any origin (today a local depth-parallax build; later its own domain).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- the reading room: ?book=<office_item_id> ---------------------------
  const bookId = (req.query?.book ?? '').toString().trim();
  if (bookId) {
    const { data: item, error: itemError } = await supabase
      .from('office_items')
      .select('id, title, author, document_id, published')
      .eq('id', bookId)
      .eq('published', true)
      .maybeSingle();
    if (itemError) {
      res.status(500).json({ error: itemError.message });
      return;
    }
    if (!item || !item.document_id) {
      res.status(404).json({ error: 'No such book on the shelves' });
      return;
    }
    // Raw text passages in reading order. The cap keeps one request from
    // shipping a 700-page transcript; MAX_CHARS trims the tail passage-by-
    // passage so the reader can say, honestly, that the rest stays filed.
    const MAX_PASSAGES = 800;
    const MAX_CHARS = 600_000;
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
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.status(200).json({
      id: item.id,
      title: item.title,
      author: item.author,
      pages,
      truncated,
    });
    return;
  }

  const [sections, items] = await Promise.all([
    supabase
      .from('office_sections')
      .select('id, kind, title, blurb, sort_order')
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('office_items')
      .select('id, section_id, title, author, excerpt, spine, sort_order, document_id')
      .eq('published', true)
      .order('sort_order')
      .order('created_at'),
  ]);
  if (sections.error || items.error) {
    res.status(500).json({ error: (sections.error || items.error).message });
    return;
  }

  const bySection = {};
  for (const it of items.data ?? []) {
    (bySection[it.section_id] ??= []).push({
      id: it.id,
      title: it.title,
      author: it.author,
      excerpt: it.excerpt,
      spine: it.spine,
      // whether ?book= will answer for this item — the document id itself
      // stays behind the glass
      readable: Boolean(it.document_id),
    });
  }
  const out = (sections.data ?? [])
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      blurb: s.blurb,
      items: bySection[s.id] ?? [],
    }))
    // an empty shelf is a back-office fact, not a public one
    .filter((s) => s.items.length > 0);

  // Let Vercel's edge cache absorb visitor traffic; a minute of staleness
  // is invisible next to the act of curating a library.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  res.status(200).json({ generated: new Date().toISOString(), sections: out });
}
