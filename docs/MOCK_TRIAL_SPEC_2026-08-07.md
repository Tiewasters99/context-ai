# Mock Trial — Build Specification

**Date:** 2026-08-07, ratified 2026-08-08 · **Author:** Claude (Fable 5), from Eden Quainton's design direction · **Status:** APPROVED — Phase 1 build authorized

**Name (decided):** **The Courtroom.** Lives in the Contextspaces **Productivity Suite**. Sibling of Moot Bench in the Grapheon Law trial-prep line.

**The pitch (Eden, 2026-08-08):** *Your* matters brought to life in the courtroom where *you* might actually argue. Not canned, not pre-set.

---

## 1. The controlling idea

**This is a rehearsal instrument, not an oracle.** A lawyer performs real advocacy — opening, direct, cross, closing, from the actual matter record — before a panel of AI jurors, and learns what the performance *did*: what landed, what confused, what provoked pushback, what survived an objection, and what a jury retained after being told to disregard. The product never predicts a verdict. It tells you what your argument taught this panel, so you can make the argument better.

Everything below follows from that sentence. The rails in §2 are product requirements, not compliance garnish.

### Why this and not "AI verdict prediction"

The market scan (2026-08-07, two passes; see memory `project_mock_jury_2026_08_07`) found six-plus shipped "AI jurors vote on your argument" products (JurySimulator.com closest to our market; Courtroom.ai best funded; Viewpoints.ai deepest deliberation mechanics). All are dashboards; all sell prediction. Peer-reviewed work (Sun et al., *Law & Human Behavior* 2025) found LLM jurors convicting at 21% where matched humans convicted at 49% — directionally useful, badly miscalibrated in absolute terms. Prediction is the crowded *and* scientifically weak position.

What nobody ships, verified: **adversarial trial procedure — objections, rulings, disregard instructions that actually alter deliberation — run on the lawyer's own case**, with the lawyer's own recorded delivery, in an inhabitable courtroom. The only product with the procedure loop (MockTrialOnline) is a legal-education tool on canned scenarios. That combination is this build.

## 2. Rails (non-negotiable product requirements)

1. **No verdict probabilities, win rates, or damages predictions — anywhere.** Panel votes are reported as *this panel's reaction*, with a standing calibration note (§9).
2. **No jury-selection features.** No voir dire simulation, no juror scoring, no strike recommendations, no matching against real venire members. A visible "not for jury selection" statement in the UI and terms. (*Batson/J.E.B.* exposure lands on the user; ABA Formal Op. 517 means buyers' ethics counsel will screen for this.)
3. **No demographic aggregation in outputs.** Demographics exist at panel *composition* (§4) and appear on the composition sheet; no report ever contains a "by race/gender" table, and no juror's stated reasoning is keyed to their demographic category.
4. **Everything stays in the matter.** All inputs and outputs are matter-scoped rows and documents under existing RLS. No case material leaves the platform. (Rule 1.6 is a selling point — say so in marketing.)
5. **The report is the work product; the courtroom is the experience.** Reports are linear, citable, lawyerly documents filed into the matter. Spectacle never substitutes for the record.

**Non-goals (v1):** voir dire in any form; witness agents that answer novel questions (witness testimony is *performed or scripted by the lawyer*, not improvised by an AI witness — that's a later, separately-specced feature); criminal-defendant simulation; multi-user live sessions.

## 3. What already exists (build on, don't rebuild)

| Asset | Where | Role here |
|---|---|---|
| Matter record + retrieval (search, get_passage, page:line cites) | context-ai core | Jurors and reports cite the actual record |
| Media ingest + transcription (video/audio → timestamped transcript) | `lib/ingest-core.mjs`, `transcribe-gemini.mjs` | Performed-advocacy input |
| Grapheon Connect (record yourself, working video format) | `Grapheon\meet` | Capture the lawyer's delivery; import into the matter |
| Moot Bench (AI judge, argument input flow) | context-ai, migration 035 | The judge agent + UX precedent |
| Model-agnostic LLM layer (`generate`, `generateStructured`, adapters, `premium` flag) | `src/lib/llm/` | All agent calls go through this; **no provider API shapes in feature code** |
| Miniverse engine + construction method | grapheon-ai repo; `miniverse-construction` skill | Phase 3 courtroom |
| `assemble_documents`, exhibit manifests | `lib/mcp-core.mjs` (2026-08-07) | Exhibit handling during segments |

## 4. The juror model

Two layers, deliberately separated. This split is the intellectual-honesty position *and* the liability design (see memory: attitudes out-predict demographics in five decades of jury research; LLM demographic personas stereotype).

**Composition layer** — who is in the box. Age band, gender, race/ethnicity, education, occupation class. Set by the lawyer via a venue-mix panel (v1: manual sliders with sensible defaults; later: census presets by district). These are facts about panel makeup — the same thing Magna does when recruiting human mock jurors — and they appear on the composition sheet the lawyer approves before empanelment.

**Reasoning layer** — why a juror decides. This is what actually drives each agent:

```jsonc
{
  "id": "uuid", "seat": 7, "display_name": "Marisol V.",
  "composition": { "age_band": "45-54", "gender": "F", "race_ethnicity": "Hispanic",
                   "education": "HS+some college", "occupation_class": "healthcare" },
  "reasoning": {
    "occupation_detail": "ER intake nurse, 18 years",
    "life_experiences": ["sued once over a fender-bender, felt the system was fair",
                          "manages an aging parent's care"],
    "attitudes": {            // 1-7 scales; these are the predictive engine
      "institutional_trust": 3, "claims_consciousness": 5,
      "authority_orientation": 4, "risk_tolerance": 2,
      "corporate_skepticism": 6, "personal_responsibility_ethic": 5
    },
    "cognitive_style": "narrative",        // analytic | narrative | social | driver
    "communication": "talkative",          // talkative | reserved | friendly | blunt
    "salience_bias": "credibility"         // numbers | story | credibility | fairness
  },
  "voice": { "backstory": "one paragraph, generated from reasoning fields", "register": "plain, warm" }
}
```

**Sampling:** a deterministic sampler draws composition from the venue mix, then draws attitudes from documented distributions *conditioned on occupation and experience* (not on race). The full panel sheet is shown to the lawyer before empanelment and every field is editable — transparency builds trust and lets the lawyer test a specific worry ("give me a panel heavy on personal-responsibility ethic"). Default panel: **12 jurors**; 6 selectable for speed.

**The rail in practice:** demographics condition nothing in the reasoning sampler and never appear as the "because" in a juror's output. A juror may organically reference their *experiences* ("when I got sued, nobody explained…") — that is honest and useful. "As a Hispanic woman, I…" is a generation failure; the juror prompt forbids it and the eval harness (§11) checks for it.

## 5. Trial flow (deterministic state machine; LLM only at judgment points)

```
EMPANEL → [SEGMENT → (REACTIONS) → {OBJECTION → RULING → STRIKE?}* ]+ → DELIBERATE → BALLOTS → REPORT
```

- **EMPANEL** — sampler + lawyer approval of the panel sheet.
- **SEGMENT** — one unit of advocacy: opening | direct | cross | closing | exhibit-publish, tagged `ours` or `theirs`. Input is (a) pasted/typed text, (b) a matter document, or (c) a Connect recording already filed to the matter (its transcript is the segment text; delivery notes ride along). The lawyer performs *both sides* if they want opposing argument tested — or enables the opposing-counsel agent (Phase 2).
- **REACTIONS** — after each segment, every juror privately records structured reactions: salience list (the 3–5 moments that stuck, with record cites), confusion points, credibility impressions, one-line gut response. Private; not shown to other jurors; feeds deliberation and the report.
- **OBJECTION / RULING / STRIKE (Phase 2)** — the opposing-counsel agent reviews each `ours` segment against candidate spans (deterministic span nomination: quotes, characterizations, hearsay-shaped assertions; LLM judges whether to object and on what ground). The judge agent (Moot Bench) rules with a one-paragraph FRE-grounded explanation. **Sustained → the span is marked STRICKEN in the transcript with the judge's disregard instruction attached.** Jurors are *not* re-served a cleaned transcript — they heard it, exactly like a real jury.
- **DELIBERATE** — §6.
- **BALLOTS** — leaning + conviction (1-7) + three reasons with record cites, per juror per round.
- **REPORT** — §9, filed into the matter as a document.

### The strike mechanic is the signature feature

Because stricken material stays in juror memory (flagged, with the instruction), deliberation measures **leakage**: does the stricken moment resurface in reasoning? Does anyone police it ("we were told to disregard that")? Did it move ballots anyway? Human research has long documented that instructed-to-disregard evidence still influences juries; no consultant can quantify it for *your* trial moment. We can — and **Twin Panel** mode (Phase 2, one checkbox) runs a second, identical panel that never heard the stricken material at all, so the report shows the measured cost of the moment the objection couldn't cure. That is a demonstrative no one else sells.

## 6. Deliberation design (the fragile part — engineered, not hoped for)

The academic record ("12 Angry AI Agents") says naive multi-agent deliberation goes flat: agreeable models converge instantly. Countermeasures, all deterministic scaffolding around LLM turns:

1. **Secret first ballot** before any discussion (anchors genuine disagreement).
2. **Salience divergence** — jurors argue from their *own* private salience lists recorded at segment time, which differ by design (salience_bias), giving them different evidence to cite.
3. **Structured turns** — the foreman (selected by profile: highest authority_orientation × communication, not random) opens with the split; speaking priority goes to jurors whose ballot or cited evidence conflicts with the emerging majority; every speaking turn must cite a record moment and respond to a named prior speaker.
4. **Re-ballot each round**; conviction movement is tracked juror-by-juror.
5. **Stop conditions:** unanimity, two rounds without movement (hung), or 5 rounds.
6. **Flatness alarm** (eval + runtime): if round-1 ballots are unanimous or total conviction movement is zero across a test suite, the harness fails the build — flat deliberation is a defect, not a result.

## 7. Agents, models, cost

| Agent | Model | Notes |
|---|---|---|
| Jurors (×12) | **claude-fable-5** | The point of the product; premium surface opts in via the existing `premium` flag pattern (Moot Bench precedent). Opus 4.8 selectable as economy mode. |
| Judge | claude-fable-5 (default) / claude-opus-4-8 | Reuse Moot Bench prompt lineage |
| Opposing counsel (Phase 2) | claude-opus-4-8 | Objection-spotting is pattern work; configurable |

All calls go through `src/lib/llm` (`generateStructured` for reactions/ballots/rulings; `generate` for deliberation speech). **Prompt-cache architecture:** order every juror prompt as `[case digest + transcript so far]` (shared, cache breakpoint) → `[juror persona][task]` (per-juror suffix), so twelve juror calls read one cached prefix; deliberation appends to the shared prefix. Handle a Fable `refusal` stop reason by retrying that turn on Opus 4.8 (trial facts can brush safety classifiers; a juror turn must never silently vanish).

**Order-of-magnitude cost at Fable list rates ($10/$50 per MTok), with caching:** Quick Panel session ≈ **$10–20**; Full Trial with objections and Twin Panel ≈ **$40–80**. Against $10K–$60K+ for one traditional exercise (IMS; Trial Dynamics quotes ~$30K/day), pricing has three orders of magnitude of room. (Estimates, not measurements — Phase 1 acceptance includes metering a real session.)

## 8. Data model (all matter-scoped, RLS mirroring existing tables)

`mock_trials` (id, matterspace_id, title, mode `quick|full`, status, venue_mix jsonb, model_id, created_by, timestamps) · `mock_trial_jurors` (trial_id, seat, profile jsonb, persona_sheet) · `mock_trial_segments` (trial_id, kind, side, source_document_id nullable, transcript, position) · `mock_trial_events` (trial_id, segment_id, type `objection|ruling|strike|note`, actor, payload jsonb, span_start, span_end) · `mock_trial_reactions` (trial_id, juror_id, segment_id, payload jsonb) · `mock_trial_ballots` (trial_id, juror_id, round, leaning, conviction, reasons jsonb) · `mock_trial_reports` (trial_id, document_id → the report filed back into the matter).

One migration, numbered next in `supabase/migrations/` (check at build time — do not guess). ⛔ Eden applies migrations and deploys.

## 9. The Rehearsal Report (the work product)

A linear memo, filed into the matter as a document (and therefore searchable/citable like everything else). Sections, in order:

1. **What landed** — themes/moments ranked by cross-panel salience, each with the record cite and which jurors flagged it.
2. **What confused** — confusion points with the transcript location; the sentence a lawyer rewrites tomorrow.
3. **Pushback map** — objections *from the jurors' reasoning* (not legal objections): where attitude clusters resisted, quoted in the jurors' own words with attitude-cluster labels (never demographic labels).
4. **Deliberation movement** — first ballot → final ballot, who moved, on what argument, citing which moment.
5. **Strike & leakage panel (Phase 2)** — stricken spans, who resurfaced them, whether ballots moved; Twin Panel delta if run.
6. **This panel's ballots** — the votes and reasons, under a standing calibration block: *"AI panels are a rehearsal instrument. Peer-reviewed comparisons show LLM jurors apply materially different decision thresholds than human juries (e.g., 21% vs. 49% conviction on identical facts). Read reactions and reasoning as directional feedback on the argument — never as a verdict prediction."*

No verdict probability. No strike advice. Every quoted juror claim about evidence carries its page:line cite (deposition-fidelity culture applies).

## 10. The courtroom scene (Phase 3 — Miniverse)

Built per the `miniverse-construction` skill: scene-as-story, mood-first, procedural textures, staged for the first frame and the phone. The story of the room: *late afternoon in a federal courtroom; your case; a panel that owes you nothing.* Judge's bench, jury box of twelve, counsel tables, gallery; pervasive subtle motion (jurors shifting, a courtroom clock, dust in the light shafts). Juror avatars carry faces from Eden's Midjourney portrait set (consistent style; procedural fallback when a face is missing). Three staged views: the lectern (you present), the box (reactions ripple as segments land), the jury room (deliberation, ballot board updating). The Rehearsal Report remains the record; the room is where you *feel* the panel. iPhone test before merge (standing rule).

## 11. Build phases & acceptance

**Phase 1 — Quick Panel (the one-shot Fable build; shippable alone).** Panel builder + sampler + editable panel sheet; segment input (paste / matter doc); per-segment juror reactions; structured deliberation with ballots; Rehearsal Report §§1-4+6 filed to the matter. UI follows Contextspaces patterns (draggable/resizable cards rule applies).
*Accepts when:* one end-to-end session runs on a real matter; every evidence quote in the report resolves to a correct page:line; deliberation shows nonzero movement on at least 2 of 3 golden scenarios; zero demographic-keyed statements in 50 sampled juror outputs; measured session cost logged.

**Phase 2 — Full Trial.** Opposing-counsel objections, judge rulings, strike + leakage measurement, Twin Panel, Connect-video segments (existing ingest), report §5.
*Accepts when:* objection grounds are plausible on spot-check (Eden reviews 20); a sustained strike produces a leakage panel; Twin Panel delta renders; a Connect recording flows end-to-end without leaving the matter.

**Phase 3 — The Courtroom.** The Miniverse scene above, wired to live session state.
*Accepts when:* first frame reads on an iPhone; reactions visibly ripple; Eden says it feels like a place (his bar, deliberately).

**Eval harness (built in Phase 1, small):** three golden scenarios — a PI case, a contract dispute, and a complex antitrust matter (Eden's stress case) — plus the flatness alarm, the demographic-keying check, and refusal-fallback coverage.

## 12. Decisions (Eden, 2026-08-08)

1. **Name:** The Courtroom.
2. **Pricing:** subscription plus overage; specifics deferred (build meters per-session cost so the overage math has data).
3. **Venue mix v1:** manual sliders; census presets later.
4. **Twin Panel:** opt-in (it doubles juror cost).
5. **Navigation home:** Productivity Suite → The Courtroom (not Practice Docket).
6. **Antitrust golden scenario:** derived from the Labib/Steris matter, anonymized. The build ships with an authored placeholder scenario in its slot; Eden supplies (or approves generation of) the anonymized Labib/Steris facts before the eval is considered real.

## 13. Note to the Fable build session

Read this spec, then `src/lib/llm/` (adapter contract), the Moot Bench module (judge + argument-input precedent), and `lib/mcp-core.mjs` (matter resolution, RLS patterns). Scope is **Phase 1 only**. This spec states goals, constraints, and the load-bearing structures (juror schema, state machine, deliberation protocol, rails); where it is silent — UI composition, prose of juror voices, prompt wording — use your judgment and the Grapheon design philosophy (beautiful, unique, no default patterns). The rails in §2 are the only immovable walls.
