// A picture from the bench on a tee, a tote, a print — the reader's side of
// the Grapheon Reader's merchandise (Phase 2b, docs/specs/GRAPHEON-READER-
// 2026-10-10.md "Merchandise"; migration 117; api/merch.mjs).
//
// Two things live here. The upload: a snip is not a file at all and a still
// sits in the Vault, so the Reader draws the picture and parks it in the
// public cover-images bucket under the reader's own folder (the rule the
// backdrop and music uploads use: the first folder is the uid); api/merch
// accepts a picture only from that folder. And the door: every call to
// api/merch carries the session's bearer, as sandboxApi does, so the server
// asks the rights question as the user.
//
// Offered only where the host says the book is a Library or public-domain
// book (DocumentReader: the Library serverspace; the Reader: the publisher's
// own edition). Matter material never goes to a public bucket. The old
// bridge to grapheon.ai's designer (PR #416) is gone: one store, the sheet
// in the reader (D12).

import { supabase } from '@/lib/supabase';

const BUCKET = 'cover-images';
const FOLDER = 'prints';

/** The picture, set out where the print shop can fetch it. Returns its public URL. */
export async function uploadPrintImage(args: { userId: string; itemId: string; blob: Blob }): Promise<string> {
  const ext = args.blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const path = `${args.userId}/${FOLDER}/${args.itemId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, args.blob, { contentType: args.blob.type || 'image/png', upsert: false });
  if (error) throw new Error(`The picture could not be set out for the print shop: ${error.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/* ───────────────────────── What api/merch returns ───────────────────────── */

export type MerchBlueprint = {
  key: string;
  kind: 'tee' | 'tote' | 'print' | string;
  label: string;
  estimate_cents: number;
  shipping_first_cents: number;
  shipping_additional_cents: number;
  countries: string[];
  default_scale: number;
};

export type MerchVariant = {
  id: number;
  title: string;
  color: string | null;
  color_hex: string | null;
  size: string | null;
  paper: string | null;
  cost_cents: number;
  price_cents: number;
  available: boolean;
};

export type MerchMockup = { src: string; variant_ids: number[]; position: string; is_default: boolean };

export type MerchProduct = {
  id: string;
  blueprint_key: string;
  title: string;
  image_url: string;
  options: unknown[];
  variants: MerchVariant[];
  mockups: MerchMockup[];
  placement: { scale?: number; fill?: boolean };
  status: 'rendering' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
};

export type MerchTracking = { carrier?: string | null; number?: string | null; url?: string | null; delivered_at?: string | null };

export type MerchOrder = {
  id: string;
  product_id: string;
  variant_id: number;
  variant_title: string | null;
  quantity: number;
  currency: string;
  item_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  status: 'pending' | 'paid' | 'placed' | 'in_production' | 'shipped' | 'delivered' | 'canceled' | 'refunded' | 'failed';
  tracking: MerchTracking[];
  placed_at: string | null;
  shipped_at: string | null;
  created_at: string;
  error: string | null;
};

/** Where a bench item came from, as api/merch's rights gate wants it. */
export type MerchSource = { kind: 'document' | 'edition'; id: string; bench_item_id: string };

export type MerchApi = <T = Record<string, unknown>>(action: string, args?: Record<string, unknown>) => Promise<T>;

/** Session-authed call to /api/merch. Throws the server's sentence. */
export const merchApi: MerchApi = async <T,>(action: string, args: Record<string, unknown> = {}): Promise<T> => {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error('Sign in to make a tee, a tote or a print.');
  const res = await fetch('/api/merch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...args }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new Error(body.message || refusalSentence(res.status, body.error));
  return body as T;
};

function refusalSentence(status: number, code?: string): string {
  if (code === 'merch_not_configured') return 'The print shop is not connected on this deployment.';
  if (code === 'not_allowed') return 'This picture is not offered on merchandise.';
  if (code === 'not_ready') return 'The product is not ready to buy yet.';
  if (status === 401) return 'Sign in again to continue.';
  return `The print shop did not answer (${status}).`;
}

/**
 * The products already made from a bench item, newest first, as the user
 * (RLS: the owner only). The sheet reuses one made since the item last
 * changed, so reopening the sheet neither uploads nor makes again.
 */
export async function myMerchProducts(benchItemId: string): Promise<MerchProduct[]> {
  const { data, error } = await supabase
    .from('merch_products')
    .select('id, blueprint_key, title, image_url, options, variants, mockups, placement, status, error, created_at')
    .eq('bench_item_id', benchItemId)
    .order('created_at', { ascending: false });
  if (error) return [];
  return (data ?? []) as MerchProduct[];
}

/** The products behind a list of orders (their titles and mockups), as the user. */
export async function merchProductsById(ids: string[]): Promise<Map<string, MerchProduct>> {
  const out = new Map<string, MerchProduct>();
  const want = [...new Set(ids)].filter(Boolean);
  if (want.length === 0) return out;
  const { data } = await supabase
    .from('merch_products')
    .select('id, blueprint_key, title, image_url, options, variants, mockups, placement, status, error, created_at')
    .in('id', want);
  for (const p of (data ?? []) as MerchProduct[]) out.set(p.id, p);
  return out;
}
