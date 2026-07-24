# Student Hub — Design System Handoff

Source prototypes: `student-hub-prototype.jsx` (React artifact), `socratic-voice.html` (standalone voice testbed). Preserve this system when rebuilding in Contextspaces.

## Concept
"Law library" — the visual world of the printed casebook and the banker's-lamp reading room. Serif for content, sans for chrome, transcript styling for dialogue. Restraint throughout: flat colors, 2px border radii, hairline rules, no shadows, no gradients.

## Palette
| Token | Hex | Use |
|---|---|---|
| paper | `#FAF8F2` | page background |
| ink | `#1C1B17` | body text |
| green | `#1F4D3A` | primary brand, active tabs, student voice |
| greenDark | `#153728` | header/caption band |
| oxblood | `#7A2E2E` | professor voice, primary action (Answer), field labels |
| brass | `#A98B45` | accents: header underline (3px), kickers, § bullets |
| rule | `#D9D4C7` | hairline borders, disabled states, transcript line numbers |
| faint | `#6E6A5E` | secondary text |

## Typography
- **Content serif:** Iowan Old Style → Palatino → Georgia. Body 15–15.5px, line-height 1.55–1.6.
- **UI sans:** system stack. Small, bold, letterspaced (0.05–0.14em), uppercase for labels/tabs/kickers (11–13px).
- **Mono:** speaker labels and transcript line numbers only.

## Signature elements
1. **Case-caption header:** greenDark band, brass 3px bottom border; brass uppercase kicker; case name in large italic serif with a small non-italic "v."; citation line at 65% opacity paper.
2. **Transcript rendering for dialogue:** every conversation renders as a court transcript — mono uppercase speaker labels ("THE PROFESSOR:" oxblood / "THE STUDENT:" green), continuous line numbers in the left gutter (rule color, right-aligned, 22–24px column), serif body. This is the identity of the product; keep it.
3. **Brief layout:** two-column rows split by hairline rules — left column oxblood uppercase field label (150px), right column serif content.
4. **Outline:** green serif section heads, brass § as bullet glyph.
5. **Voice affordances:** pill toggle ("● Professor speaks" / "○ Professor muted"); mic button goes oxblood with a soft box-shadow pulse (1.2s) while listening; ■ stop glyph. Respect `prefers-reduced-motion`.
6. **Empty state ("Take your seat"):** centered, quiet, green primary button — frames the session as walking into class.

## Interaction principles
- Minimal prompt, maximal context: 2–3 sentences of situational framing + the student's own ingested material. Socratic by default; follows the student's lead into tutoring ("wait, I don't understand") and back.
- Dictation lands in the input for review before sending — never auto-submits.
- Ingestion flow (per Eden): upload (with copyright guardrails) → "What would you like me to do?" → Case summary / Section outline / Socratic dialogue / Something else / Suggest a case.

## Guardrails baked into product (from legal discussion — get full memo before launch)
- Scan hard-locked to the owner's account; never transmissible in any form (Kindle model).
- Derived artifacts (briefs, outlines, dialogue) freely shareable; generation pipeline paraphrases and caps quotation of editorial matter.
- Study groups: ≤5 members, each attests lawful ownership of the underlying work (TOS makes attestation a warranty); group queries permitted against the group's single ingestion on that basis.
- Marketing never suggests scan-sharing or "only one of you needs to scan" (Grokster inducement risk lives in the pitch, not the code).
- DMCA agent + repeat-infringer policy for §512.
