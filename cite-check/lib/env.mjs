// Tiny .env loader for the cite-check CLI. Avoids pulling in dotenv as a
// dependency; reads KEY=VALUE lines and stuffs them into process.env unless
// they're already set (so caller-provided env wins).
import fs from 'node:fs/promises';

export async function loadEnv(envPath) {
  let raw;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // no .env is fine; assume env is already set
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
