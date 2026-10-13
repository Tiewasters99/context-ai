// Grapheon Discovery — email families: an email and its attachments.
//
// A professional production keeps a family together. Each attachment is its
// own produced document (its own Bates range, image, text and DAT row), it
// follows its email in Bates order, and every member's DAT row carries the
// family's range: BEGATTACH = the first Bates number of the family,
// ENDATTACH = the last. The receiving side's review platform rebuilds the
// family from those two fields.
//
// The link lives in production_items.source_metadata (no migration):
//   parent      { family: true, attachment_count: N }
//   attachment  { parent_item_id, attachment_of, attachment_index }
// Only the top-level email is unpacked. An email attached to an email is
// imaged as one document; its own attachments are named on its page, not
// split out (one level, as in the corpus's own Phase 3 filing).
//
// Withholding follows the family, conservatively: when an email is withheld
// (Privileged or Non-Responsive), its attachments are withheld with it, and
// the package says so (RECONCILIATION.txt, and the privilege log for a
// privileged email). An attachment tagged on its own is withheld on its own;
// its email can still be produced.

export const parentIdOf = (item) => item?.source_metadata?.parent_item_id ?? null;

/**
 * Widen a set of withheld item ids to whole families.
 * @param {Array<{id: string, source_metadata?: object}>} items
 * @param {Set<string>} excludedIds  ids withheld by their own tags
 * @returns {{ excludedIds: Set<string>, withParent: Array<{item: object, parentId: string}> }}
 *          withParent: the attachments withheld only because their email was
 */
export function withholdFamilies(items, excludedIds) {
  const out = new Set(excludedIds);
  const withParent = [];
  // Until nothing changes, so the result does not depend on row order.
  for (let changed = true; changed;) {
    changed = false;
    for (const it of items) {
      const p = parentIdOf(it);
      if (!p || out.has(it.id) || !out.has(p)) continue;
      out.add(it.id);
      withParent.push({ item: it, parentId: p });
      changed = true;
    }
  }
  return { excludedIds: out, withParent };
}

/**
 * BEGATTACH / ENDATTACH for every produced member of a family.
 * @param {Array<{id: string, bates_first: string, bates_last: string, source_metadata?: object}>} produced
 *        the produced items, in Bates order
 * @returns {Map<string, {beg_attach: string, end_attach: string}>} by item id;
 *          a document that is not in a family has no entry (empty fields)
 */
export function familyRanges(produced) {
  // The family is named by its email: an attachment by its parent's id, the
  // email by its own (only an email that had attachments is a family).
  const members = new Map();
  for (const it of produced) {
    const root = parentIdOf(it) ?? (it.source_metadata?.family ? it.id : null);
    if (!root) continue;
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(it);
  }
  // The range spans what was produced: an attachment withheld on its own
  // leaves the range, it does not leave a hole the receiving side must guess at.
  const out = new Map();
  for (const list of members.values()) {
    const range = { beg_attach: list[0].bates_first, end_attach: list[list.length - 1].bates_last };
    for (const it of list) out.set(it.id, range);
  }
  return out;
}

/**
 * Privilege-log rows for attachments withheld with their email. Each sits
 * right after its email's own entry, with the email's basis.
 * @param {Array<object>} entries  privilege_log_entries rows
 * @param {Array<{item: object, parentId: string}>} withParent
 */
export function privilegeEntriesWithFamilies(entries, withParent) {
  const byParent = new Map();
  for (const w of withParent) {
    if (!byParent.has(w.parentId)) byParent.set(w.parentId, []);
    byParent.get(w.parentId).push(w.item);
  }
  const own = new Set(entries.map((e) => e.production_item_id));
  const out = [];
  for (const e of entries) {
    out.push(e);
    for (const child of byParent.get(e.production_item_id) ?? []) {
      if (own.has(child.id)) continue;   // tagged Privileged itself: it has its own entry
      out.push({
        production_item_id: child.id,
        doc_date: e.doc_date,
        author: e.author,
        addressee: e.addressee,
        cc: e.cc,
        subject_matter: `Attachment "${child.original_filename ?? ''}" to the email above`,
        basis: e.basis,
        basis_custom: e.basis_custom,
        description: 'Withheld with its parent email.',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Remove duplicates" (one switch, OFF unless chosen, per production, in Bates
// & Produce before stamping; decided by the stamp job).
//
// Off, every copy is produced under its own Bates number: a copy carries its
// own custodian and location. On, byte-identical copies (sha256 of the native)
// in the same production are produced once:
//   * loose copies of one another: the first in Bates order is produced;
//   * a loose copy of a family member (an email with attachments, or an
//     attachment): the family member is produced, the family whole.
// A copy set aside is never dropped silently: the produced copy's DAT row names
// every custodian and location (ALLCUSTODIANS, DUPLICATEPATHS), DUPLICATES.csv
// and RECONCILIATION.txt list it with the Bates number it went out at, and the
// stamp count says how many.
//
// Never: a family member set aside (two identical attachments in two families
// are both produced), a family broken, a copy set aside for a twin that is
// withheld (it is decided over what WOULD be produced, so a withheld twin is
// simply absent and the copy stands on its own tags), or an empty file treated
// as anyone's copy.

const isLoose = (it) => !parentIdOf(it) && !it?.source_metadata?.family;

/**
 * The copies the switch sets aside.
 * @param {Array<{id: string, sha256?: string|null, file_size_bytes?: number|null, source_metadata?: object}>} items
 *        the documents that would be produced (ready, not withheld), in Bates order
 * @returns {Array<{item: object, of: object}>}  `of` = the copy produced in its place
 */
export function duplicatesToSetAside(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.sha256 || Number(it.file_size_bytes) === 0) continue;
    if (!groups.has(it.sha256)) groups.set(it.sha256, []);
    groups.get(it.sha256).push(it);
  }
  const order = new Map(items.map((it, i) => [it.id, i]));
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const kept = list.find((it) => !isLoose(it)) ?? list[0];
    for (const it of list) if (it !== kept && isLoose(it)) out.push({ item: it, of: kept });
  }
  return out.sort((a, b) => order.get(a.item.id) - order.get(b.item.id));
}

const pathOf = (it) => it?.original_path || it?.original_filename || '';

/**
 * ALLCUSTODIANS / DUPLICATEPATHS for each produced document that had copies
 * set aside. Documents with none get no entry (empty fields).
 * @param {Array<{item: object, of: object}>} setAside
 * @returns {Map<string, {all_custodians: string, duplicate_paths: string}>}
 */
export function duplicateColumns(setAside) {
  const byMember = new Map();
  for (const { item, of } of setAside) {
    if (!byMember.has(of.id)) byMember.set(of.id, { of, copies: [] });
    byMember.get(of.id).copies.push(item);
  }
  const out = new Map();
  for (const [id, { of, copies }] of byMember) {
    const custodians = [];
    for (const c of [of, ...copies]) {
      const name = String(c.source_metadata?.custodian ?? '').trim();
      if (name && !custodians.includes(name)) custodians.push(name);
    }
    out.set(id, {
      all_custodians: custodians.join('; '),
      duplicate_paths: copies.map(pathOf).join('; '),
    });
  }
  return out;
}

/**
 * RECONCILIATION.txt's line for each copy set aside, once numbers exist.
 * @param {Array<{item: object, of: object}>} setAside  `of` carrying bates_first
 * @param {Map<string, object>} byId  production items by id (for the email)
 */
export function setAsideLines(setAside, byId) {
  return setAside.map(({ item, of }) => {
    const name = item.original_filename ?? pathOf(item);
    if (isLoose(of)) return `${name} (copy): not produced; identical to ${of.bates_first ?? ''}, produced once`;
    const parent = byId.get(parentIdOf(of));
    const tail = parent ? `, produced as an attachment to ${parent.bates_first ?? ''}` : ', produced as an email with its attachments';
    return `${name} (filed copy): not produced; identical to ${of.bates_first ?? ''}${tail}`;
  });
}
