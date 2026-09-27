// A picture, described — so it can be found (step 2 of the image plan,
// 2026-09-26; Eden's decisions: Opus 5.5 writes it, telegraphic, two lengths).
//
// A stored image used to go through OCR only, which looks for printed words.
// A concept render for a screenplay has none, so the row ended "image only"
// and nothing about it could be searched or asked about. This module asks a
// vision model for three things about the picture, in the fewest words that
// still tell one render from the next:
//
//   LABEL — for the thumbnail tile, five words or so:
//             "Luthiers workshop dusk snow falling"
//   LINE  — for search and the assistant, one telegraphic line:
//             "Luthier's workshop Cremona, dusk, snow falling, violins hanging,
//              fire in hearth"
//   TEXT  — the words actually printed in the picture, verbatim, or none.
//
// and one verdict, KIND: `picture` (art, a photo, a render) or `page` (a
// photographed or screenshotted document). A page's words are still read by
// the tier's OCR route — the protocol in lib/ocr-protocol.mjs stays the one
// authority on verbatim text — and this call only labels it.
//
// Provider-specific by design, like lib/ocr-anthropic.mjs beside it: the
// pipeline sees a hook, (buf, ext, { onProgress }) → description, and the
// caller (the worker, scripts/reingest.mjs) decides whether to wire it. The
// seal decides whether it may run at all (ingest-core: never for a sealed
// matter — Opus is a first-party, non-sealed provider).
//
// The reply is a delimited text protocol, parsed strictly, rather than a
// forced tool call: Claude Opus 5.5 returns 400 for forced tool_choice, and
// a four-line answer needs no schema. A malformed reply is retried once.

import Anthropic from '@anthropic-ai/sdk';

import { estimateAnthropicUsd } from './ocr-anthropic.mjs';

// Eden's choice (2026-09-26). Override with ANTHROPIC_DESCRIBE_MODEL.
export const DEFAULT_DESCRIBE_MODEL = 'claude-opus-5-5';

// The long edge the picture is scaled to before it is sent. Opus reads a
// 1568-px image at full fidelity; anything larger costs tokens for nothing,
// and a 12 MB phone photo would not fit a request at all.
export const DESCRIBE_MAX_EDGE = 1568;

export const DESCRIBE_SYSTEM = [
  'You label pictures stored in a case file so a person can tell them apart at a glance and find them by search.',
  'Answer in exactly this form, four lines, nothing before or after:',
  '',
  'KIND: picture | page',
  'LABEL: <five words or fewer>',
  'LINE: <one line, fifteen words or fewer>',
  'TEXT: <the words printed in the picture, verbatim, or [none]>',
  '',
  'Rules:',
  '- Telegraphic. No sentences, no articles, no "image of", no "this shows". Nouns and a few qualifiers, comma-separated in LINE.',
  '- LABEL names the subject plus the one or two cues that distinguish it from a similar picture (time of day, weather, who is in it, what they hold).',
  '- LINE adds setting, mood, notable objects and people. Say what is visible, never what it might mean.',
  '- KIND is "page" only when the picture is chiefly a document, letter, form, receipt, screenshot or other block of text meant to be read. Art, photographs, renders, scenes, diagrams and charts are "picture".',
  '- LABEL has no commas: subject first, then the cues, space-separated ("Luthiers workshop dusk snow falling").',
  '- TEXT is verbatim: every printed word you can read, in reading order, spelling kept. Signs, captions, labels, handwriting count. Nothing readable → [none]. For a "page", TEXT may be long; give it all.',
  '- Lettering that does not form real words — decorative, synthetic or AI-rendered glyphs, a blurred sign — is not text: answer [none] rather than guessing letters.',
  '- Do not name real people unless their name is printed in the picture. Describe them by role or appearance.',
  '',
  'Example, a render of a violin maker\'s shop:',
  'KIND: picture',
  'LABEL: Luthiers workshop dusk snow falling',
  'LINE: Luthier\'s workshop Cremona, dusk, snow falling past arched window, violins hanging, fire in hearth',
  'TEXT: [none]',
  '',
  'Example, a photographed letter:',
  'KIND: page',
  'LABEL: Typed letter, Smith to Jones, 1987',
  'LINE: Typed business letter on letterhead, dated March 3 1987, signature in blue ink, one page',
  'TEXT: <the letter, verbatim>',
].join('\n');

export const DESCRIBE_USER_TURN = 'Label this picture.';

const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

// Extensions this adapter can send. TIFF, BMP and SVG are transcoded by
// sharp on the way in (see prepareImage), so they are accepted too when
// sharp is present; without it they are skipped, never sent as-is.
export const DESCRIBABLE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp', '.svg'];

/**
 * Parse the model's four-line reply. Throws on anything that is not the
 * protocol, so the caller can retry once and then give up honestly.
 * @param {string} raw
 * @returns {{ kind: 'picture'|'page', label: string, line: string, text: string }}
 */
export function parseDescription(raw) {
  const s = String(raw || '').replace(/\r\n?/g, '\n').trim();
  const kindM = s.match(/^\s*KIND:\s*(picture|page)\s*$/im);
  const labelM = s.match(/^\s*LABEL:\s*(.+?)\s*$/im);
  const lineM = s.match(/^\s*LINE:\s*(.+?)\s*$/im);
  const textIdx = s.search(/^\s*TEXT:/im);
  if (!kindM || !labelM || !lineM || textIdx < 0) {
    throw new Error(`describe: reply is not the KIND/LABEL/LINE/TEXT protocol (${s.slice(0, 80).replace(/\n/g, ' ')}…)`);
  }
  let text = s.slice(textIdx).replace(/^\s*TEXT:\s*/i, '').trim();
  if (/^\[none\]$/i.test(text) || /^none\.?$/i.test(text)) text = '';
  const tidy = (v) => v.replace(/\s+/g, ' ').replace(/^["'“‘]+|["'”’.]+$/g, '').trim();
  return {
    kind: kindM[1].toLowerCase(),
    label: tidy(labelM[1]).slice(0, 80),
    line: tidy(lineM[1]).slice(0, 240),
    text,
  };
}

/**
 * Scale the picture to DESCRIBE_MAX_EDGE on its long side and hand back
 * WebP bytes (small, lossless enough for reading, accepted by the API).
 * sharp is a native module proven on the worker; where it is absent, a
 * PNG/JPEG/GIF/WebP under 4 MB is sent as it is, and anything else is
 * refused with the reason.
 */
export async function prepareImage(buf, ext) {
  const e = String(ext || '').toLowerCase();
  let sharp = null;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    sharp = null;
  }
  if (sharp) {
    const out = await sharp(buf, { animated: false })
      .rotate() // honour EXIF orientation: a phone photo arrives sideways otherwise
      .resize({ width: DESCRIBE_MAX_EDGE, height: DESCRIBE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return { data: out, mediaType: 'image/webp', resized: true };
  }
  const mediaType = MEDIA_TYPES[e];
  if (!mediaType) throw new Error(`describe: ${e || 'this format'} needs sharp to transcode, and sharp is not installed here`);
  if (buf.length > 4 * 1024 * 1024) throw new Error(`describe: ${(buf.length / 1048576).toFixed(1)} MB image needs sharp to downscale, and sharp is not installed here`);
  return { data: buf, mediaType, resized: false };
}

/**
 * Describe one picture.
 * @returns {Promise<{kind:'picture'|'page'|'refused', label:string, line:string, text:string, model:string, usage:object, estimated_usd:number, resized:boolean}>}
 */
export async function describeImageAnthropic(buf, ext, {
  apiKey,
  model = DEFAULT_DESCRIBE_MODEL,
  client = null,
  maxRetries = 3,
  onProgress = () => {},
} = {}) {
  if (!apiKey && !client) throw new Error('describeImageAnthropic: apiKey required');
  const anthropic = client || new Anthropic({ apiKey, maxRetries });
  const prepared = await prepareImage(buf, ext);
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, requests: 0 };

  const ask = async (note) => {
    onProgress({ stage: 'extracting', message: `Describing the picture via ${model}${note ? ` (${note})` : ''}` });
    // Opus 5.5: thinking cannot be turned off, so effort is the dial — low,
    // because this is labelling, not reasoning. Server-side fallbacks: a
    // picture the safety layer declines (evidence photographs happen in this
    // practice) is re-run on Anthropic's recommended fallback inside the same
    // call instead of coming back as a refusal.
    const msg = await anthropic.beta.messages.create({
      model,
      max_tokens: 1500,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: DESCRIBE_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: prepared.mediaType, data: prepared.data.toString('base64') } },
          { type: 'text', text: note ? `${DESCRIBE_USER_TURN} Your previous answer was not in the four-line form; answer in exactly that form.` : DESCRIBE_USER_TURN },
        ],
      }],
    });
    usage.requests += 1;
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) usage[k] += msg.usage?.[k] || 0;
    return msg;
  };

  let msg = await ask('');
  const servedBy = msg.model || model;
  if (msg.stop_reason === 'refusal') {
    return { kind: 'refused', label: '', line: '', text: '', model: servedBy, usage, estimated_usd: estimateAnthropicUsd(model, usage), resized: prepared.resized };
  }
  const textOf = (m) => (m?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  let parsed;
  try {
    parsed = parseDescription(textOf(msg));
  } catch {
    msg = await ask('retry');
    if (msg.stop_reason === 'refusal') {
      return { kind: 'refused', label: '', line: '', text: '', model: servedBy, usage, estimated_usd: estimateAnthropicUsd(model, usage), resized: prepared.resized };
    }
    parsed = parseDescription(textOf(msg)); // throws to the caller on a second malformed reply
  }
  return { ...parsed, model: servedBy, usage, estimated_usd: estimateAnthropicUsd(model, usage), resized: prepared.resized };
}

/**
 * The hook the pipeline takes: null when there is no key where this runs,
 * else (buf, ext, { onProgress }) → description. Reads the env per call so
 * a key set on a running machine takes effect without a restart.
 */
export function makeDescribeHook(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  return (buf, ext, { onProgress } = {}) => describeImageAnthropic(buf, ext, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL,
    onProgress,
  });
}
