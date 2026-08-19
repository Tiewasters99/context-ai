// GET /api/office — the public manifest of The Office
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

  const [sections, items] = await Promise.all([
    supabase
      .from('office_sections')
      .select('id, kind, title, blurb, room, sort_order')
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('office_items')
      .select('id, section_id, title, author, excerpt, spine, sort_order')
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
    });
  }
  const out = (sections.data ?? [])
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      blurb: s.blurb,
      room: s.room ?? '',
      items: bySection[s.id] ?? [],
    }))
    // an empty shelf is a back-office fact, not a public one
    .filter((s) => s.items.length > 0);

  // Let Vercel's edge cache absorb visitor traffic; a minute of staleness
  // is invisible next to the act of curating a library.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  res.status(200).json({ generated: new Date().toISOString(), sections: out });
}
