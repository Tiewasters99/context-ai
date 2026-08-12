# The Courtroom — house venire cards

Twelve waist-up juror figures for the Miniverse jury box (Phase 3). Cropped
from Eden's Midjourney set (2026-08-09, originals in his Downloads; filenames
below are the `u7448524986_…` stems). Cards are 384×512 (3:4), cropped
waist-up — the desk hides everything below. The scene feathers edges and
warm-tints at load (`setJurorPortrait`), so cards ship un-feathered.

These are presence, not identity: no visual is keyed to any juror's profile
(spec §2.3 rail). Seats are assigned by number only.

| Seat | Figure | Source stem |
|---|---|---|
| Bench | The judge — late forties, black robes, wood paneling | `a_female_judge_late_fourties_in_black_robes_seate_e64d6fea…_0` |
| Counsel (lead) | The lawyer — she sits at our table; tap her and she takes the lectern | `A_lawyer_standing_at_the_lectern_shot_by_Annie_Li_342fda38…_0` |
| Counsel (second) | Second chair, orange tie | `a_male_lawyer_at_the_counsel_table_shot_by_annie__2723ec0d…_3` |
| Counsel (opposing) | Opposing lead, red leather chair | `a_male_lawyer_at_counsel_table_shot_by_Annie_Lieb_00d31f35…_2` |
| 1 | Electrician, cap and coveralls | `an_electrician_seated_…_309de486…_0` |
| 2 | Elegant Asian woman | `An_asian_woman_elegant_mid_30s_…_07e60c00…_0` |
| 3 | Retired accountant, round glasses | `a_retired_accountant_…_9d54e190…_1` |
| 4 | Latina housewife, red dress | `a_middle_aged_latina_housewife_…_58545fc7…_2` |
| 5 | Black professional man, pinstripes | `a_black_professional_man_…_0d2bd210…_1` |
| 6 | Suburban housewife, garden light | `a_pretty_white_suburban_housewife_…_6237cbce…_0` |
| 7 | College woman, sepia | `a_young_woman_…college_look_…_f062c729…_2` |
| 8 | Indian man, vest | `an_Indian_man_early_50s_…_3e68147c…_2` |
| 9 | Puerto Rican woman | `a_puerto_rican_woman_…_e726f38c…_0` |
| 10 | Young athletic blond man | `a_young_athletic_blond_man_…_868e3c8d…_2` |
| 11 | Black professional woman, B&W | `an_attractive_black_professional_woman_…_ec81c2e1…_3` |
| 12 | College man | `a_young_man_…college_look_…_572ba6c8…_0` |

## Panel B (`venire2-N.png`)

| Seat | Figure | Source stem |
|---|---|---|
| 1 | Gus Palowski — plumber, overalls | `a_middle_aged_white_plumber_off_work_…_1c3a6d0f…_0` |
| 2 | Dorothy Bell — retired teacher | `an_older_black_woman_retired_teacher_…_e2d29aef…_2` |
| 3 | Frank DiSalvo — retired adjuster, arms crossed | `an_elderly_man_retiree_from_Florida_…_30294a79…_3` |
| 4 | Amara Wells — marketing manager | `an_attractive_black_professional_woman_…_d352f041…_0` |
| 5 | Esteban Ruiz — landscaper in the foliage | `A_latino_landscaper_…_24fc83aa…_2` |
| 6 | Nora Sheehan — bank manager (redhead, navy) | `Show_the_reference_figure_…_20631f64…_1` (left panel) |
| 7 | Danny Song — IT specialist | `An_Asian_IT_specialist_…_8caac7c4…_1` |
| 8 | Walt Jessup — charter captain, leather jacket | `an_elderly_man_retiree_from_Florida_…_4b5b5893…_1` |
| 9 | Claire Fontaine — events manager (seated brunette) | `Show_the_reference_figure_…_20631f64…_3` |
| 10 | Ari Beaumont — junior architect | `a_young_professional_gender_ethnic_fluid_person_…_6c8d3585…_0` |
| 11 | Peggy Ostrowski — retired cafeteria manager | `an_elderly_retiree_from_Florida_…_a8e76417…_0` |
| 12 | Maya Castellano — nursing student (curly college) | `a_young_woman_…college_look_…_74ed66a3…_0` |

## The witness stand

Witnesses are per-matter: the stand takes any waist-up portrait via
`setWitnessPortrait(url)` (null empties the chair). One committed demo card:

| Figure | Source stem |
|---|---|
| Demo witness (`witness-demo.png`) — silver-haired woman, hands folded | `a_female_judge_late_fourties_in_black_robes_seate_b8ebd6df…_3` (the unused judge alternate; her robe reads as a dark garment off the bench) |

## Counsel (no cards)

Counsel are SCULPTED figures as of the figures.ts build — modeled low-poly
people, two per table, styled by slot only. The old `counsel-*.png` cards are
retired from the scene (files kept for reference). Per-matter avatar dressing
is a future path.

Both panels are also REASONING agents: `src/lib/courtroom/house-panel.ts`
gives every figure an authored attitude profile, so a trial can empanel
House Panel A or B and these people deliberate in character. Personality is
the sanctioned engine (spec §4); demographics still condition nothing.

Format rules learned the hard way: **seated, front-facing, waist-up or
wider** (a head more than ~⅓ of frame height becomes a giant disembodied
face on the card); dark painterly backdrops melt into the room. Recrop with
sharp: `extract({left, top, width, height: width / 0.75})` → `resize(384,
512, {fit: 'cover'})`.
