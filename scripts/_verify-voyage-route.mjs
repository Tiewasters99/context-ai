// Verify the voyage-4 SageMaker route — offline always, live when configured.
//
// Three sections, in order of what they can prove:
//
//   1. SIGNING (offline, always runs). Replays AWS's published SigV4 worked
//      example — fixed credentials, fixed timestamp, documented expected
//      signature — through lib/aws-sigv4.mjs. Hand-rolled signing is only
//      acceptable because this check exists: match AWS's own answer and the
//      algorithm is right, not "looks right".
//
//   2. REQUEST SHAPE (offline, always runs). Builds a real request through the
//      route and asserts the URL, the input_type asymmetry, the dimension ask
//      and the signature header — the same assertions _verify-seal-pipes.mjs
//      makes, runnable on their own without the whole harness.
//
//   3. LIVE (only when AWS_* and SAGEMAKER_VOYAGE_ENDPOINT are real). One
//      document batch and one query, fictional text, against the actual
//      endpoint. Asserts 1024 floats and that document- and query-encoded
//      vectors of the SAME text differ (proof the input_type flag reached the
//      model — asymmetric encoding is the point of it). Run this ONCE after
//      provisioning (docs/SEALED_EMBEDDINGS_SETUP.md) before permitting any
//      real sealed ingest; it is also the moment to simplify parse() to
//      whichever response shape the container actually returned.
//
//   node scripts/_verify-voyage-route.mjs
//
// Sections 1–2: no network. Section 3: two calls to OUR endpoint, nothing else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signRequest } from '../lib/aws-sigv4.mjs';
import { EMBED_DIM, ROUTES, routeReady } from '../lib/embed-routes.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// 1. The known-answer test.
// ---------------------------------------------------------------------------
console.log('\n--- SigV4 known-answer test (AWS documented example) ------------');
{
  const out = signRequest({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  const sig = out.authorization.match(/Signature=([0-9a-f]+)$/)?.[1];
  check(sig === '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    "signature matches AWS's published value", sig);
  check(/SignedHeaders=content-type;host;x-amz-date/.test(out.authorization),
    'signed-header set matches the documented example');
  check(out['x-amz-date'] === '20150830T123600Z', 'timestamp formatting is exact');
}

// ---------------------------------------------------------------------------
// 2. The route builds the request the endpoint expects.
// ---------------------------------------------------------------------------
console.log('\n--- request shape ----------------------------------------------');
const route = ROUTES['voyage-4-sagemaker'];
const fakeEnv = {
  AWS_ACCESS_KEY_ID: 'AKIDFICTION',
  AWS_SECRET_ACCESS_KEY: 'fiction-secret',
  AWS_REGION: 'us-east-1',
  SAGEMAKER_VOYAGE_ENDPOINT: 'voyage-4-embed',
};
{
  const doc = route.buildRequest(['fictional text one', 'fictional text two'], { env: fakeEnv });
  const q = route.buildRequest(['fictional query'], { env: fakeEnv, inputType: 'query' });
  check(doc.url === 'https://runtime.sagemaker.us-east-1.amazonaws.com/endpoints/voyage-4-embed/invocations',
    'URL targets our endpoint in our region', doc.url);
  const docBody = JSON.parse(doc.body);
  const qBody = JSON.parse(q.body);
  check(docBody.input_type === 'document' && qBody.input_type === 'query',
    'documents and queries are encoded asymmetrically');
  check(docBody.output_dimension === EMBED_DIM, `asks for ${EMBED_DIM} dimensions`);
  check(docBody.input.length === 2 && qBody.input.length === 1, 'inputs pass through untouched');
  check(/^AWS4-HMAC-SHA256 Credential=AKIDFICTION\/\d{8}\/us-east-1\/sagemaker\/aws4_request,/.test(doc.headers.authorization),
    'signed for the sagemaker service in the right region');
  check(route.model === 'voyage-4' && route.dim === EMBED_DIM,
    'model stamp and dimension match the policy');
  check(route.parse({ data: [{ embedding: [1] }, { embedding: [2] }] }).length === 2
    && route.parse({ embeddings: [[1], [2]] }).length === 2,
    'parse accepts both candidate response shapes');
}

// ---------------------------------------------------------------------------
// 3. Live, only when the endpoint is real.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const env = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env is fine — section 3 just skips */ }

if (!routeReady(route, process.env)) {
  console.log('\n--- live -------------------------------------------------------');
  console.log('  SKIP  AWS credentials / SAGEMAKER_VOYAGE_ENDPOINT not configured —');
  console.log('        offline sections above are the whole proof until provisioning.');
} else {
  console.log('\n--- live: the actual endpoint ----------------------------------');
  const call = async (texts, inputType) => {
    const req = route.buildRequest(texts, { env: process.env, inputType });
    const t0 = Date.now();
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    const ms = Date.now() - t0;
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    return { vectors: route.parse(json), ms, raw: json };
  };
  try {
    const doc = await call(
      ['The Vashti letter is fictional text used only to verify this endpoint.'], 'document');
    const q = await call(
      ['The Vashti letter is fictional text used only to verify this endpoint.'], 'query');
    check(doc.vectors.length === 1 && q.vectors.length === 1, 'one vector per input');
    check(doc.vectors[0].length === EMBED_DIM, `document vector is ${EMBED_DIM}-dimensional`,
      `got ${doc.vectors[0].length}`);
    check(q.vectors[0].length === EMBED_DIM, `query vector is ${EMBED_DIM}-dimensional`);
    check(doc.vectors[0].every((x) => typeof x === 'number' && Number.isFinite(x)),
      'vector is finite floats');
    const same = doc.vectors[0].every((x, i) => x === q.vectors[0][i]);
    check(!same, 'document- and query-encoding of the SAME text differ (input_type reached the model)');
    console.log(`        latency: document ${doc.ms}ms, query ${q.ms}ms`);
    console.log(`        response keys: ${Object.keys(doc.raw).join(', ')} — simplify parse() to this shape.`);
  } catch (err) {
    check(false, 'live call failed', err.message.slice(0, 200));
  }
}

console.log(`\n${failures === 0 ? 'voyage route verified.' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
