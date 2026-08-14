// POST /api/student-hub-ocr  { pages: [{ path, n }] }
//
// OCR a small batch of scanned casebook pages from the private
// student-hub-scans bucket. The Student Hub's "add a chapter" flow uploads
// page JPEGs client-side, then drives this endpoint in resumable batches.
//
// Auth: requires a Supabase Bearer JWT, and every storage read/write here
// happens AS THAT USER (anon client + forwarded token), so bucket RLS
// (migration 038) enforces the owner-folder lock — the scan never crosses
// accounts (Kindle model, see docs/student-hub/student-hub-design.md).
// The uid-prefix check below is defense in depth, not the lock itself.
//
// For each page we also persist the transcription to
//   {uid}/{slug}/ocr/page_NNNN.txt   (derived from the image path)
// so an interrupted run resumes without re-spending OCR.

import { createClient } from '@supabase/supabase-js';
import { ocrImages } from '../lib/ocr-gemini.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const BUCKET = 'student-hub-scans';
const MAX_PAGES = 8;

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// {uid}/{slug}/page_0001.jpg -> {uid}/{slug}/ocr/page_0001.txt
export function ocrTextPath(imagePath) {
  const cut = imagePath.lastIndexOf('/');
  return `${imagePath.slice(0, cut)}/ocr/${imagePath.slice(cut + 1).replace(IMAGE_EXT, '')}.txt`;
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'GOOGLE_API_KEY not configured' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(res, 500, { error: 'supabase_env_missing' });

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const uid = userData.user.id;

  const pages = Array.isArray(req.body?.pages) ? req.body.pages : null;
  if (!pages?.length) return json(res, 400, { error: 'pages required' });
  if (pages.length > MAX_PAGES) return json(res, 400, { error: `at most ${MAX_PAGES} pages per call` });
  for (const p of pages) {
    if (
      typeof p?.path !== 'string' || !Number.isInteger(p?.n) || p.n < 1 ||
      !p.path.startsWith(`${uid}/`) || p.path.includes('..') || !IMAGE_EXT.test(p.path)
    ) {
      return json(res, 400, { error: `bad page entry: ${JSON.stringify(p)}` });
    }
  }

  const images = [];
  for (const p of pages) {
    const { data, error } = await sb.storage.from(BUCKET).download(p.path);
    if (error || !data) return json(res, 404, { error: `download failed: ${p.path}: ${error?.message || 'no data'}` });
    images.push({
      pageNumber: p.n,
      bytes: Buffer.from(await data.arrayBuffer()),
      mimeType: MIME[p.path.toLowerCase().match(IMAGE_EXT)[1]] || 'image/jpeg',
    });
  }

  let results;
  try {
    results = await ocrImages(images, { apiKey });
  } catch (err) {
    return json(res, 502, { error: `ocr failed: ${err.message}` });
  }

  const byPage = new Map(results.map((r) => [r.pageNumber, r.text]));
  const out = [];
  for (const p of pages) {
    const text = byPage.get(p.n) ?? '';
    // No upsert: bucket RLS (038) has no UPDATE policy, so overwrites are
    // denied. A sidecar that already exists (retried batch) is the same
    // page's transcription — first write wins.
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(ocrTextPath(p.path), Buffer.from(text, 'utf8'), { contentType: 'text/plain' });
    if (error && !/already exists/i.test(error.message)) {
      return json(res, 500, { error: `persist failed: ${p.path}: ${error.message}` });
    }
    out.push({ path: p.path, n: p.n, text });
  }
  return json(res, 200, { pages: out });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
