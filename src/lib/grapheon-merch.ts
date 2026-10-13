// A picture from the bench, on a tee or a tote.
//
// The Grapheon store's designer (grapheon.ai/marketplace/customize) takes a
// public image URL and a title, puts the picture on a blueprint with a live
// preview, and makes the Printify product with its mockups. It cannot reach
// the Vault, and a snip is not a file at all, so the Reader draws the
// picture, parks the PNG in the public cover-images bucket under the
// reader's own folder (the rule the backdrop and music uploads use: the
// first folder is the uid) and hands the designer that URL.
//
// Offered only where the host says the book is a Library or public-domain
// book (DocumentReader: the Library serverspace; the Reader: the publisher's
// own edition). Matter material never goes to a public bucket.

import { supabase } from '@/lib/supabase';

export const GRAPHEON_MERCH_DESIGNER = 'https://grapheon.ai/marketplace/customize';

const BUCKET = 'cover-images';
const FOLDER = 'prints';

/** Where the designer opens for this picture. The upload happens here. */
export async function merchDesignerUrl(args: {
  userId: string;
  itemId: string;
  blob: Blob;
  title: string | null;
}): Promise<string> {
  const ext = args.blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const path = `${args.userId}/${FOLDER}/${args.itemId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, args.blob, { contentType: args.blob.type || 'image/png', upsert: false });
  if (error) throw new Error(`The picture could not be set out for the store: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const q = new URLSearchParams({ imageUrl: data.publicUrl });
  const title = (args.title ?? '').trim();
  if (title) q.set('title', title);
  return `${GRAPHEON_MERCH_DESIGNER}?${q.toString()}`;
}
