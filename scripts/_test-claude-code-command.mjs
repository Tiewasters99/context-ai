// The Claude Code command the connector page tells people to type, checked
// character for character against the syntax on Anthropic's own pages
// (code.claude.com/docs/en/mcp and .../mcp-quickstart, read 2026-09-20).
//
// This is a copy-paste instruction: a stray quote or a dropped flag is not a
// cosmetic bug, it is a command that fails in a lawyer's terminal with no
// clue why. So the assertions are whole strings, not substrings.
//
// Run:  node --test scripts/_test-claude-code-command.mjs
// (Node 22.18+ strips the types out of the .ts import on its own;
// connectorTokens.ts has no '@/' imports and no React, so it needs no loader.)
//
// Untracked by convention — scripts/_*.mjs are probes, not code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claudeCodeAddCommand,
  MCP_ENDPOINT_URL,
} from '../src/lib/connectorTokens.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const URL_ = 'https://www.contextspaces.ai/api/mcp';
const ADD = `claude mcp add --scope user --transport http contextspaces ${URL_}`;
const SAMPLE = 'csp_A1b2C3d4E5f6G7h8';

test('the endpoint is the www form the connector clients need', () => {
  assert.equal(MCP_ENDPOINT_URL, URL_);
});

test('no token — the sign-in command, exactly', () => {
  assert.equal(claudeCodeAddCommand(), ADD);
  assert.equal(claudeCodeAddCommand(null), ADD);
  assert.equal(claudeCodeAddCommand(''), ADD);
});

test('no token — both shells give the identical command', () => {
  // Nothing is quoted when there is no header, so there is nothing to differ.
  assert.equal(claudeCodeAddCommand(null, 'posix'), ADD);
  assert.equal(claudeCodeAddCommand(null, 'powershell'), ADD);
});

test('a token, bash/zsh — double quotes', () => {
  assert.equal(
    claudeCodeAddCommand(SAMPLE, 'posix'),
    `${ADD} --header "Authorization: Bearer ${SAMPLE}"`,
  );
});

test('a token, PowerShell — single quotes', () => {
  // PowerShell expands $ inside a double-quoted string; single quotes are
  // the form that cannot surprise anyone.
  assert.equal(
    claudeCodeAddCommand(SAMPLE, 'powershell'),
    `${ADD} --header 'Authorization: Bearer ${SAMPLE}'`,
  );
});

test('posix is the default shell', () => {
  assert.equal(
    claudeCodeAddCommand(SAMPLE),
    claudeCodeAddCommand(SAMPLE, 'posix'),
  );
});

test('the flags the page promises are all present and in the documented order', () => {
  const cmd = claudeCodeAddCommand(SAMPLE, 'posix');
  // --scope user, or the connector exists only in one folder.
  assert.match(cmd, /^claude mcp add --scope user --transport http /);
  // SSE is deprecated; http is what the docs tell people to use.
  assert.ok(!cmd.includes('--transport sse'));
  // The header rides after the URL, as the documented example shows.
  assert.ok(cmd.indexOf('--header') > cmd.indexOf(URL_));
});

test('a token is never mangled by the builder', () => {
  // Real tokens are base64url: - and _ appear, and must survive verbatim.
  const awkward = 'csp_-_aZ09-_';
  assert.ok(claudeCodeAddCommand(awkward, 'posix').endsWith(`Bearer ${awkward}"`));
  assert.ok(
    claudeCodeAddCommand(awkward, 'powershell').endsWith(`Bearer ${awkward}'`),
  );
});

test('one URL constant, and only one — the page never hard-codes a second', () => {
  const count = (hay, needle) => hay.split(needle).length - 1;

  const lib = readFileSync(join(ROOT, 'src/lib/connectorTokens.ts'), 'utf8');
  assert.equal(
    count(lib, URL_),
    1,
    'connectorTokens.ts should declare the endpoint exactly once',
  );

  // If a second literal ever appears in the page, the www caveat that the
  // constant carries stops applying to it, and the two drift apart.
  const page = readFileSync(join(ROOT, 'src/pages/ClaudeConnect.tsx'), 'utf8');
  assert.equal(
    count(page, 'contextspaces.ai/api/mcp'),
    0,
    'ClaudeConnect.tsx must use MCP_ENDPOINT_URL, never a literal URL',
  );
});

test('the page shows a placeholder, not a fabricated token', () => {
  const page = readFileSync(join(ROOT, 'src/pages/ClaudeConnect.tsx'), 'utf8');
  assert.ok(page.includes("const TOKEN_PLACEHOLDER = 'YOUR_TOKEN'"));
  // csp_ is the real token prefix (generateConnectorToken). A literal one in
  // the page source would mean an example token that looks live.
  assert.ok(
    !/['"`]csp_[A-Za-z0-9_-]/.test(page),
    'no token-shaped literal belongs in the page source',
  );
});
