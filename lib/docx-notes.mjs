// Footnotes and endnotes of a .docx, as text, in the order Word numbers them.
//
// mammoth's extractRawText reads a Word file's body and skips its notes, so a
// decision's footnote 1 was in the stored file, on screen in the Reader, and
// nowhere in the indexed text: search, "Find in corpus" and the connector
// could not see it (Eden, 10-02: DCWP v. Diplomat Home Remodeling, at 2 n.1).
// The body is still read by mammoth exactly as before; this adds the notes.
//
// Numbering: Word numbers notes by where their reference marks fall in the
// body, not by their ids, so the order here is the order of the
// <w:footnoteReference>/<w:endnoteReference> marks in word/document.xml. The
// separator and continuation entries (w:type="separator" etc.) are not notes.

import JSZip from 'jszip';

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

/** The visible text of a run of WordprocessingML: <w:t> text, tabs and breaks as spaces, paragraphs as line breaks. */
export function wordText(xml) {
  const paras = xml.split(/<\/w:p>/);
  const out = [];
  for (const p of paras) {
    let t = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g;
    for (let m = re.exec(p); m; m = re.exec(p)) t += m[1] !== undefined ? decode(m[1]) : ' ';
    t = t.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out.join('\n');
}

function notesOf(xml, tag) {
  const byId = new Map();
  const re = new RegExp(`<w:${tag}\\b([^>]*)>([\\s\\S]*?)<\\/w:${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[1];
    if (/w:type="(separator|continuationSeparator|continuationNotice)"/.test(attrs)) continue;
    const id = /w:id="(-?\d+)"/.exec(attrs)?.[1];
    if (id === undefined) continue;
    const text = wordText(m[2]);
    if (text) byId.set(id, text);
  }
  return byId;
}

function referenceOrder(docXml, tag) {
  const ids = [];
  const re = new RegExp(`<w:${tag}Reference\\b[^>]*w:id="(-?\\d+)"`, 'g');
  for (let m = re.exec(docXml); m; m = re.exec(docXml)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

/**
 * { footnotes, endnotes }: each a list of note texts in Word's numbering
 * order. A note whose mark is not in the body (left behind by an edit) comes
 * after the numbered ones, so nothing in the file is lost. Empty lists for a
 * file without notes; never throws on a missing part.
 */
export async function extractDocxNotes(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : '');
  const [doc, fn, en] = await Promise.all([read('word/document.xml'), read('word/footnotes.xml'), read('word/endnotes.xml')]);
  const ordered = (notesXml, tag) => {
    if (!notesXml) return [];
    const byId = notesOf(notesXml, tag);
    const order = referenceOrder(doc, tag).filter((id) => byId.has(id));
    const rest = [...byId.keys()].filter((id) => !order.includes(id));
    return [...order, ...rest].map((id) => byId.get(id));
  };
  return { footnotes: ordered(fn, 'footnote'), endnotes: ordered(en, 'endnote') };
}

/**
 * The notes as a section to append to the body's text: "Footnotes", then
 * "1. …", "2. …" — the form a footnote is cited in ("at 2 n.1"), so a search
 * for its words lands on it. '' when there are none.
 */
export function notesSection({ footnotes, endnotes }) {
  const part = (title, notes) => (notes.length ? `${title}\n\n${notes.map((t, i) => `${i + 1}. ${t}`).join('\n\n')}` : '');
  return [part('Footnotes', footnotes), part('Endnotes', endnotes)].filter(Boolean).join('\n\n');
}
