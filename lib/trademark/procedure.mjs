// lib/trademark/procedure.mjs — the recipe's procedure, as data.
//
// Spec §0.1 rule 4: the substitution table, endings, exclusion defaults,
// class notes, the self-test, the forbidden phrases and the search-syntax
// reference live in readable JSON beside this file, each row with a `why`.
// They are shown read-only in the Method panel, and their content hash is
// stored on the clearance when queries are generated and printed in the
// report — so a report always says which procedure produced it.
//
// One loader for both runtimes: JSON import attributes work in Node 22+ and
// in Vite. Nothing here touches node:fs or node:crypto; the hash is
// crypto.subtle (Node 22 and every browser).
//
// How to change the procedure: a pull request to lib/trademark/procedure/.
// The hash changes with it, and every later report says so.

import substitutions from './procedure/substitutions.json' with { type: 'json' };
import endings from './procedure/endings.json' with { type: 'json' };
import exclusions from './procedure/exclusions.json' with { type: 'json' };
import classes from './procedure/classes.json' with { type: 'json' };
import forbidden from './procedure/forbidden.json' with { type: 'json' };
import selftest from './procedure/selftest.json' with { type: 'json' };
import syntax from './procedure/syntax.json' with { type: 'json' };

/** The generator's version, stored on every query row it writes. */
export const GENERATOR_VERSION = 'tm-queries/1';

/** The procedure files, in the order they are hashed and printed. */
export const PROCEDURE = Object.freeze({
  substitutions, endings, exclusions, classes, forbidden, selftest, syntax,
});

export const PROCEDURE_FILES = Object.freeze(Object.keys(PROCEDURE));

export const HOW_TO_CHANGE = 'How to change this: a pull request to lib/trademark/procedure.';

/** JSON with object keys sorted at every depth: the same data, the same bytes. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The text that is hashed: each file's name and canonical JSON, one per line. */
export function procedureText(procedure = PROCEDURE) {
  return PROCEDURE_FILES.map((name) => `${name}.json ${canonicalJson(procedure[name])}`).join('\n');
}

/** sha256 (hex) of procedureText(). */
export async function procedureHash(procedure = PROCEDURE) {
  const bytes = new TextEncoder().encode(procedureText(procedure));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
