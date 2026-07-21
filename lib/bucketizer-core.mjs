// Bucketizer core — prompts, schemas, and tree/passage serialization shared
// by the browser engine (src/lib/bucketizer, via generateStructured) and the
// service-role CLI (scripts/bucketize.mjs). Pure functions, no provider or
// network code: adapters own the wire format, this module owns the words.

/** Cap on pleading/passage text fed to a single model call. */
export const TREE_INPUT_CHAR_BUDGET = 400_000;
export const CLASSIFY_INPUT_CHAR_BUDGET = 60_000;
/** At most this many buckets proposed per document. */
export const MAX_ASSIGNMENTS_PER_DOC = 6;

// ---------------------------------------------------------------------------
// Tree generation (pleadings -> case-theory tree)
// ---------------------------------------------------------------------------

export const TREE_TOOL_NAME = 'submit_case_theory_tree';
export const TREE_TOOL_DESCRIPTION =
  'Submit the case-theory tree extracted from the pleadings.';

export const TREE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      description: 'One entry per cause of action / claim in the operative complaint (and counterclaims, if any).',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short claim name, e.g. "Excessive force (§ 1983, Fourth Amendment)".' },
          description: { type: 'string', description: 'One or two sentences: what this claim is and what evidence bears on it.' },
          elements: {
            type: 'array',
            description: 'The legal elements the plaintiff must prove for this claim.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string', description: 'Routing criteria: what kinds of evidence would tend to prove or disprove this element.' },
                subissues: {
                  type: 'array',
                  description: 'Contested factual subissues under this element — including defenses and denials raised in the answer that bear on it.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string', description: 'Routing criteria for this subissue.' },
                    },
                    required: ['label', 'description'],
                  },
                },
              },
              required: ['label', 'description'],
            },
          },
        },
        required: ['label', 'description', 'elements'],
      },
    },
    themes: {
      type: 'array',
      description: 'Cross-cutting case themes that span claims (e.g. "pattern of indifference", "credibility of Officer X"), plus practical buckets like damages and key witnesses.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string', description: 'Routing criteria for this theme.' },
        },
        required: ['label', 'description'],
      },
    },
  },
  required: ['claims', 'themes'],
};

export const TREE_SYSTEM = `You are a senior litigator building the working case-theory outline for a civil matter, directly from the operative pleadings.

Read the pleadings and produce a tree: claims (causes of action), the legal elements that must be proven for each, and under each element the contested factual subissues — folding in the defenses, denials, and affirmative defenses raised in the answer where they bear. Add cross-cutting themes: recurring factual patterns, credibility contests, damages, and other buckets a trial team would sort evidence into.

Rules:
- Ground every claim and element in what the pleadings actually allege; use the correct legal elements for the causes of action pleaded (with the governing law's terminology, e.g. Graham v. Connor factors for a Fourth Amendment excessive-force claim).
- Write every description as ROUTING CRITERIA for a document classifier: concretely say what kinds of documents, testimony, records, or footage belong in that bucket.
- Prefer a usable working tree over an exhaustive one: typically 2-8 claims, 3-6 elements each, 0-5 subissues per element, 3-8 themes.
- Do not invent parties, claims, or facts not in the pleadings.`;

/**
 * @param {{title: string, text: string}[]} pleadings
 */
export function buildTreeUserContent(pleadings) {
  const per = Math.floor(TREE_INPUT_CHAR_BUDGET / Math.max(1, pleadings.length));
  const parts = pleadings.map((p) => {
    const body = p.text.length > per ? `${p.text.slice(0, per)}\n[... truncated ...]` : p.text;
    return `=== PLEADING: ${p.title} ===\n${body}`;
  });
  return `Build the case-theory tree from these pleadings.\n\n${parts.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Classification (document -> tree nodes)
// ---------------------------------------------------------------------------

export const CLASSIFY_TOOL_NAME = 'submit_classifications';
export const CLASSIFY_TOOL_DESCRIPTION =
  'Submit the case-theory buckets this document belongs in.';

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      description: `The buckets this document belongs in, best matches first. Empty if none genuinely fit. At most ${MAX_ASSIGNMENTS_PER_DOC}.`,
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The node ref from the outline, e.g. "N7".' },
          confidence: { type: 'number', description: '0 to 1: how confident you are this document belongs in this bucket.' },
          rationale: { type: 'string', description: 'One or two sentences a reviewing attorney can check: what in the document puts it in this bucket.' },
          passageRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Refs of the supporting excerpts, e.g. ["P3", "P12"].',
          },
        },
        required: ['ref', 'confidence', 'rationale'],
      },
    },
  },
  required: ['assignments'],
};

export const CLASSIFY_SYSTEM = `You are classifying discovery documents into a litigation case-theory tree for attorney review.

You will get the tree as a numbered outline (each node has a ref like N4 and routing criteria) and one document as numbered excerpts (refs like P2). Assign the document to the nodes where a trial team would actually look for it.

Rules:
- Assign to the MOST SPECIFIC applicable nodes (a subissue rather than its parent element) — but if a document genuinely bears on a whole claim or element broadly, assign the broader node.
- Only assign buckets the document genuinely supports; most documents belong in 1-3 buckets, and an irrelevant document belongs in none (return an empty list — never force a fit).
- Confidence reflects how squarely the document fits the node's routing criteria.
- Rationale must point at the document's actual content, never boilerplate.
- Cite the excerpt refs that support each assignment.`;

/**
 * Serialize the node tree into a stable numbered outline. Returns the outline
 * text and the ref->nodeId map for decoding the model's answer.
 * @param {{id: string, parent_id: string|null, kind: string, label: string, description: string|null, position: number}[]} nodes
 */
export function serializeOutline(nodes) {
  const byParent = new Map();
  for (const n of nodes) {
    const key = n.parent_id ?? 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.position - b.position) || a.label.localeCompare(b.label));
  }
  const refToId = new Map();
  const lines = [];
  let counter = 0;
  const walk = (parentKey, depth) => {
    for (const n of byParent.get(parentKey) ?? []) {
      counter += 1;
      const ref = `N${counter}`;
      refToId.set(ref, n.id);
      const indent = '  '.repeat(depth);
      const desc = n.description ? ` — ${n.description}` : '';
      lines.push(`${indent}[${ref}] (${n.kind}) ${n.label}${desc}`);
      walk(n.id, depth + 1);
    }
  };
  walk('root', 0);
  return { outline: lines.join('\n'), refToId };
}

/**
 * @param {{title: string, docType?: string|null}} doc
 * @param {{id: string, text: string}[]} passages
 * @param {string} outline
 */
export function buildClassifyUserContent(doc, passages, outline) {
  const refToPassageId = new Map();
  const parts = [];
  let used = 0;
  let truncated = false;
  for (let i = 0; i < passages.length; i++) {
    const ref = `P${i + 1}`;
    const text = passages[i].text ?? '';
    if (used + text.length > CLASSIFY_INPUT_CHAR_BUDGET) { truncated = true; break; }
    used += text.length;
    refToPassageId.set(ref, passages[i].id);
    parts.push(`[${ref}] ${text}`);
  }
  const userContent = `## Case-theory outline\n${outline}\n\n## Document\nTitle: ${doc.title}${doc.docType ? `\nType: ${doc.docType}` : ''}${truncated ? '\n(Long document — excerpts below are a leading sample.)' : ''}\n\n${parts.join('\n\n')}`;
  return { userContent, refToPassageId };
}

/**
 * Decode a model classification result into insertable rows.
 * Unknown refs and out-of-range confidences are dropped/clamped rather than
 * thrown: one bad ref shouldn't sink a batch run.
 */
export function decodeAssignments(result, refToId, refToPassageId) {
  const seen = new Set();
  const out = [];
  for (const a of result?.assignments ?? []) {
    const nodeId = refToId.get(a.ref);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    out.push({
      node_id: nodeId,
      confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
      rationale: typeof a.rationale === 'string' ? a.rationale.slice(0, 2000) : null,
      passage_ids: (a.passageRefs ?? [])
        .map((r) => refToPassageId.get(r))
        .filter(Boolean),
    });
    if (out.length >= MAX_ASSIGNMENTS_PER_DOC) break;
  }
  return out;
}
