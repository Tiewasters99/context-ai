// Browser-side PPTX text extraction — the client twin of lib/pptx-extract.mjs.
// A .pptx is an OOXML zip; slide text lives in <a:t> runs inside <a:p>
// paragraphs, so a regex walk is enough — no DOM, no new dependency (JSZip is
// already used for Vault zip expansion and by the server extractors).

export interface PptxSlide {
  num: number;
  /** One entry per non-empty paragraph, in slide order. First is usually the title. */
  lines: string[];
  /** Speaker notes paragraphs (bare slide-number runs dropped). */
  notes: string[];
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');

// One line per <a:p> paragraph; runs within a paragraph joined as-is.
function slideXmlToLines(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const pMatch of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const runs: string[] = [];
    for (const tMatch of pMatch.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) || []) {
      runs.push(decodeEntities(tMatch.replace(/^<a:t(?:\s[^>]*)?>/, '').replace(/<\/a:t>$/, '')));
    }
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs;
}

export async function extractPptxSlides(data: ArrayBuffer | Blob): Promise<PptxSlide[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);

  // Slides are ppt/slides/slideN.xml; sort numerically (slide10 after slide9).
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)![1], 10) - parseInt(b.match(/slide(\d+)/)![1], 10));

  const slides: PptxSlide[] = [];
  for (const name of slideNames) {
    const num = parseInt(name.match(/slide(\d+)/)![1], 10);
    const lines = slideXmlToLines(await zip.files[name].async('string'));

    let notes: string[] = [];
    const notesName = `ppt/notesSlides/notesSlide${num}.xml`;
    if (zip.files[notesName]) {
      // Notes slides echo the slide number as a text run; drop bare numbers.
      notes = slideXmlToLines(await zip.files[notesName].async('string')).filter(
        (l) => !/^\d+$/.test(l),
      );
    }
    slides.push({ num, lines, notes });
  }
  return slides;
}

/** Flatten a deck to plain text — "Slide N" headers, notes marked, one blank line between slides. */
export async function extractPptxText(data: ArrayBuffer | Blob): Promise<string> {
  const slides = await extractPptxSlides(data);
  return slides
    .map((s) => {
      let text = `Slide ${s.num}\n${s.lines.join('\n')}`;
      if (s.notes.length) text += `\n\nNotes: ${s.notes.join('\n')}`;
      return text;
    })
    .join('\n\n');
}
