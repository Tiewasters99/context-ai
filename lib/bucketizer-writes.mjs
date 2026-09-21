// What a classification run is ALLOWED to write — attorney work product is
// sacred, and this module is where that is decided.
//
// WHERE THIS CAME FROM, AND WHY IT IS IN lib/ NOW
// ---------------------------------------------------------------------------
// These two functions were the tail of `src/lib/bucketizer/chooser.ts` (PR
// #186). The run they govern now also happens on the Fly worker, where a
// browser module cannot be imported — and the discipline is exactly the thing
// that must not be re-derived on the server. A server-side re-run that
// overwrote a confirmed row would destroy a decision a lawyer made and took
// responsibility for, and it would do it silently, overnight, with the laptop
// shut. So the rule lives here, both sides import it, and
// `src/lib/bucketizer/chooser.ts` re-exports it unchanged.
//
// No `node:` imports, deliberately: this module is bundled into the browser.

/**
 * What a run writes for one document — and, by its shape, what it never does.
 *
 * THERE IS NO `delete`. A classification row is the anchor for #177's evidence
 * (`bucketizer_evidence`) and for the attorney's own decision, and deleting one
 * to "clean up" a re-run would take confirmed quotations with it. So:
 *
 *   - a CONFIRMED or REJECTED row is never touched — not its status, not its
 *     confidence, not its rationale, not its passage ids. It is your decision;
 *     the machine does not get to revise it;
 *   - an UNDECIDED (proposed) row is refreshed from the new read, which is the
 *     point of running again — a row written from the first 200 passages
 *     carries a rationale about page 3 and passage ids the evidence lane would
 *     quote from;
 *   - a pair with no row yet is inserted;
 *   - nothing is ever removed.
 *
 * The caller must ALSO carry `status = 'proposed'` into the UPDATE itself, so
 * a row confirmed in another tab — or by an attorney while a server run was
 * grinding through the matter overnight — is not overwritten by a refresh
 * planned an hour earlier.
 *
 * @param {import('./bucketizer-writes.d.mts').ExistingClassification[]} existing
 * @param {import('./bucketizer-writes.d.mts').ProposedClassification[]} proposed
 * @returns {import('./bucketizer-writes.d.mts').WritePlan}
 */
export function planClassificationWrites(existing, proposed) {
  const byNode = new Map(existing.map((e) => [e.node_id, e]));
  const proposedNodes = new Set(proposed.map((p) => p.node_id));

  const plan = { insert: [], refresh: [], keptDecided: [], keptStale: [] };

  for (const row of proposed) {
    const prior = byNode.get(row.node_id);
    if (!prior) plan.insert.push(row);
    else if (prior.status === 'proposed') plan.refresh.push({ id: prior.id, row });
    else plan.keptDecided.push(prior.id);
  }
  for (const prior of existing) {
    if (proposedNodes.has(prior.node_id)) continue;
    if (prior.status === 'proposed') plan.keptStale.push(prior.id);
    else plan.keptDecided.push(prior.id);
  }
  return plan;
}

/**
 * The "examined, nothing fitted" sentinel after a run, or null to clear it.
 *
 * It exists so a document that fits no bucket is not re-read (and re-charged)
 * on every run. On a RE-run it has to be able to go the other way too: a
 * document that now has rows must lose the sentinel, and a document that
 * already carried rows must never gain one just because this pass added
 * nothing new.
 *
 * @param {{existingRows: number, writtenRows: number, completedAt: string}} input
 * @returns {string|null}
 */
export function sentinelAfterRun(input) {
  return input.existingRows === 0 && input.writtenRows === 0 ? input.completedAt : null;
}
