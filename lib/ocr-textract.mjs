// AWS Textract OCR — the SEALED route (Phase 4 of the ingestion plan,
// 2026-09-04; Eden's decision 2: Textract for documents in SecureSpaces).
//
// Why this is the sealed route: the scan goes to textract.<region>.amazonaws.com
// in OUR OWN AWS account — the same account that holds the sealed embedding
// endpoint (docs/SEALED_EMBEDDINGS_SETUP.md) and the Bedrock pen — and no
// model provider is in the loop. Textract is a service, not a chat model: no
// prompt, no training on prompts, and the one data-use question it does raise
// (AWS may use processed content to improve its AI services unless the account
// opts out) is closed by an AWS Organizations AI-services opt-out policy set
// BEFORE the first job. The route refuses to run until that opt-out is
// attested in the environment — see TEXTRACT_AI_OPT_OUT_CONFIRMED in
// lib/ocr-routes.mjs and docs/SEALED_OCR_SETUP.md.
//
// Mechanics: DetectDocumentText, the synchronous API. It takes ONE page per
// call (multi-page PDFs need the asynchronous API, which needs S3, which this
// codebase does not touch), so the PDF is split page by page with pdf-lib —
// the same windowing as the model routes with window = 1 — and each page's
// bytes go inline, base64 in the JSON body, signed with the hand-rolled SigV4
// in lib/aws-sigv4.mjs (verified against AWS's published known-answer test).
// No SDK, for the reason that file gives.
//
// Output: LINE blocks in the order Textract returns them, joined with
// newlines. Textract returns lines in reading order for ordinary pages; a
// two-column exhibit may interleave, which is a fidelity limit worth knowing
// about, not a bug to paper over here.

import { signRequest } from './aws-sigv4.mjs';
import { ocrByWindows, sleep, backoff } from './ocr-protocol.mjs';

// $1.50 per 1,000 pages (DetectDocumentText, us-east-1, first million pages).
export const TEXTRACT_USD_PER_PAGE = 0.0015;

// Synchronous Textract accepts a document of at most 10 MB.
export const TEXTRACT_MAX_PAGE_BYTES = 10 * 1024 * 1024;

const present = (v) => Boolean(v) && v !== 'PASTE';

/** The credentials and region the route uses, read from `env`. */
export function textractConfig(env = process.env) {
  return {
    region: present(env.TEXTRACT_AWS_REGION) ? env.TEXTRACT_AWS_REGION : (present(env.AWS_REGION) ? env.AWS_REGION : 'us-east-1'),
    accessKeyId: env.TEXTRACT_AWS_ACCESS_KEY_ID,
    secretAccessKey: env.TEXTRACT_AWS_SECRET_ACCESS_KEY,
    sessionToken: present(env.TEXTRACT_AWS_SESSION_TOKEN) ? env.TEXTRACT_AWS_SESSION_TOKEN : null,
  };
}

/**
 * One signed DetectDocumentText request for `bytes` (a single-page PDF or an
 * image). Pure — returns { url, headers, body } for fetch. `date` is
 * injectable for the request-shape test.
 */
export function textractRequest(bytes, { region, accessKeyId, secretAccessKey, sessionToken = null, date = new Date() }) {
  const url = `https://textract.${region}.amazonaws.com/`;
  const body = JSON.stringify({ Document: { Bytes: Buffer.from(bytes).toString('base64') } });
  const headers = signRequest({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'Textract.DetectDocumentText',
    },
    body,
    region,
    service: 'textract',
    accessKeyId,
    secretAccessKey,
    sessionToken,
    date,
  });
  return { url, headers, body };
}

/** LINE blocks → page text. PAGE and WORD blocks are ignored (WORDs repeat the LINEs). */
export function textFromBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.BlockType === 'LINE' && typeof b.Text === 'string')
    .map((b) => b.Text)
    .join('\n')
    .trim();
}

// Textract's error type rides in the body as {"__type": "...Exception"}.
function errorType(text) {
  try { return JSON.parse(text)?.__type?.split('#').pop() || ''; } catch { return ''; }
}
const RETRYABLE_TYPES = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'InternalServerError', 'LimitExceededException']);

async function detectOnePage(bytes, config, { fetchImpl = fetch, maxRetries = 5 } = {}) {
  if (bytes.length > TEXTRACT_MAX_PAGE_BYTES) {
    throw new Error(`textract: page is ${(bytes.length / 1048576).toFixed(1)} MB, over the 10 MB limit for a single page`);
  }
  let attempt = 0;
  for (;;) {
    const { url, headers, body } = textractRequest(bytes, config);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body });
    } catch (netErr) {
      if (attempt >= maxRetries) throw new Error(`textract network error: ${netErr.message}`);
      await sleep(backoff(attempt++)); continue;
    }
    if (res.ok) {
      const data = await res.json();
      return textFromBlocks(data?.Blocks);
    }
    const errText = await res.text();
    const type = errorType(errText);
    const retryable = res.status === 429 || res.status >= 500 || RETRYABLE_TYPES.has(type);
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`textract ${res.status}${type ? ` ${type}` : ''}: ${errText.slice(0, 300)}`);
    }
    await sleep(backoff(attempt++));
  }
}

// Public: OCR a whole PDF buffer -> { pages: [{ pageNumber, text }], usage, model }.
// Same shape and guarantees as the model routes.
export async function ocrPdfTextract(buf, {
  env = process.env,
  concurrency = 4,
  onProgress = () => {},
  fetchImpl = fetch,
  maxRetries = 5,
} = {}) {
  const config = textractConfig(env);
  if (!present(config.accessKeyId) || !present(config.secretAccessKey)) throw new Error('ocrPdfTextract: TEXTRACT_AWS_ACCESS_KEY_ID / TEXTRACT_AWS_SECRET_ACCESS_KEY required');
  const pages = await ocrByWindows(buf, { window: 1, concurrency, onProgress, label: `OCR via AWS Textract (${config.region})` }, async (bytes, absNums) => {
    const text = await detectOnePage(bytes, config, { fetchImpl, maxRetries });
    return [{ pageNumber: absNums[0], text }];
  });
  return {
    pages,
    usage: { pages: pages.length, requests: pages.length },
    model: 'textract-detect-document-text',
    estimated_usd: pages.length * TEXTRACT_USD_PER_PAGE,
  };
}
