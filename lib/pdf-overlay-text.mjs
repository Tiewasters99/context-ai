// Text a PDF draws in WATERMARK annotations — where Acrobat's "Add Header &
// Footer" puts the page numbers it stamps on a document.
//
// Found 2026-09-24 on DeCamara ECF 66-7, a deposition filed as an exhibit:
// the court reporter's page numbers ("89" on the 90th sheet) are not in the
// page's content stream at all. They live in a /Watermark annotation's
// appearance stream, which pdf.js — and so pdf-parse, and every extractor
// built on it — never reads. MuPDF does. With the reporter's number invisible
// and the court's "Page 90 of 157" stamp visible, the printed-page detector
// fitted the court's count and cited every page one too high.
//
// This reads only what the page-number detector needs: the literal strings
// drawn in each page's Watermark appearance streams (and the form XObjects
// they call, one level down). It is NOT merged into the indexed text — a
// header repeated on every page is not testimony.
//
// Returns Map<pageNumber (1-based), string> for the pages that have any.

const TJ = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g;

function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e] ?? e;
  });
}

// The strings a content stream shows, one line per text-showing operator.
export function contentStreamStrings(content) {
  const out = [];
  for (const m of String(content).matchAll(TJ)) {
    const op = m[0];
    if (op.startsWith('(')) {
      out.push(unescapePdfString(op.slice(1, op.lastIndexOf(')'))));
    } else {
      const parts = [...op.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((p) => unescapePdfString(p[0].slice(1, -1)));
      out.push(parts.join(''));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

export async function pdfOverlayText(fileBuf) {
  const out = new Map();
  const { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream, PDFArray, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(fileBuf, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const resolve = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const streamText = (stream) => {
    try {
      if (!(stream instanceof PDFRawStream)) return '';
      return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    } catch { return ''; }
  };
  // An appearance stream, plus the form XObjects it draws (one level).
  const formStrings = (stream) => {
    const own = streamText(stream);
    const lines = contentStreamStrings(own);
    const res = resolve(stream?.dict?.get(PDFName.of('Resources')));
    const xobjs = res instanceof PDFDict ? resolve(res.get(PDFName.of('XObject'))) : null;
    if (xobjs instanceof PDFDict) {
      for (const [, ref] of xobjs.entries()) {
        const x = resolve(ref);
        if (x instanceof PDFRawStream) lines.push(...contentStreamStrings(streamText(x)));
      }
    }
    return lines;
  };
  doc.getPages().forEach((page, i) => {
    const annots = resolve(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return;
    const lines = [];
    for (const a of annots.asArray()) {
      const annot = resolve(a);
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(PDFName.of('Subtype')) !== PDFName.of('Watermark')) continue;
      const ap = resolve(annot.get(PDFName.of('AP')));
      const normal = ap instanceof PDFDict ? resolve(ap.get(PDFName.of('N'))) : null;
      if (normal) lines.push(...formStrings(normal));
    }
    if (lines.length) out.set(i + 1, lines.join('\n'));
  });
  return out;
}
