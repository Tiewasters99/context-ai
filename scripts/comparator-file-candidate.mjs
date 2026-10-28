// File one candidate into a Model Comparator comparison, BLIND, without the UI.
//
// It POSTs /api/sandbox add_comparison_candidate — the same action the Compare
// dialog uses — so the candidate is filed under "Candidate <letter> — <title>"
// whatever the file is called, and the name given with --as is stored in the
// comparison's key, which nobody can read until every candidate has a grade
// card and the comparison is revealed. The script prints the blind label only.
//
//   CS_BEARER=<your Supabase access token> \
//   node scripts/comparator-file-candidate.mjs <comparison_id> <path/to/DRAFT-A.md> --as "<who made it>" [--label A] [--base https://www.contextspaces.ai]
//
// The bearer is your own session token (the browser's supabase.auth.getSession()
// access_token), so RLS applies exactly as it does in the app. It is read from
// the environment, never from the command line, and is never printed.
// Needs migration 120 applied and the code deployed; until then the server
// answers that the comparator is not set up.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? null;
};
const revealed = flag('as');
const label = flag('label');
const base = (flag('base') || process.env.CS_BASE_URL || 'https://www.contextspaces.ai').replace(/\/+$/, '');
const [comparisonId, file] = argv;
const bearer = process.env.CS_BEARER;

if (!comparisonId || !file) {
  console.error('usage: CS_BEARER=… node scripts/comparator-file-candidate.mjs <comparison_id> <file> --as "<who made it>" [--label A] [--base URL]');
  process.exit(2);
}
if (!bearer) {
  console.error('Set CS_BEARER to your Supabase access token (it is not accepted on the command line).');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}

const res = await fetch(`${base}/api/sandbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({
    action: 'add_comparison_candidate',
    args: {
      comparison_id: comparisonId,
      filename: path.basename(file),
      content: fs.readFileSync(file).toString('base64'),
      encoding: 'base64',
      ...(revealed ? { revealed_label: revealed } : {}),
      ...(label ? { label } : {}),
    },
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Refused (${res.status}): ${body.error ?? 'no message'}`);
  process.exit(1);
}
console.log(`Filed as "${body.title}" (Candidate ${body.label}); document ${body.document_id}.`);
console.log(body.key_filed ? 'Who made it is held in the comparison\'s key until the reveal.' : 'No --as given: the reveal will show the label only.');
