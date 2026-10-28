// The Video Room's provider-neutral core, exercised with no credentials.
//   node --test tests/video-discovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fmtTime, parseTime, planWindows, buildAnalysisPrompt, buildInterrogationPrompt,
  normalizeEventGraph, looksExcerptRelative, mergeWindowGraphs, deriveMeasures, digestForWindow,
  normalizeInterrogation, timestampsIn, ANALYSIS_WINDOW_SEC, WINDOW_OVERLAP_SEC, windowSecFromEnv, mmssReading,
} from '../lib/video-discovery/core.mjs';
import { EVENT_GRAPH_SCHEMA, INTERROGATION_SCHEMA, EVENT_TYPES } from '../lib/video-discovery/schemas.mjs';
import {
  modelsFromEnv, displayNameFor, expiryOf, mimeForExt, durationOf, modalitiesSeen, uploadVideoFromPath,
} from '../lib/video-discovery/gemini-video.mjs';
import { isVideoFilename, mediaExportPayload, WORKER_ACTOR } from '../lib/video-discovery/jobs.mjs';
import { estimateVideoCents, centsForTokens, VIDEO_TOKENS_PER_SECOND } from '../lib/usage-prices.mjs';

test('fmtTime / parseTime round-trip', () => {
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(65), '01:05');
  assert.equal(fmtTime(3661), '1:01:01');
  assert.equal(parseTime('01:05'), 65);
  assert.equal(parseTime('[02:40]'), 160);
  assert.equal(parseTime('1:01:01'), 3661);
  assert.equal(parseTime('95'), 95);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1:2:3:4'), null);
});

test('planWindows: one window for short recordings, overlapping passes for long ones', () => {
  assert.deepEqual(planWindows(230), [{ index: 0, startSec: 0, endSec: 230 }]);
  assert.deepEqual(planWindows(null), [{ index: 0, startSec: 0, endSec: null }]);
  const w = planWindows(3 * ANALYSIS_WINDOW_SEC - 100);
  assert.equal(w.length, 3);
  assert.equal(w[0].startSec, 0);
  assert.equal(w[1].startSec, ANALYSIS_WINDOW_SEC - WINDOW_OVERLAP_SEC);
  assert.equal(w[2].endSec, 3 * ANALYSIS_WINDOW_SEC - 100);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].startSec < w[i - 1].endSec, 'passes overlap');
});

test('the pass is thirty minutes unless GEMINI_VIDEO_WINDOW_SEC says otherwise (60-3600)', () => {
  assert.equal(ANALYSIS_WINDOW_SEC, 1800, 'the default this suite runs with');
  assert.equal(windowSecFromEnv({}), 1800);
  assert.equal(windowSecFromEnv({ GEMINI_VIDEO_WINDOW_SEC: '600' }), 600);
  assert.equal(windowSecFromEnv({ GEMINI_VIDEO_WINDOW_SEC: '3600' }), 3600, 'an hour is the ceiling');
  for (const bad of ['30', '5000', 'abc', '']) assert.equal(windowSecFromEnv({ GEMINI_VIDEO_WINDOW_SEC: bad }), 1800, `"${bad}" falls back`);
  // A 25-minute recording (the length in hand) is ONE pass: no seam, whole-recording questions allowed.
  assert.deepEqual(planWindows(25 * 60), [{ index: 0, startSec: 0, endSec: 1500 }]);
  // A 50-minute recording: two passes, none longer than the window, the seam overlapping by 10 s, the end reached.
  const w = planWindows(50 * 60);
  assert.equal(w.length, 2);
  for (const x of w) assert.ok(x.endSec - x.startSec <= 1800, `pass ${x.index} is at most thirty minutes`);
  assert.equal(w[1].startSec, w[0].endSec - WINDOW_OVERLAP_SEC);
  assert.equal(w[0].startSec, 0);
  assert.equal(w[1].endSec, 3000);
});

test('prompts carry no legal vocabulary and state absolute time', () => {
  const p = buildAnalysisPrompt({ windowStart: 1190, windowEnd: 2390, durationSec: 3000, windowIndex: 1, windowCount: 3 });
  assert.match(p, /pass 2 of 3/);
  assert.match(p, /absolute position/);
  assert.match(p, /not at 00:30/);
  assert.match(p, /1:45 is 105/);
  assert.match(p, /11:33 is 693 \(11 × 60 \+ 33\), never 1133/);
  assert.match(buildAnalysisPrompt({ durationSec: 90 }), /never 1133/, 'a one-pass recording gets the examples too');
  for (const banned of ['excessive', 'violation', 'directive', 'unlawful', 'sworn']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`, 'i').test(p.replace(/Do not characterise conduct as[^.]*\./, '')), `prompt should not use "${banned}" except in the prohibition`);
  }
  const q = buildInterrogationPrompt({ question: 'What is visible?', startSec: 60, endSec: 90, claims: ['Nobody moved.'], digest: 'Actors: A1=person' });
  assert.match(q, /01:00 to 01:30/);
  assert.match(q, /1\. Nobody moved\./);
  assert.match(q, /Actors: A1=person/);
  const q2 = buildInterrogationPrompt({ question: 'x' });
  assert.match(q2, /whole recording/);
  assert.match(q2, /leave claim_assessments empty/);
});

test('normalizeEventGraph: sorts, enforces enums, drops junk, and flags (never clamps) times it cannot place', () => {
  const raw = {
    video: { duration_sec: '120', has_audio: true, camera_description: 'handheld' },
    actors: [{ id: 'A1', label: 'person in white coat', identifying_marks: '', role_observed: '', first_seen_sec: 5 }, { label: '' }],
    events: [
      { start_sec: 50, end_sec: 40, type: 'NOT_A_TYPE', actor_ids: ['A1', 'ghost'], description: 'later', basis: 'telepathy', confidence: 'sure' },
      { start_sec: '10', type: 'VERBAL', actor_ids: [], description: 'first', basis: 'audio', confidence: 'high', verbatim_quote: 'hello' },
      { start_sec: 999, type: 'OTHER', actor_ids: [], description: 'past the end' },
      { type: 'OTHER', description: 'no time' },
      { start_sec: 3, type: 'OTHER', description: '   ' },
    ],
    camera_coverage: [{ start_sec: 0, end_sec: 60, status: 'CLEAR', obstructed_by: 'x' }, { start_sec: 60, end_sec: 50, status: 'OCCLUDED' }],
    subject_position: [{ start_sec: 20, end_sec: 80, position: 'PRONE', restrained: 'yes', basis: 'visual', confidence: 'low' }],
    transcript: [{ start_sec: 10, speaker: 'A1', text: 'hello' }, { start_sec: 11, text: '' }],
  };
  const g = normalizeEventGraph(raw, { durationSec: 120 });
  assert.equal(g.video.duration_sec, 120);
  assert.equal(g.actors.length, 1);
  assert.deepEqual(g.events.map((e) => e.description), ['first', 'later', 'past the end']);
  assert.equal(g.events[0].time_flag, undefined, 'a placeable entry carries no flag');
  assert.equal(g.events[1].type, 'OTHER');
  assert.equal(g.events[1].end_sec, 40, 'a backwards interval keeps the end the model gave');
  assert.equal(g.events[1].time_flag, 'suspect');
  assert.match(g.events[1].time_flag_reason, /ends \(40\) before it starts \(50\)/);
  assert.deepEqual(g.events[1].actor_ids, ['A1'], 'unknown actor handles are dropped');
  assert.equal(g.events[1].basis, 'visual');
  assert.equal(g.events[1].confidence, 'medium');
  assert.equal(g.events[2].start_sec, 999, 'past the end: kept as reported, not clamped');
  assert.equal(g.events[2].time_flag, 'suspect');
  assert.match(g.events[2].time_flag_reason, /999 s is outside this pass \(00:00–02:00\)/);
  assert.equal(g.camera_coverage.length, 2, 'the backwards coverage interval is kept');
  assert.deepEqual(g.camera_coverage[0].obstructed_by, []);
  assert.equal(g.camera_coverage[1].time_flag, 'suspect');
  assert.equal(g.subject_position[0].restrained, false, 'only a real true counts');
  assert.equal(g.transcript.length, 1);
});

test('normalizeEventGraph: MMSS run together is flagged with its reading; rounding at the edge is not', () => {
  assert.equal(mmssReading(1133), 693);
  assert.equal(mmssReading(105), 65);
  assert.equal(mmssReading(170), null, '70 is not a seconds field');
  assert.equal(mmssReading(12.5), null);
  // Pass 3 of a recording: 580-880 s. 1133 lies past the pass; read as 11:33 = 693 s it lands inside.
  const g = normalizeEventGraph({
    events: [
      { start_sec: 1133, end_sec: 1140, type: 'VERBAL', description: 'mmss' },
      { start_sec: 600, end_sec: 881.5, type: 'OTHER', description: 'rounding past the end' },
      { start_sec: 2000, type: 'OTHER', description: 'outside, no MMSS reading inside' },
      { start_sec: 700, type: 'OTHER', description: 'model says flagged', time_flag: 'suspect', time_flag_reason: 'trust me' },
    ],
    camera_coverage: [{ start_sec: 578.5, end_sec: 700, status: 'CLEAR' }],
    subject_position: [{ start_sec: 610, end_sec: 1205, position: 'PRONE' }],
    transcript: [{ start_sec: 1133, speaker: 'A1', text: 'mmss line' }],
  }, { clampStart: 580, clampEnd: 880 });
  const byDesc = Object.fromEntries(g.events.map((e) => [e.description, e]));
  assert.equal(byDesc.mmss.start_sec, 1133, 'kept as reported');
  assert.match(byDesc.mmss.time_flag_reason, /1133 reads as 11:33 written without the colon \(693 s\)/);
  assert.equal(byDesc['rounding past the end'].end_sec, 880, 'within the 2-s slack: placed at the edge, not flagged');
  assert.equal(byDesc['rounding past the end'].time_flag, undefined);
  assert.equal(byDesc['outside, no MMSS reading inside'].time_flag, 'suspect');
  assert.doesNotMatch(byDesc['outside, no MMSS reading inside'].time_flag_reason, /reads as/);
  assert.equal(byDesc['model says flagged'].time_flag, undefined, 'a flag the model volunteers is ignored');
  assert.equal(g.camera_coverage[0].start_sec, 580);
  assert.equal(g.camera_coverage[0].time_flag, undefined);
  assert.equal(g.subject_position[0].end_sec, 1205);
  assert.match(g.subject_position[0].time_flag_reason, /1205 reads as 12:05/);
  assert.equal(g.transcript[0].time_flag, 'suspect');
});

test('looksExcerptRelative detects a pass that ignored the absolute-time instruction', () => {
  const rel = { events: [{ start_sec: 5, description: 'a' }, { start_sec: 100, description: 'b' }, { start_sec: 700, description: 'c' }], transcript: [{ start_sec: 9, text: 'hi' }] };
  assert.equal(looksExcerptRelative(rel, { windowStart: 1190, windowEnd: 2390 }), true);
  const abs = { events: [{ start_sec: 1200 }, { start_sec: 1500 }, { start_sec: 2300 }], transcript: [] };
  assert.equal(looksExcerptRelative(abs, { windowStart: 1190, windowEnd: 2390 }), false);
  assert.equal(looksExcerptRelative(rel, { windowStart: 0, windowEnd: 1200 }), false, 'the first window is never shifted');
  const shifted = normalizeEventGraph(rel, { shiftSec: 1190, clampStart: 1190, clampEnd: 2390 });
  assert.equal(shifted.events[0].start_sec, 1195);
});

test('mergeWindowGraphs merges actors by identity, drops the overlap, merges adjacent bands', () => {
  const mk = (windowStart, windowEnd, index, extra = {}) => ({
    index, windowStart, windowEnd,
    graph: normalizeEventGraph({
      video: { duration_sec: 2400, has_audio: true, camera_description: 'fixed' },
      actors: [{ id: 'A1', label: 'officer with shield', identifying_marks: 'vest 005', role_observed: '', first_seen_sec: windowStart + 1 }],
      events: [{ start_sec: windowStart + 2, type: 'ENTRY', actor_ids: ['A1'], description: `enter ${index}`, basis: 'visual', confidence: 'high' },
        { start_sec: windowStart + 30, type: 'OTHER', actor_ids: [], description: `later ${index}`, basis: 'visual', confidence: 'high' }],
      camera_coverage: [{ start_sec: windowStart, end_sec: windowEnd, status: 'CLEAR', obstructed_by: [], what_is_not_visible: '' }],
      subject_position: [{ start_sec: windowStart, end_sec: windowEnd, position: 'PRONE', restrained: true, basis: 'visual', confidence: 'high' }],
      transcript: [],
      ...extra,
    }),
  });
  const merged = mergeWindowGraphs([mk(0, 1200, 0), mk(1190, 2400, 1)], { durationSec: 2400 });
  assert.equal(merged.actors.length, 1, 'same person across passes is one actor');
  assert.equal(merged.actors[0].id, 'A1');
  // The second pass's "enter" at 1192 falls inside the 10 s overlap and is dropped; its "later" at 1220 stays.
  assert.deepEqual(merged.events.map((e) => e.description), ['enter 0', 'later 0', 'later 1']);
  assert.equal(merged.camera_coverage.length, 1, 'adjacent CLEAR bands merge');
  assert.equal(merged.camera_coverage[0].end_sec, 2400);
  assert.equal(merged.subject_position.length, 1);
  assert.equal(merged.video.duration_sec, 2400);
});

test('mergeWindowGraphs across many seams: a 25-minute recording in six 5-minute passes, the same moment reported on both sides of every seam', () => {
  const windows = planWindows(1500, { windowSec: 300 }); // pinned: the merge is exercised across five seams whatever the default window is
  assert.equal(windows.length, 6);
  const passes = windows.map((w) => {
    const seamIn = w.startSec + WINDOW_OVERLAP_SEC + 2; // past the earlier pass's end, so only the seam check can drop it
    const seamOut = w.endSec - 1;    // the same moment, seen from the earlier side of the seam
    const events = [
      { start_sec: w.startSec + 60, type: 'OTHER', description: `middle ${w.index}` },
      ...(w.index > 0 ? [{ start_sec: seamIn, type: 'VERBAL', description: `seam ${w.index} late view`, verbatim_quote: `Line ${w.index}!` }] : []),
      ...(w.index < windows.length - 1 ? [{ start_sec: seamOut, type: 'VERBAL', description: `seam ${w.index + 1} early view`, verbatim_quote: `line ${w.index + 1}` }] : []),
      // Same type at the seam but different words: a second exchange, not a duplicate.
      ...(w.index > 0 ? [{ start_sec: seamIn + 1, type: 'VERBAL', description: `reply ${w.index}`, verbatim_quote: `reply ${w.index}` }] : []),
    ];
    const transcript = [
      ...(w.index > 0 ? [{ start_sec: seamIn, speaker: 'A1', text: `Line ${w.index}!` }] : []),
      ...(w.index < windows.length - 1 ? [{ start_sec: seamOut, speaker: 'A1', text: `line ${w.index + 1}` }] : []),
    ];
    if (w.index === 2) events.push({ start_sec: 1205, type: 'OTHER', description: 'flagged MMSS' }); // 12:05 run together, pass 580-880
    return {
      index: w.index, windowStart: w.startSec, windowEnd: w.endSec,
      graph: normalizeEventGraph({
        video: { has_audio: true },
        actors: [{ id: 'A1', label: 'speaker', identifying_marks: 'red jacket', first_seen_sec: w.startSec }],
        events, transcript,
        camera_coverage: [{ start_sec: w.startSec, end_sec: w.endSec, status: w.index === 2 ? 'OCCLUDED' : 'CLEAR' }],
        subject_position: [],
      }, { clampStart: w.startSec, clampEnd: w.endSec, durationSec: 1500 }),
    };
  });
  const merged = mergeWindowGraphs(passes, { durationSec: 1500 });
  const seamEvents = merged.events.filter((e) => /^seam/.test(e.description));
  assert.equal(seamEvents.length, 5, 'one entry per seam, not two');
  assert.ok(seamEvents.every((e) => /early view/.test(e.description)), 'the earlier pass owns the seam');
  assert.equal(merged.events.filter((e) => /^reply/.test(e.description)).length, 5, 'a different exchange at the seam is kept');
  assert.equal(merged.events.filter((e) => /^middle/.test(e.description)).length, 6);
  assert.equal(merged.transcript.length, 5, 'one transcript line per seam');
  assert.equal(merged.actors.length, 1);
  const flagged = merged.events.find((e) => e.description === 'flagged MMSS');
  assert.ok(flagged && flagged.time_flag === 'suspect', 'a flagged entry survives the merge wherever it says it is');
  // Coverage: contiguous, CLEAR / OCCLUDED / CLEAR, ending at the end.
  assert.deepEqual(merged.camera_coverage.map((c) => c.status), ['CLEAR', 'OCCLUDED', 'CLEAR']);
  assert.equal(merged.camera_coverage[0].start_sec, 0);
  assert.equal(merged.camera_coverage.at(-1).end_sec, 1500);
  for (let i = 1; i < merged.camera_coverage.length; i++) assert.equal(merged.camera_coverage[i].start_sec, merged.camera_coverage[i - 1].end_sec, 'no gap, no overlap at a seam');
  for (let i = 1; i < merged.events.length; i++) assert.ok(merged.events[i].start_sec >= merged.events[i - 1].start_sec, 'sorted');
});

test('deriveMeasures adds up the model\'s intervals', () => {
  const g = normalizeEventGraph({
    video: {}, actors: [],
    events: [{ start_sec: 1, type: 'OTHER', description: 'a', confidence: 'low' }],
    camera_coverage: [{ start_sec: 0, end_sec: 100, status: 'CLEAR' }, { start_sec: 100, end_sec: 140, status: 'OCCLUDED' }],
    subject_position: [{ start_sec: 160, end_sec: 230, position: 'PRONE', restrained: true }, { start_sec: 230, end_sec: 260, position: 'SEATED' }],
    transcript: [],
  });
  const m = deriveMeasures(g);
  assert.equal(m.coverage_sec.OCCLUDED, 40);
  assert.equal(m.position_totals_sec.PRONE, 70);
  assert.equal(m.restrained_total_sec, 70);
  assert.deepEqual(m.longest_position, { position: 'PRONE', total_sec: 70 });
  assert.equal(m.low_confidence_events, 1);
  assert.equal(m.time_flagged, 0);
});

test('deriveMeasures and the digest leave flagged entries out, and say how many there were', () => {
  const g = normalizeEventGraph({
    events: [{ start_sec: 10, type: 'OTHER', description: 'placed' }, { start_sec: 1133, type: 'OTHER', description: 'flagged' }],
    camera_coverage: [{ start_sec: 0, end_sec: 100, status: 'CLEAR' }, { start_sec: 90, end_sec: 50, status: 'OCCLUDED' }],
    subject_position: [{ start_sec: 20, end_sec: 60, position: 'PRONE' }, { start_sec: 100, end_sec: 1205, position: 'PRONE' }],
    transcript: [{ start_sec: 5, text: 'ok' }, { start_sec: 2000, text: 'flagged line' }],
  }, { durationSec: 300 });
  const m = deriveMeasures(g);
  assert.equal(m.time_flagged, 4, 'one event, one coverage, one position, one transcript line');
  assert.equal(m.coverage_sec.OCCLUDED, 0, 'the backwards OCCLUDED interval is not added');
  assert.equal(m.coverage_sec.CLEAR, 100);
  assert.equal(m.position_totals_sec.PRONE, 40, 'the 1,105-s flagged interval is not added');
  assert.equal(m.event_count, 2, 'events are still all counted');
  const d = digestForWindow(g, null, null);
  assert.match(d, /placed/);
  assert.doesNotMatch(d, /flagged/);
});

test('digestForWindow keeps only what falls in the window', () => {
  const g = normalizeEventGraph({
    video: {}, actors: [{ id: 'A1', label: 'nurse', identifying_marks: 'scrubs' }],
    events: [{ start_sec: 10, type: 'OTHER', description: 'early' }, { start_sec: 500, type: 'MEDICAL', description: 'late', actor_ids: ['A1'] }],
    camera_coverage: [{ start_sec: 0, end_sec: 600, status: 'PARTIAL', obstructed_by: ['doorframe'] }],
    subject_position: [], transcript: [],
  });
  const d = digestForWindow(g, 400, 600);
  assert.match(d, /late/);
  assert.ok(!/early/.test(d));
  assert.match(d, /PARTIAL by doorframe/);
  assert.match(d, /A1=nurse \(scrubs\)/);
});

test('normalizeInterrogation pins claim assessments to the claims as supplied', () => {
  const r = normalizeInterrogation({
    answer_markdown: 'At [00:05] a door opens. **Nothing** else at [00:09].',
    cited_intervals: [{ start_sec: 9, end_sec: 4 }, { start_sec: 5, end_sec: 7, what_is_seen: 'door' }],
    line_of_sight: { status: 'nope', basis: 'b' },
    claim_assessments: [{ claim_text: 'rewritten', finding: 'REFUTES', basis: 'x' }],
    limitations: ['short window', 3],
  }, { claims: ['The door stays shut.', 'Someone speaks.'] });
  assert.equal(r.claim_assessments.length, 2);
  assert.equal(r.claim_assessments[0].claim_text, 'The door stays shut.');
  assert.equal(r.claim_assessments[0].finding, 'REFUTES');
  assert.equal(r.claim_assessments[1].finding, 'CANNOT_DETERMINE_FROM_FOOTAGE', 'a claim the model skipped is undetermined, never corroborated');
  assert.equal(r.line_of_sight.status, 'PARTIAL');
  assert.deepEqual(r.cited_intervals.map((c) => [c.start_sec, c.end_sec]), [[5, 7], [9, 9]]);
  const clamped = normalizeInterrogation({ cited_intervals: [{ start_sec: 113, end_sec: 130 }, { start_sec: 80, end_sec: 95 }] }, { durationSec: 90 });
  assert.deepEqual(clamped.cited_intervals.map((c) => [c.start_sec, c.end_sec]), [[80, 90], [90, 90]], 'cited times past the end of the recording are clamped');
  assert.deepEqual(r.limitations, ['short window']);
  assert.deepEqual(timestampsIn(r.answer_markdown).map((t) => t.sec), [5, 9]);
});

test('schemas are the structured-output subset: no $schema, no additionalProperties, required lists match properties', () => {
  const walk = (node, path = '') => {
    assert.ok(!('$schema' in node), `${path} has $schema`);
    assert.ok(!('additionalProperties' in node), `${path} has additionalProperties`);
    assert.ok(!('oneOf' in node) && !('anyOf' in node), `${path} uses a union`);
    if (node.type === 'object') {
      for (const r of node.required ?? []) assert.ok(node.properties?.[r], `${path}.required names ${r}, which is not a property`);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    }
    if (node.type === 'array') walk(node.items, `${path}[]`);
  };
  walk(EVENT_GRAPH_SCHEMA, 'event_graph');
  walk(INTERROGATION_SCHEMA, 'interrogation');
  assert.ok(EVENT_TYPES.includes('CAMERA'));
});

test('adapter helpers: env-driven models, stable display names, expiry, mime', () => {
  assert.deepEqual(modelsFromEnv({}), ['gemini-3.8-flash']);
  assert.deepEqual(modelsFromEnv({ GEMINI_VIDEO_MODEL: 'gemini-x' }), ['gemini-x']);
  assert.deepEqual(modelsFromEnv({ GEMINI_VIDEO_MODELS: ' a , b,,c ' }), ['a', 'b', 'c']);
  assert.equal(displayNameFor('abc'), 'cs-video-abc');
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(expiryOf({ expirationTime: '2026-10-19T00:00:00Z' }, now), '2026-10-19T00:00:00.000Z');
  assert.equal(expiryOf({}, now), new Date(now + 47 * 3600 * 1000).toISOString());
  assert.equal(expiryOf({ expirationTime: '2026-10-21T00:00:00Z' }, now), new Date(now + 47 * 3600 * 1000).toISOString(), 'never later than our own 47 h');
  assert.equal(mimeForExt('.MOV'), 'video/mov');
  assert.equal(durationOf({ videoMetadata: { videoDuration: '90s' } }), 90);
  assert.equal(durationOf({ video_metadata: { video_duration: '1130.5s' } }), 1130.5);
  assert.equal(durationOf({}), null);
  assert.equal(isVideoFilename('Clip.MP4'), true);
  assert.equal(isVideoFilename('brief.pdf'), false);
  assert.deepEqual(modalitiesSeen({ promptTokensDetails: [{ modality: 'VIDEO', tokenCount: 5460 }, { modality: 'TEXT', tokenCount: 329 }] }), ['TEXT', 'VIDEO']);
  assert.deepEqual(modalitiesSeen({ promptTokensDetails: [{ modality: 'TEXT', tokenCount: 330 }, { modality: 'AUDIO', tokenCount: 2880 }, { modality: 'VIDEO', tokenCount: 0 }] }), ['AUDIO', 'TEXT'], 'a zero count is not a modality seen (the 2.5-flash clipped shape)');
  assert.equal(modalitiesSeen({ promptTokenCount: 9000 }), null, 'no breakdown: unknown, never "no video"');
  assert.equal(modalitiesSeen(null), null);
});

test('a failed chunk resumes from the offset the upload session reports, never from zero', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-video-test-'));
  const file = path.join(dir, 'clip.mp4');
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  await fsp.writeFile(file, bytes);
  const SESSION = 'https://upload.example/session-1';
  const held = [];              // what the "server" has committed, in order
  const puts = [];              // X-Goog-Upload-Offset of every chunk PUT
  let failedOnce = false;
  const res = (status, headers = {}, body = null) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body ?? {}),
  });
  const fetchImpl = async (url, init) => {
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (String(url).includes('/upload/v1beta/files')) return res(200, { 'x-goog-upload-url': SESSION });
    assert.equal(url, SESSION);
    if (h['x-goog-upload-command'] === 'query') {
      return res(200, { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': String(held.length) });
    }
    const offset = Number(h['x-goog-upload-offset']);
    puts.push(offset);
    assert.equal(offset, held.length, 'every chunk starts exactly where the session left off');
    const body = Buffer.from(init.body);
    if (offset === 256 && !failedOnce) {
      // The socket dies after the server took 128 of the chunk's 256 bytes.
      failedOnce = true;
      held.push(...body.subarray(0, 128));
      throw new Error('socket hang up');
    }
    held.push(...body);
    return h['x-goog-upload-command'].includes('finalize')
      ? res(200, {}, { file: { name: 'files/abc', uri: 'https://x/files/abc', state: 'PROCESSING' } })
      : res(200);
  };
  const out = await uploadVideoFromPath({ apiKey: 'k', filePath: file, fetchImpl, chunkBytes: 256, retryDelayMs: () => 0 });
  assert.equal(out.name, 'files/abc');
  assert.deepEqual(puts, [0, 256, 384, 640, 896], 'resumed at 384 (what the session held), not at 256 or 0');
  assert.ok(Buffer.from(held).equals(bytes), 'the bytes the server holds are the file, once, in order');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a finalize whose answer was lost is recovered from the session, not uploaded again', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-video-test-'));
  const file = path.join(dir, 'clip.mp4');
  await fsp.writeFile(file, Buffer.alloc(300, 7));
  let puts = 0;
  const res = (status, headers = {}, body = null) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => '',
  });
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/upload/v1beta/files')) return res(200, { 'x-goog-upload-url': 'https://s' });
    if (init.headers['X-Goog-Upload-Command'] === 'query') return res(200, { 'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '300' }, { file: { name: 'files/done' } });
    puts++;
    throw new Error('connection reset after the server finalised');
  };
  const out = await uploadVideoFromPath({ apiKey: 'k', filePath: file, fetchImpl, chunkBytes: 1024, retryDelayMs: () => 0 });
  assert.equal(out.name, 'files/done');
  assert.equal(puts, 1, 'the bytes went up once');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the video meter charges the footage as input tokens plus the full answer allowance, rounded up', () => {
  assert.equal(VIDEO_TOKENS_PER_SECOND, 91, 'measured on gemini-3.8-flash 2026-10-23');
  // 90 s × 91 = 8,190 input tokens at $0.75/M + 16,384 output at $3.75/M = 0.61 ¢ + 6.14 ¢ → 7 ¢ (was 8 ¢ at 295/s)
  assert.equal(estimateVideoCents({ model: 'gemini-3.8-flash', seconds: 90, maxOutputTokens: 16384 }), 7);
  // one 5-minute pass: 27,300 input tokens → 2.05 ¢ + 6.14 ¢ → 9 ¢
  assert.equal(estimateVideoCents({ model: 'gemini-3.8-flash', seconds: 300, maxOutputTokens: 16384 }), 9);
  // 20 minutes on the older rate table: 109,200 input at $0.30/M + 16,384 output at $2.50/M = 3.3 ¢ + 4.1 ¢ → 8 ¢
  assert.equal(estimateVideoCents({ model: 'gemini-2.5-flash', seconds: 1200, maxOutputTokens: 16384 }), 8);
  // the question's bytes count too
  assert.ok(estimateVideoCents({ model: 'gemini-2.5-flash', seconds: 1200, promptText: 'x'.repeat(300000) }) > 8);
  // an unknown Google model falls back to the provider's dearest rate — never cheap by accident
  assert.ok(estimateVideoCents({ model: 'gemini-9-ultra', seconds: 1200 }) > estimateVideoCents({ model: 'gemini-2.5-flash', seconds: 1200 }));
  // nothing watched, nothing asked: only the output allowance
  assert.equal(estimateVideoCents({ model: 'gemini-2.5-flash', seconds: 0, maxOutputTokens: 0 }), 0);
  // actuals, in the shape the API and the worker record from usageMetadata
  assert.equal(centsForTokens('gemini-2.5-flash', 'google', { input: 26880, output: 3000 }), 2);
  // The successor is priced: 26,880 in at $0.75 + 3,000 out at $3.75 = 3.14 c, rounded up.
  assert.equal(centsForTokens('gemini-3.8-flash', 'google', { input: 26880, output: 3000 }), 4);
});

test('the Record row for a recording leaving for the video model is metadata only', () => {
  const payload = mediaExportPayload({
    doc: { id: 'd1', title: 'Body cam 3', source_filename: 'cam3.mp4', file_size_bytes: 1200, matterspace_id: 'm1' },
    analysis: { id: 'a1', created_by: 'u1' },
    fileResource: { name: 'files/abc123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123', expirationTime: '2026-10-20T00:00:00Z' },
  });
  assert.equal(payload.destination, 'video-model');
  assert.equal(payload.provider, 'google');
  assert.equal(payload.document_id, 'd1');
  assert.equal(payload.requested_by, 'u1');
  assert.equal(payload.bytes, 1200);
  assert.equal(payload.sealed, false);
  assert.ok(payload.expires_at, 'the provider\'s retention end is recorded');
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('files/abc123') && !text.includes('googleapis'), 'no provider handle or URL reaches the Record');
  // the worker may write only as a system actor (064's _ledger_append_checked)
  assert.equal(WORKER_ACTOR.kind, 'system');
});
