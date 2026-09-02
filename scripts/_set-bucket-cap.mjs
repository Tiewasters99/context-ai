// Raise the vault-documents size cap. Blue Book - 402.pdf is 711 MB against a
// 500 MB bucket limit, so the upload was rejected and the document row was left
// with no storage_path — silently, which is the actual complaint.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/discovery/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GB = 1024 * 1024 * 1024;
const target = Number(process.argv[2] || 2) * GB;

const res = await fetch(`${url}/storage/v1/bucket/vault-documents`, {
  method: 'PUT',
  headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'vault-documents', public: false, file_size_limit: target }),
});

console.log(`${res.status} ${(await res.text()).slice(0, 300)}`);

const check = await fetch(`${url}/storage/v1/bucket/vault-documents`, {
  headers: { apikey: key, authorization: `Bearer ${key}` },
});
const b = await check.json();
console.log(`vault-documents cap is now: ${b.file_size_limit ? (b.file_size_limit / 1048576).toFixed(0) + ' MB' : 'none'}`);
