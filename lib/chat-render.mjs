// chat-render.mjs — render a captured AI conversation as plain, readable prose.
//
// The Contextspaces reader shows chat documents as text, not rendered
// markdown, so anything the model wrote in markdown (bold, headings, bullets,
// links) and every "**User:**" label used to appear as raw markup. A chat
// should read like a conversation: a title, a source line, then turns that
// open with who is speaking — "You:" and the assistant by name — with the
// model's markdown folded into ordinary paragraphs.
//
// Used by scripts/sync-chats.mjs (the FileSaver → Contextspaces bridge). Pure
// functions; no I/O except the artifact reader the caller passes in.

const ASSISTANT_NAMES = {
  'extension-claude': 'Claude',
  'claude-code': 'Claude',
  'claude-desktop': 'Claude',
  'extension-chatgpt': 'ChatGPT',
  'extension-gemini': 'Gemini',
  'extension-kimi': 'Kimi',
  'extension-grok': 'Grok',
  'extension-perplexity': 'Perplexity',
  'extension-labs-google': 'Google Labs',
  'extension-midjourney': 'Midjourney',
  'extension-elevenlabs': 'ElevenLabs',
  'extension-veed': 'Veed',
};

export function assistantName(source) {
  return ASSISTANT_NAMES[source] || 'Assistant';
}

// Strip embedded base64 blobs (data URIs, bare base64 runs): they carry no
// searchable signal and their token density blows the embeddings limit.
export function scrubBinary(s) {
  return String(s)
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[embedded file]')
    .replace(/[A-Za-z0-9+/=]{2000,}/g, '[binary data]');
}

// Markdown → prose. Conservative on purpose: it only removes markup that is
// unambiguous, and leaves anything that might be meant literally (math,
// snake_case, tables, code inside fences) untouched.
export function markdownToProse(md) {
  if (!md) return '';
  const src = String(md).replace(/\r\n?/g, '\n');
  const out = [];
  let inFence = false;
  for (const raw of src.split('\n')) {
    const line = raw;
    // Fenced code: drop the fence lines, keep the code verbatim.
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }

    let l = line;
    // Horizontal rules carry nothing in prose.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) continue;
    // Headings become a line of their own.
    const h = l.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) l = h[1];
    // Block quotes: drop the marker.
    l = l.replace(/^(\s*)>\s?/, '$1');
    // Bullets: one consistent marker.
    l = l.replace(/^(\s*)[*+]\s+/, '$1- ');
    // Task boxes.
    l = l.replace(/^(\s*-\s+)\[[ xX]\]\s+/, '$1');
    out.push(inline(l));
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(l) {
  return l
    // Images before links (same bracket syntax).
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt ? `[image: ${alt}]` : '[image]')
    // Links: keep the text, keep the address when it adds something.
    .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_, text, url) => (text.trim() === url ? url : `${text} (${url})`))
    // Bold-italic, bold, then italic.
    .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '$1')
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '$1')
    .replace(/__(?!\s)(.+?)(?<!\s)__/g, '$1')
    .replace(/(^|[^\w*\\])\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w\\])_(?!\s|_)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1$2')
    // Inline code and strikethrough.
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '$1')
    // Line breaks and non-breaking spaces from HTML-flavoured output.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    // Markdown escapes.
    .replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, '$1');
}

// One conversation → the document text.
//   conv: { source, title, ts, url, project, messages?[{role,content}] | turns?[{role,text}] | text?, artifacts? }
//   opts.readArtifact(relPath) → file content or '' (caller owns the disk)
export function renderConversation(conv, opts = {}) {
  const readArtifact = opts.readArtifact || (() => '');
  const sourceName = opts.sourceName || assistantName(conv.source);
  const who = assistantName(conv.source);
  const when = (conv.ts || '').slice(0, 10);
  const lines = [
    conv.title || 'Untitled conversation',
    [sourceName, conv.project, when, conv.url].filter(Boolean).join(' · '),
    '',
  ];

  const turn = (role, text) => {
    const body = markdownToProse(scrubBinary(text));
    if (!body) return;
    lines.push(`${role === 'user' ? 'You' : who}: ${body}`, '');
  };

  if (conv.text) {
    lines.push(markdownToProse(scrubBinary(conv.text)), '');
  } else if (Array.isArray(conv.messages)) {
    for (const m of conv.messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      turn(m.role, (content || '').trim());
    }
  } else if (Array.isArray(conv.turns)) {
    for (const t of conv.turns) turn(t.role, t.text);
  }

  renderArtifacts(lines, conv.artifacts, readArtifact);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Deliverables captured alongside the chat: each text file's content in full
// (a file is a file — its markdown stays as written), and the binary outputs
// by name.
function renderArtifacts(lines, art, readArtifact) {
  const files = Array.isArray(art?.artifacts) ? art.artifacts : [];
  const presented = Array.isArray(art?.presented) ? art.presented : [];
  if (!files.length && !presented.length) return;
  lines.push('', 'Files created in this conversation', '');
  for (const a of files) {
    let body = '';
    try { body = readArtifact(String(a.relPath || '')) || ''; } catch { body = ''; }
    lines.push(`${a.name}${a.title && a.title !== a.name ? ` — ${a.title}` : ''}`, '');
    lines.push(body ? scrubBinary(body.slice(0, 200_000)) : '(content not on disk)', '');
  }
  const capturedBases = new Set(files.map((f) => (f.name || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\s-]+/g, '')));
  const seen = new Set();
  for (const p of presented) {
    const key = `${p.name}|${p.mime_type}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const base = (p.name || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[_\s-]+/g, '');
    if (base && capturedBases.has(base)) continue;
    lines.push(`- Output file presented in chat, not yet archived: ${p.name} (${p.mime_type || 'unknown type'})`);
  }
  lines.push('');
}
