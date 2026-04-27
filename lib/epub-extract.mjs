// EPUB extraction: zip -> OPF/NCX -> chapters -> clean text.
//
// Returns a normalized object the ingestion pipeline can chunk + embed:
//
//   {
//     drm: false,
//     metadata: { title, author, publisher, rights, language },
//     chapters: [
//       {
//         chapter_number: 1,
//         chapter_title: 'Family, childhood and youth',
//         text: '...full chapter text with [fn:N] and [IMAGE: x] markers...',
//         sections: [
//           { section_title: 'Family history', char_offset: 0, char_length: 9210 },
//           ...
//         ],
//       },
//       ...
//     ],
//     footnotes: [
//       { chapter_number: 1, footnote_number: 1, text: '...' },
//     ],
//     images: [{ name: 'image00544.jpeg', mime: 'image/jpeg' }],
//   }
//
// DRM detection is intentionally non-bypassing: if META-INF/encryption.xml
// exists we set drm=true and return immediately. The caller surfaces the
// user-facing message; we never attempt to remove DRM.

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const NS = {
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
  ncx: 'http://www.daisy.org/z3986/2005/ncx/',
  xhtml: 'http://www.w3.org/1999/xhtml',
  epub: 'http://www.idpf.org/2007/ops',
};

export async function extractEpub(buf) {
  const zip = await JSZip.loadAsync(buf);

  // -- DRM check ------------------------------------------------------------
  if (zip.file(/^META-INF\/encryption\.xml$/i).length > 0) {
    return { drm: true };
  }

  // -- Locate OPF -----------------------------------------------------------
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) throw new Error('Not a valid EPUB: missing container.xml');
  const containerXml = await containerEntry.async('string');
  const containerDoc = parseXml(containerXml);
  const opfPath = containerDoc
    .getElementsByTagName('rootfile')[0]
    ?.getAttribute('full-path');
  if (!opfPath) throw new Error('Not a valid EPUB: no rootfile in container.xml');

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error(`OPF not found at ${opfPath}`);
  const opfXml = await opfEntry.async('string');
  const opfDoc = parseXml(opfXml);

  // -- Metadata -------------------------------------------------------------
  const metadata = extractMetadata(opfDoc);

  // -- Manifest + spine -----------------------------------------------------
  const manifest = extractManifest(opfDoc);
  const spineHrefs = extractSpine(opfDoc, manifest);

  // -- Chapter titles from NCX (or EPUB3 nav) ------------------------------
  const titleByHref = await extractChapterTitles(zip, opfDoc, manifest, opfPath);

  // -- Walk spine, extract per-chapter text --------------------------------
  const opfDir = dirOf(opfPath);
  const chapters = [];
  const footnotes = [];
  const imageRefs = new Set();
  let chapterNumber = 0;

  for (const href of spineHrefs) {
    const fullPath = resolvePath(opfDir, href);
    const entry = zip.file(fullPath);
    if (!entry) continue;
    const xhtml = await entry.async('string');

    const ncxTitle = titleByHref[href] || titleByHref[href.split('#')[0]];
    const extracted = extractChapterFromXhtml(xhtml, {
      chapterNumber: chapterNumber + 1,
      ncxTitle,
    });
    if (!extracted.text.trim()) continue;

    chapterNumber += 1;
    chapters.push({
      chapter_number: chapterNumber,
      chapter_title: extracted.chapter_title,
      text: extracted.text,
      sections: extracted.sections,
    });
    for (const fn of extracted.footnotes) {
      footnotes.push({ chapter_number: chapterNumber, ...fn });
    }
    for (const img of extracted.images) imageRefs.add(img);
  }

  return {
    drm: false,
    metadata,
    chapters,
    footnotes,
    images: [...imageRefs].map((name) => ({ name })),
  };
}

// -----------------------------------------------------------------------------
// OPF parsing
// -----------------------------------------------------------------------------
function extractMetadata(opfDoc) {
  const meta = (tag) => {
    const el = opfDoc.getElementsByTagNameNS(NS.dc, tag)[0]
      || opfDoc.getElementsByTagName(`dc:${tag}`)[0];
    return el ? el.textContent.trim() : null;
  };
  return {
    title: meta('title'),
    author: meta('creator'),
    publisher: meta('publisher'),
    rights: meta('rights'),
    language: meta('language'),
  };
}

function extractManifest(opfDoc) {
  const items = opfDoc.getElementsByTagName('item');
  const out = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = it.getAttribute('id');
    if (!id) continue;
    out[id] = {
      href: it.getAttribute('href'),
      mediaType: it.getAttribute('media-type'),
      properties: it.getAttribute('properties') || '',
    };
  }
  return out;
}

function extractSpine(opfDoc, manifest) {
  const spineItems = opfDoc.getElementsByTagName('itemref');
  const hrefs = [];
  for (let i = 0; i < spineItems.length; i++) {
    const idref = spineItems[i].getAttribute('idref');
    const m = manifest[idref];
    if (m && m.href) hrefs.push(m.href);
  }
  return hrefs;
}

// Build a map from spine href -> chapter title using either the NCX (EPUB2)
// or the navigation document (EPUB3 nav). Returns {} if neither is usable;
// chapter titles will fall back to the first h1/h2 inside each XHTML file.
async function extractChapterTitles(zip, opfDoc, manifest, opfPath) {
  const opfDir = dirOf(opfPath);

  // EPUB3 nav doc (preferred when present)
  const navItem = Object.values(manifest).find((m) =>
    m.properties && m.properties.split(/\s+/).includes('nav')
  );
  if (navItem) {
    const navPath = resolvePath(opfDir, navItem.href);
    const navEntry = zip.file(navPath);
    if (navEntry) {
      const navXml = await navEntry.async('string');
      const titles = parseNavTitles(navXml, dirOf(navItem.href));
      if (Object.keys(titles).length) return titles;
    }
  }

  // EPUB2 NCX (toc attribute on spine)
  const spine = opfDoc.getElementsByTagName('spine')[0];
  const ncxId = spine?.getAttribute('toc');
  if (ncxId && manifest[ncxId]) {
    const ncxPath = resolvePath(opfDir, manifest[ncxId].href);
    const ncxEntry = zip.file(ncxPath);
    if (ncxEntry) {
      const ncxXml = await ncxEntry.async('string');
      return parseNcxTitles(ncxXml, dirOf(manifest[ncxId].href));
    }
  }

  return {};
}

function parseNavTitles(navXml, navDir) {
  const doc = parseXml(navXml);
  const titles = {};
  // Find the toc nav: <nav epub:type="toc"> ... </nav>
  const navs = doc.getElementsByTagName('nav');
  for (let i = 0; i < navs.length; i++) {
    const t = navs[i].getAttributeNS?.(NS.epub, 'type')
      || navs[i].getAttribute('epub:type')
      || navs[i].getAttribute('type');
    if (t === 'toc' || !t) {
      const links = navs[i].getElementsByTagName('a');
      for (let j = 0; j < links.length; j++) {
        const href = links[j].getAttribute('href');
        const label = links[j].textContent.trim();
        if (href && label) {
          const resolved = resolvePath(navDir, href);
          titles[resolved] = label;
          // also store bare-href form (without anchor and without dir)
          titles[href.split('#')[0]] = label;
        }
      }
      if (Object.keys(titles).length) break;
    }
  }
  return titles;
}

function parseNcxTitles(ncxXml, ncxDir) {
  const doc = parseXml(ncxXml);
  const titles = {};
  const points = doc.getElementsByTagName('navPoint');
  for (let i = 0; i < points.length; i++) {
    const labelEl = points[i].getElementsByTagName('navLabel')[0];
    const contentEl = points[i].getElementsByTagName('content')[0];
    if (!contentEl) continue;
    const src = contentEl.getAttribute('src');
    if (!src) continue;
    const text = labelEl?.getElementsByTagName('text')[0]?.textContent.trim();
    // Kindle conversion artifact: empty navLabels. Skip; chapter title will
    // fall back to the first h1/h2 in the chapter file.
    if (!text) continue;
    const resolved = resolvePath(ncxDir, src);
    titles[resolved] = text;
    titles[src.split('#')[0]] = text;
  }
  return titles;
}

// -----------------------------------------------------------------------------
// XHTML chapter extraction
//
// Walks the body, accumulates plain text, captures section breaks at h2/h3,
// rewrites images as [IMAGE: name] markers, and pulls footnotes (anything
// inside an aside/li with epub:type="footnote" or a div role="doc-footnote")
// into a separate list, replacing in-text references with [fn:N] markers.
// -----------------------------------------------------------------------------
function extractChapterFromXhtml(xhtml, { chapterNumber, ncxTitle }) {
  const doc = parseXml(xhtml);

  // Collect footnotes first so we can substitute references inline.
  const footnoteMap = collectFootnotes(doc);

  // Find the body
  const body = doc.getElementsByTagName('body')[0] || doc.documentElement;

  let chapter_title = ncxTitle || null;
  const sections = [];
  const images = [];
  let buf = '';

  function pushSection(title, offset) {
    sections.push({ section_title: title, char_offset: offset });
  }

  walk(body, {
    onElement(el, ctx) {
      const tag = (el.tagName || '').toLowerCase();
      if (skipTag(tag)) return false; // skip subtree

      // Footnote bodies are rendered separately, not inline.
      if (isFootnoteContainer(el)) return false;

      // Footnote reference -> [fn:N]
      if (tag === 'a') {
        const ref = footnoteRefNumber(el, footnoteMap);
        if (ref != null) {
          buf += `[fn:${ref}]`;
          return false;
        }
      }

      if (tag === 'h1' && !chapter_title) {
        chapter_title = el.textContent.trim();
        // Don't include the chapter title in the chapter text body.
        return false;
      }

      if (tag === 'h2' || tag === 'h3') {
        const title = el.textContent.trim();
        if (title) {
          // Begin a new section. Offset is current buffer length.
          if (buf && !buf.endsWith('\n\n')) buf += '\n\n';
          pushSection(title, buf.length);
        }
        return false;
      }

      if (tag === 'img') {
        const src = el.getAttribute('src') || '';
        const name = src.split('/').pop() || src;
        if (name) {
          images.push(name);
          buf += ` [IMAGE: ${name}] `;
        }
        return false;
      }

      // Block-level elements that should produce paragraph breaks.
      if (BLOCK_TAGS.has(tag)) {
        ctx.blockBefore = true;
      }
      return true;
    },
    onText(node, ctx) {
      const text = node.nodeValue;
      if (!text) return;
      if (ctx.blockBefore && buf && !buf.endsWith('\n\n')) buf += '\n\n';
      ctx.blockBefore = false;
      buf += text.replace(/\s+/g, ' ');
    },
  });

  if (!chapter_title) {
    // No NCX title and no h1 — fall back to first non-empty line.
    const firstLine = buf.split('\n').map((l) => l.trim()).find(Boolean);
    chapter_title = firstLine ? firstLine.slice(0, 80) : `Chapter ${chapterNumber}`;
  }

  // Compute char_length for each section (offset to next, or end).
  const text = buf.replace(/\n{3,}/g, '\n\n').trim();
  const sectionsWithLen = sections.map((s, i) => {
    const next = sections[i + 1];
    const end = next ? next.char_offset : text.length;
    return { ...s, char_length: Math.max(0, end - s.char_offset) };
  });

  const footnotes = Object.entries(footnoteMap).map(([n, fn]) => ({
    footnote_number: parseInt(n, 10),
    text: fn.text,
  }));

  return {
    chapter_title,
    text,
    sections: sectionsWithLen,
    footnotes,
    images,
  };
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'pre',
  'ul', 'ol', 'li', 'br', 'hr', 'h4', 'h5', 'h6',
]);

function skipTag(tag) {
  // Style/script never contribute to text; nav/header/footer inside chapters
  // are usually noise (page numbers, running heads).
  return tag === 'script' || tag === 'style';
}

function isFootnoteContainer(el) {
  const epubType = el.getAttributeNS?.(NS.epub, 'type')
    || el.getAttribute?.('epub:type')
    || '';
  if (/footnote|endnote|note/i.test(epubType)) return true;
  const role = el.getAttribute?.('role') || '';
  if (/doc-footnote|doc-endnote/i.test(role)) return true;
  return false;
}

// Build a map of footnote number -> { text, ids } from the document.
// Anchors that link to those ids become [fn:N] markers in the body.
function collectFootnotes(doc) {
  const out = {};
  const idToNumber = {};
  let n = 0;

  // Find footnote/endnote containers; assign numbers in document order.
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isFootnoteContainer(el)) continue;
    n += 1;
    const id = el.getAttribute('id');
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    out[n] = { text, ids: id ? [id] : [] };
    if (id) idToNumber[id] = n;
  }

  // Stash idToNumber so footnoteRefNumber can find them.
  out.__idToNumber = idToNumber;
  return out;
}

function footnoteRefNumber(anchorEl, footnoteMap) {
  const epubType = anchorEl.getAttributeNS?.(NS.epub, 'type')
    || anchorEl.getAttribute?.('epub:type')
    || '';
  const isNoteref = /noteref|footnote-ref/i.test(epubType);
  const href = anchorEl.getAttribute('href') || '';
  if (!isNoteref && !href.startsWith('#')) return null;
  const targetId = href.replace(/^#/, '');
  const map = footnoteMap.__idToNumber || {};
  return map[targetId] ?? null;
}

// -----------------------------------------------------------------------------
// Tiny DOM walker. xmldom doesn't ship a TreeWalker; this is enough.
// -----------------------------------------------------------------------------
function walk(node, handlers, ctx = { blockBefore: false }) {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  if (node.nodeType === ELEMENT_NODE) {
    const descend = handlers.onElement(node, ctx);
    if (descend === false) return;
    let child = node.firstChild;
    while (child) {
      walk(child, handlers, ctx);
      child = child.nextSibling;
    }
  } else if (node.nodeType === TEXT_NODE) {
    handlers.onText(node, ctx);
  }
}

// -----------------------------------------------------------------------------
// Path + XML helpers
// -----------------------------------------------------------------------------
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

function resolvePath(dir, href) {
  // Strip anchor; resolve relative to dir.
  const cleanHref = href.split('#')[0];
  if (cleanHref.startsWith('/')) return cleanHref.slice(1);
  const parts = (dir + cleanHref).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function parseXml(xml) {
  // Suppress noisy "entity not defined" / unclosed-tag warnings — many
  // EPUBs have technically-invalid XHTML and xmldom logs each violation.
  const errorHandler = { warning: () => {}, error: () => {}, fatalError: () => {} };
  return new DOMParser({ errorHandler }).parseFromString(xml, 'application/xml');
}
