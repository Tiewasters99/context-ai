/**
 * Word-level diff between an edit's `before` and `after`, for rendering a
 * redline in the Word convention: deletions struck through, insertions
 * underlined. Pure code — the redline is computed, never asked of a model.
 */

export interface DiffOp {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** Split into word and whitespace tokens so the diff preserves spacing. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

const MAX_TOKENS = 1200; // beyond this the DP table is not worth it

export function wordDiff(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : [];
  if (!before) return [{ type: 'ins', text: after }];
  if (!after) return [{ type: 'del', text: before }];

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      { type: 'del', text: before },
      { type: 'ins', text: after },
    ];
  }

  // Longest common subsequence over tokens.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('ins', b[j]);
      j++;
    }
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('ins', b[j++]);

  return ops;
}
