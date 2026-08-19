/**
 * Desk-text preparation — the gate between any manuscript source and the
 * Editor's desk.
 *
 * Indexed documents and uploaded files arrive in whatever shape ingestion
 * left them: clean prose, prose littered with residual HTML tags and
 * entities, a quoted-printable email export, a whole captured web page, or
 * (when an ingest failed badly) the PDF's internal object code. The desk
 * never lays markup in front of the user: real documents are lifted out of
 * their markup, captures and unreadable text are refused with a plain
 * explanation.
 *
 * Pure string logic, no imports — unit-testable with bare node.
 */

export type DeskTextResult =
  | { kind: 'clean'; text: string }
  | { kind: 'converted'; text: string; note: string }
  | { kind: 'refused'; reason: string };

// Only real HTML tag names count as markup. A transcript's "<unintelligible>"
// or a brief's "<REDACTED>" must never be treated — or stripped — as a tag.
const TAG_NAMES =
  'html|head|body|meta|link|script|style|title|div|span|p|br|hr|a|b|i|u|em|strong|small|sub|sup|' +
  'ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|h[1-6]|img|form|input|select|option|button|' +
  'label|textarea|nav|header|footer|section|article|aside|main|figure|figcaption|blockquote|pre|' +
  'code|font|center|iframe|svg|path|o:p';
const TAG_RE = new RegExp(`</?(?:${TAG_NAMES})(?=[\\s/>])[^>]*>`, 'gi');
const BLOCK_END_RE = new RegExp(
  `</(?:p|div|li|tr|h[1-6]|blockquote|pre|section|article|header|footer|table|ul|ol|dl)>|<(?:br|hr)\\s*/?>`,
  'gi',
);
const STRIP_WITH_CONTENT_RE = /<(script|style|head|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', sect: '§',
  para: '¶', copy: '©', reg: '®', trade: '™',
  bull: '•', middot: '·', deg: '°', frac12: '½',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
};
const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,8});/g;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** First 20K plus a slice from the middle — markup deep in a long document still counts. */
function sampleOf(text: string): string {
  if (text.length <= 30_000) return text;
  const mid = Math.floor(text.length / 2);
  return text.slice(0, 20_000) + '\n' + text.slice(mid, mid + 10_000);
}

function looksLikeRawPdf(text: string): boolean {
  const head = text.slice(0, 2000);
  if (/^\s*%PDF-/.test(head)) return true;
  const sample = sampleOf(text);
  return /\bendobj\b/.test(sample) && (/\bendstream\b/.test(sample) || /\/Type\s*\/(Page|Catalog)\b/.test(sample));
}

function looksQuotedPrintable(sample: string): boolean {
  if (/content-transfer-encoding:\s*quoted-printable/i.test(sample)) return true;
  // Headerless fragment: only decode when the =XX density is unmistakable.
  return countMatches(/=\r?\n/g, sample) >= 3 || countMatches(/=[0-9A-F]{2}/g, sample) >= 8;
}

function decodeQuotedPrintable(text: string): string {
  let out = text.replace(/=\r?\n/g, '');
  // Decode =XX byte runs as UTF-8 so =E2=80=99 comes back as a real apostrophe.
  out = out.replace(/(?:=[0-9A-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return run;
    }
  });
  return out;
}

/** Drop a leading MIME/email header block (Received:, Content-Type:, …) if one is present. */
function stripMimeHeaders(text: string): string {
  const lines = text.split(/\r?\n/);
  let headerLines = 0;
  for (const line of lines) {
    if (line.trim() === '') break;
    if (/^[A-Za-z][A-Za-z0-9-]*:\s/.test(line) || /^\s/.test(line)) headerLines++;
    else return text; // a non-header line before the blank line — not a header block
  }
  if (headerLines < 3) return text;
  return lines.slice(headerLines).join('\n');
}

function htmlToText(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(STRIP_WITH_CONTENT_RE, '\n');
  out = out.replace(BLOCK_END_RE, '\n');
  out = out.replace(TAG_RE, ' ');
  out = out.replace(/<!doctype[^>]*>/gi, '');
  out = decodeEntities(out);
  out = out
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

export function prepareDeskText(raw: string): DeskTextResult {
  let text = raw.trim();
  if (!text) return { kind: 'refused', reason: 'no readable text found' };

  if (looksLikeRawPdf(text)) {
    return {
      kind: 'refused',
      reason:
        'the stored text is the PDF’s internal code, not its words — the ingestion of this copy failed. Re-ingest the original PDF, then pull it again.',
    };
  }

  const notes: string[] = [];
  let sample = sampleOf(text);

  if (looksQuotedPrintable(sample)) {
    text = stripMimeHeaders(decodeQuotedPrintable(text)).trim();
    notes.push('decoded from an email export');
    sample = sampleOf(text);
  }

  const fullHtml = /<!doctype html|<html[\s>]/i.test(sample.slice(0, 2000));
  const tagCount = countMatches(TAG_RE, sample);
  const entityCount = countMatches(ENTITY_RE, sample);

  if (fullHtml || tagCount >= 3 || entityCount >= 5) {
    const formCount = countMatches(/<(form|input|select|button)\b/gi, sample);
    const stripped = htmlToText(text);
    // A capture (a login page, a court's search screen) is markup-heavy and
    // prose-poor; a real document saved as a web page yields real prose.
    if ((fullHtml && stripped.length < 300) || (formCount >= 3 && stripped.length < 1500)) {
      return {
        kind: 'refused',
        reason:
          'this is a captured web page (a login or search screen), not a document — a failed download often saves the site’s page under the document’s name. Re-download the real file and try again.',
      };
    }
    if (stripped.length < 40) {
      return { kind: 'refused', reason: 'no readable text remains once the web-page markup is removed' };
    }
    notes.push('web-page markup removed');
    return { kind: 'converted', text: stripped, note: notes.join('; ') };
  }

  if (notes.length > 0) return { kind: 'converted', text, note: notes.join('; ') };
  return { kind: 'clean', text };
}
