// POST /api/edition-share — send a passage of a Library edition to someone
// by email (the Reader's Send, beside Note on a highlight).
//
// Body: { edition_id, page, quote, to, message? }
//   edition_id  uuid of the edition (its title and author go in the mail)
//   page        the page the passage is on
//   quote       the passage itself (the selection), ≤ 4,000 characters
//   to          one plain email address, for now
//   message     a line from the sender, optional, ≤ 2,000 characters
//
// Answers:
//   200 { ok: true, to }
//   400 { error: 'bad_request', detail }
//   401 { error: 'missing_bearer' | 'invalid_session' }
//   404 { error: 'not_found' }                the edition is not there
//   501 { error: 'email_not_configured' }     no RESEND_API_KEY
//   502 { error: 'send_failed', detail }      Resend refused or was unreachable
//
// The sender is the signed-in reader: the mail goes out from the Reader's
// own address (Resend, on the verified domain) with the reader's address as
// Reply-To, so an answer reaches them. Nothing about the recipient is kept.
//
// Plain fetch with an injectable fetchImpl, so scripts/_test-edition-share.mjs
// drives this file with no network.

import { json, corsPreflight, bearerFrom, readJsonBody, authUser, SUPABASE_URL, SERVICE_KEY } from '../lib/account-security.mjs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Grapheon Reader <reader@contextspaces.ai>';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUOTE = 4000;
const MAX_MESSAGE = 2000;
const TIMEOUT_MS = 10_000;
const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function composeMail({ edition, page, quote, message, senderEmail, readUrl }) {
  const who = senderEmail || 'A reader';
  const where = `${edition.title}${edition.author ? `, ${edition.author}` : ''}, page ${page}`;
  const subject = `${who} sent you a passage from ${edition.title}`;
  const text = [
    `${who} sent you this from the Grapheon Reader.`,
    '',
    message ? `${message}\n` : null,
    `“${quote}”`,
    '',
    `— ${where}`,
    readUrl ? `Open it: ${readUrl}` : null,
    '',
    'Grapheon Reader · reader.grapheon.ai',
  ].filter((l) => l !== null).join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#1b1a15;color:#f1e3b8;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:560px;margin:0 auto">
<p style="font-size:14px;color:rgba(233,214,160,0.8);margin:0 0 16px">${esc(who)} sent you this from the Grapheon Reader.</p>
${message ? `<p style="font-size:17px;line-height:1.5;margin:0 0 18px">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
<blockquote style="margin:0 0 14px;padding:14px 18px;border-left:3px solid #d9bd7a;font-size:18px;line-height:1.55;font-style:italic">${esc(quote).replace(/\n/g, '<br>')}</blockquote>
<p style="font-size:14px;color:rgba(233,214,160,0.8);margin:0 0 20px">— ${esc(where)}</p>
${readUrl ? `<p style="margin:0 0 28px"><a href="${esc(readUrl)}" style="color:#1b1a15;background:#d9bd7a;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:15px">Open it in the Reader</a></p>` : ''}
<p style="font-size:12px;color:rgba(233,214,160,0.55);margin:0">Grapheon Reader · reader.grapheon.ai</p>
</div></body></html>`;
  return { subject, text, html };
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const body = (await readJsonBody(req)) ?? {};
  const editionId = String(body.edition_id ?? '');
  const page = Number(body.page);
  const quote = String(body.quote ?? '').trim();
  const to = String(body.to ?? '').trim();
  const message = String(body.message ?? '').trim();
  if (!UUID_RE.test(editionId)) return json(res, 400, { error: 'bad_request', detail: 'edition_id' });
  if (!Number.isInteger(page) || page < 1) return json(res, 400, { error: 'bad_request', detail: 'page' });
  if (!quote) return json(res, 400, { error: 'bad_request', detail: 'quote' });
  if (quote.length > MAX_QUOTE) return json(res, 400, { error: 'bad_request', detail: `quote is longer than ${MAX_QUOTE} characters` });
  if (message.length > MAX_MESSAGE) return json(res, 400, { error: 'bad_request', detail: `message is longer than ${MAX_MESSAGE} characters` });
  if (!EMAIL_RE.test(to) || to.length > 254) return json(res, 400, { error: 'bad_request', detail: 'to must be one email address' });

  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) return json(res, 501, { error: 'email_not_configured' });

  // The edition, as the service role: a published edition's title and author are not secret, but the row is read once, here.
  let edition = null;
  try {
    const r = await doFetch(`${base()}/rest/v1/editions?id=eq.${editionId}&select=id,title,author,status&limit=1`, {
      headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rows = r.ok ? await r.json().catch(() => null) : null;
    edition = Array.isArray(rows) ? rows[0] ?? null : null;
  } catch {
    edition = null;
  }
  if (!edition) return json(res, 404, { error: 'not_found' });

  const readUrl = `https://reader.grapheon.ai/read/${edition.id}?page=${page}`;
  const mail = composeMail({ edition, page, quote, message, senderEmail: user.email || null, readUrl });

  let sendRes;
  try {
    sendRes = await doFetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM_READER || DEFAULT_FROM,
        to: [to],
        reply_to: user.email || undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return json(res, 502, { error: 'send_failed', detail: err?.message || 'unreachable' });
  }
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    console.error(`[edition-share] resend ${sendRes.status}: ${detail.slice(0, 300)}`);
    return json(res, 502, { error: 'send_failed', detail: `resend ${sendRes.status}` });
  }
  return json(res, 200, { ok: true, to });
}
