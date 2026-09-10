// Opening a stored PDF for pdf.js — by ranges, not by download.
//
// The reader used to fetch the whole file and hand pdf.js the bytes, so a
// 165 MB scan of a book showed blank paper until every byte had arrived:
// Eden took it for a failed import. The vault's storage honours HTTP Range
// requests (and its CORS allows the Range header), and archive.org scans
// are linearized, so pdf.js can open on the first megabyte and ask for the
// pages it paints as it paints them. Measured on that book: open in under
// two seconds after 5 MB; page 200 after 13 MB in all.
//
// Cross-origin, the browser hides Accept-Ranges and Content-Range from
// scripts, so pdf.js's own detection would fall back to a full download.
// The transport below asks for ranges itself; the file length comes from
// the document row or a HEAD (Content-Length is a safelisted header). If
// anything in that path fails, the whole file is downloaded as before.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { supabase } from '@/lib/supabase';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

const BUCKET = 'vault-documents';
const INITIAL_BYTES = 1 << 20;
const CHUNK_BYTES = 1 << 20;
// Long enough for an afternoon's reading; a page asked for after this
// fails to paint, and reopening the document signs a fresh link.
const URL_TTL_SECONDS = 12 * 3600;

const WORKER_URL = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type PdfjsModule = typeof import('pdfjs-dist');

/** What the reader can say while a file opens. `loaded`/`total` are bytes
 *  and only present when they are known. */
export type PdfOpenProgress =
  | { stage: 'signing' }
  | { stage: 'fetching'; loaded: number; total: number }
  | { stage: 'downloading'; loaded: number; total: number | null }
  | { stage: 'opening'; total: number | null };
export type PdfOpenProgressFn = (p: PdfOpenProgress) => void;

async function rangeSource(pdfjsLib: PdfjsModule, storagePath: string, sizeBytes: number | null, report: PdfOpenProgressFn) {
  report({ stage: 'signing' });
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'no signed url');
  const url = data.signedUrl;

  const first = await fetch(url, { headers: { Range: `bytes=0-${INITIAL_BYTES - 1}` } });
  if (first.status !== 206) throw new Error(`range not honoured (${first.status})`);
  const initial = new Uint8Array(await first.arrayBuffer());
  let fetched = initial.byteLength;

  let length = sizeBytes ?? 0;
  if (!length) {
    const head = await fetch(url, { method: 'HEAD' });
    length = Number(head.headers.get('content-length')) || 0;
  }
  if (!length) throw new Error('length unknown');
  // A small file came down whole with the first request.
  if (initial.byteLength >= length) return { data: initial };
  report({ stage: 'fetching', loaded: fetched, total: length });

  class RangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number): void {
      fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
        .then(async (r) => {
          if (r.status !== 206) throw new Error(`range ${begin}-${end}: ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          fetched += bytes.byteLength;
          report({ stage: 'fetching', loaded: fetched, total: length });
          this.onDataRange(begin, bytes);
        })
        .catch((e: unknown) => {
          // The page that needed these bytes stays unpainted; a later pass
          // asks again. Say why, for whoever is looking.
          console.warn('pdf range fetch failed', e);
        });
    }
    abort(): void { /* nothing in flight is cancellable; pending fetches finish harmlessly */ }
  }
  return {
    range: new RangeTransport(length, initial),
    length,
    rangeChunkSize: CHUNK_BYTES,
    // Only what a page needs, when it needs it — never the rest of the
    // file in the background.
    disableAutoFetch: true,
    disableStream: true,
  };
}

/** The whole file, read as it arrives so the caller can show how far
 *  along it is — the fallback when ranges are not honoured. A count of
 *  bytes is what turns "is it broken?" into "it's a third of the way". */
async function downloadWhole(storagePath: string, sizeBytes: number | null, report: PdfOpenProgressFn): Promise<Uint8Array> {
  report({ stage: 'signing' });
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'no signed url');
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = sizeBytes ?? (Number(res.headers.get('content-length')) || null);
  report({ stage: 'downloading', loaded: 0, total });
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    // A report per chunk would be hundreds a second on a fast link.
    if (loaded - lastReport >= 512 * 1024 || loaded === total) {
      lastReport = loaded;
      report({ stage: 'downloading', loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** Open a PDF from the vault bucket for pdf.js, by ranges when the host
 *  allows it and by full download when it does not. `sizeBytes` (from the
 *  documents row) saves a HEAD request; `onProgress` hears each stage so
 *  the reader can show that something is happening. */
export async function openStoredPdf(
  storagePath: string,
  opts: { sizeBytes?: number | null; onProgress?: PdfOpenProgressFn } = {},
): Promise<PDFDocumentProxy> {
  const report: PdfOpenProgressFn = opts.onProgress ?? (() => {});
  const sizeBytes = opts.sizeBytes ?? null;
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
  const byRange = await rangeSource(pdfjsLib, storagePath, sizeBytes, report).catch((e: unknown) => {
    console.warn('pdf: range loading unavailable, downloading whole file', e);
    return null;
  });
  if (byRange) {
    report({ stage: 'opening', total: sizeBytes });
    return pdfjsLib.getDocument({ ...byRange, ...PDFJS_DOC_PARAMS }).promise;
  }

  const bytes = await downloadWhole(storagePath, sizeBytes, report);
  report({ stage: 'opening', total: bytes.byteLength });
  return pdfjsLib.getDocument({ data: bytes, ...PDFJS_DOC_PARAMS }).promise;
}
