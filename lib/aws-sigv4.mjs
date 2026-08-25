// AWS Signature Version 4, in ~90 lines of node:crypto.
//
// Why hand-rolled instead of the AWS SDK
// ---------------------------------------------------------------------------
// The only AWS call this codebase makes is InvokeEndpoint against a SageMaker
// runtime — one POST with a signed Authorization header. The modular SDK would
// be the third-largest dependency in the tree for the sake of that header, and
// this project has concrete reasons (the 2026-06 supply-chain incident) to
// keep the dependency surface small on security-sensitive paths.
//
// Hand-rolled signing is only acceptable because it is VERIFIABLE: SigV4 is a
// deterministic HMAC chain, and AWS publishes a complete worked example with
// fixed credentials, a fixed timestamp and the expected signature at every
// intermediate step. scripts/_verify-voyage-route.mjs replays that exact
// example against this implementation — if the final signature matches AWS's
// published value, the algorithm is right, not "looks right".
//
// Scope deliberately small: header-based signing (not presigned URLs), single
// chunk (not streaming), UNSIGNED-PAYLOAD not supported. That is everything an
// InvokeEndpoint call needs and nothing more.

import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// AWS's canonical encoding is RFC 3986: encodeURIComponent, then the five
// characters JavaScript leaves bare that AWS does not.
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Sign one HTTP request. Returns the COMPLETE header object to send —
 * the caller's headers plus x-amz-date, the credential token if any, and
 * Authorization. (`host` is part of the signature but not returned: fetch
 * derives it from the URL, which is exactly the value that was signed.)
 *
 *   method, url, headers, body — the request as it will be sent. The body
 *     must be the exact bytes/string that go on the wire: the signature
 *     covers its SHA-256, so re-stringifying after signing breaks it.
 *   region, service              — e.g. 'us-east-1', 'sagemaker'.
 *   accessKeyId, secretAccessKey, sessionToken? — the credentials.
 *   date?                        — injectable for the known-answer test only.
 */
export function signRequest({
  method, url, headers = {}, body = '',
  region, service, accessKeyId, secretAccessKey, sessionToken = null,
  date = new Date(),
}) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  // Everything the caller sends gets signed, plus host and x-amz-date. Signing
  // all headers (rather than a minimal set) means a proxy cannot alter any of
  // them without invalidating the signature.
  const toSign = { host: u.host, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) toSign[k.toLowerCase()] = String(v);
  if (sessionToken) toSign['x-amz-security-token'] = sessionToken;

  const signedNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedNames
    .map((k) => `${k}:${toSign[k].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = signedNames.join(';');

  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalUri = u.pathname
    .split('/')
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join('/') || '/';

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
