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
