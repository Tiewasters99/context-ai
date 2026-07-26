// PPTX extraction: zip -> per-slide text runs, one "page" per slide.
//
// A .pptx is an OOXML package (a ZIP), the same shape as .docx / .xlsx / .epub,
// so we reuse the JSZip dependency already used by lib/epub-extract.mjs and
// lib/xlsx-extract.mjs (no new package).
//
// Returns the shape extractPages() expects from every other format:
//   [{ pageNumber, text }]
// where pageNumber is the slide number — so citations read "slide N" naturally
// as "p. N".
//
// Why this exists: without a .pptx branch, extractPages() fell through to the
// plain-text fallback and read the binary ZIP as UTF-8. A 15 MB deck became
// ~500k tokens of garbage that blew the embeddings API's 300k-token
// per-request limit and left the document in error ("Teleporter
// presentation.pptx", Huddleston).
//
// Parsing: slide XML is small (a few KB each; images live in separate package
// parts), so no DOM is needed. Text lives in <a:t>…</a:t> runs inside
// paragraphs (<a:p>). We join runs within a paragraph and emit one line per
// paragraph. Speaker notes (ppt/notesSlides/) are appended under a "Notes:"
// marker when present — for a litigation deck the notes are often the
// substance.

import JSZip from 'jszip';

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');

// One line of text per <a:p> paragraph; runs within a paragraph joined as-is.
function slideXmlToText(xml) {
  const paragraphs = [];
  for (const pMatch of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const runs = [];
    for (const tMatch of pMatch.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) || []) {
      runs.push(decodeEntities(tMatch.replace(/^<a:t(?:\s[^>]*)?>/, '').replace(/<\/a:t>$/, '')));
    }
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

export async function extractPptx(fileBuf) {
  const buf = fileBuf instanceof Uint8Array ? Buffer.from(fileBuf) : fileBuf;
  const zip = await JSZip.loadAsync(buf);

  // Slides are ppt/slides/slideN.xml; sort numerically (slide10 after slide9).
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));

  const pages = [];
  for (const name of slideNames) {
    const slideNum = parseInt(name.match(/slide(\d+)/)[1], 10);
    const xml = await zip.files[name].async('string');
    let text = slideXmlToText(xml);

    const notesName = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.files[notesName]) {
      const notesText = slideXmlToText(await zip.files[notesName].async('string'))
        // Notes slides echo the slide number as a text run; drop bare numbers.
        .split('\n').filter((l) => !/^\d+$/.test(l)).join('\n');
      if (notesText) text += (text ? '\n\n' : '') + 'Notes: ' + notesText;
    }

    pages.push({ pageNumber: slideNum, text });
  }
  return pages;
}
