// The wording of a matter's "AI with access" section (Share dialog): why an
// agent sees the matter, and the one line about assistants connected with
// the person's full access. Pure, no imports beyond a type, so a node harness
// can check the sentences directly.

import type { AgentCoverage } from './agent-scope';

/** "this matter" / "via Bushell" / "All matters" — why the agent sees it. */
export function coverageLabel(reason: AgentCoverage, nameOf: (id: string) => string | undefined): string {
  if (reason.kind === 'all') return 'All matters';
  if (reason.kind === 'self') return 'this matter';
  return `via ${nameOf(reason.viaId) ?? 'a matter above this one'}`;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Which assistant a client's self-chosen name is, for display. */
export function assistantName(clientName: string): string {
  const n = clientName || '';
  if (/claude|anthropic/i.test(n)) return 'Claude';
  if (/chatgpt|openai|\bgpt\b/i.test(n)) return 'ChatGPT';
  if (/gemini|antigravity|google/i.test(n)) return 'Gemini';
  if (/grok|xai|x\.ai/i.test(n)) return 'Grok';
  return n.trim() || 'An AI client';
}

/**
 * One truthful sentence about the full-access connections, or null when
 * there are none. `clientNames` are the live sign-in grants that are NOT
 * agents; `keyCount` the live connections made with a key from a Connect
 * page. They are not scoped, so they are not listed as if they were.
 */
export function fullAccessLine(clientNames: readonly string[], keyCount: number): string | null {
  const names = [...new Set(clientNames.map(assistantName))];
  if (keyCount > 0) names.push(`${keyCount} connection${keyCount === 1 ? '' : 's'} set up with a key`);
  if (names.length === 0) return null;
  return `${joinNames(names)}, connected with your full access, can also see this matter.`;
}
