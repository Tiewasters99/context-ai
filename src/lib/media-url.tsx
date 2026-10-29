import { createContext, useContext } from 'react';
import { clipUrl } from '@/lib/document-animations';

// Where a clip's bytes come from. The page and the bench show media by its
// storage path, and until the Grapheon Reader every path was an object in
// the vault bucket, so AnimationLayer and WorkshopPanel asked clipUrl()
// directly. An edition's clips live in the `editions` bucket and are served
// through api/editions.mjs after an ownership check, so the book's source
// may now bring its own resolver (PdfSource.mediaUrl); PdfBook provides it
// here, and the two consumers ask the context instead of the vault. With no
// provider, the vault answers as before — DocumentReader changes nothing.

export type MediaUrlResolver = (storagePath: string) => Promise<string | null>;

const MediaUrlContext = createContext<MediaUrlResolver>(clipUrl);

export const MediaUrlProvider = MediaUrlContext.Provider;

/** The resolver for the book on screen: the vault's by default. */
export function useMediaUrl(): MediaUrlResolver {
  return useContext(MediaUrlContext);
}
