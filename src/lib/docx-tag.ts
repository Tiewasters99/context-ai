// The tag a .docx carries that says which Equazia document it is
// (docs/specs/WORD-ROUNDTRIP-2026-11-01.md, "The tag").
//
// Two custom document properties — EquaziaDocumentId, EquaziaMatterId — in
// docProps/custom.xml. Word shows them under File → Info → Properties →
// Advanced → Custom, keeps them through Save As, and the task pane reads and
// writes them through Word.run (office.ts). Here they are read and written in
// the bytes with JSZip: Open in Word tags the file before it leaves, and the
// browser mock reads what Word would.
//
// The part is created when the file has none: the part itself, its
// relationship from the package root, and its content-type override. A file
// that already has custom properties keeps them; only ours are replaced.

import JSZip from 'jszip';

export const TAG_DOCUMENT = 'EquaziaDocumentId';
export const TAG_MATTER = 'EquaziaMatterId';

export interface DocxTag {
  documentId: string;
  matterId: string | null;
}

const PART = 'docProps/custom.xml';
const CT_PART = '[Content_Types].xml';
const RELS = '_rels/.rels';
const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const NS_VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
const FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** Every <property> in a custom.xml: name → text value. */
export function parseCustomProps(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<property\b([^>]*)>([\s\S]*?)<\/property>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const val = />([^<]*)<\/vt:\w+>/.exec(m[2])?.[1];
    if (name) out.set(unesc(name), unesc(val ?? ''));
  }
  return out;
}

/** The tag in these .docx bytes, or null when there is none (or no valid id). */
export async function readDocxTag(bytes: Uint8Array): Promise<DocxTag | null> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return null; }
  const xml = await zip.file(PART)?.async('string');
  if (!xml) return null;
  return tagFromProps(parseCustomProps(xml));
}

export function tagFromProps(props: Map<string, string>): DocxTag | null {
  const doc = (props.get(TAG_DOCUMENT) ?? '').trim().toLowerCase();
  if (!UUID_RE.test(doc)) return null;
  const matter = (props.get(TAG_MATTER) ?? '').trim().toLowerCase();
  return { documentId: doc, matterId: UUID_RE.test(matter) ? matter : null };
}

/**
 * The same bytes with our two properties set (others kept). Returns a new
 * .docx; the input is not changed.
 */
export async function writeDocxTag(bytes: Uint8Array, tag: DocxTag): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);

  // 1. The part.
  const existing = await zip.file(PART)?.async('string');
  let props = existing ? parseCustomProps(existing) : new Map<string, string>();
  props.delete(TAG_DOCUMENT);
  props.delete(TAG_MATTER);
  props = new Map([...props, [TAG_DOCUMENT, tag.documentId], ...(tag.matterId ? [[TAG_MATTER, tag.matterId] as [string, string]] : [])]);
  let pid = 2;
  const body = [...props].map(([name, value]) =>
    `<property fmtid="${FMTID}" pid="${pid++}" name="${esc(name)}"><vt:lpwstr>${esc(value)}</vt:lpwstr></property>`).join('');
  zip.file(PART, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="${NS}" xmlns:vt="${NS_VT}">${body}</Properties>`);

  // 2. Its content type.
  const ct = (await zip.file(CT_PART)?.async('string')) ?? '';
  if (ct && !/PartName="\/docProps\/custom\.xml"/.test(ct)) {
    zip.file(CT_PART, ct.replace(/<\/Types>\s*$/, `<Override PartName="/docProps/custom.xml" ContentType="${CONTENT_TYPE}"/></Types>`));
  }

  // 3. The relationship from the package root.
  const rels = (await zip.file(RELS)?.async('string')) ?? '';
  if (rels && !rels.includes(REL_TYPE)) {
    const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
    const next = (ids.length ? Math.max(...ids) : 0) + 1;
    zip.file(RELS, rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="rId${next}" Type="${REL_TYPE}" Target="docProps/custom.xml"/></Relationships>`));
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
