// The Video Room's provider-neutral core, exercised with no credentials.
//   node --test tests/video-discovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtTime, parseTime, planWindows, buildAnalysisPrompt, buildInterrogationPrompt,
  normalizeEventGraph, looksExcerptRelative, mergeWindowGraphs, deriveMeasures, digestForWindow,
  normalizeInterrogation, timestampsIn, ANALYSIS_WINDOW_SEC, WINDOW_OVERLAP_SEC,
} from '../lib/video-discovery/core.mjs';
import { EVENT_GRAPH_SCHEMA, INTERROGATION_SCHEMA, EVENT_TYPES } from '../lib/video-discovery/schemas.mjs';
import { modelsFromEnv, displayNameFor, expiryOf, mimeForExt } from '../lib/video-discovery/gemini-video.mjs';
import { isVideoFilename } from '../lib/video-discovery/jobs.mjs';

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

test('prompts carry no legal vocabulary and state absolute time', () => {
  const p = buildAnalysisPrompt({ windowStart: 1190, windowEnd: 2390, durationSec: 3000, windowIndex: 1, windowCount: 3 });
  assert.match(p, /pass 2 of 3/);
  assert.match(p, /absolute position/);
  assert.match(p, /not at 00:30/);
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

test('normalizeEventGraph: clamps, sorts, enforces enums, drops junk', () => {
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
  assert.equal(g.events[1].type, 'OTHER');
  assert.equal(g.events[1].end_sec, null, 'an end before the start is dropped');
  assert.deepEqual(g.events[1].actor_ids, ['A1'], 'unknown actor handles are dropped');
  assert.equal(g.events[1].basis, 'visual');
  assert.equal(g.events[1].confidence, 'medium');
  assert.equal(g.events[2].start_sec, 120, 'clamped to the duration');
  assert.equal(g.camera_coverage.length, 1);
  assert.deepEqual(g.camera_coverage[0].obstructed_by, []);
  assert.equal(g.subject_position[0].restrained, false, 'only a real true counts');
  assert.equal(g.transcript.length, 1);
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
  assert.deepEqual(modelsFromEnv({}), ['gemini-2.5-flash']);
  assert.deepEqual(modelsFromEnv({ GEMINI_VIDEO_MODEL: 'gemini-x' }), ['gemini-x']);
  assert.deepEqual(modelsFromEnv({ GEMINI_VIDEO_MODELS: ' a , b,,c ' }), ['a', 'b', 'c']);
  assert.equal(displayNameFor('abc'), 'cs-video-abc');
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(expiryOf({ expirationTime: '2026-10-19T00:00:00Z' }, now), '2026-10-19T00:00:00.000Z');
  assert.equal(expiryOf({}, now), new Date(now + 47 * 3600 * 1000).toISOString());
  assert.equal(expiryOf({ expirationTime: '2026-10-21T00:00:00Z' }, now), new Date(now + 47 * 3600 * 1000).toISOString(), 'never later than our own 47 h');
  assert.equal(mimeForExt('.MOV'), 'video/mov');
  assert.equal(isVideoFilename('Clip.MP4'), true);
  assert.equal(isVideoFilename('brief.pdf'), false);
});
