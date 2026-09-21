// Where an exported copy lands, and what it is called when it gets there.
//
// One rule for every cloud drive, so a lawyer opening OneDrive and a lawyer
// opening Dropbox find the file in the same place:
//
//     <app folder>/Contextspaces/<matter name>/<filename>
//
// and, when the document belongs to no matter (a loose upload),
//
//     <app folder>/Contextspaces/<filename>
//
// The <app folder> is not ours to name — it is the folder the provider gives
// an app-folder-scoped application, and it is the only place either token can
// reach. See lib/cloud-drives/onedrive.mjs and dropbox.mjs.
//
// SANITIZING. A matter is named by a lawyer, not by a file system: "Calder v.
// Atlas — settlement (2026)" carries an em dash, parentheses and a period.
// Most of that is fine; a handful of characters are not, and the two providers
// disagree about which. The conservative intersection is taken below — the
// Windows/OneDrive illegal set (`" * : < > ? / \ |`), control characters, and
// the trailing dot-or-space that Windows silently strips — so the same name
// produces the same path on both services. Nothing is transliterated: an
// accented or non-Latin matter name survives intact, because both providers
// store UTF-8 names and a lawyer should recognise their own matter.

// Characters no drive will take in a name, plus the ASCII control range.
const ILLEGAL = /["*:<>?/\\|\u0000-\u001f\u007f]/g;

// Long enough for a real matter name, short enough that the whole path stays
// well inside both providers' limits (OneDrive: 400 characters for the full
// path; Dropbox: 255 per component).
const MAX_SEGMENT = 120;

/**
 * One path component — a folder name or a file name — made safe without being
 * made unrecognisable. Returns '' when nothing usable is left, so the caller
 * decides the fallback rather than inheriting a silent default.
 */
export function sanitizeSegment(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(ILLEGAL, ' ')
    // A path separator is not a name; collapsing it to a space is what keeps
    // "Smith 7/12 hearing" one folder instead of two.
    .replace(/\s+/g, ' ')
    .trim();
  // Windows and OneDrive both strip a trailing dot or space, which turns
  // "Exhibit A." into "Exhibit A" AFTER the collision check has run. Do it
  // here instead, so the name we send is the name that is stored.
  s = s.replace(/[. ]+$/g, '');
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).trim().replace(/[. ]+$/g, '');
  return s;
}

/**
 * A file name, sanitized with its extension kept. The extension is what the
 * reader and the provider both use to decide the content type, so it is
 * protected from the length trim rather than being the first thing lost.
 */
export function sanitizeFilename(raw, fallback = 'document') {
  const name = typeof raw === 'string' ? raw : '';
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1 && name.length - dot <= 12;
  const stem = sanitizeSegment(hasExt ? name.slice(0, dot) : name);
  const ext = hasExt ? sanitizeSegment(name.slice(dot + 1)) : '';
  const safeStem = stem || sanitizeSegment(fallback) || 'document';
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/**
 * The folder chain under the app folder, and the file name. Never absolute,
 * never containing a separator: each element is one component the adapter
 * creates or addresses in the provider's own way.
 */
export function exportPath({ matterName, filename, title }) {
  const folders = ['Contextspaces'];
  const matter = sanitizeSegment(matterName);
  if (matter) folders.push(matter);
  return {
    folders,
    filename: sanitizeFilename(filename || title || 'document', title || 'document'),
  };
}

/** The same path as one POSIX-ish string, which is how Dropbox addresses it. */
export function posixPath({ folders, filename }) {
  return `/${[...folders, filename].join('/')}`;
}
