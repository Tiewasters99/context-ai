// Keeps the Agents tab's two halves in step. No network, no database, no
// writes — it reads four files and compares names.
//
//   node scripts/_verify-agent-tools.mjs
//
// Checks:
//   1. every tool the charter EDITOR offers (src/lib/agent-tools.ts) exists
//      in mcp-core's TOOLS and is inside assistant-core's ALLOWED_TOOLS —
//      otherwise the checkbox would grant something the server drops;
//   2. every built-in agent's DISPLAY row (src/lib/agent-builtins.ts) has a
//      matching server-side charter (lib/agent-charter.mjs) with the same
//      key and the same tool list, so the docket never describes a run that
//      would behave differently;
//   3. every prebuilt template's tools (src/lib/agent-templates.ts) are on
//      the menu.
//
// Drift always fails CLOSED at run time (the server intersects), so this
// script exists to catch the cosmetic lie — a UI promising a tool the run
// would not have.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const { TOOLS } = await import('../lib/mcp-core.mjs');
const { ALLOWED_TOOLS } = await import('../lib/assistant-core.mjs');
const { BUILTIN_CHARTERS } = await import('../lib/agent-charter.mjs');

const implemented = new Set(TOOLS.map((t) => t.name));
const problems = [];

// 1 ── the editor's menu
const menuSrc = read('src/lib/agent-tools.ts');
const menuNames = [...menuSrc.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1]);
if (menuNames.length === 0) problems.push('agent-tools.ts: no tool names found — did the shape change?');
for (const n of menuNames) {
  if (!implemented.has(n)) problems.push(`agent-tools.ts offers "${n}", which mcp-core does not implement`);
  else if (!ALLOWED_TOOLS.has(n)) problems.push(`agent-tools.ts offers "${n}", which assistant-core does not allow`);
}
const menuSet = new Set(menuNames);
for (const n of ALLOWED_TOOLS) {
  if (!menuSet.has(n)) problems.push(`ALLOWED_TOOLS has "${n}" but the charter editor never offers it`);
}

// 2 ── built-ins: display rows vs server charters
const builtinSrc = read('src/lib/agent-builtins.ts');
const displayKeys = [...builtinSrc.matchAll(/^\s*key: '([a-z_]+)',$/gm)].map((m) => m[1]);
const serverKeys = Object.keys(BUILTIN_CHARTERS);
for (const k of displayKeys) {
  if (!serverKeys.includes(k)) problems.push(`agent-builtins.ts shows "${k}" but lib/agent-charter.mjs has no charter for it`);
}
for (const k of serverKeys) {
  if (!displayKeys.includes(k)) problems.push(`lib/agent-charter.mjs defines "${k}" but the docket never shows it`);
}
for (const [key, charter] of Object.entries(BUILTIN_CHARTERS)) {
  for (const n of charter.allowed_tools) {
    if (!ALLOWED_TOOLS.has(n)) problems.push(`builtin "${key}" asks for "${n}", which assistant-core does not allow`);
  }
  // The display row's tool list must match the server's, in any order.
  const block = builtinSrc.split(`key: '${key}'`)[1] ?? '';
  const toolsLine = /tools: \[([^\]]*)\]/s.exec(block);
  if (!toolsLine) {
    problems.push(`agent-builtins.ts: no tools list found for "${key}"`);
  } else {
    const shown = [...toolsLine[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    const actual = [...charter.allowed_tools].sort();
    if (shown.join(',') !== actual.join(',')) {
      problems.push(`builtin "${key}": docket shows [${shown}] but the charter grants [${actual}]`);
    }
  }
}

// 3 ── templates
const tplSrc = read('src/lib/agent-templates.ts');
for (const m of tplSrc.matchAll(/allowed_tools: \[([^\]]*)\]/g)) {
  for (const t of m[1].matchAll(/'([a-z_]+)'/g)) {
    if (!menuSet.has(t[1])) problems.push(`a template asks for "${t[1]}", which is not on the charter menu`);
  }
}

if (problems.length) {
  console.error('agent tool drift:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`agent tools OK — ${menuNames.length} tools on the menu, ${serverKeys.length} built-in charters.`);
