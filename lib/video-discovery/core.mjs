// lib/video-discovery/core.mjs — the Video Room's provider-neutral middle.
//
// Everything here is pure: prompt text, window planning for long recordings,
// normalising what a model returned into the shapes schemas.mjs promises, and
// the derived bands the room draws on its timeline. No network, no file
// system, no provider names. The adapters (gemini-video.mjs today) and the
// worker/API call these; the unit tests in tests/video-discovery.test.mjs
// exercise them with no credentials.
//
// What this module never does: decide. It derives "time in a prone position"
// from the model's own interval entries so the room can show a number, and
// labels that number as derived from AI entries. Whether any of it matters is
// the lawyer's call, recorded in video_analysis_reviews.

import {
  EVENT_TYPES, COVERAGE_STATUSES, POSITIONS, BASES, CONFIDENCES, CLAIM_FINDINGS,
} from './schemas.mjs';

// A single analysis pass covers at most this much footage. An hour of video is
// roughly a million tokens at default resolution (263/s of frames + 32/s of
// audio — the worker's own comment, 2026-09-16), so recordings past the
// window are analysed in passes and merged. Twenty minutes is comfortably
// inside every current model's context with room for the answer.
export const ANALYSIS_WINDOW_SEC = 20 * 60;
export const WINDOW_OVERLAP_SEC = 10;

/** [mm:ss], or [h:mm:ss] past the hour — the house timestamp. */
export function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** "mm:ss", "m:ss", "h:mm:ss" or a bare number of seconds → seconds, or null. */
export function parseTime(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return Math.max(0, text);
  const t = String(text ?? '').trim().replace(/^\[|\]$/g, '');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  return parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
}

/** How a long recording is cut into analysis passes. Short recordings: one window. */
export function planWindows(durationSec, { windowSec = ANALYSIS_WINDOW_SEC, overlapSec = WINDOW_OVERLAP_SEC } = {}) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return [{ index: 0, startSec: 0, endSec: null }];
  if (d <= windowSec) return [{ index: 0, startSec: 0, endSec: Math.ceil(d) }];
  const out = [];
  let start = 0;
  let i = 0;
  while (start < d) {
    const end = Math.min(d, start + windowSec);
    out.push({ index: i++, startSec: Math.max(0, Math.floor(start)), endSec: Math.ceil(end) });
    if (end >= d) break;
    start = end - overlapSec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const NEUTRALITY = [
  'You are describing a recording for people who will watch it themselves and reach their own conclusions.',
  'Report only what is visible and audible. Do not characterise conduct as reasonable, excessive, justified, necessary, lawful or unlawful, and do not cite rules, policies, directives or law.',
  'Do not infer intent, names, ranks or roles that are not seen or heard. If something cannot be seen, say that it cannot be seen rather than guessing.',
  'Every statement about the footage carries a time. Times are seconds from the start of the whole recording, not from the start of any excerpt.',
  'Where speech is unclear write [inaudible]. Where the view is blocked, say by what.',
].join('\n');

/**
 * The analysis prompt for one window. `windowStart`/`windowEnd` are absolute
 * seconds; null end means "to the end of the recording".
 */
export function buildAnalysisPrompt({ windowStart = 0, windowEnd = null, durationSec = null, windowIndex = 0, windowCount = 1 } = {}) {
  const span = windowEnd == null
    ? `from ${fmtTime(windowStart)} to the end`
    : `from ${fmtTime(windowStart)} to ${fmtTime(windowEnd)}`;
  const excerpt = windowCount > 1
    ? `This is pass ${windowIndex + 1} of ${windowCount} over a recording ${durationSec ? `about ${fmtTime(durationSec)} long` : 'of unknown length'}. You are shown the excerpt ${span}. Report every time as an absolute position in the whole recording: an event 30 seconds into this excerpt is at ${fmtTime(windowStart + 30)}, not at 00:30.`
    : `You are shown the whole recording${durationSec ? ` (about ${fmtTime(durationSec)})` : ''}.`;
  return [
    NEUTRALITY,
    '',
    excerpt,
    '',
    'Produce the structured account the response schema describes:',
    '- actors: every distinct person, identified only by what is visible or spoken (stencils, badges, clothing, equipment, spoken names).',
    '- events: a chronological account, one entry per distinct action or exchange, each with its basis (visual, audio, both) and your confidence.',
    '- camera_coverage: intervals covering the whole excerpt, saying when the main action was in view, partly in view, or out of view, and what blocked it.',
    '- subject_position: if one person is the focus (being moved, held, examined), their body position over time and whether restraints are visible.',
    '- transcript: everything spoken, verbatim, with the speaker where clear.',
    'Be complete rather than brief. A ten-minute excerpt with people acting in it should yield dozens of events and a transcript, not a summary.',
  ].join('\n');
}

/**
 * The interrogation prompt: a question about a window, with the claims the
 * asker put beside it and a compact digest of what an earlier analysis said
 * about the same window (so the answer is grounded in the footage AND consistent
 * with the account the room already shows).
 */
export function buildInterrogationPrompt({ question, startSec = null, endSec = null, claims = [], digest = '' } = {}) {
  const window = startSec != null && endSec != null
    ? `The question is about the excerpt from ${fmtTime(startSec)} to ${fmtTime(endSec)}. You are shown that excerpt. Times you report are absolute positions in the whole recording.`
    : 'The question is about the whole recording.';
  const claimLines = claims.length
    ? ['', 'Claims to assess against the footage, in order (answer each in claim_assessments, in the same order, quoting the claim as given):',
      ...claims.map((c, i) => `${i + 1}. ${c}`)]
    : ['', 'No claims were supplied; leave claim_assessments empty.'];
  const digestLines = digest
    ? ['', 'An earlier structured pass over this recording recorded the following for the same window. Use it to orient; the footage itself governs where they differ, and say so if they do.', digest]
    : [];
  return [
    NEUTRALITY,
    '',
    window,
    '',
    `Question: ${String(question).trim()}`,
    ...claimLines,
    ...digestLines,
    '',
    'Answer in the response schema. In answer_markdown, put a [mm:ss] time on every statement about the footage. For each claim, CORROBORATES means the footage in this window shows the claim to be so; REFUTES means it shows the claim not to be so; CANNOT_DETERMINE_FROM_FOOTAGE means the footage cannot settle it (out of view, inaudible, outside the window) — and say what cannot be seen. State the limits of the answer in limitations.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const strOr = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/**
 * Bring a raw model answer to the EVENT_GRAPH_SCHEMA shape: numbers are
 * numbers, enums are enums, lists are sorted by time, out-of-range entries are
 * clamped to the window. `shiftSec` moves every time (for a pass that reported
 * excerpt-relative times despite instructions — detected by the caller).
 */
export function normalizeEventGraph(raw, { durationSec = null, shiftSec = 0, clampStart = null, clampEnd = null } = {}) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const shift = Number(shiftSec) || 0;
  const lo = clampStart == null ? 0 : Math.max(0, clampStart);
  const hi = clampEnd == null ? (durationSec == null ? Infinity : durationSec) : clampEnd;
  const t = (v) => {
    const n = numOrNull(v);
    if (n == null) return null;
    return Math.min(hi, Math.max(lo, n + shift));
  };

  const video = g.video && typeof g.video === 'object' ? g.video : {};
  const actors = (Array.isArray(g.actors) ? g.actors : [])
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({
      id: strOr(a.id, `A${i + 1}`).trim() || `A${i + 1}`,
      label: strOr(a.label).trim(),
      identifying_marks: strOr(a.identifying_marks).trim(),
      role_observed: strOr(a.role_observed).trim(),
      first_seen_sec: t(a.first_seen_sec) ?? lo,
    }))
    .filter((a) => a.label);
  const actorIds = new Set(actors.map((a) => a.id));

  const events = (Array.isArray(g.events) ? g.events : [])
    .filter((e) => e && typeof e === 'object' && numOrNull(e.start_sec) != null)
    .map((e) => {
      const start = t(e.start_sec);
      const end = t(e.end_sec);
      return {
        start_sec: start,
        end_sec: end != null && end >= start ? end : null,
        type: pick(e.type, EVENT_TYPES, 'OTHER'),
        actor_ids: strList(e.actor_ids).filter((id) => actorIds.has(id)),
        description: strOr(e.description).trim(),
        basis: pick(e.basis, BASES, 'visual'),
        confidence: pick(e.confidence, CONFIDENCES, 'medium'),
        verbatim_quote: typeof e.verbatim_quote === 'string' && e.verbatim_quote.trim() ? e.verbatim_quote.trim() : null,
      };
    })
    .filter((e) => e.description)
    .sort((a, b) => a.start_sec - b.start_sec);

  const intervals = (list, build) => (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === 'object' && numOrNull(x.start_sec) != null && numOrNull(x.end_sec) != null)
    .map((x) => ({ start_sec: t(x.start_sec), end_sec: t(x.end_sec), ...build(x) }))
    .filter((x) => x.end_sec > x.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec);

  const camera_coverage = intervals(g.camera_coverage, (c) => ({
    status: pick(c.status, COVERAGE_STATUSES, 'PARTIAL'),
    obstructed_by: strList(c.obstructed_by),
    what_is_not_visible: strOr(c.what_is_not_visible).trim(),
  }));
  const subject_position = intervals(g.subject_position, (p) => ({
    position: pick(p.position, POSITIONS, 'UNKNOWN'),
    restrained: p.restrained === true,
    basis: pick(p.basis, BASES, 'visual'),
    confidence: pick(p.confidence, CONFIDENCES, 'medium'),
  }));
  const transcript = (Array.isArray(g.transcript) ? g.transcript : [])
    .filter((x) => x && typeof x === 'object' && numOrNull(x.start_sec) != null && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ start_sec: t(x.start_sec), speaker: strOr(x.speaker, 'unseen voice').trim() || 'unseen voice', text: x.text.trim() }))
    .sort((a, b) => a.start_sec - b.start_sec);

  return {
    video: {
      duration_sec: numOrNull(video.duration_sec) ?? (durationSec ?? null),
      has_audio: video.has_audio !== false,
      camera_description: strOr(video.camera_description).trim(),
    },
    actors, events, camera_coverage, subject_position, transcript,
  };
}

/**
 * Did a windowed pass report excerpt-relative times? True when the window
 * starts past zero and nothing the model reported reaches past the excerpt's
 * own length (with a little slack). Callers then normalise with shiftSec.
 */
export function looksExcerptRelative(raw, { windowStart, windowEnd }) {
  if (!(windowStart > 0) || windowEnd == null) return false;
  const len = windowEnd - windowStart;
  const times = [];
  const push = (v) => { const n = numOrNull(v); if (n != null) times.push(n); };
  for (const e of (raw?.events ?? [])) { push(e?.start_sec); push(e?.end_sec); }
  for (const c of (raw?.camera_coverage ?? [])) { push(c?.start_sec); push(c?.end_sec); }
  for (const p of (raw?.subject_position ?? [])) { push(p?.start_sec); push(p?.end_sec); }
  for (const x of (raw?.transcript ?? [])) push(x?.start_sec);
  if (times.length < 3) return false;
  const max = Math.max(...times);
  const min = Math.min(...times);
  // Absolute times for this window would mostly sit at or past windowStart.
  return max <= len + 15 && min < windowStart - 15;
}

/** Combine the passes over one recording into one graph. Actors are merged by what identifies them. */
export function mergeWindowGraphs(passes, { durationSec = null } = {}) {
  const sorted = [...passes].sort((a, b) => (a.windowStart ?? 0) - (b.windowStart ?? 0));
  const actors = [];
  const keyOf = (a) => `${a.label}|${a.identifying_marks}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const events = []; const coverage = []; const positions = []; const transcript = [];
  let camera_description = '';
  let has_audio = false;
  for (const pass of sorted) {
    const g = pass.graph;
    if (!g) continue;
    const idMap = new Map();
    for (const a of g.actors) {
      const k = keyOf(a);
      let found = actors.find((x) => keyOf(x) === k);
      if (!found) {
        found = { ...a, id: `A${actors.length + 1}` };
        actors.push(found);
      } else if (a.first_seen_sec < found.first_seen_sec) {
        found.first_seen_sec = a.first_seen_sec;
      }
      idMap.set(a.id, found.id);
    }
    const remap = (ids) => [...new Set(ids.map((id) => idMap.get(id)).filter(Boolean))];
    // Overlap between passes: keep the earlier pass's entries for the shared seconds.
    const from = pass.index > 0 ? (pass.windowStart ?? 0) + WINDOW_OVERLAP_SEC : -Infinity;
    for (const e of g.events) if (e.start_sec >= from) events.push({ ...e, actor_ids: remap(e.actor_ids) });
    for (const c of g.camera_coverage) if (c.end_sec > from) coverage.push({ ...c, start_sec: Math.max(c.start_sec, from === -Infinity ? 0 : from) });
    for (const p of g.subject_position) if (p.end_sec > from) positions.push({ ...p, start_sec: Math.max(p.start_sec, from === -Infinity ? 0 : from) });
    for (const x of g.transcript) if (x.start_sec >= from) transcript.push({ ...x, speaker: idMap.get(x.speaker) ?? x.speaker });
    if (!camera_description && g.video?.camera_description) camera_description = g.video.camera_description;
    has_audio = has_audio || g.video?.has_audio === true;
  }
  const bySec = (a, b) => a.start_sec - b.start_sec;
  return {
    video: { duration_sec: durationSec ?? null, has_audio, camera_description },
    actors,
    events: events.sort(bySec),
    camera_coverage: mergeAdjacent(coverage.sort(bySec), (a, b) => a.status === b.status),
    subject_position: mergeAdjacent(positions.sort(bySec), (a, b) => a.position === b.position && a.restrained === b.restrained),
    transcript: transcript.sort(bySec),
  };
}

function mergeAdjacent(list, same) {
  const out = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (last && same(last, x) && x.start_sec <= last.end_sec + 1) {
      last.end_sec = Math.max(last.end_sec, x.end_sec);
      if (x.obstructed_by) last.obstructed_by = [...new Set([...(last.obstructed_by ?? []), ...x.obstructed_by])];
    } else {
      out.push({ ...x });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived measures the room shows (and labels as derived from AI entries)
// ---------------------------------------------------------------------------
export function deriveMeasures(graph) {
  const g = graph ?? {};
  const totals = {};
  let restrainedSec = 0;
  for (const p of g.subject_position ?? []) {
    const d = Math.max(0, p.end_sec - p.start_sec);
    totals[p.position] = (totals[p.position] ?? 0) + d;
    if (p.restrained) restrainedSec += d;
  }
  let occludedSec = 0; let partialSec = 0; let clearSec = 0;
  for (const c of g.camera_coverage ?? []) {
    const d = Math.max(0, c.end_sec - c.start_sec);
    if (c.status === 'OCCLUDED') occludedSec += d;
    else if (c.status === 'PARTIAL') partialSec += d;
    else clearSec += d;
  }
  const longestPosition = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] ?? null;
  return {
    position_totals_sec: totals,
    restrained_total_sec: restrainedSec,
    coverage_sec: { CLEAR: clearSec, PARTIAL: partialSec, OCCLUDED: occludedSec },
    longest_position: longestPosition ? { position: longestPosition[0], total_sec: longestPosition[1] } : null,
    event_count: (g.events ?? []).length,
    actor_count: (g.actors ?? []).length,
    low_confidence_events: (g.events ?? []).filter((e) => e.confidence === 'low').length,
  };
}

/** A compact text digest of what the graph says inside [startSec, endSec], for the interrogation prompt. */
export function digestForWindow(graph, startSec = null, endSec = null, { maxEvents = 40, maxChars = 6000 } = {}) {
  const g = graph ?? {};
  const inWin = (s, e = s) => (startSec == null || e == null || e >= startSec) && (endSec == null || s <= endSec);
  const lines = [];
  const actors = g.actors ?? [];
  if (actors.length) lines.push('Actors: ' + actors.map((a) => `${a.id}=${a.label}${a.identifying_marks ? ` (${a.identifying_marks})` : ''}`).join('; '));
  const cov = (g.camera_coverage ?? []).filter((c) => inWin(c.start_sec, c.end_sec));
  if (cov.length) lines.push('Camera: ' + cov.map((c) => `[${fmtTime(c.start_sec)}-${fmtTime(c.end_sec)}] ${c.status}${c.obstructed_by?.length ? ` by ${c.obstructed_by.join(', ')}` : ''}`).join('; '));
  const pos = (g.subject_position ?? []).filter((p) => inWin(p.start_sec, p.end_sec));
  if (pos.length) lines.push('Subject position: ' + pos.map((p) => `[${fmtTime(p.start_sec)}-${fmtTime(p.end_sec)}] ${p.position}${p.restrained ? ', restrained' : ''}`).join('; '));
  const evs = (g.events ?? []).filter((e) => inWin(e.start_sec, e.end_sec ?? e.start_sec)).slice(0, maxEvents);
  for (const e of evs) lines.push(`[${fmtTime(e.start_sec)}] ${e.type}${e.actor_ids?.length ? ` (${e.actor_ids.join(',')})` : ''}: ${e.description}${e.verbatim_quote ? ` "${e.verbatim_quote}"` : ''}`);
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

/** Bring a raw interrogation answer to INTERROGATION_SCHEMA shape. */
export function normalizeInterrogation(raw, { claims = [] } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const los = r.line_of_sight && typeof r.line_of_sight === 'object' ? r.line_of_sight : {};
  const given = Array.isArray(r.claim_assessments) ? r.claim_assessments : [];
  const claim_assessments = claims.map((claim, i) => {
    const a = given[i] && typeof given[i] === 'object' ? given[i] : {};
    return {
      claim_text: claim,
      finding: pick(a.finding, CLAIM_FINDINGS, 'CANNOT_DETERMINE_FROM_FOOTAGE'),
      basis: strOr(a.basis).trim(),
    };
  });
  return {
    answer_markdown: strOr(r.answer_markdown).trim(),
    cited_intervals: (Array.isArray(r.cited_intervals) ? r.cited_intervals : [])
      .filter((c) => c && numOrNull(c.start_sec) != null)
      .map((c) => {
        const s = numOrNull(c.start_sec);
        const e = numOrNull(c.end_sec);
        return { start_sec: Math.max(0, s), end_sec: e != null && e >= s ? e : s, what_is_seen: strOr(c.what_is_seen).trim() };
      })
      .sort((a, b) => a.start_sec - b.start_sec),
    line_of_sight: {
      status: pick(los.status, COVERAGE_STATUSES, 'PARTIAL'),
      basis: strOr(los.basis).trim(),
      what_cannot_be_seen: strOr(los.what_cannot_be_seen).trim(),
    },
    claim_assessments,
    limitations: strList(r.limitations),
  };
}

/** Pull every [mm:ss] / [h:mm:ss] out of a markdown answer, deduplicated and in order. */
export function timestampsIn(markdown) {
  const seen = new Set();
  const out = [];
  for (const m of String(markdown ?? '').matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)) {
    const sec = parseTime(m[1]);
    if (sec == null || seen.has(sec)) continue;
    seen.add(sec);
    out.push({ sec, display: m[1] });
  }
  return out.sort((a, b) => a.sec - b.sec);
}
